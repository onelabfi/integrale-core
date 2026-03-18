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
import * as store from "./storage/recoveryStore.js";
import type {
  RecoveryOpportunity,
  PreviewResult,
  ExecutionResult,
  DealInput,
  InvoiceInput,
  Playbook,
} from "./types.js";
import type { Deal, Invoice } from "../../engine/types.js";

/* ── Data normalizers — convert connector output to playbook input ── */

function normalizeDeal(deal: Deal, customers: Map<string, string>): DealInput {
  return {
    id: deal.id,
    customerId: deal.customer_id,
    customerEmail: customers.get(deal.customer_id) ?? "",
    company: deal.company,
    name: deal.name,
    amount: deal.amount,
    currency: deal.currency,
    stage: deal.stage,
    closeDate: deal.close_date,
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

/* ═══════════════════════════════════════════════════════════════════
 * RECOVERY ENGINE
 * ═══════════════════════════════════════════════════════════════════ */

export class RecoveryEngine {
  private playbooks: Playbook[] = [MissingInvoicePlaybook];
  private opportunities: RecoveryOpportunity[] = [];
  private customerEmails = new Map<string, string>();

  /** Register customer emails for normalization */
  setCustomerEmails(map: Map<string, string>): void {
    this.customerEmails = map;
  }

  /**
   * scan() — Run all playbook detectors against current data.
   *
   * Accepts raw connector output (Deal[], Invoice[]) and normalizes
   * internally. Returns all detected recovery opportunities.
   */
  scan(rawDeals: Deal[], rawInvoices: Invoice[]): RecoveryOpportunity[] {
    const deals = rawDeals.map((d) => normalizeDeal(d, this.customerEmails));
    const invoices = rawInvoices.map((i) => normalizeInvoice(i, this.customerEmails));

    this.opportunities = [];

    for (const playbook of this.playbooks) {
      const detected = playbook.detect(deals, invoices);
      this.opportunities.push(...detected);
    }

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
   * Returns planned actions without executing anything.
   */
  preview(opportunityId: string): PreviewResult | null {
    const opportunity = this.getOpportunity(opportunityId);
    if (!opportunity) return null;

    const playbook = this.playbooks.find((p) => p.type === opportunity.playbook);
    if (!playbook) return null;

    return playbook.preview(opportunity);
  }

  /**
   * execute() — Run recovery for a specific opportunity.
   * Goes through safeExecute wrapper. Idempotent.
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

  /** Get recovery action history */
  getHistory() {
    return store.getAllActions();
  }
}

/* ── Re-exports ────────────────────────────────────────────────────── */
export type {
  RecoveryOpportunity,
  PreviewResult,
  ExecutionResult,
  DealInput,
  InvoiceInput,
} from "./types.js";

export { MissingInvoicePlaybook } from "./playbooks/missing-invoice.js";
export * as recoveryStore from "./storage/recoveryStore.js";
