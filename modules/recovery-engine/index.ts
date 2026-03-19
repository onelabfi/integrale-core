/**
 * Recovery Engine — Entry Point
 *
 * Orchestrates playbook-based recovery:
 *   1. Normalizes data from connectors
 *   2. Runs playbook detection
 *   3. Provides scan / preview / execute API
 *
 * Usage:
 *   import { RecoveryEngine } from "./modules/recovery-engine/index.js";
 *   const engine = new RecoveryEngine();
 *   const opportunities = engine.scan(deals, invoices);
 *   const preview = engine.preview(opportunityId);
 *   const result = await engine.execute(opportunityId);
 */
import { MissingInvoicePlaybook } from "./playbooks/missing-invoice.js";
import { NoBillingRecordPlaybook } from "./playbooks/no-billing-record.js";
import { MissedRenewalPlaybook } from "./playbooks/missed-renewal.js";
import * as store from "./storage/recoveryStore.js";
import {
  runAutoRecovery,
  DEFAULT_AUTO_RECOVERY_CONFIG,
} from "./autoRecovery.js";
import type {
  AutoRecoveryConfig,
  AutoRecoveryResult,
} from "./autoRecovery.js";
import type {
  RecoveryOpportunity,
  PreviewResult,
  ExecutionResult,
  DealInput,
  InvoiceInput,
  SubscriptionInput,
  Playbook,
  SafetyEnvelope,
  ValidationResult,
} from "./types.js";
import type { Deal, Invoice, Subscription } from "../../engine/types.js";

/* ── Data normalizers — convert connector output to playbook input ── */

function normalizeDeal(deal: Deal, customers: Map<string, string>): DealInput {
  // Use contact_email from live HubSpot data, fall back to customer map (mock), then derive from company/deal name
  const deriveEmail = (name: string) => `billing@${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}.com`;
  const email = deal.contact_email
    || customers.get(deal.customer_id)
    || (deal.company !== "Unknown Company" ? deriveEmail(deal.company) : deriveEmail(deal.name));

  return {
    id: deal.id,
    customerId: deal.customer_id,
    customerEmail: email,
    company: deal.company,
    name: deal.name,
    amount: deal.amount,
    currency: deal.currency,
    stage: deal.stage,
    closeDate: deal.close_date,
    source: deal.source,
  };
}

function normalizeInvoice(invoice: Invoice, customers: Map<string, string>): InvoiceInput {
  return {
    id: invoice.id,
    customerId: invoice.customer_id,
    customerEmail: customers.get(invoice.customer_id) ?? "",
    amount: invoice.amount,
    currency: invoice.currency,
    status: invoice.status,
    createdAt: invoice.created_at,
    metadata: {},
  };
}

function normalizeSubscription(sub: Subscription, customers: Map<string, string>): SubscriptionInput {
  return {
    id: sub.id,
    customerId: sub.customer_id,
    customerEmail: customers.get(sub.customer_id) ?? "",
    company: sub.company,
    plan: sub.plan,
    amount: sub.amount,
    currency: sub.currency,
    status: sub.status,
    currentPeriodEnd: sub.current_period_end,
    canceledAt: sub.canceled_at,
  };
}

/* ═══════════════════════════════════════════════════════════════════
 * RECOVERY ENGINE
 * ═══════════════════════════════════════════════════════════════════ */

export class RecoveryEngine {
  private playbooks: Playbook[] = [
    MissingInvoicePlaybook,
    NoBillingRecordPlaybook,
    MissedRenewalPlaybook,
  ];
  private opportunities: RecoveryOpportunity[] = [];
  private customerEmails = new Map<string, string>();

  /** Register customer emails for normalization */
  setCustomerEmails(map: Map<string, string>): void {
    this.customerEmails = map;
  }

  /**
   * scan() — Run all playbook detectors against current data.
   *
   * Accepts raw connector output (Deal[], Invoice[], Subscription[])
   * and normalizes internally. Returns all detected recovery opportunities.
   */
  scan(rawDeals: Deal[], rawInvoices: Invoice[], rawSubscriptions?: Subscription[]): RecoveryOpportunity[] {
    const deals = rawDeals.map((d) => normalizeDeal(d, this.customerEmails));
    const invoices = rawInvoices.map((i) => normalizeInvoice(i, this.customerEmails));
    const subscriptions = (rawSubscriptions ?? []).map((s) => normalizeSubscription(s, this.customerEmails));

    this.opportunities = [];

    for (const playbook of this.playbooks) {
      const detected = playbook.detect(deals, invoices, subscriptions);
      this.opportunities.push(...detected);
    }

    // Filter out deals that have already been successfully recovered
    this.opportunities = this.opportunities.filter(
      (opp) => !store.isDealHandled(opp.dealId),
    );

    // Sort by amount descending
    this.opportunities.sort((a, b) => b.amount - a.amount);
    return this.opportunities;
  }

  /** Get all current opportunities */
  getOpportunities(): RecoveryOpportunity[] {
    return [...this.opportunities];
  }

  /** Get a single opportunity by ID */
  getOpportunity(id: string): RecoveryOpportunity | null {
    return this.opportunities.find((o) => o.id === id) ?? null;
  }

  /**
   * preview() — Dry-run for a specific opportunity.
   *
   * Returns planned actions without executing anything.
   * Also issues a preview token that is required for execute().
   */
  preview(opportunityId: string): PreviewResult | null {
    const opportunity = this.getOpportunity(opportunityId);
    if (!opportunity) return null;

    const playbook = this.playbooks.find((p) => p.type === opportunity.playbook);
    if (!playbook) return null;

    const result = playbook.preview(opportunity);

    // Issue preview token with state hash — required before execute()
    const stateHash = store.computeStateHash(opportunity);
    store.issuePreviewToken(opportunityId, result, stateHash);

    return result;
  }

  /**
   * execute() — Run recovery for a specific opportunity.
   *
   * Safety gates (enforced by safeExecute):
   *   1. Rate limiting
   *   2. Idempotency (deal already recovered)
   *   3. Preview enforcement (must preview first)
   *   4. Execution lock (no parallel execution)
   *   5. Validation
   *   6. Stripe duplicate check
   *   7. Atomic action record
   */
  async execute(opportunityId: string): Promise<ExecutionResult | null> {
    const opportunity = this.getOpportunity(opportunityId);
    if (!opportunity) return null;

    const playbook = this.playbooks.find((p) => p.type === opportunity.playbook);
    if (!playbook) return null;

    const result = await playbook.execute(opportunity);

    // If successful, remove from active opportunities
    if (result.success) {
      this.opportunities = this.opportunities.filter((o) => o.id !== opportunityId);
    }

    return result;
  }

  /**
   * getSafetyStatus() — Returns safety signals for a specific opportunity.
   * Used by the API to expose safety state to the UI.
   */
  getSafetyStatus(opportunityId: string): SafetyEnvelope["safety"] {
    const opportunity = this.getOpportunity(opportunityId);
    if (!opportunity) {
      return {
        idempotent: true,
        previewRequired: true,
        previewed: false,
        locked: false,
      };
    }

    const playbook = this.playbooks.find((p) => p.type === opportunity.playbook);
    const validation = playbook ? playbook.validate(opportunity) : { valid: false, reasons: ["Unknown playbook"] };

    return {
      idempotent: true,
      previewRequired: true,
      previewed: store.hasValidPreview(opportunityId),
      locked: store.isLocked(opportunity.dealId),
      validation,
      riskLevel: "low",
    };
  }

  /**
   * getRetryableActions() — Returns failed actions that can be retried.
   */
  getRetryableActions() {
    return store.getRetryableActions();
  }

  /** Get recovery action history */
  getHistory() {
    return store.getAllActions();
  }

  /**
   * runAutoRecovery() — Automatically recover eligible opportunities.
   *
   * Processes opportunities that meet strict safety criteria:
   *   - Confidence within allowed levels
   *   - Risk within allowed levels
   *   - Amount within per-action and per-day limits
   *   - Sufficient credits available
   *
   * Uses full preview → execute pipeline with all safety gates.
   */
  async runAutoRecovery(
    config: AutoRecoveryConfig,
    availableCredits: number,
  ): Promise<AutoRecoveryResult> {
    const executor = {
      preview: (id: string) => this.preview(id),
      execute: (id: string) => this.execute(id),
    };

    return runAutoRecovery(
      this.getOpportunities(),
      config,
      availableCredits,
      executor,
    );
  }
}

/* ── Re-exports ────────────────────────────────────────────────────── */
export type {
  RecoveryOpportunity,
  PreviewResult,
  ExecutionResult,
  DealInput,
  InvoiceInput,
  SubscriptionInput,
  SafetyEnvelope,
} from "./types.js";

export { MissingInvoicePlaybook } from "./playbooks/missing-invoice.js";
export { NoBillingRecordPlaybook } from "./playbooks/no-billing-record.js";
export { MissedRenewalPlaybook } from "./playbooks/missed-renewal.js";
export * as recoveryStore from "./storage/recoveryStore.js";
export { runAutoRecovery, DEFAULT_AUTO_RECOVERY_CONFIG } from "./autoRecovery.js";
export type { AutoRecoveryConfig, AutoRecoveryResult } from "./autoRecovery.js";
