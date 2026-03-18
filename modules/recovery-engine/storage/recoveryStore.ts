/**
 * Recovery Action Store
 *
 * In-memory storage for recovery actions (recovery_actions table).
 * Production: replace with PostgreSQL / Supabase.
 *
 * Provides idempotency checking: a deal can only be recovered once.
 */
import type { RecoveryAction, RecoveryActionStatus, PlaybookType } from "../types.js";

let actions: RecoveryAction[] = [];
let nextId = 1;

function generateId(): string {
  return `ra-${String(nextId++).padStart(5, "0")}`;
}

/* ── Create a new recovery action record ───────────────────────────── */
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

/* ── Update action status ──────────────────────────────────────────── */
export function updateAction(
  id: string,
  update: { status: RecoveryActionStatus; metadata?: Record<string, unknown> },
): RecoveryAction | null {
  const action = actions.find((a) => a.id === id);
  if (!action) return null;
  action.status = update.status;
  action.executedAt = update.status === "success" || update.status === "failed" ? new Date().toISOString() : action.executedAt;
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

/** Reset store (for testing) */
export function resetStore(): void {
  actions = [];
  nextId = 1;
}
