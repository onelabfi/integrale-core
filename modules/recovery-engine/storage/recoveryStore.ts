/**
 * Recovery Action Store — Production-Grade Safety
 *
 * In-memory storage for recovery actions (recovery_actions table).
 * Production: replace with PostgreSQL / Supabase.
 *
 * Safety guarantees:
 *   - Idempotency: a deal can only be recovered once
 *   - Preview enforcement: execute requires a valid preview token
 *   - Execution locks: prevents parallel execution on same deal
 *   - Audit trail: every action is logged with full context
 */
import type {
  RecoveryAction,
  RecoveryActionStatus,
  PlaybookType,
  PreviewToken,
  ExecutionLock,
  PreviewResult,
} from "../types.js";

let actions: RecoveryAction[] = [];
let nextId = 1;

/* ── Preview token store ──────────────────────────────────────────── */
const previewTokens = new Map<string, PreviewToken>();

/** Preview tokens expire after 10 minutes */
const PREVIEW_TTL_MS = 10 * 60 * 1000;

/* ── Execution lock store ─────────────────────────────────────────── */
const executionLocks = new Map<string, ExecutionLock>();

/** Execution locks expire after 2 minutes (timeout safety) */
const LOCK_TTL_MS = 2 * 60 * 1000;

function generateId(): string {
  return `ra-${String(nextId++).padStart(5, "0")}`;
}

/* ═══════════════════════════════════════════════════════════════════
 * RECOVERY ACTIONS
 * ═══════════════════════════════════════════════════════════════════ */

/** Create a new recovery action record */
export function createAction(params: {
  playbookType: PlaybookType;
  dealId: string;
  opportunityId: string;
  metadata?: Record<string, unknown>;
}): RecoveryAction {
  const action: RecoveryAction = {
    id: generateId(),
    playbookType: params.playbookType,
    dealId: params.dealId,
    opportunityId: params.opportunityId,
    status: "pending",
    executedAt: null,
    createdAt: new Date().toISOString(),
    metadata: params.metadata ?? {},
  };
  actions.push(action);
  return action;
}

/** Update action status */
export function updateAction(
  id: string,
  update: { status: RecoveryActionStatus; metadata?: Record<string, unknown> },
): RecoveryAction | null {
  const action = actions.find((a) => a.id === id);
  if (!action) return null;
  action.status = update.status;
  action.executedAt =
    update.status === "success" || update.status === "failed" || update.status === "already_handled"
      ? new Date().toISOString()
      : action.executedAt;
  if (update.metadata) {
    action.metadata = { ...action.metadata, ...update.metadata };
  }
  return action;
}

/* ── Query helpers ─────────────────────────────────────────────────── */

/** Check if a deal has already been successfully recovered */
export function isDealHandled(dealId: string): boolean {
  return actions.some((a) => a.dealId === dealId && a.status === "success");
}

/** Check if an opportunity has a pending or successful action */
export function hasActiveAction(opportunityId: string): boolean {
  return actions.some(
    (a) => a.opportunityId === opportunityId && (a.status === "pending" || a.status === "success"),
  );
}

/** Get action by opportunity ID */
export function getActionByOpportunity(opportunityId: string): RecoveryAction | null {
  return actions.find((a) => a.opportunityId === opportunityId) ?? null;
}

/** Get all actions */
export function getAllActions(): RecoveryAction[] {
  return [...actions];
}

/** Get actions by playbook type */
export function getActionsByPlaybook(type: PlaybookType): RecoveryAction[] {
  return actions.filter((a) => a.playbookType === type);
}

/** Get failed actions eligible for retry */
export function getRetryableActions(): RecoveryAction[] {
  return actions.filter(
    (a) => a.status === "failed" && !isDealHandled(a.dealId),
  );
}

/** Count recent actions for rate limiting */
export function countRecentActions(windowMs: number): number {
  const cutoff = Date.now() - windowMs;
  return actions.filter(
    (a) => a.status === "pending" && new Date(a.createdAt).getTime() > cutoff,
  ).length;
}

/* ═══════════════════════════════════════════════════════════════════
 * PREVIEW TOKENS — Dry-run enforcement
 *
 * Every execute() call must present a valid (non-expired) preview token.
 * This ensures the user/system has reviewed what will happen.
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Generate a state hash for an opportunity.
 * Used to detect if opportunity data changed between preview and execute.
 */
export function computeStateHash(opportunity: { dealId: string; amount: number; customerId: string }): string {
  // Simple deterministic hash — in production, use crypto.createHash("sha256")
  const input = `${opportunity.dealId}:${opportunity.amount}:${opportunity.customerId}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return `ph_${Math.abs(hash).toString(36)}`;
}

/** Issue a preview token after a successful preview */
export function issuePreviewToken(
  opportunityId: string,
  previewResult: PreviewResult,
  stateHash: string,
): PreviewToken {
  const now = Date.now();
  const token: PreviewToken = {
    opportunityId,
    previewedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(),
    previewResult,
    stateHash,
  };
  previewTokens.set(opportunityId, token);
  return token;
}

/** Validate that a preview token exists, is not expired, and matches current state */
export function validatePreviewToken(
  opportunityId: string,
  currentStateHash?: string,
): { valid: boolean; reason?: string } {
  const token = previewTokens.get(opportunityId);
  if (!token) {
    return { valid: false, reason: "No preview found — run preview before execute" };
  }
  if (new Date(token.expiresAt).getTime() < Date.now()) {
    previewTokens.delete(opportunityId);
    return { valid: false, reason: "Preview expired — re-run preview before execute" };
  }
  // State hash validation — prevent stale execution
  if (currentStateHash && token.stateHash !== currentStateHash) {
    previewTokens.delete(opportunityId);
    return { valid: false, reason: "Opportunity has changed since preview. Please preview again." };
  }
  return { valid: true };
}

/** Consume a preview token after successful execution */
export function consumePreviewToken(opportunityId: string): void {
  previewTokens.delete(opportunityId);
}

/** Check if a valid preview token exists (for UI signals — no hash check) */
export function hasValidPreview(opportunityId: string): boolean {
  return validatePreviewToken(opportunityId).valid;
}

/** Get the state hash from a preview token (for execution validation) */
export function getPreviewStateHash(opportunityId: string): string | null {
  const token = previewTokens.get(opportunityId);
  return token?.stateHash ?? null;
}

/* ═══════════════════════════════════════════════════════════════════
 * EXECUTION LOCKS — Prevent parallel execution on same deal
 *
 * Only one execution can run per deal at a time.
 * Locks auto-expire after LOCK_TTL_MS as a safety net.
 * ═══════════════════════════════════════════════════════════════════ */

/** Attempt to acquire an execution lock for a deal */
export function acquireLock(dealId: string, opportunityId: string): { acquired: boolean; reason?: string } {
  // Clean expired locks first
  cleanExpiredLocks();

  const existing = executionLocks.get(dealId);
  if (existing) {
    return {
      acquired: false,
      reason: `Deal ${dealId} is already being processed (locked at ${existing.lockedAt})`,
    };
  }

  const now = Date.now();
  executionLocks.set(dealId, {
    dealId,
    opportunityId,
    lockedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LOCK_TTL_MS).toISOString(),
  });
  return { acquired: true };
}

/** Release an execution lock */
export function releaseLock(dealId: string): void {
  executionLocks.delete(dealId);
}

/** Check if a deal is currently locked */
export function isLocked(dealId: string): boolean {
  cleanExpiredLocks();
  return executionLocks.has(dealId);
}

/** Clean expired locks (safety net) */
function cleanExpiredLocks(): void {
  const now = Date.now();
  for (const [dealId, lock] of executionLocks) {
    if (new Date(lock.expiresAt).getTime() < now) {
      executionLocks.delete(dealId);
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════
 * RATE LIMITING
 * ═══════════════════════════════════════════════════════════════════ */

/** Maximum concurrent pending actions */
const MAX_CONCURRENT_PENDING = 5;

/** Maximum actions per minute */
const MAX_ACTIONS_PER_MINUTE = 10;

/** Check if we've hit rate limits */
export function checkRateLimit(): { allowed: boolean; reason?: string } {
  const pendingCount = actions.filter((a) => a.status === "pending").length;
  if (pendingCount >= MAX_CONCURRENT_PENDING) {
    return { allowed: false, reason: `Too many concurrent operations (${pendingCount}/${MAX_CONCURRENT_PENDING})` };
  }

  const recentCount = countRecentActions(60_000);
  if (recentCount >= MAX_ACTIONS_PER_MINUTE) {
    return { allowed: false, reason: `Rate limit exceeded (${recentCount}/${MAX_ACTIONS_PER_MINUTE} per minute)` };
  }

  return { allowed: true };
}

/* ═══════════════════════════════════════════════════════════════════
 * RESET
 * ═══════════════════════════════════════════════════════════════════ */

/** Reset store (for testing) */
export function resetStore(): void {
  actions = [];
  nextId = 1;
  previewTokens.clear();
  executionLocks.clear();
}
