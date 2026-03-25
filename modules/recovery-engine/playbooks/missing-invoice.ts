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

function calcCreditsRequired(_amount: number): number {
  return 10; // Fixed: 1 token = €1, fix single issue = 10 tokens
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
      description: `Revenue mismatch detected — "${deal.name}" closed ${age} day${age !== 1 ? "s" : ""} ago, not reflected across connected systems`,
      confidence: "high",
      creditsRequired: calcCreditsRequired(deal.amount),
      source: deal.source,
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

  // Age check: if close date is in the past, must be at least 24h old.
  // Future close dates are allowed (deal marked won with upcoming close date).
  const ageHours = hoursSince(opportunity.closeDate);
  if (ageHours >= 0 && ageHours < MIN_AGE_HOURS) {
    reasons.push(`Deal closed less than 24 hours ago (${Math.round(ageHours)}h)`);
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
      `Missing revenue will be recovered and invoiced`,
      `All systems will be brought into alignment`,
    ],
    technicalDetails: [],
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

/**
 * safeExecute() — Production-grade execution wrapper
 *
 * Safety guarantees enforced in order:
 *   1. Rate limiting (max concurrent + per-minute)
 *   2. Idempotency (deal already recovered → no-op)
 *   3. Preview enforcement (must preview before execute)
 *   4. Execution lock (no parallel execution on same deal)
 *   5. Validation (amount, email, age, exclusions)
 *   6. Stripe duplicate check (metadata.dealId)
 *   7. Atomic action record (pending → success | failed)
 *   8. Lock release (always, even on failure)
 */
async function safeExecute(opportunity: RecoveryOpportunity): Promise<ExecutionResult> {
  const executedActions: string[] = [];
  const now = new Date().toISOString();

  // ── Gate 1: Rate limiting ──────────────────────────────────────
  const rateCheck = store.checkRateLimit();
  if (!rateCheck.allowed) {
    return {
      opportunityId: opportunity.id,
      success: false,
      error: rateCheck.reason!,
      errorType: "rate_limited",
      executedAt: now,
      actions: [`Rate limit: ${rateCheck.reason}`],
    };
  }

  // ── Gate 2: Idempotency check ──────────────────────────────────
  if (store.isDealHandled(opportunity.dealId)) {
    const action = store.createAction({
      playbookType: PLAYBOOK_TYPE,
      dealId: opportunity.dealId,
      opportunityId: opportunity.id,
      metadata: { reason: "duplicate_attempt", skipped: true },
    });
    store.updateAction(action.id, { status: "already_handled" });
    return {
      opportunityId: opportunity.id,
      success: false,
      error: "Deal already recovered — invoice exists",
      errorType: "already_handled",
      executedAt: now,
      actions: ["Idempotency check: deal already handled — no action taken"],
    };
  }

  // ── Gate 3: Preview enforcement + state hash validation ────────
  const currentHash = store.computeStateHash(opportunity);
  const previewCheck = store.validatePreviewToken(opportunity.id, currentHash);
  if (!previewCheck.valid) {
    return {
      opportunityId: opportunity.id,
      success: false,
      error: previewCheck.reason!,
      errorType: "preview_invalid",
      executedAt: now,
      actions: [`Blocked: ${previewCheck.reason}`],
    };
  }

  // ── Gate 4: Execution lock (prevent parallel execution) ────────
  const lockResult = store.acquireLock(opportunity.dealId, opportunity.id);
  if (!lockResult.acquired) {
    return {
      opportunityId: opportunity.id,
      success: false,
      error: lockResult.reason!,
      errorType: "lock_denied",
      executedAt: now,
      actions: [`Lock denied: ${lockResult.reason}`],
    };
  }

  try {
    // ── Gate 5: Validation ─────────────────────────────────────────
    const validation = validate(opportunity);
    if (!validation.valid) {
      return {
        opportunityId: opportunity.id,
        success: false,
        error: `Validation failed: ${validation.reasons.join("; ")}`,
        errorType: "validation_failed",
        executedAt: now,
        actions: [`Validation failed: ${validation.reasons.join("; ")}`],
      };
    }

    // ── Gate 6: Stripe duplicate check ─────────────────────────────
    const duplicateCheck = await checkStripeDuplicate(opportunity.dealId);
    if (duplicateCheck.exists) {
      store.createAction({
        playbookType: PLAYBOOK_TYPE,
        dealId: opportunity.dealId,
        opportunityId: opportunity.id,
        metadata: { reason: "stripe_duplicate_detected", existingInvoiceId: duplicateCheck.invoiceId },
      });
      return {
        opportunityId: opportunity.id,
        success: false,
        error: `Stripe invoice already exists for this deal (${duplicateCheck.invoiceId})`,
        errorType: "duplicate_detected",
        executedAt: now,
        actions: [`Stripe duplicate detected: ${duplicateCheck.invoiceId} — no action taken`],
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
        previewedAt: "yes",
        stateHash: currentHash,
      },
    });

    // Track structured counts for summary
    let invoicesCreated = 0;
    let dealsUpdated = 0;

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
      invoicesCreated++;

      // ── Step 4: Update CRM deal ─────────────────────────────────
      await updateHubSpotDeal(opportunity.dealId, {
        invoiced: true,
        invoiceId,
        invoiceCreatedAt: now,
      });
      executedActions.push(`Updated CRM deal ${opportunity.dealId}: invoiced=true`);
      dealsUpdated++;

      // ── Step 5: Mark action as success + consume preview ────────
      store.updateAction(action.id, {
        status: "success",
        metadata: { invoiceId, completedActions: executedActions },
      });
      store.consumePreviewToken(opportunity.id);
      executedActions.push(`Logged recovery action: ${action.id}`);

      return {
        opportunityId: opportunity.id,
        success: true,
        invoiceId,
        executedAt: now,
        actions: executedActions,
        summary: {
          invoicesCreated,
          subscriptionsCreated: 0,
          dealsUpdated,
          actions: executedActions,
        },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      store.updateAction(action.id, {
        status: "failed",
        metadata: { error: errorMsg, completedActions: executedActions },
      });

      return {
        opportunityId: opportunity.id,
        success: false,
        error: errorMsg,
        errorType: "external_api_error",
        executedAt: now,
        actions: [...executedActions, `FAILED: ${errorMsg}`],
      };
    }
  } finally {
    store.releaseLock(opportunity.dealId);
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

/**
 * Check Stripe for existing invoices with matching dealId metadata.
 * Prevents creating duplicate invoices even if our store was reset.
 *
 * In production: stripe.invoices.list({ metadata: { dealId } })
 */
async function checkStripeDuplicate(dealId: string): Promise<{ exists: boolean; invoiceId?: string }> {
  // Simulate Stripe metadata lookup
  await new Promise((r) => setTimeout(r, 50));

  // In production:
  // const existing = await stripe.invoices.list({
  //   limit: 1,
  //   metadata: { dealId, source: "integrale_recovery" },
  // });
  // if (existing.data.length > 0) {
  //   return { exists: true, invoiceId: existing.data[0].id };
  // }

  // Simulated: check our local counter-based IDs (no duplicates in simulation)
  return { exists: false };
}

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
