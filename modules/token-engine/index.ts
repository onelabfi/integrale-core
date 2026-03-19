/**
 * Token Engine — Core Service
 *
 * Internal financial control layer for RevCore.
 * Provides: margin protection, cost modeling, runaway prevention,
 * workload safety, fee calculation, and admin reporting.
 *
 * CRITICAL: This module is NEVER exposed to end users.
 * All user-facing pricing is performance-based (~3–5% of recovered revenue).
 */
import { randomUUID } from "crypto";
import type {
  ActionType,
  TokenAccount,
  TokenUsageEntry,
  TokenEstimate,
  RecoveryFeeRecord,
  AdminUsageReport,
  CustomerEfficiency,
  MarginGuardResult,
  MarginStatus,
  PlanTier,
} from "./types.js";
import {
  getTokenCost,
  getPlanConfig,
  getSafetyLimits,
  getFeeSchedule,
  getMinFeeEur,
  tokensToEuro,
} from "./config.js";

// Re-export types and config for convenience
export type * from "./types.js";
export {
  getTokenCost,
  getPlanConfig,
  getSafetyLimits,
  getFeeSchedule,
  overrideTokenCost,
  overrideSafetyLimits,
  overrideFeeSchedule,
  resetConfig,
  tokensToEuro,
  getTokenCostEur,
  setTokenCostEur,
  getMinFeeEur,
  setMinFeeEur,
} from "./config.js";
export type { FeeScheduleEntry } from "./config.js";

/* ═══════════════════════════════════════════════════════════════════
 * In-memory store (replace with Supabase persistence later)
 * ═══════════════════════════════════════════════════════════════════ */
const accounts = new Map<string, TokenAccount>();
const usageLogs: TokenUsageEntry[] = [];
const recoveryFees: RecoveryFeeRecord[] = [];

/* ── Default workspace for single-tenant mode ────────────────────── */
const DEFAULT_WORKSPACE = "default";

/* ═══════════════════════════════════════════════════════════════════
 * Account Management
 * ═══════════════════════════════════════════════════════════════════ */

export function getOrCreateAccount(
  workspaceId: string = DEFAULT_WORKSPACE,
  tier: PlanTier = "growth"
): TokenAccount {
  const existing = accounts.get(workspaceId);
  if (existing) return existing;

  const plan = getPlanConfig(tier);
  const now = new Date().toISOString();
  const account: TokenAccount = {
    workspaceId,
    tokenBalance: plan.monthlyAllocation === Infinity ? 999_999 : plan.monthlyAllocation,
    totalConsumed: 0,
    totalCostEur: 0,
    monthlyLimit: plan.monthlyAllocation === Infinity ? null : plan.monthlyAllocation,
    monthlyConsumed: 0,
    periodStart: now,
    lastResetAt: null,
    planTier: tier,
    rolloverEnabled: plan.rolloverEnabled,
    totalRecoveredEur: 0,
    totalFeesEur: 0,
    createdAt: now,
    updatedAt: now,
  };
  accounts.set(workspaceId, account);
  return account;
}

export function getAccount(workspaceId: string = DEFAULT_WORKSPACE): TokenAccount | null {
  return accounts.get(workspaceId) ?? null;
}

/* ═══════════════════════════════════════════════════════════════════
 * Token Estimation
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Estimate tokens required for an action BEFORE running it.
 * Returns whether the account has sufficient balance + EUR cost.
 */
export function estimateTokens(
  actionType: ActionType,
  recordCount: number = 0,
  issueCount: number = 0,
  workspaceId: string = DEFAULT_WORKSPACE
): TokenEstimate {
  const rule = getTokenCost(actionType);
  const multiplier = rule.dynamicMultiplier ?? 1.0;
  const estimated = Math.ceil(
    (rule.baseCost + rule.perRecordCost * recordCount + rule.perIssueCost * issueCount) *
      rule.discountMultiplier *
      multiplier
  );

  const account = getOrCreateAccount(workspaceId);
  const balance = account.tokenBalance;

  return {
    actionType,
    estimatedTokens: estimated,
    estimatedCostEur: tokensToEuro(estimated),
    currentBalance: balance,
    sufficient: balance >= estimated,
    deficit: Math.max(0, estimated - balance),
  };
}

/* ═══════════════════════════════════════════════════════════════════
 * Margin Guard — CRITICAL profitability check
 *
 * Before executing a recovery, verifies that the internal cost
 * will not exceed a configurable ratio of the expected fee.
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Check whether a job is profitable before running it.
 * NEVER blocks — returns margin status and recommendations instead.
 *
 * @param estimatedTokens How many tokens the job will cost
 * @param expectedRecoveryEur Expected recovery amount (if known)
 * @param workspaceId For cumulative fee tier calculation
 * @param recordCount Optional record count for scope-reduction recommendations
 */
export function checkMarginGuard(
  estimatedTokens: number,
  expectedRecoveryEur: number = 0,
  workspaceId: string = DEFAULT_WORKSPACE,
  recordCount?: number
): MarginGuardResult {
  const limits = getSafetyLimits();
  const estimatedCostEur = tokensToEuro(estimatedTokens);

  // If no expected recovery, margin guard can't evaluate — healthy by default
  if (expectedRecoveryEur <= 0) {
    return {
      allowed: true, // always true — non-blocking
      estimatedCostEur,
      expectedFeeEur: 0,
      costToFeeRatio: 0,
      marginStatus: "healthy",
      reason: "No expected recovery — margin guard skipped",
    };
  }

  // Calculate expected fee from recovery amount
  const cumulative = recoveryFees
    .filter((f) => f.workspaceId === workspaceId)
    .reduce((s, f) => s + f.recoveredAmount, 0);
  const { finalFee: expectedFeeEur } = calculateRecoveryFee(expectedRecoveryEur, cumulative);

  // Check ratio
  const ratio = expectedFeeEur > 0 ? estimatedCostEur / expectedFeeEur : Infinity;

  // Determine margin status (NEVER blocking)
  let marginStatus: MarginStatus = "healthy";
  let suggestion: MarginGuardResult["suggestion"];
  let scopeReduced = false;
  let recommendedMaxRecords: number | undefined;

  if (ratio > limits.maxCostToFeeRatio) {
    marginStatus = "low";

    // Determine suggestion based on context
    const account = getOrCreateAccount(workspaceId);
    const plan = getPlanConfig(account.planTier);

    if (plan.tier === "starter" || plan.tier === "growth") {
      suggestion = "upgrade_plan";
    } else if (estimatedTokens > plan.maxTokensPerJob) {
      suggestion = "reduce_records";
    } else {
      suggestion = "reduce_records";
    }

    // Calculate recommended max records for acceptable margin
    if (recordCount && recordCount > 0 && expectedFeeEur > 0) {
      const rule = getTokenCost("fix_execution");
      const targetCost = expectedFeeEur * limits.maxCostToFeeRatio;
      const targetTokens = targetCost / (tokensToEuro(1) || 0.0005);
      recommendedMaxRecords = Math.max(1, Math.floor(
        (targetTokens - rule.baseCost) / (rule.perRecordCost || 1)
      ));
      if (recommendedMaxRecords < recordCount) {
        scopeReduced = true;
      }
    }

    console.warn(
      `[TokenEngine] Margin guard LOW: cost/fee ratio ${(ratio * 100).toFixed(1)}% exceeds limit ` +
      `${(limits.maxCostToFeeRatio * 100).toFixed(0)}% — NOT blocking, flagging as low margin`
    );
  } else if (ratio > limits.maxCostToFeeRatio * 0.7) {
    marginStatus = "warning";
  }

  return {
    allowed: true, // ALWAYS true — margin guard is non-blocking
    estimatedCostEur,
    expectedFeeEur,
    costToFeeRatio: Math.round(ratio * 1000) / 1000,
    marginStatus,
    reason: marginStatus === "low"
      ? `Cost/fee ratio ${(ratio * 100).toFixed(1)}% exceeds limit ${(limits.maxCostToFeeRatio * 100).toFixed(0)}%: ` +
        `cost €${estimatedCostEur.toFixed(2)} vs expected fee €${expectedFeeEur.toFixed(2)} — flagged as low margin`
      : undefined,
    suggestion,
    scopeReduced,
    recommendedMaxRecords,
  };
}

/* ═══════════════════════════════════════════════════════════════════
 * Token Deduction
 * ═══════════════════════════════════════════════════════════════════ */

export interface DeductResult {
  success: boolean;
  tokensDeducted: number;
  costEur: number;
  remainingBalance: number;
  blockedReason?: string;
}

/**
 * Deduct tokens from the account. Call after action completes.
 */
export function deductTokens(
  workspaceId: string = DEFAULT_WORKSPACE,
  amount: number,
  actionType: ActionType
): DeductResult {
  const account = getOrCreateAccount(workspaceId);
  const plan = getPlanConfig(account.planTier);
  const limits = getSafetyLimits();

  // Safety: cap single-action deduction
  const capped = Math.min(amount, limits.maxTokensPerAction);
  const costEur = tokensToEuro(capped);

  // Check balance
  if (plan.hardBlock && account.tokenBalance < capped) {
    return {
      success: false,
      tokensDeducted: 0,
      costEur: 0,
      remainingBalance: account.tokenBalance,
      blockedReason: `Insufficient tokens: need ${capped}, have ${account.tokenBalance}. Action: ${actionType}`,
    };
  }

  // Deduct
  account.tokenBalance -= capped;
  account.totalConsumed += capped;
  account.totalCostEur += costEur;
  account.monthlyConsumed += capped;
  account.updatedAt = new Date().toISOString();

  return {
    success: true,
    tokensDeducted: capped,
    costEur,
    remainingBalance: account.tokenBalance,
  };
}

/**
 * Pre-check: can this action run? Does NOT deduct.
 */
export function canAfford(
  workspaceId: string = DEFAULT_WORKSPACE,
  estimatedTokens: number
): { allowed: boolean; reason?: string } {
  const account = getOrCreateAccount(workspaceId);
  const plan = getPlanConfig(account.planTier);

  if (!plan.hardBlock) return { allowed: true };

  if (account.tokenBalance < estimatedTokens) {
    return {
      allowed: false,
      reason: `Insufficient tokens: need ~${estimatedTokens}, have ${account.tokenBalance}`,
    };
  }

  return { allowed: true };
}

/* ═══════════════════════════════════════════════════════════════════
 * Workload Safety — check record/token limits per plan tier
 * ═══════════════════════════════════════════════════════════════════ */

export interface WorkloadCheck {
  allowed: boolean;
  requiresBatching: boolean;
  batchSize: number;
  batchCount: number;
  reason?: string;
  suggestion?: "batch_processing" | "upgrade_plan" | "reduce_records";
}

/**
 * Check if a workload fits within plan limits.
 * Returns batching instructions if the workload is too large.
 */
export function checkWorkload(
  recordCount: number,
  estimatedTokens: number,
  workspaceId: string = DEFAULT_WORKSPACE
): WorkloadCheck {
  const account = getOrCreateAccount(workspaceId);
  const plan = getPlanConfig(account.planTier);
  const limits = getSafetyLimits();

  // Check absolute limits
  if (recordCount > limits.maxRecordsPerRun) {
    return {
      allowed: false,
      requiresBatching: false,
      batchSize: 0,
      batchCount: 0,
      reason: `Record count ${recordCount} exceeds system max ${limits.maxRecordsPerRun}`,
      suggestion: "reduce_records",
    };
  }

  // Check plan-level record limit
  if (recordCount > plan.maxRecordsPerJob) {
    const batchSize = limits.heavyWorkloadBatchSize;
    const batchCount = Math.ceil(recordCount / batchSize);
    return {
      allowed: true,
      requiresBatching: true,
      batchSize,
      batchCount,
      reason: `Record count ${recordCount} exceeds plan limit ${plan.maxRecordsPerJob} — batching into ${batchCount} chunks`,
      suggestion: "batch_processing",
    };
  }

  // Check plan-level token limit
  if (estimatedTokens > plan.maxTokensPerJob) {
    return {
      allowed: true,
      requiresBatching: true,
      batchSize: Math.floor(plan.maxRecordsPerJob / 2),
      batchCount: Math.ceil(recordCount / Math.floor(plan.maxRecordsPerJob / 2)),
      reason: `Estimated tokens ${estimatedTokens} exceeds plan limit ${plan.maxTokensPerJob}`,
      suggestion: "batch_processing",
    };
  }

  // Check heavy workload threshold
  if (recordCount > limits.heavyWorkloadThreshold) {
    const batchSize = limits.heavyWorkloadBatchSize;
    return {
      allowed: true,
      requiresBatching: true,
      batchSize,
      batchCount: Math.ceil(recordCount / batchSize),
      reason: `Heavy workload detected (${recordCount} records) — batching recommended`,
      suggestion: "batch_processing",
    };
  }

  return {
    allowed: true,
    requiresBatching: false,
    batchSize: recordCount,
    batchCount: 1,
  };
}

/* ═══════════════════════════════════════════════════════════════════
 * Usage Logging
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Log a completed action with full metadata including EUR cost.
 */
export function logUsage(entry: Omit<TokenUsageEntry, "id" | "costEurEstimate"> & { costEurEstimate?: number }): TokenUsageEntry {
  const full: TokenUsageEntry = {
    id: randomUUID(),
    costEurEstimate: entry.costEurEstimate ?? tokensToEuro(entry.tokensUsed),
    ...entry,
  };
  usageLogs.push(full);

  // Keep log bounded (last 10,000 entries in memory)
  if (usageLogs.length > 10_000) {
    usageLogs.splice(0, usageLogs.length - 10_000);
  }

  return full;
}

export function getUsageLogs(
  workspaceId?: string,
  limit: number = 100
): TokenUsageEntry[] {
  const filtered = workspaceId
    ? usageLogs.filter((e) => e.workspaceId === workspaceId)
    : usageLogs;
  return filtered.slice(-limit);
}

/* ═══════════════════════════════════════════════════════════════════
 * High-Level Action Runner
 *
 * Full lifecycle: estimate → workload check → margin guard →
 * pre-check → execute with timeout → runaway detection →
 * deduct → log → return.
 *
 * This is the primary API for server.ts.
 * ═══════════════════════════════════════════════════════════════════ */

export interface ActionContext {
  actionType: ActionType;
  workspaceId?: string;
  recordCount?: number;
  issueCount?: number;
  /** Expected recovery EUR — enables margin guard */
  expectedRecoveryEur?: number;
  metadata?: Record<string, unknown>;
  /** @deprecated Margin guard is always non-blocking. This field is ignored. */
  marginGuardHardBlock?: boolean;
}

/**
 * Result type for action functions that can report actual usage.
 * If the action returns this shape, runWithTokens uses actualRecords/actualIssues
 * for token calculation instead of the pre-estimated values.
 */
export interface ActionResultWithUsage<T> {
  data: T;
  actualRecords?: number;
  actualIssues?: number;
}

export interface ActionResult<T> {
  data: T | null;
  tokensUsed: number;
  costEur: number;
  blocked: boolean;
  blockReason?: string;
  marginGuard?: MarginGuardResult;
  workloadCheck?: WorkloadCheck;
  usageEntry?: TokenUsageEntry;
  /** If runaway protection was triggered */
  runawayTriggered?: boolean;
  /** True if only a subset of records was processed (runaway or workload limit) */
  partialResult?: boolean;
  /** Number of records actually processed (relevant for partial results) */
  processedRecords?: number;
  /** Processing status: "complete" | "partial" | "batched" */
  processingStatus?: "complete" | "partial" | "batched";
  /** Non-blocking margin health indicator */
  marginStatus?: import("./types.js").MarginStatus;
}

/**
 * Run an action with full token lifecycle management.
 *
 * 1. Estimate tokens + EUR cost
 * 2. Check workload limits (batching, plan limits)
 * 3. Margin guard (cost vs expected fee)
 * 4. Pre-check balance
 * 5. Execute with timeout + runaway detection
 * 6. Deduct actual tokens
 * 7. Log usage with EUR cost
 */
export async function runWithTokens<T>(
  ctx: ActionContext,
  action: () => Promise<T | ActionResultWithUsage<T>>
): Promise<ActionResult<T>> {
  const ws = ctx.workspaceId ?? DEFAULT_WORKSPACE;
  const limits = getSafetyLimits();

  // 1. Estimate
  const estimate = estimateTokens(
    ctx.actionType,
    ctx.recordCount ?? 0,
    ctx.issueCount ?? 0,
    ws
  );

  // 2. Workload check — NEVER blocks, reduces scope if needed
  const workload = checkWorkload(ctx.recordCount ?? 0, estimate.estimatedTokens, ws);
  if (!workload.allowed) {
    // Instead of blocking, reduce scope to max allowed and proceed
    console.warn(
      `[TokenEngine] Workload exceeds limits (${workload.reason}) — reducing scope to ${workload.batchSize} records, proceeding with partial execution`
    );
    // Override the record count to the allowed maximum
    const plan = getPlanConfig(getOrCreateAccount(ws).planTier);
    ctx.recordCount = Math.min(ctx.recordCount ?? 0, plan.maxRecordsPerJob);
    workload.allowed = true;
    workload.requiresBatching = true;
    workload.batchSize = plan.maxRecordsPerJob;
    workload.batchCount = 1;
    workload.reason = `Scope reduced from original to ${plan.maxRecordsPerJob} records — processing top-priority subset`;
    workload.suggestion = "batch_processing";
  }

  // 3. Margin guard — cost vs expected fee (NEVER blocks)
  let marginResult: MarginGuardResult | undefined;
  let marginStatus: MarginStatus = "healthy";
  if (ctx.expectedRecoveryEur && ctx.expectedRecoveryEur > 0) {
    marginResult = checkMarginGuard(
      estimate.estimatedTokens,
      ctx.expectedRecoveryEur,
      ws,
      ctx.recordCount
    );
    marginStatus = marginResult.marginStatus;

    if (marginStatus === "low") {
      console.warn(
        `[TokenEngine] Margin guard LOW — optimization candidate (non-blocking): ${marginResult.reason}`
      );
      // Reduce scope more aggressively for low-margin jobs
      if (ctx.recordCount && marginResult.recommendedMaxRecords) {
        const aggressiveMax = Math.max(1, Math.floor(marginResult.recommendedMaxRecords * 0.5));
        if (aggressiveMax < ctx.recordCount) {
          ctx.recordCount = aggressiveMax;
          console.warn(
            `[TokenEngine] Aggressively reduced scope to ${aggressiveMax} records for low-margin job`
          );
        }
      }
      // Log the low-margin execution but NEVER block
      logUsage({
        workspaceId: ws,
        actionType: ctx.actionType,
        tokensEstimated: estimate.estimatedTokens,
        tokensUsed: 0,
        recordsProcessed: ctx.recordCount ?? 0,
        issuesFound: ctx.issueCount ?? 0,
        metadata: { ...ctx.metadata, marginGuard: marginResult, marginStatus, optimizationCandidate: true },
        timestamp: new Date().toISOString(),
        durationMs: 0,
        success: true,
        marginGuardTriggered: true,
      });
    } else if (marginStatus === "warning") {
      // Allow full execution, mark for monitoring
      console.info(
        `[TokenEngine] Margin guard WARNING — marked for monitoring: cost/fee ratio ${marginResult.costToFeeRatio}`
      );
    }
    // marginStatus === "healthy": no restrictions
    // Margin guard NEVER blocks — always proceeds
  }

  // 4. Pre-check balance
  const check = canAfford(ws, estimate.estimatedTokens);
  if (!check.allowed) {
    return {
      data: null,
      tokensUsed: 0,
      costEur: 0,
      blocked: true,
      blockReason: check.reason,
      marginGuard: marginResult,
    };
  }

  // 5. Execute with timeout + runaway detection
  const start = Date.now();
  let rawResult: T | ActionResultWithUsage<T>;
  let data: T;
  let runawayTriggered = false;

  try {
    // Create a timeout race
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Action timed out after ${limits.actionTimeoutMs}ms`)),
        limits.actionTimeoutMs
      )
    );

    rawResult = await Promise.race([action(), timeoutPromise]);
  } catch (err) {
    // Failed — deduct partial tokens (25% for failed attempts)
    const partialTokens = Math.ceil(estimate.estimatedTokens * 0.25);
    const deduction = deductTokens(ws, partialTokens, ctx.actionType);

    const entry = logUsage({
      workspaceId: ws,
      actionType: ctx.actionType,
      tokensEstimated: estimate.estimatedTokens,
      tokensUsed: partialTokens,
      costEurEstimate: deduction.costEur,
      recordsProcessed: ctx.recordCount ?? 0,
      issuesFound: ctx.issueCount ?? 0,
      metadata: { ...ctx.metadata, error: String(err) },
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - start,
      success: false,
    });

    return {
      data: null,
      tokensUsed: partialTokens,
      costEur: deduction.costEur,
      blocked: false,
      marginGuard: marginResult,
      usageEntry: entry,
    };
  }

  const durationMs = Date.now() - start;

  // Extract actual usage if the action reported it
  let actualRecords = ctx.recordCount ?? 0;
  let actualIssues = ctx.issueCount ?? 0;

  if (rawResult && typeof rawResult === "object" && "data" in rawResult && ("actualRecords" in rawResult || "actualIssues" in rawResult)) {
    const usageResult = rawResult as ActionResultWithUsage<T>;
    data = usageResult.data;
    actualRecords = usageResult.actualRecords ?? actualRecords;
    actualIssues = usageResult.actualIssues ?? actualIssues;
  } else {
    data = rawResult as T;
  }

  // Recalculate actual tokens based on real usage
  const rule = getTokenCost(ctx.actionType);
  const multiplier = rule.dynamicMultiplier ?? 1.0;
  const actualTokens = Math.ceil(
    (rule.baseCost + rule.perRecordCost * actualRecords + rule.perIssueCost * actualIssues) *
      rule.discountMultiplier *
      multiplier
  );

  // Graceful runaway detection: if actual exceeds estimate × overrun ratio,
  // finish current atomic operation, stop further processing, mark as "partial".
  // NEVER terminate mid-action, NEVER leave inconsistent state.
  if (actualTokens > estimate.estimatedTokens * limits.maxOverrunRatio) {
    runawayTriggered = true;
    const overrunRatio = actualTokens / estimate.estimatedTokens;
    console.warn(
      `[TokenEngine] RUNAWAY detected (graceful stop): ${actualTokens} actual tokens vs ${estimate.estimatedTokens} estimated ` +
      `(${overrunRatio.toFixed(1)}x overrun, limit: ${limits.maxOverrunRatio}x). ` +
      `Action: ${ctx.actionType}, workspace: ${ws}. Current atomic operation completed, no further processing.`
    );
    // Cap at overrun limit to prevent unbounded cost
    const cappedTokens = Math.ceil(estimate.estimatedTokens * limits.maxOverrunRatio);
    const deduction = deductTokens(ws, cappedTokens, ctx.actionType);

    const entry = logUsage({
      workspaceId: ws,
      actionType: ctx.actionType,
      tokensEstimated: estimate.estimatedTokens,
      tokensUsed: deduction.tokensDeducted,
      costEurEstimate: deduction.costEur,
      recordsProcessed: actualRecords,
      issuesFound: actualIssues,
      metadata: {
        ...ctx.metadata,
        runaway: {
          actualTokens,
          estimatedTokens: estimate.estimatedTokens,
          overrunRatio,
          capped: true,
          cappedAt: cappedTokens,
          gracefulStop: true,
        },
      },
      timestamp: new Date().toISOString(),
      durationMs,
      success: true,
      runawayProtectionTriggered: true,
    });

    return {
      data, // return whatever was completed — never discard valid results
      tokensUsed: deduction.tokensDeducted,
      costEur: deduction.costEur,
      blocked: false,
      marginGuard: marginResult,
      usageEntry: entry,
      runawayTriggered: true,
      partialResult: true,
      processedRecords: actualRecords,
      processingStatus: "partial",
      marginStatus,
    };
  }

  // 6. Deduct actual tokens
  const deduction = deductTokens(ws, actualTokens, ctx.actionType);

  // 7. Log
  const entry = logUsage({
    workspaceId: ws,
    actionType: ctx.actionType,
    tokensEstimated: estimate.estimatedTokens,
    tokensUsed: deduction.tokensDeducted,
    costEurEstimate: deduction.costEur,
    recordsProcessed: actualRecords,
    issuesFound: actualIssues,
    metadata: { ...ctx.metadata, ...(workload.requiresBatching ? { batching: workload } : {}) },
    timestamp: new Date().toISOString(),
    durationMs,
    success: true,
    runawayProtectionTriggered: runawayTriggered,
  });

  return {
    data,
    tokensUsed: deduction.tokensDeducted,
    costEur: deduction.costEur,
    blocked: false,
    marginGuard: marginResult,
    workloadCheck: workload.requiresBatching ? workload : undefined,
    usageEntry: entry,
    runawayTriggered,
    partialResult: false,
    processedRecords: actualRecords,
    processingStatus: workload.requiresBatching ? "batched" : "complete",
    marginStatus,
  };
}

/* ═══════════════════════════════════════════════════════════════════
 * Token Replenishment — Safe Monthly Reset
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Monthly plan replenishment — call from a cron job or billing cycle.
 * Prevents double-reset via lastResetAt tracking.
 */
export function replenishMonthly(workspaceId: string = DEFAULT_WORKSPACE): {
  account: TokenAccount;
  resetPerformed: boolean;
  reason?: string;
} {
  const account = getOrCreateAccount(workspaceId);
  const plan = getPlanConfig(account.planTier);
  const now = new Date();

  // Prevent double-reset: check if already reset this period
  if (account.lastResetAt) {
    const lastReset = new Date(account.lastResetAt);
    const daysSinceReset = (now.getTime() - lastReset.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSinceReset < 28) {
      return {
        account,
        resetPerformed: false,
        reason: `Last reset was ${daysSinceReset.toFixed(1)} days ago — too soon (min: 28 days)`,
      };
    }
  }

  // Check if period has elapsed (compare month/year, timezone-safe)
  const periodStart = new Date(account.periodStart);
  const isSameMonth =
    now.getUTCFullYear() === periodStart.getUTCFullYear() &&
    now.getUTCMonth() === periodStart.getUTCMonth();

  if (isSameMonth && account.lastResetAt) {
    return {
      account,
      resetPerformed: false,
      reason: "Same billing month — no reset needed",
    };
  }

  // Perform reset
  const previousBalance = account.tokenBalance;
  const previousConsumed = account.monthlyConsumed;

  if (plan.monthlyAllocation === Infinity) {
    account.monthlyConsumed = 0;
  } else {
    const newBalance = account.rolloverEnabled
      ? account.tokenBalance + plan.monthlyAllocation
      : plan.monthlyAllocation;
    account.tokenBalance = plan.maxBalanceCap
      ? Math.min(newBalance, plan.maxBalanceCap)
      : newBalance;
    account.monthlyConsumed = 0;
  }

  account.periodStart = now.toISOString();
  account.lastResetAt = now.toISOString();
  account.updatedAt = now.toISOString();

  // Log the reset event
  logUsage({
    workspaceId,
    actionType: "continuous_sync", // closest match for admin actions
    tokensEstimated: 0,
    tokensUsed: 0,
    recordsProcessed: 0,
    issuesFound: 0,
    metadata: {
      type: "monthly_reset",
      previousBalance,
      previousConsumed,
      newBalance: account.tokenBalance,
      planTier: account.planTier,
    },
    timestamp: now.toISOString(),
    durationMs: 0,
    success: true,
  });

  console.log(
    `[TokenEngine] Monthly reset for ${workspaceId}: ` +
    `${previousBalance} → ${account.tokenBalance} tokens, ` +
    `consumed ${previousConsumed} reset to 0`
  );

  return { account, resetPerformed: true };
}

/**
 * One-time token top-up (enterprise, manual, or promotional).
 */
export function addTokens(
  workspaceId: string = DEFAULT_WORKSPACE,
  amount: number,
  reason: string = "manual_topup"
): TokenAccount {
  const account = getOrCreateAccount(workspaceId);
  const plan = getPlanConfig(account.planTier);

  account.tokenBalance += amount;

  if (plan.maxBalanceCap) {
    account.tokenBalance = Math.min(account.tokenBalance, plan.maxBalanceCap);
  }

  account.updatedAt = new Date().toISOString();

  logUsage({
    workspaceId,
    actionType: "continuous_sync",
    tokensEstimated: 0,
    tokensUsed: -amount, // negative = credit
    recordsProcessed: 0,
    issuesFound: 0,
    metadata: { type: "replenishment", reason, amount },
    timestamp: new Date().toISOString(),
    durationMs: 0,
    success: true,
  });

  return account;
}

/**
 * Upgrade plan tier.
 */
export function upgradePlan(
  workspaceId: string = DEFAULT_WORKSPACE,
  newTier: PlanTier
): TokenAccount {
  const account = getOrCreateAccount(workspaceId);
  const oldTier = account.planTier;
  const newPlan = getPlanConfig(newTier);

  account.planTier = newTier;
  account.rolloverEnabled = newPlan.rolloverEnabled;

  const oldPlan = getPlanConfig(oldTier);
  if (newPlan.monthlyAllocation > oldPlan.monthlyAllocation && newPlan.monthlyAllocation !== Infinity) {
    const bonus = newPlan.monthlyAllocation - (oldPlan.monthlyAllocation === Infinity ? 0 : oldPlan.monthlyAllocation);
    account.tokenBalance += bonus;
  }

  if (newPlan.monthlyAllocation === Infinity) {
    account.monthlyLimit = null;
    account.tokenBalance = 999_999;
  } else {
    account.monthlyLimit = newPlan.monthlyAllocation;
  }

  account.updatedAt = new Date().toISOString();
  return account;
}

/* ═══════════════════════════════════════════════════════════════════
 * Performance-Based Fee Calculation
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Calculate the fee for a successful recovery.
 * Uses tiered marginal rates (like tax brackets).
 */
export function calculateRecoveryFee(
  recoveredAmount: number,
  cumulativeRecovered: number = 0
): { calculatedFee: number; finalFee: number; appliedPercentage: number } {
  const schedule = getFeeSchedule();
  let remaining = recoveredAmount;
  let totalFee = 0;
  let cursor = cumulativeRecovered;

  for (const tier of schedule) {
    if (remaining <= 0) break;

    const tierSpace = Math.max(0, tier.upTo - cursor);
    if (tierSpace <= 0) {
      cursor = tier.upTo;
      continue;
    }

    const inThisTier = Math.min(remaining, tierSpace);
    totalFee += inThisTier * tier.percentage;
    remaining -= inThisTier;
    cursor += inThisTier;
  }

  const calculatedFee = Math.round(totalFee * 100) / 100;
  const finalFee = Math.max(calculatedFee, getMinFeeEur());
  const effectivePercentage = recoveredAmount > 0 ? totalFee / recoveredAmount : 0;

  return {
    calculatedFee,
    finalFee,
    appliedPercentage: Math.round(effectivePercentage * 10000) / 10000,
  };
}

/**
 * Record a completed recovery with fee calculation + margin tracking.
 */
export function recordRecoveryFee(
  workspaceId: string = DEFAULT_WORKSPACE,
  opportunityId: string,
  recoveredAmount: number,
  currency: string = "EUR",
  tokensConsumed: number = 0
): RecoveryFeeRecord {
  const cumulative = recoveryFees
    .filter((f) => f.workspaceId === workspaceId)
    .reduce((s, f) => s + f.recoveredAmount, 0);

  const { appliedPercentage, calculatedFee, finalFee } = calculateRecoveryFee(recoveredAmount, cumulative);
  const costEur = tokensToEuro(tokensConsumed);
  const marginEur = finalFee - costEur;

  const marginRatio = finalFee > 0 ? marginEur / finalFee : 0;

  const record: RecoveryFeeRecord = {
    id: randomUUID(),
    workspaceId,
    opportunityId,
    recoveredAmount,
    appliedPercentage,
    calculatedFeeEur: calculatedFee,
    finalFeeEur: finalFee,
    finalFee,
    currency,
    tokensConsumed,
    costEur,
    costEurEstimate: costEur, // estimate equals actual at record time
    marginEur,
    marginRatio: Math.round(marginRatio * 10000) / 10000,
    timestamp: new Date().toISOString(),
  };

  recoveryFees.push(record);

  // Update account totals
  const account = getOrCreateAccount(workspaceId);
  account.totalRecoveredEur += recoveredAmount;
  account.totalFeesEur += finalFee;
  account.updatedAt = new Date().toISOString();

  return record;
}

export function getRecoveryFees(workspaceId?: string): RecoveryFeeRecord[] {
  return workspaceId
    ? recoveryFees.filter((f) => f.workspaceId === workspaceId)
    : recoveryFees;
}

/* ═══════════════════════════════════════════════════════════════════
 * Admin Dashboard — Enhanced Reporting
 * ═══════════════════════════════════════════════════════════════════ */

/**
 * Generate an admin usage report with full margin + efficiency metrics.
 */
export function generateAdminReport(
  workspaceId: string = DEFAULT_WORKSPACE,
  periodStart?: string,
  periodEnd?: string
): AdminUsageReport {
  const start = periodStart ?? new Date(Date.now() - 30 * 86400000).toISOString();
  const end = periodEnd ?? new Date().toISOString();

  const entries = usageLogs.filter(
    (e) =>
      e.workspaceId === workspaceId &&
      e.timestamp >= start &&
      e.timestamp <= end
  );

  const fees = recoveryFees.filter(
    (f) =>
      f.workspaceId === workspaceId &&
      f.timestamp >= start &&
      f.timestamp <= end
  );

  // Action breakdown with EUR cost
  const actionBreakdown: Record<ActionType, { count: number; tokens: number; costEur: number }> = {
    initial_scan: { count: 0, tokens: 0, costEur: 0 },
    rescan: { count: 0, tokens: 0, costEur: 0 },
    continuous_sync: { count: 0, tokens: 0, costEur: 0 },
    leak_detection: { count: 0, tokens: 0, costEur: 0 },
    fix_execution: { count: 0, tokens: 0, costEur: 0 },
    preview: { count: 0, tokens: 0, costEur: 0 },
  };

  const integrationBreakdown: Record<string, { tokens: number; costEur: number }> = {};
  let totalTokens = 0;
  let totalCostEur = 0;

  for (const entry of entries) {
    if (entry.tokensUsed > 0) {
      const ab = actionBreakdown[entry.actionType];
      if (ab) {
        ab.count++;
        ab.tokens += entry.tokensUsed;
        ab.costEur += entry.costEurEstimate;
      }
      totalTokens += entry.tokensUsed;
      totalCostEur += entry.costEurEstimate;

      const integration = entry.metadata?.integration as string | undefined;
      if (integration) {
        const ib = integrationBreakdown[integration] ?? { tokens: 0, costEur: 0 };
        ib.tokens += entry.tokensUsed;
        ib.costEur += entry.costEurEstimate;
        integrationBreakdown[integration] = ib;
      }
    }
  }

  const totalRecovered = fees.reduce((s, f) => s + f.recoveredAmount, 0);
  const totalFeesGenerated = fees.reduce((s, f) => s + f.finalFee, 0);
  const marginEur = totalFeesGenerated - totalCostEur;
  const marginPct = totalFeesGenerated > 0 ? marginEur / totalFeesGenerated : 0;
  const tokensPerEurRecovered = totalRecovered > 0 ? totalTokens / totalRecovered : 0;
  const costPerEurRecovered = totalRecovered > 0 ? totalCostEur / totalRecovered : 0;

  // Average margin ratio from recovery fee records
  const averageMarginRatio = fees.length > 0
    ? fees.reduce((s, f) => s + f.marginRatio, 0) / fees.length
    : 0;

  // Low-margin recoveries (margin ratio < 0.3 or negative)
  const lowMarginRecoveries = fees
    .filter((f) => f.marginRatio < 0.3)
    .map((f) => f.id);

  // High-cost anomalies: actions with cost > 2x the average cost per action
  const avgCostPerAction = entries.length > 0 ? totalCostEur / entries.length : 0;
  const highCostAnomalies = entries
    .filter((e) => e.costEurEstimate > avgCostPerAction * 2 && avgCostPerAction > 0)
    .map((e) => e.id);

  // Anomaly detection
  const anomalyReasons: string[] = [];
  const avgTokensPerAction = entries.length > 0 ? totalTokens / entries.length : 0;

  if (avgTokensPerAction > 5000) {
    anomalyReasons.push(`High avg tokens/action: ${avgTokensPerAction.toFixed(0)}`);
  }
  if (totalFeesGenerated > 0 && marginEur < 0) {
    anomalyReasons.push(`Negative margin: €${marginEur.toFixed(2)}`);
  }
  if (marginPct < 0.3 && totalFeesGenerated > 10) {
    anomalyReasons.push(`Low margin: ${(marginPct * 100).toFixed(1)}% (target: >50%)`);
  }
  if (entries.some((e) => e.runawayProtectionTriggered)) {
    anomalyReasons.push("Runaway protection was triggered");
  }
  if (entries.some((e) => e.marginGuardTriggered)) {
    anomalyReasons.push("Margin guard was triggered");
  }
  if (lowMarginRecoveries.length > 0) {
    anomalyReasons.push(`${lowMarginRecoveries.length} low-margin recoveries detected`);
  }
  if (highCostAnomalies.length > 0) {
    anomalyReasons.push(`${highCostAnomalies.length} high-cost actions (>2x average)`);
  }

  // Customer efficiency (single-workspace in v1)
  const customerEfficiency = buildCustomerEfficiency(workspaceId, totalTokens, totalCostEur, totalRecovered, totalFeesGenerated);

  // Optimization candidates: recoveries with marginRatio < 0.3
  const optimizationCandidates = fees.filter((f) => f.marginRatio < 0.3);

  // Top efficient customers: sorted by efficiency_score desc, top 5
  const topEfficientCustomers = [...customerEfficiency]
    .sort((a, b) => b.efficiencyScore - a.efficiencyScore)
    .slice(0, 5);

  return {
    workspaceId,
    totalTokensConsumed: totalTokens,
    totalCostEur: Math.round(totalCostEur * 100) / 100,
    totalRevenueRecovered: totalRecovered,
    totalFeesGenerated: Math.round(totalFeesGenerated * 100) / 100,
    marginEur: Math.round(marginEur * 100) / 100,
    marginPct: Math.round(marginPct * 10000) / 10000,
    averageMarginRatio: Math.round(averageMarginRatio * 10000) / 10000,
    tokensPerEurRecovered: Math.round(tokensPerEurRecovered * 100) / 100,
    costPerEurRecovered: Math.round(costPerEurRecovered * 10000) / 10000,
    actionBreakdown,
    integrationBreakdown,
    customerEfficiency,
    anomalyFlag: anomalyReasons.length > 0,
    anomalyReasons,
    lowMarginRecoveries,
    highCostAnomalies,
    optimizationCandidates,
    topEfficientCustomers,
    period: { start, end },
  };
}

function buildCustomerEfficiency(
  workspaceId: string,
  tokensUsed: number,
  costEur: number,
  recoveredEur: number,
  feesEur: number
): CustomerEfficiency[] {
  const efficiencyRatio = tokensUsed > 0 ? recoveredEur / tokensUsed : 0;
  const efficiencyScore = tokensUsed > 0 ? recoveredEur / tokensUsed : 0;
  const costToFeeRatio = feesEur > 0 ? costEur / feesEur : 0;

  const flagReasons: string[] = [];
  if (efficiencyRatio < 0.5 && tokensUsed > 100) {
    flagReasons.push(`Low efficiency: ${efficiencyRatio.toFixed(2)} EUR/token`);
  }
  if (costToFeeRatio > 0.7 && feesEur > 1) {
    flagReasons.push(`High cost/fee ratio: ${(costToFeeRatio * 100).toFixed(1)}%`);
  }

  return [{
    workspaceId,
    tokensUsed,
    costEur: Math.round(costEur * 100) / 100,
    recoveredEur,
    feesEur: Math.round(feesEur * 100) / 100,
    efficiencyRatio: Math.round(efficiencyRatio * 100) / 100,
    efficiencyScore: Math.round(efficiencyScore * 10000) / 10000,
    costToFeeRatio: Math.round(costToFeeRatio * 1000) / 1000,
    flagged: flagReasons.length > 0,
    flagReasons,
  }];
}

/**
 * Get reports for all workspaces (admin overview).
 */
export function generateAllReports(): AdminUsageReport[] {
  return Array.from(accounts.keys()).map((ws) => generateAdminReport(ws));
}

/* ═══════════════════════════════════════════════════════════════════
 * Reset (for testing)
 * ═══════════════════════════════════════════════════════════════════ */
export function resetAll(): void {
  accounts.clear();
  usageLogs.length = 0;
  recoveryFees.length = 0;
}
