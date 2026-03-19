/**
 * PDF Report Generator — Types
 *
 * Type definitions for recovery report PDF generation.
 * Designed for extensibility (monthly summaries, compliance exports, etc.)
 */

/* ── Recovery report data (input to PDF generator) ────────────────── */
export interface RecoveryReportData {
  /** Unique report ID */
  reportId: string;
  /** Recovery opportunity ID */
  recoveryId: string;
  /** Workspace / company name */
  workspaceName: string;
  /** Generation timestamp (ISO) */
  generatedAt: string;
  /** Summary data */
  summary: {
    totalRecovered: number;
    currency: string;
    issuesResolved: number;
    systemsInvolved: string[];
    executionTimeMs: number;
  };
  /** Individual recovery items */
  items: RecoveryReportItem[];
  /** Audit trail entries */
  audit: AuditEntry[];
}

export interface RecoveryReportItem {
  /** Issue type label (human-readable) */
  issueType: string;
  /** Short description */
  description: string;
  /** Amount recovered */
  amount: number;
  currency: string;
  /** Outcome-based actions (NOT technical steps) */
  actions: string[];
  /** Playbook type (internal, for categorization) */
  playbook: string;
}

export interface AuditEntry {
  timestamp: string;
  actionId: string;
  status: "Completed" | "Pending" | "Failed";
  idempotent: boolean;
}

/* ── Stored report record ─────────────────────────────────────────── */
export interface StoredReport {
  reportId: string;
  recoveryId: string;
  workspaceId: string;
  generatedAt: string;
  fileName: string;
  /** PDF buffer (in-memory storage) */
  buffer: Buffer;
  /** Report metadata for listing */
  summary: {
    totalRecovered: number;
    currency: string;
    issuesResolved: number;
  };
}
