/**
 * Auto-Recovery Engine
 *
 * Automatically recovers revenue when safe, without user interaction.
 * Only executes opportunities that meet strict safety criteria:
 *   - High confidence
 *   - Low risk
 *   - Within user-defined limits
 *   - Sufficient credits
 *
 * Uses the existing safeExecute pipeline — all safety gates apply.
 *
 * Lifecycle:
 *   1. Filter opportunities by user config (confidence, risk, limits)
 *   2. Sort smallest → largest (conservative approach)
 *   3. Execute each via preview → execute (full safety pipeline)
 *   4. Stop when credits insufficient or daily limit reached
 */
import type { RecoveryOpportunity, PreviewResult, ExecutionResult } from "./types.js";
import * as store from "./storage/recoveryStore.js";

/* ── User auto-recovery configuration ─────────────────────────────── */

export interface AutoRecoveryConfig {
  autoRecoveryEnabled: boolean;
  maxPerAction: number;       // Maximum € per single recovery
  maxPerDay: number;          // Maximum € total per day
  allowedConfidence: Array<"high" | "medium" | "low">;
  allowedRisk: Array<"low" | "medium" | "high">;
}

/** Default config: conservative — only high-confidence, low-risk */
export const DEFAULT_AUTO_RECOVERY_CONFIG: AutoRecoveryConfig = {
  autoRecoveryEnabled: false,
  maxPerAction: 10_000,
  maxPerDay: 50_000,
  allowedConfidence: ["high"],
  allowedRisk: ["low"],
};

/* ── Auto-recovery result ─────────────────────────────────────────── */

export interface AutoRecoveryResult {
  recoveredToday: number;
  actionsExecuted: number;
  actionsFailed: number;
  actionsSkipped: number;
  creditsUsed: number;
  stoppedReason: string | null;
  results: Array<{
    opportunityId: string;
    amount: number;
    success: boolean;
    error?: string;
    creditsUsed: number;
  }>;
}

/* ── Execution interface — injected by RecoveryEngine ────────────── */

export interface AutoRecoveryExecutor {
  preview(opportunityId: string): PreviewResult | null;
  execute(opportunityId: string): Promise<ExecutionResult | null>;
}

/* ═══════════════════════════════════════════════════════════════════
 * runAutoRecovery()
 *
 * Core auto-recovery loop. Processes eligible opportunities
 * smallest → largest, respecting all user-defined limits.
 *
 * Safety guarantees:
 *   - Uses full safeExecute pipeline (preview → execute)
 *   - Respects user config limits
 *   - Stops on insufficient credits
 *   - Never runs medium/high risk unless explicitly allowed
 *   - All standard safety gates still apply (idempotency, locks, etc.)
 * ═══════════════════════════════════════════════════════════════════ */

export async function runAutoRecovery(
  opportunities: RecoveryOpportunity[],
  config: AutoRecoveryConfig,
  availableCredits: number,
  executor: AutoRecoveryExecutor,
): Promise<AutoRecoveryResult> {
  const result: AutoRecoveryResult = {
    recoveredToday: 0,
    actionsExecuted: 0,
    actionsFailed: 0,
    actionsSkipped: 0,
    creditsUsed: 0,
    stoppedReason: null,
    results: [],
  };

  if (!config.autoRecoveryEnabled) {
    result.stoppedReason = "Auto-recovery is disabled";
    return result;
  }

  if (opportunities.length === 0) {
    result.stoppedReason = "No opportunities available";
    return result;
  }

  // Sort smallest → largest (conservative: start with low-risk amounts)
  const sorted = [...opportunities].sort((a, b) => a.amount - b.amount);

  let remainingCredits = availableCredits;

  for (const opp of sorted) {
    // ── Check 1: Config still enabled (could be disabled mid-run)
    if (!config.autoRecoveryEnabled) {
      result.stoppedReason = "Auto-recovery was disabled during execution";
      break;
    }

    // ── Check 2: Confidence filter
    if (!config.allowedConfidence.includes(opp.confidence)) {
      result.actionsSkipped++;
      continue;
    }

    // ── Check 3: Per-action amount limit
    if (opp.amount > config.maxPerAction) {
      result.actionsSkipped++;
      continue;
    }

    // ── Check 4: Daily limit
    if (result.recoveredToday + opp.amount > config.maxPerDay) {
      result.stoppedReason = "Daily recovery limit reached";
      break;
    }

    // ── Check 5: Credit check
    if (opp.creditsRequired > remainingCredits) {
      result.stoppedReason = "Insufficient credits";
      break;
    }

    // ── Check 6: Already handled
    if (store.isDealHandled(opp.dealId)) {
      result.actionsSkipped++;
      continue;
    }

    // ── Step 1: Preview (required by safety layer)
    const previewResult = executor.preview(opp.id);
    if (!previewResult) {
      result.actionsSkipped++;
      continue;
    }

    // ── Step 1.5: Risk filter (check AFTER preview provides riskLevel)
    if (!config.allowedRisk.includes(previewResult.riskLevel)) {
      result.actionsSkipped++;
      continue;
    }

    // ── Step 2: Execute (full safety pipeline)
    const execResult = await executor.execute(opp.id);

    if (!execResult) {
      result.actionsFailed++;
      result.results.push({
        opportunityId: opp.id,
        amount: opp.amount,
        success: false,
        error: "Execution returned no result",
        creditsUsed: 0,
      });
      continue;
    }

    if (execResult.success) {
      result.actionsExecuted++;
      result.recoveredToday += opp.amount;
      result.creditsUsed += opp.creditsRequired;
      remainingCredits -= opp.creditsRequired;
      result.results.push({
        opportunityId: opp.id,
        amount: opp.amount,
        success: true,
        creditsUsed: opp.creditsRequired,
      });
    } else {
      result.actionsFailed++;
      result.results.push({
        opportunityId: opp.id,
        amount: opp.amount,
        success: false,
        error: execResult.error,
        creditsUsed: 0,
      });

      // If rate limited, stop auto-recovery entirely
      if (execResult.errorType === "rate_limited") {
        result.stoppedReason = "Rate limit reached";
        break;
      }
    }
  }

  return result;
}
