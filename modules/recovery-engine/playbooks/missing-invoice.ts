/**
 * Missing Invoice Playbook
 *
 * Detects CRM deals marked "Closed Won" that have no corresponding
 * invoice in Stripe, and enables safe automated recovery.
 *
 * Production-safe: idempotent, no duplicates, fail-safe execution.
 *
 * Lifecycle:
 *   detect() → validate() → estimate() → preview() → execute()
 */
import type {
  Playbook,
  PlaybookType,
  RecoveryOpportunity,
  ValidationResult,
  EstimationResult,
  PreviewResult,
  ExecutionResult,
  DealInput,
  InvoiceInput,
} from "../types.js";
import * as store from "../storage/recoveryStore.js";

const PLAYBOOK_TYPE: PlaybookType = "missing_invoice";

/* ── Constants ─────────────────────────────────────────────────────── */

/** Amount tolerance for invoice matching (±2%) */
const AMOUNT_TOLERANCE = 0.02;

/** Minimum hours since deal close before we flag it (24h) */
const MIN_AGE_HOURS = 24;

/** Patterns that indicate test/internal deals (case-insensitive) */
const EXCLUDED_PATTERNS = [
  /\btest\b/i,
  /\binternal\b/i,
  /\bdemo\b/i,
  /\bsandbox\b/i,
  /\bfake\b/i,
];

/** Basic email validation */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* ── Formatting ────────────────────────────────────────────────────── */

function fmtEur(amount: number): string {
  return new Intl.NumberFormat("fi-FI", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(amount);
}

function hoursSince(isoDate: string): number {
  return (Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60);
}

function daysSince(isoDate: string): number {
  return Math.floor(hoursSince(isoDate) / 24);
}

/* ── Credit cost calculation ───────────────────────────────────────── */

function calcCreditsRequired(amount: number): number {
  if (amount > 10000) return Math.floor(amount / 100);
  if (amount > 5000) return Math.floor(amount / 80);
  return Math.floor(amount / 50);
}

/* ═══════════════════════════════════════════════════════════════════
 * INVOICE MATCHING
 * Checks if a deal already has a corresponding Stripe invoice.
 *
 * Match criteria (any of):
 *   1. Invoice metadata.dealId === deal.id (system-created)
 *   2. Same customer + amount within ±2% tolerance
 * ═══════════════════════════════════════════════════════════════════ */

function hasMatchingInvoice(deal: DealInput, invoices: InvoiceInput[]): boolean {
  return invoices.some((inv) => {
    // Match by metadata (system-created invoices)
    if (inv.metadata?.dealId === deal.id) return true;
    if (inv.metadata?.source === "integrale_recovery" && inv.metadata?.dealId === deal.id) return true;

    // Match by customer + amount within tolerance
    if (inv.customerId !== deal.customerId) return false;
    const amountDiff = Math.abs(inv.amount - deal.amount) / deal.amount;
    return amountDiff <= AMOUNT_TOLERANCE;
  });
}

/* ═══════════════════════════════════════════════════════════════════
 * detect()
 *
 * Returns all Closed Won deals with no matching Stripe invoice.
 * Pure function — no side effects, no mutations.
 * ═══════════════════════════════════════════════════════════════════ */

function detect(deals: DealInput[], invoices: InvoiceInput[]): RecoveryOpportunity[] {
  const opportunities: RecoveryOpportunity[] = [];

  const closedWon = deals.filter(
    (d) => d.stage === "closed_won" && d.amount > 0 && d.customerEmail,
  );

  for (const deal of closedWon) {
    // Skip if already matched to an invoice
    if (hasMatchingInvoice(deal, invoices)) continue;

    // Skip if already successfully recovered
    if (store.isDealHandled(deal.id)) continue;

    const age = daysSince(deal.closeDate);

    opportunities.push({
      id: `recovery-mi-${deal.id}`,
      playbook: PLAYBOOK_TYPE,
      dealId: deal.id,
      customerId: deal.customerId,
      customerEmail: deal.customerEmail,
      company: deal.company,
      dealName: deal.name,
      amount: deal.amount,
      currency: deal.currency,
      closeDate: deal.closeDate,
      description: `Missing invoice detected between CRM and billing — "${deal.name}" closed ${age} day${age !== 1 ? "s" : ""} ago with no Stripe invoice`,
      confidence: "high",
      creditsRequired: calcCreditsRequired(deal.amount),
    });
  }

  // Sort by amount descending (highest value first)
  opportunities.sort((a, b) => b.amount - a.amount);
  return opportunities;
}

/* ═══════════════════════════════════════════════════════════════════
 * validate()
 *
 * Returns true only if the opportunity is safe to recover.
 * Checks: amount > 0, valid email, not test/internal, ≥24h old,
 * not previously handled.
 * ═══════════════════════════════════════════════════════════════════ */

function validate(opportunity: RecoveryOpportunity): ValidationResult {
  const reasons: string[] = [];

  // Amount must be positive
  if (opportunity.amount <= 0) {
    reasons.push("Deal amount must be greater than zero");
  }

  // Valid email
  if (!EMAIL_REGEX.test(opportunity.customerEmail)) {
    reasons.push(`Invalid customer email: ${opportunity.customerEmail}`);
  }

  // Not test/internal
  const dealText = `${opportunity.dealName} ${opportunity.company}`.toLowerCase();
  for (const pattern of EXCLUDED_PATTERNS) {
    if (pattern.test(dealText)) {
      reasons.push(`Deal appears to be test/internal (matched: ${pattern.source})`);
      break;
    }
  }

  // At least 24 hours old
  if (hoursSince(opportunity.closeDate) < MIN_AGE_HOURS) {
    reasons.push(`Deal closed less than 24 hours ago (${Math.round(hoursSince(opportunity.closeDate))}h)`);
  }

  // Not already handled
  if (store.isDealHandled(opportunity.dealId)) {
    reasons.push("This deal has already been successfully recovered");
  }

  // Not currently being processed
  if (store.hasActiveAction(opportunity.id)) {
    reasons.push("A recovery action is already in progress for this opportunity");
  }

  return {
    valid: reasons.length === 0,
    reasons,
  };
}

/* ═══════════════════════════════════════════════════════════════════
 * estimate()
 *
 * Returns amount, confidence, and credit cost.
 * ═══════════════════════════════════════════════════════════════════ */

function estimate(opportunity: RecoveryOpportunity): EstimationResult {
  return {
    amount: opportunity.amount,
    confidence: "high",
    creditsRequired: calcCreditsRequired(opportunity.amount),
  };
}

/* ═══════════════════════════════════════════════════════════════════
 * preview() — DRY RUN
 *
 * Returns a structured action plan. Executes NOTHING.
 * ═══════════════════════════════════════════════════════════════════ */

function preview(opportunity: RecoveryOpportunity): PreviewResult {
  const warnings: string[] = [];
  const validation = validate(opportunity);
  if (!validation.valid) {
    warnings.push(...validation.reasons);
  }

  return {
    opportunityId: opportunity.id,
    actions: [
      `Create Stripe invoice for ${fmtEur(opportunity.amount)}`,
      `Attach invoice to customer (${opportunity.customerEmail})`,
      `Set invoice metadata: dealId=${opportunity.dealId}, source=integrale_recovery`,
      `Mark CRM deal "${opportunity.dealName}" as invoiced`,
      `Log recovery action for audit trail`,
    ],
    riskLevel: "low",
    estimatedAmount: opportunity.amount,
    warnings,
  };
}

/* ═══════════════════════════════════════════════════════════════════
 * execute() — SAFE EXECUTION
 *
 * Creates a Stripe invoice and updates CRM. Production-safe:
 *   - Idempotency check (no duplicate invoices)
 *   - Atomic action record (pending → success/failed)
 *   - Simulated Stripe/HubSpot calls (swap for real SDK)
 *
 * ⚠️  All execution goes through safeExecute wrapper below.
 * ═══════════════════════════════════════════════════════════════════ */

async function execute(opportunity: RecoveryOpportunity): Promise<ExecutionResult> {
  return safeExecute(opportunity);
}

async function safeExecute(opportunity: RecoveryOpportunity): Promise<ExecutionResult> {
  const executedActions: string[] = [];
  const now = new Date().toISOString();

  // ── Step 0: Idempotency check ─────────────────────────────────
  if (store.isDealHandled(opportunity.dealId)) {
    return {
      opportunityId: opportunity.id,
      success: false,
      error: "Deal already recovered — invoice exists",
      executedAt: now,
      actions: ["Idempotency check: deal already handled — no action taken"],
    };
  }

  // ── Step 0b: Validation ───────────────────────────────────────
  const validation = validate(opportunity);
  if (!validation.valid) {
    return {
      opportunityId: opportunity.id,
      success: false,
      error: `Validation failed: ${validation.reasons.join("; ")}`,
      executedAt: now,
      actions: [`Validation failed: ${validation.reasons.join("; ")}`],
    };
  }

  // ── Step 1: Create action record (pending) ────────────────────
  const action = store.createAction({
    playbookType: PLAYBOOK_TYPE,
    dealId: opportunity.dealId,
    opportunityId: opportunity.id,
    metadata: {
      company: opportunity.company,
      amount: opportunity.amount,
      customerEmail: opportunity.customerEmail,
    },
  });

  try {
    // ── Step 2: Ensure Stripe customer exists ───────────────────
    const customerId = await ensureStripeCustomer(opportunity);
    executedActions.push(`Verified Stripe customer: ${customerId}`);

    // ── Step 3: Create Stripe invoice ───────────────────────────
    const invoiceId = await createStripeInvoice({
      customerId,
      amount: opportunity.amount,
      currency: opportunity.currency,
      dealId: opportunity.dealId,
    });
    executedActions.push(`Created Stripe invoice: ${invoiceId} for ${fmtEur(opportunity.amount)}`);

    // ── Step 4: Update CRM deal ─────────────────────────────────
    await updateHubSpotDeal(opportunity.dealId, {
      invoiced: true,
      invoiceId,
      invoiceCreatedAt: now,
    });
    executedActions.push(`Updated CRM deal ${opportunity.dealId}: invoiced=true`);

    // ── Step 5: Mark action as success ──────────────────────────
    store.updateAction(action.id, {
      status: "success",
      metadata: { invoiceId, completedActions: executedActions },
    });
    executedActions.push(`Logged recovery action: ${action.id}`);

    return {
      opportunityId: opportunity.id,
      success: true,
      invoiceId,
      executedAt: now,
      actions: executedActions,
    };
  } catch (err) {
    // ── Failure: mark action as failed, log error ───────────────
    const errorMsg = err instanceof Error ? err.message : String(err);
    store.updateAction(action.id, {
      status: "failed",
      metadata: { error: errorMsg, completedActions: executedActions },
    });

    return {
      opportunityId: opportunity.id,
      success: false,
      error: errorMsg,
      executedAt: now,
      actions: [...executedActions, `FAILED: ${errorMsg}`],
    };
  }
}

/* ═══════════════════════════════════════════════════════════════════
 * SIMULATED EXTERNAL CALLS
 *
 * These simulate Stripe and HubSpot API calls.
 * In production, replace with real SDK calls:
 *   - stripe.customers.create() / stripe.invoices.create()
 *   - hubspot.crm.deals.basicApi.update()
 * ═══════════════════════════════════════════════════════════════════ */

let invoiceCounter = 1000;

async function ensureStripeCustomer(opportunity: RecoveryOpportunity): Promise<string> {
  // Simulate: check if customer exists, create if not
  await new Promise((r) => setTimeout(r, 150));
  // In production: stripe.customers.list({ email }) or stripe.customers.create()
  return opportunity.customerId || `cus_${opportunity.customerEmail.replace(/[^a-z0-9]/gi, "")}`;
}

async function createStripeInvoice(params: {
  customerId: string;
  amount: number;
  currency: string;
  dealId: string;
}): Promise<string> {
  // Simulate Stripe invoice creation
  await new Promise((r) => setTimeout(r, 300));

  const invoiceId = `inv_integrale_${++invoiceCounter}`;

  // In production:
  // const invoice = await stripe.invoices.create({
  //   customer: params.customerId,
  //   collection_method: "send_invoice",
  //   days_until_due: 30,
  //   metadata: {
  //     dealId: params.dealId,
  //     source: "integrale_recovery",
  //   },
  // });
  // await stripe.invoiceItems.create({
  //   customer: params.customerId,
  //   invoice: invoice.id,
  //   amount: params.amount * 100, // cents
  //   currency: params.currency.toLowerCase(),
  // });
  // await stripe.invoices.finalizeInvoice(invoice.id);

  console.log(
    `[Recovery] Created invoice ${invoiceId}: ${params.amount} ${params.currency} for customer ${params.customerId} (deal: ${params.dealId})`,
  );

  return invoiceId;
}

async function updateHubSpotDeal(
  dealId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  // Simulate HubSpot deal update
  await new Promise((r) => setTimeout(r, 150));

  // In production:
  // await hubspotClient.crm.deals.basicApi.update(dealId, {
  //   properties: {
  //     invoiced: "true",
  //     invoice_id: properties.invoiceId,
  //     invoice_created_at: properties.invoiceCreatedAt,
  //   },
  // });

  console.log(
    `[Recovery] Updated HubSpot deal ${dealId}:`,
    JSON.stringify(properties),
  );
}

/* ═══════════════════════════════════════════════════════════════════
 * EXPORT — Playbook interface
 * ═══════════════════════════════════════════════════════════════════ */

export const MissingInvoicePlaybook: Playbook = {
  type: PLAYBOOK_TYPE,
  detect,
  validate,
  estimate,
  preview,
  execute,
};

// Named exports for direct use
export { detect, validate, estimate, preview, execute };
