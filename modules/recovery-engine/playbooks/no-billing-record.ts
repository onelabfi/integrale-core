/**
 * No Billing Record Playbook
 *
 * Detects CRM deals marked "Closed Won" where the customer has
 * NO Stripe presence at all — either no Stripe customer exists,
 * or the customer exists but has zero invoices.
 *
 * Different from missing-invoice: that playbook checks if a specific
 * deal has a matching invoice. This playbook checks if the customer
 * has ANY billing presence whatsoever.
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

const PLAYBOOK_TYPE: PlaybookType = "no_billing_record";

/* ── Constants ─────────────────────────────────────────────────────── */

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
 * BILLING PRESENCE CHECK
 *
 * Returns true if customer has ANY billing presence in Stripe:
 *   - At least one invoice (any status) for their customer ID
 * ═══════════════════════════════════════════════════════════════════ */

function customerHasBillingRecord(customerId: string, invoices: InvoiceInput[]): boolean {
  return invoices.some((inv) => inv.customerId === customerId);
}

/* ═══════════════════════════════════════════════════════════════════
 * detect()
 *
 * Returns Closed Won deals where the customer has NO billing record.
 * Pure function — no side effects, no mutations.
 * ═══════════════════════════════════════════════════════════════════ */

function detect(deals: DealInput[], invoices: InvoiceInput[]): RecoveryOpportunity[] {
  const opportunities: RecoveryOpportunity[] = [];

  const closedWon = deals.filter(
    (d) => d.stage === "closed_won" && d.amount > 0 && d.customerEmail,
  );

  for (const deal of closedWon) {
    // Skip if customer has ANY billing record
    if (customerHasBillingRecord(deal.customerId, invoices)) continue;

    // Skip if already successfully recovered
    if (store.isDealHandled(deal.id)) continue;

    const age = daysSince(deal.closeDate);

    opportunities.push({
      id: `recovery-nbr-${deal.id}`,
      playbook: PLAYBOOK_TYPE,
      dealId: deal.id,
      customerId: deal.customerId,
      customerEmail: deal.customerEmail,
      company: deal.company,
      dealName: deal.name,
      amount: deal.amount,
      currency: deal.currency,
      closeDate: deal.closeDate,
      description: `Revenue not recorded across systems — "${deal.name}" (${deal.company}) closed ${age} day${age !== 1 ? "s" : ""} ago, not reflected in billing`,
      confidence: "high",
      creditsRequired: calcCreditsRequired(deal.amount),
      source: deal.source,
    });
  }

  // Sort by amount descending
  opportunities.sort((a, b) => b.amount - a.amount);
  return opportunities;
}

/* ═══════════════════════════════════════════════════════════════════
 * validate()
 *
 * Returns true only if the opportunity is safe to recover.
 * ═══════════════════════════════════════════════════════════════════ */

function validate(opportunity: RecoveryOpportunity): ValidationResult {
  const reasons: string[] = [];

  if (opportunity.amount <= 0) {
    reasons.push("Deal amount must be greater than zero");
  }

  if (!EMAIL_REGEX.test(opportunity.customerEmail)) {
    reasons.push(`Invalid customer email: ${opportunity.customerEmail}`);
  }

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

  if (store.isDealHandled(opportunity.dealId)) {
    reasons.push("This deal has already been successfully recovered");
  }

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
 * ═══════════════════════════════════════════════════════════════════ */

async function execute(opportunity: RecoveryOpportunity): Promise<ExecutionResult> {
  return safeExecute(opportunity);
}

async function safeExecute(opportunity: RecoveryOpportunity): Promise<ExecutionResult> {
  const executedActions: string[] = [];
  const now = new Date().toISOString();

  // ── Gate 1: Rate limiting
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

  // ── Gate 2: Idempotency check
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
      error: "Deal already recovered — billing record exists",
      errorType: "already_handled",
      executedAt: now,
      actions: ["Idempotency check: deal already handled — no action taken"],
    };
  }

  // ── Gate 3: Preview enforcement + state hash validation
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

  // ── Gate 4: Execution lock
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
    // ── Gate 5: Validation
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

    // ── Gate 6: Re-check billing presence (may have changed since scan)
    const existingCustomer = await checkStripeCustomerExists(opportunity.customerEmail);
    if (existingCustomer.exists) {
      const hasInvoices = await checkCustomerHasInvoices(existingCustomer.customerId!);
      if (hasInvoices) {
        return {
          opportunityId: opportunity.id,
          success: false,
          error: "Customer now has billing records — no action needed",
          errorType: "duplicate_detected",
          executedAt: now,
          actions: ["Re-check: customer billing records found — no action taken"],
        };
      }
    }

    // ── Step 1: Create action record
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

    let invoicesCreated = 0;
    let dealsUpdated = 0;

    try {
      // ── Step 2: Create Stripe customer
      const customerId = await createStripeCustomer(opportunity);
      executedActions.push(`Created Stripe customer: ${customerId} (${opportunity.customerEmail})`);

      // ── Step 3: Create Stripe invoice
      const invoiceId = await createStripeInvoice({
        customerId,
        amount: opportunity.amount,
        currency: opportunity.currency,
        dealId: opportunity.dealId,
      });
      executedActions.push(`Created Stripe invoice: ${invoiceId} for ${fmtEur(opportunity.amount)}`);
      invoicesCreated++;

      // ── Step 4: Update CRM deal
      await updateHubSpotDeal(opportunity.dealId, {
        invoiced: true,
        invoiceId,
        invoiceCreatedAt: now,
        stripeCustomerId: customerId,
      });
      executedActions.push(`Updated CRM deal ${opportunity.dealId}: invoiced=true, stripeCustomerId=${customerId}`);
      dealsUpdated++;

      // ── Step 5: Mark success + consume preview
      store.updateAction(action.id, {
        status: "success",
        metadata: { invoiceId, customerId, completedActions: executedActions },
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
 * In production, replace with real Stripe/HubSpot SDK calls.
 * ═══════════════════════════════════════════════════════════════════ */

let invoiceCounter = 2000;
let customerCounter = 100;

async function checkStripeCustomerExists(email: string): Promise<{ exists: boolean; customerId?: string }> {
  await new Promise((r) => setTimeout(r, 50));
  // In production: stripe.customers.list({ email, limit: 1 })
  return { exists: false };
}

async function checkCustomerHasInvoices(customerId: string): Promise<boolean> {
  await new Promise((r) => setTimeout(r, 50));
  // In production: stripe.invoices.list({ customer: customerId, limit: 1 })
  return false;
}

async function createStripeCustomer(opportunity: RecoveryOpportunity): Promise<string> {
  await new Promise((r) => setTimeout(r, 200));
  const customerId = `cus_integrale_${++customerCounter}`;
  // In production:
  // const customer = await stripe.customers.create({
  //   email: opportunity.customerEmail,
  //   name: opportunity.company,
  //   metadata: { source: "integrale_recovery", dealId: opportunity.dealId },
  // });
  console.log(
    `[Recovery:NBR] Created Stripe customer ${customerId}: ${opportunity.customerEmail} (${opportunity.company})`,
  );
  return customerId;
}

async function createStripeInvoice(params: {
  customerId: string;
  amount: number;
  currency: string;
  dealId: string;
}): Promise<string> {
  await new Promise((r) => setTimeout(r, 300));
  const invoiceId = `inv_integrale_${++invoiceCounter}`;
  console.log(
    `[Recovery:NBR] Created invoice ${invoiceId}: ${params.amount} ${params.currency} for customer ${params.customerId} (deal: ${params.dealId})`,
  );
  return invoiceId;
}

async function updateHubSpotDeal(
  dealId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  await new Promise((r) => setTimeout(r, 150));
  console.log(
    `[Recovery:NBR] Updated HubSpot deal ${dealId}:`,
    JSON.stringify(properties),
  );
}

/* ═══════════════════════════════════════════════════════════════════
 * EXPORT — Playbook interface
 * ═══════════════════════════════════════════════════════════════════ */

export const NoBillingRecordPlaybook: Playbook = {
  type: PLAYBOOK_TYPE,
  detect,
  validate,
  estimate,
  preview,
  execute,
};

export { detect, validate, estimate, preview, execute };
