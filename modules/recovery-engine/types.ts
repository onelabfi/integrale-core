/**
 * Recovery Engine — Domain Types
 *
 * Shared types for the playbook-based recovery system.
 * Every playbook implements the same interface for consistent behavior.
 */

/* ── Recovery opportunity (output of detect()) ─────────────────────── */
export interface RecoveryOpportunity {
  id: string;
  playbook: PlaybookType;
  dealId: string;
  customerId: string;
  customerEmail: string;
  company: string;
  dealName: string;
  amount: number;
  currency: string;
  closeDate: string;
  description: string;
  confidence: "high" | "medium" | "low";
  creditsRequired: number;
}

/* ── Validation result ─────────────────────────────────────────────── */
export interface ValidationResult {
  valid: boolean;
  reasons: string[];
}

/* ── Estimation result ─────────────────────────────────────────────── */
export interface EstimationResult {
  amount: number;
  confidence: "high" | "medium" | "low";
  creditsRequired: number;
}

/* ── Preview (dry run) result ──────────────────────────────────────── */
export interface PreviewResult {
  opportunityId: string;
  actions: string[];
  riskLevel: "low" | "medium" | "high";
  estimatedAmount: number;
  warnings: string[];
}

/* ── Execution result ──────────────────────────────────────────────── */
export interface ExecutionResult {
  opportunityId: string;
  success: boolean;
  invoiceId?: string;
  error?: string;
  executedAt: string;
  actions: string[];
}

/* ── Playbook types ────────────────────────────────────────────────── */
export type PlaybookType = "missing_invoice";

/* ── Playbook interface — every playbook must implement this ────────── */
export interface Playbook {
  type: PlaybookType;
  detect(deals: DealInput[], invoices: InvoiceInput[]): RecoveryOpportunity[];
  validate(opportunity: RecoveryOpportunity): ValidationResult;
  estimate(opportunity: RecoveryOpportunity): EstimationResult;
  preview(opportunity: RecoveryOpportunity): PreviewResult;
  execute(opportunity: RecoveryOpportunity): Promise<ExecutionResult>;
}

/* ── Input types (normalized from connectors) ──────────────────────── */
export interface DealInput {
  id: string;
  customerId: string;
  customerEmail: string;
  company: string;
  name: string;
  amount: number;
  currency: string;
  stage: string;
  closeDate: string;
  properties?: Record<string, string>;
}

export interface InvoiceInput {
  id: string;
  customerId: string;
  customerEmail: string;
  amount: number;
  currency: string;
  status: string;
  createdAt: string;
  metadata?: Record<string, string>;
}

/* ── Recovery action record (for storage) ──────────────────────────── */
export type RecoveryActionStatus = "pending" | "success" | "failed";

export interface RecoveryAction {
  id: string;
  playbookType: PlaybookType;
  dealId: string;
  opportunityId: string;
  status: RecoveryActionStatus;
  executedAt: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}
