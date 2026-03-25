/**
 * Missed Renewal Playbook
 *
 * Detects customers with canceled/expired subscriptions who are
 * still active in the CRM. These are missed renewals — the customer
 * is still engaged but their subscription lapsed.
 *
 * Detection logic:
 *   - Subscription status is "canceled" or "past_due"
 *   - Customer has an active deal in CRM (lifecycle = active)
 *   - No replacement subscription exists
 *
 * Production-safe: idempotent, no duplicate subscriptions, fail-safe.
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
  SubscriptionInput,
} from "../types.js";
import * as store from "../storage/recoveryStore.js";

const PLAYBOOK_TYPE: PlaybookType = "missed_renewal";

/* ── Constants ─────────────────────────────────────────────────────── */

/** Minimum days since cancellation before flagging (to avoid false positives) */
const MIN_CANCELED_DAYS = 3;

/** Maximum days since cancellation (too old = probably intentional) */
const MAX_CANCELED_DAYS = 180;

/** Patterns that indicate test/internal (case-insensitive) */
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

function daysSince(isoDate: string): number {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24));
}

/* ── Credit cost calculation ───────────────────────────────────────── */

function calcCreditsRequired(_amount: number): number {
  return 10; // Fixed: 1 token = €1, fix single issue = 10 tokens
}

/* ═══════════════════════════════════════════════════════════════════
 * ACTIVE CUSTOMER CHECK
 *
 * Determines if a customer is still "active" in the CRM by checking
 * if they have a closed_won deal. This serves as a proxy for
 * lifecycle stage when usage data isn't available.
 * ═══════════════════════════════════════════════════════════════════ */

function isCustomerActiveInCRM(customerId: string, deals: DealInput[]): boolean {
  return deals.some(
    (d) => d.customerId === customerId && d.stage === "closed_won",
  );
}

/* ═══════════════════════════════════════════════════════════════════
 * DUPLICATE SUBSCRIPTION CHECK
 *
 * Returns true if the customer already has an active subscription,
 * preventing double-subscribing.
 * ═══════════════════════════════════════════════════════════════════ */

function hasActiveSubscription(customerId: string, subscriptions: SubscriptionInput[]): boolean {
  return subscriptions.some(
    (s) => s.customerId === customerId && s.status === "active",
  );
}

/* ═══════════════════════════════════════════════════════════════════
 * detect()
 *
 * Returns canceled/expired subscriptions where:
 *   - Customer is still active in CRM
 *   - No replacement subscription exists
 *   - Not already recovered
 *
 * Pure function — no side effects.
 * ═══════════════════════════════════════════════════════════════════ */

function detect(deals: DealInput[], invoices: InvoiceInput[], subscriptions?: SubscriptionInput[]): RecoveryOpportunity[] {
  if (!subscriptions || subscriptions.length === 0) return [];

  const opportunities: RecoveryOpportunity[] = [];

  // Find lapsed subscriptions (canceled or past_due)
  const lapsedSubs = subscriptions.filter(
    (s) => (s.status === "canceled" || s.status === "past_due") && s.amount > 0 && s.customerEmail,
  );

  for (const sub of lapsedSubs) {
    // Skip if customer already has an active subscription (replaced)
    if (hasActiveSubscription(sub.customerId, subscriptions)) continue;

    // Skip if customer is NOT active in CRM (intentional churn)
    if (!isCustomerActiveInCRM(sub.customerId, deals)) continue;

    // Skip if already recovered
    const opportunityDealId = `sub-${sub.id}`;
    if (store.isDealHandled(opportunityDealId)) continue;

    // Check cancellation age
    const cancelDate = sub.canceledAt ?? sub.currentPeriodEnd;
    const age = daysSince(cancelDate);

    if (age < MIN_CANCELED_DAYS) continue; // Too recent
    if (age > MAX_CANCELED_DAYS) continue; // Too old

    opportunities.push({
      id: `recovery-mr-${sub.id}`,
      playbook: PLAYBOOK_TYPE,
      dealId: opportunityDealId, // Use sub ID as deal ID for idempotency
      customerId: sub.customerId,
      customerEmail: sub.customerEmail,
      company: sub.company,
      dealName: sub.plan,
      amount: sub.amount,
      currency: sub.currency,
      closeDate: cancelDate,
      description: `Revenue continuity gap — "${sub.plan}" (${sub.company}) billing cycle lapsed ${age} day${age !== 1 ? "s" : ""} ago, account still active`,
      confidence: "medium",
      creditsRequired: calcCreditsRequired(sub.amount),
      source: "stripe",
      subscriptionId: sub.id,
      planName: sub.plan,
    });
  }

  // Sort by amount descending
  opportunities.sort((a, b) => b.amount - a.amount);
  return opportunities;
}

/* ═══════════════════════════════════════════════════════════════════
 * validate()
 * ═══════════════════════════════════════════════════════════════════ */

function validate(opportunity: RecoveryOpportunity): ValidationResult {
  const reasons: string[] = [];

  if (opportunity.amount <= 0) {
    reasons.push("Subscription amount must be greater than zero");
  }

  if (!EMAIL_REGEX.test(opportunity.customerEmail)) {
    reasons.push(`Invalid customer email: ${opportunity.customerEmail}`);
  }

  const text = `${opportunity.dealName} ${opportunity.company}`.toLowerCase();
  for (const pattern of EXCLUDED_PATTERNS) {
    if (pattern.test(text)) {
      reasons.push(`Subscription appears to be test/internal (matched: ${pattern.source})`);
      break;
    }
  }

  if (store.isDealHandled(opportunity.dealId)) {
    reasons.push("This subscription has already been renewed");
  }

  if (store.hasActiveAction(opportunity.id)) {
    reasons.push("A renewal action is already in progress for this subscription");
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
    confidence: "medium",
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
      `Missed renewal will be recovered and billing restored`,
      `All systems will be brought into alignment`,
    ],
    technicalDetails: [],
    riskLevel: "medium",
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
      error: "Subscription already renewed — no action needed",
      errorType: "already_handled",
      executedAt: now,
      actions: ["Idempotency check: subscription already handled — no action taken"],
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

    // ── Gate 6: Check for active subscriptions (prevent double-subscribe)
    const activeSubs = await checkActiveSubscriptions(opportunity.customerId);
    if (activeSubs.exists) {
      return {
        opportunityId: opportunity.id,
        success: false,
        error: `Customer already has active subscription: ${activeSubs.subscriptionId}`,
        errorType: "duplicate_detected",
        executedAt: now,
        actions: [`Active subscription found: ${activeSubs.subscriptionId} — no action taken`],
      };
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
        subscriptionId: opportunity.subscriptionId,
        planName: opportunity.planName,
        previewedAt: "yes",
        stateHash: currentHash,
      },
    });

    let subscriptionsCreated = 0;

    try {
      // ── Step 2: Retrieve previous subscription plan
      const previousPlan = await getPreviousSubscription(opportunity.subscriptionId!);
      executedActions.push(`Retrieved previous subscription plan: ${previousPlan.plan}`);

      // ── Step 3: Create new subscription
      const newSubId = await createSubscription({
        customerId: opportunity.customerId,
        plan: previousPlan.plan,
        amount: opportunity.amount,
        currency: opportunity.currency,
        previousSubscriptionId: opportunity.subscriptionId!,
      });
      executedActions.push(`Created new subscription: ${newSubId} (${opportunity.planName} at ${fmtEur(opportunity.amount)})`);
      subscriptionsCreated++;

      // ── Step 4: Update CRM
      await updateCRMRenewal(opportunity.customerId, {
        renewed: true,
        newSubscriptionId: newSubId,
        renewedAt: now,
        planName: opportunity.planName,
      });
      executedActions.push(`Updated CRM: renewal recorded for ${opportunity.company}`);

      // ── Step 5: Mark success + consume preview
      store.updateAction(action.id, {
        status: "success",
        metadata: { newSubscriptionId: newSubId, completedActions: executedActions },
      });
      store.consumePreviewToken(opportunity.id);
      executedActions.push(`Logged recovery action: ${action.id}`);

      return {
        opportunityId: opportunity.id,
        success: true,
        invoiceId: newSubId, // Reuse field for subscription ID
        executedAt: now,
        actions: executedActions,
        summary: {
          invoicesCreated: 0,
          subscriptionsCreated,
          dealsUpdated: 1,
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
 * In production, replace with real Stripe SDK calls.
 * ═══════════════════════════════════════════════════════════════════ */

let subscriptionCounter = 500;

async function checkActiveSubscriptions(customerId: string): Promise<{ exists: boolean; subscriptionId?: string }> {
  await new Promise((r) => setTimeout(r, 50));
  // In production: stripe.subscriptions.list({ customer: customerId, status: "active", limit: 1 })
  return { exists: false };
}

async function getPreviousSubscription(subscriptionId: string): Promise<{ plan: string; priceId: string }> {
  await new Promise((r) => setTimeout(r, 100));
  // In production: stripe.subscriptions.retrieve(subscriptionId)
  return { plan: subscriptionId, priceId: `price_${subscriptionId}` };
}

async function createSubscription(params: {
  customerId: string;
  plan: string;
  amount: number;
  currency: string;
  previousSubscriptionId: string;
}): Promise<string> {
  await new Promise((r) => setTimeout(r, 300));
  const subId = `sub_integrale_${++subscriptionCounter}`;

  // In production:
  // const subscription = await stripe.subscriptions.create({
  //   customer: params.customerId,
  //   items: [{ price: params.priceId }],
  //   metadata: {
  //     source: "integrale_recovery",
  //     previousSubscriptionId: params.previousSubscriptionId,
  //   },
  // });

  console.log(
    `[Recovery:MR] Created subscription ${subId}: ${params.plan} at ${params.amount} ${params.currency} for customer ${params.customerId}`,
  );
  return subId;
}

async function updateCRMRenewal(
  customerId: string,
  properties: Record<string, unknown>,
): Promise<void> {
  await new Promise((r) => setTimeout(r, 150));
  console.log(
    `[Recovery:MR] Updated CRM for customer ${customerId}:`,
    JSON.stringify(properties),
  );
}

/* ═══════════════════════════════════════════════════════════════════
 * EXPORT — Playbook interface
 * ═══════════════════════════════════════════════════════════════════ */

export const MissedRenewalPlaybook: Playbook = {
  type: PLAYBOOK_TYPE,
  detect,
  validate,
  estimate,
  preview,
  execute,
};

export { detect, validate, estimate, preview, execute };
