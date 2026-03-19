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
  /** Data source (hubspot, salesforce, stripe, etc.) */
  source?: string;
  /** Subscription ID (missed_renewal playbook) */
  subscriptionId?: string;
  /** Subscription plan name (missed_renewal playbook) */
  planName?: string;
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
  technicalDetails?: string[];
  riskLevel: "low" | "medium" | "high";
  estimatedAmount: number;
  warnings: string[];
}

/* ── Error classification ─────────────────────────────────────────── */
export type ErrorType =
  | "validation_failed"
  | "duplicate_detected"
  | "external_api_error"
  | "rate_limited"
  | "preview_invalid"
  | "lock_denied"
  | "already_handled";

/* ── Execution summary (returned on success) ──────────────────────── */
export interface ExecutionSummary {
  invoicesCreated: number;
  subscriptionsCreated: number;
  dealsUpdated: number;
  actions: string[];
}

/* ── Execution result ──────────────────────────────────────────────── */
export interface ExecutionResult {
  opportunityId: string;
  success: boolean;
  invoiceId?: string;
  error?: string;
  /** Classified error type for UI-specific handling */
  errorType?: ErrorType;
  executedAt: string;
  actions: string[];
  /** Structured summary (present on success) */
  summary?: ExecutionSummary;
}

/* ── Playbook types ────────────────────────────────────────────────── */
export type PlaybookType = "missing_invoice" | "no_billing_record" | "missed_renewal";

/* ── Playbook interface — every playbook must implement this ────────── */
export interface Playbook {
  type: PlaybookType;
  detect(deals: DealInput[], invoices: InvoiceInput[], subscriptions?: SubscriptionInput[]): RecoveryOpportunity[];
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
  source?: string;
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

export interface SubscriptionInput {
  id: string;
  customerId: string;
  customerEmail: string;
  company: string;
  plan: string;
  amount: number;
  currency: string;
  status: string;
  currentPeriodEnd: string;
  canceledAt: string | null;
}

/* ── Recovery action record (for storage) ──────────────────────────── */
export type RecoveryActionStatus = "pending" | "success" | "failed" | "already_handled";

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

/* ── Preview token (dry-run enforcement) ──────────────────────────── */
export interface PreviewToken {
  opportunityId: string;
  previewedAt: string;
  expiresAt: string;
  previewResult: PreviewResult;
  /** Hash of opportunity state at preview time — prevents stale execution */
  stateHash: string;
}

/* ── Execution lock (prevents parallel execution on same deal) ───── */
export interface ExecutionLock {
  dealId: string;
  opportunityId: string;
  lockedAt: string;
  expiresAt: string;
}

/* ── Standardized API response ────────────────────────────────────── */
export interface SafetyEnvelope<T = unknown> {
  status: "ok" | "error" | "blocked";
  data?: T;
  error?: string;
  safety: {
    idempotent: boolean;
    previewRequired: boolean;
    previewed: boolean;
    locked: boolean;
    validation?: ValidationResult;
    riskLevel?: "low" | "medium" | "high";
  };
  timestamp: string;
}
