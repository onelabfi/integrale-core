/**
 * Revenue Leak Detection Engine
 *
 * Three rules:
 *   A) UNINVOICED DEALS — deal closed_won with no matching Stripe invoice within 30 days
 *   B) MISSING RENEWALS — subscription ended/canceled with no renewal or new deal
 *   C) CHURN RISK       — no activity or payment in last 30 days
 */
import type { Deal, Invoice, Subscription, RevenueLeak, LeakSummary, DetectionOutput, LeakFix } from "./types.js";

const INVOICE_MATCH_WINDOW_DAYS = 30;

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function hasMatchingInvoice(deal: Deal, invoices: Invoice[]): boolean {
  const dealClose = new Date(deal.close_date).getTime();
  return invoices.some((inv) => {
    if (inv.customer_id !== deal.customer_id) return false;
    const invDate = new Date(inv.created_at).getTime();
    const withinWindow = Math.abs(invDate - dealClose) <= INVOICE_MATCH_WINDOW_DAYS * 86_400_000;
    const amountMatch = Math.abs(inv.amount - deal.amount) / deal.amount < 0.05;
    return withinWindow && amountMatch;
  });
}

function hasRenewal(sub: Subscription, deals: Deal[], subs: Subscription[]): boolean {
  const subEnd = new Date(sub.current_period_end).getTime();
  const hasNewDeal = deals.some(
    (d) => d.customer_id === sub.customer_id && new Date(d.close_date).getTime() > subEnd,
  );
  if (hasNewDeal) return true;
  const hasActiveSub = subs.some(
    (s) => s.id !== sub.id && s.customer_id === sub.customer_id && s.status === "active",
  );
  return hasActiveSub;
}

/* ── AI-generated fix suggestions per category ───────────────────── */

function getFixForUninvoiced(deal: Deal): LeakFix {
  const days = daysSince(deal.close_date);
  return {
    cause: `When "${deal.name}" was marked as Closed Won in HubSpot ${days} days ago, no automation triggered invoice creation in Stripe. The deal and billing systems are not connected.`,
    trigger: "Deal marked as Closed Won in HubSpot",
    action: `Create a ${fmtEur(deal.amount)} invoice in Stripe for ${deal.company} within 24 hours of deal close`,
    impact: `Recovers ${fmtEur(deal.amount)} for this deal. Prevents future uninvoiced deals automatically.`,
  };
}

function getFixForRenewal(sub: Subscription): LeakFix {
  const days = daysSince(sub.current_period_end);
  return {
    cause: `The "${sub.plan}" subscription for ${sub.company} expired ${days} days ago. No renewal workflow exists — the team was never notified, and no follow-up deal was created.`,
    trigger: "Subscription reaches 30 days before expiry",
    action: `Send renewal reminder to ${sub.company}, create renewal deal in HubSpot, and auto-generate renewal quote`,
    impact: `Recovers ${fmtEur(sub.amount)} in recurring revenue. Prevents silent churn on all future renewals.`,
  };
}

function getFixForChurn(sub: Subscription): LeakFix {
  return {
    cause: `${sub.company} has a ${sub.status === "past_due" ? "past due" : "overdue"} subscription with no recent payment activity. Without intervention, this customer will likely churn.`,
    trigger: "Payment fails or subscription becomes past due",
    action: `Send automated dunning email to ${sub.company}, notify account manager, and retry payment in 48 hours`,
    impact: `Saves ${fmtEur(sub.amount)} in at-risk revenue. Reduces involuntary churn by catching payment issues early.`,
  };
}

export function detectLeaks(
  deals: Deal[],
  invoices: Invoice[],
  subscriptions: Subscription[],
): DetectionOutput {
  const leaks: RevenueLeak[] = [];

  // ── Rule A: Uninvoiced Deals ────────────────────────────────────
  const closedWon = deals.filter((d) => d.stage === "closed_won");
  for (const deal of closedWon) {
    if (!hasMatchingInvoice(deal, invoices)) {
      const daysClosed = daysSince(deal.close_date);
      leaks.push({
        id: `leak-uninv-${deal.id}`,
        category: "uninvoiced",
        company: deal.company,
        deal_name: deal.name,
        amount: deal.amount,
        currency: deal.currency,
        date: deal.close_date,
        issue: `${fmtEur(deal.amount)} not invoiced`,
        detail: `"${deal.name}" closed ${daysClosed} day${daysClosed !== 1 ? "s" : ""} ago with no matching Stripe invoice. ${fmtEur(deal.amount)} is sitting in your CRM but not in your billing system.`,
        source_record_id: deal.id,
        status: "open",
        fix: getFixForUninvoiced(deal),
      });
    }
  }

  // ── Rule B: Missing Renewals ────────────────────────────────────
  const expired = subscriptions.filter(
    (s) => (s.status === "canceled" || s.status === "past_due") && daysSince(s.current_period_end) > 0,
  );
  for (const sub of expired) {
    if (!hasRenewal(sub, deals, subscriptions)) {
      const daysExpired = daysSince(sub.current_period_end);
      leaks.push({
        id: `leak-renew-${sub.id}`,
        category: "missing_renewal",
        company: sub.company,
        deal_name: sub.plan,
        amount: sub.amount,
        currency: sub.currency,
        date: sub.current_period_end,
        issue: `${fmtEur(sub.amount)} renewal missed`,
        detail: `"${sub.plan}" for ${sub.company} expired ${daysExpired} day${daysExpired !== 1 ? "s" : ""} ago. Nobody followed up — ${fmtEur(sub.amount)} in recurring revenue silently disappeared.`,
        source_record_id: sub.id,
        status: "open",
        fix: getFixForRenewal(sub),
      });
    }
  }

  // ── Rule C: Churn Risk ──────────────────────────────────────────
  const atRisk = subscriptions.filter((s) => {
    if (s.status === "canceled") return false;
    if (s.status === "past_due") return true;
    const periodEnd = new Date(s.current_period_end).getTime();
    const now = Date.now();
    const daysUntilEnd = (periodEnd - now) / 86_400_000;
    if (daysUntilEnd < 0 && s.status === "active") return true;
    return false;
  });

  for (const sub of atRisk) {
    if (leaks.some((l) => l.source_record_id === sub.id)) continue;
    leaks.push({
      id: `leak-churn-${sub.id}`,
      category: "churn_risk",
      company: sub.company,
      deal_name: sub.plan,
      amount: sub.amount,
      currency: sub.currency,
      date: sub.current_period_end,
      issue: `${fmtEur(sub.amount)} at risk of churn`,
      detail: `${sub.company} subscription "${sub.plan}" is ${sub.status === "past_due" ? "past due" : "overdue"}. No payment activity detected. ${fmtEur(sub.amount)} will be lost without intervention.`,
      source_record_id: sub.id,
      status: "open",
      fix: getFixForChurn(sub),
    });
  }

  leaks.sort((a, b) => b.amount - a.amount);

  const byCategory = (cat: RevenueLeak["category"]) => leaks.filter((l) => l.category === cat);
  const sumAmount = (items: RevenueLeak[]) => items.reduce((s, l) => s + l.amount, 0);

  const uninvoiced = byCategory("uninvoiced");
  const renewals = byCategory("missing_renewal");
  const churn = byCategory("churn_risk");

  const summary: LeakSummary = {
    uninvoiced_total: sumAmount(uninvoiced),
    uninvoiced_count: uninvoiced.length,
    missing_renewal_total: sumAmount(renewals),
    missing_renewal_count: renewals.length,
    churn_risk_total: sumAmount(churn),
    churn_risk_count: churn.length,
    total: sumAmount(leaks),
    total_count: leaks.length,
  };

  return { leaks, summary };
}

function fmtEur(amount: number): string {
  return new Intl.NumberFormat("fi-FI", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function generateLeakSummary(output: DetectionOutput): string {
  const { summary, leaks } = output;
  if (leaks.length === 0) return "No revenue leaks detected. Your billing pipeline looks clean.";

  const fmt = (n: number) =>
    new Intl.NumberFormat("fi-FI", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);

  const parts: string[] = [];

  if (summary.uninvoiced_count > 0) {
    parts.push(
      `${summary.uninvoiced_count} closed deal${summary.uninvoiced_count > 1 ? "s have" : " has"} no matching invoice — ${fmt(summary.uninvoiced_total)} in unrecovered revenue`,
    );
  }
  if (summary.missing_renewal_count > 0) {
    parts.push(
      `${summary.missing_renewal_count} subscription${summary.missing_renewal_count > 1 ? "s" : ""} expired without renewal — ${fmt(summary.missing_renewal_total)} in recurring revenue lost`,
    );
  }
  if (summary.churn_risk_count > 0) {
    parts.push(
      `${summary.churn_risk_count} customer${summary.churn_risk_count > 1 ? "s show" : " shows"} churn signals — ${fmt(summary.churn_risk_total)} at risk`,
    );
  }

  return `${parts.join(". ")}.`;
}

/**
 * Generate root-cause analysis text for the AI insight panel.
 */
export function generateRootCause(output: DetectionOutput): { rootCause: string; recommendation: string } {
  const { summary } = output;
  const total = summary.total_count;
  if (total === 0) {
    return { rootCause: "No issues detected.", recommendation: "Keep monitoring." };
  }

  // Determine dominant category
  const uninvPct = Math.round((summary.uninvoiced_count / total) * 100);
  const renewPct = Math.round((summary.missing_renewal_count / total) * 100);

  let rootCause: string;
  let recommendation: string;

  if (uninvPct >= renewPct && uninvPct > 30) {
    rootCause = `${uninvPct}% of your revenue leaks are caused by missing automation between your CRM and billing system. Deals close in HubSpot but invoices never get created in Stripe.`;
    recommendation = "Connect deal close events to automatic invoice creation. This single automation would prevent the majority of your leakage.";
  } else if (renewPct > uninvPct) {
    rootCause = `${renewPct}% of your revenue leaks come from subscriptions expiring without follow-up. Your team has no automated renewal workflow — customers silently churn.`;
    recommendation = "Set up renewal reminders 30 days before expiry and auto-create renewal deals. This closes the gap between subscription end and re-engagement.";
  } else {
    rootCause = "Your revenue leaks are spread across invoicing gaps, missed renewals, and churn signals. The common thread: no automation connects your CRM to your billing system.";
    recommendation = "Activate end-to-end automation between HubSpot and Stripe. One integration prevents multiple categories of leakage.";
  }

  return { rootCause, recommendation };
}
