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

function crmLabel(deal: Deal): string {
  return deal.source === "salesforce" ? "Salesforce" : "HubSpot";
}

function getFixForUninvoiced(deal: Deal): LeakFix {
  return {
    cause: `Revenue from "${deal.name}" (${deal.company}) was not recorded across connected systems after deal close. Systems are out of alignment.`,
    trigger: "Detected automatically",
    action: `Recover ${fmtEur(deal.amount)} and bring all systems into alignment`,
    impact: `Recovers ${fmtEur(deal.amount)} for this deal. Prevents future misalignment automatically.`,
  };
}

function getFixForRenewal(sub: Subscription): LeakFix {
  const days = daysSince(sub.current_period_end);
  return {
    cause: `Revenue continuity gap detected for ${sub.company} — billing cycle lapsed ${days} days ago while account remains active.`,
    trigger: "Detected automatically",
    action: `Restore billing continuity for ${sub.company} and recover ${fmtEur(sub.amount)}`,
    impact: `Recovers ${fmtEur(sub.amount)} in recurring revenue. Prevents future continuity gaps automatically.`,
  };
}

function getFixForChurn(sub: Subscription): LeakFix {
  return {
    cause: `Revenue at risk for ${sub.company} — billing disruption detected across connected systems.`,
    trigger: "Detected automatically",
    action: `Secure ${fmtEur(sub.amount)} in at-risk revenue and restore system alignment`,
    impact: `Protects ${fmtEur(sub.amount)} in at-risk revenue. Prevents future disruptions automatically.`,
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
        issue: `${fmtEur(deal.amount)} revenue mismatch`,
        detail: `"${deal.name}" closed ${daysClosed} day${daysClosed !== 1 ? "s" : ""} ago — revenue not recorded across connected systems. ${fmtEur(deal.amount)} detected as unrecovered.`,
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
        issue: `${fmtEur(sub.amount)} revenue continuity gap`,
        detail: `"${sub.plan}" for ${sub.company} — billing cycle lapsed ${daysExpired} day${daysExpired !== 1 ? "s" : ""} ago while account remains active. ${fmtEur(sub.amount)} in recurring revenue not captured.`,
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
      issue: `${fmtEur(sub.amount)} revenue at risk`,
      detail: `${sub.company} — billing disruption detected across connected systems. ${fmtEur(sub.amount)} at risk without automated intervention.`,
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
      `${summary.uninvoiced_count} revenue mismatch${summary.uninvoiced_count > 1 ? "es" : ""} detected — ${fmt(summary.uninvoiced_total)} not recorded across systems`,
    );
  }
  if (summary.missing_renewal_count > 0) {
    parts.push(
      `${summary.missing_renewal_count} revenue continuity gap${summary.missing_renewal_count > 1 ? "s" : ""} detected — ${fmt(summary.missing_renewal_total)} in recurring revenue not captured`,
    );
  }
  if (summary.churn_risk_count > 0) {
    parts.push(
      `${summary.churn_risk_count} billing disruption${summary.churn_risk_count > 1 ? "s" : ""} detected — ${fmt(summary.churn_risk_total)} at risk`,
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
    rootCause = `${uninvPct}% of detected issues stem from revenue not being recorded across connected systems after deal close. Systems are out of alignment.`;
    recommendation = "Automated system alignment will prevent the majority of future revenue mismatches.";
  } else if (renewPct > uninvPct) {
    rootCause = `${renewPct}% of detected issues are revenue continuity gaps — billing cycles lapsing while accounts remain active across systems.`;
    recommendation = "Automated continuity monitoring will detect and resolve future gaps before revenue is lost.";
  } else {
    rootCause = "Revenue leaks are distributed across system misalignments, continuity gaps, and billing disruptions. The common thread: systems operating independently without automated coordination.";
    recommendation = "End-to-end system alignment will prevent multiple categories of revenue leakage simultaneously.";
  }

  return { rootCause, recommendation };
}
