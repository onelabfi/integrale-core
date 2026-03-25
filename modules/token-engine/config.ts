/**
 * Token Engine — Configuration
 *
 * All token costs, plan tiers, safety limits, fee schedules,
 * and internal cost model are defined here. Nothing is hardcoded
 * in the engine itself.
 */
import type { ActionType, TokenCostRule, PlanConfig, PlanTier, SafetyLimits } from "./types.js";

/* ═══════════════════════════════════════════════════════════════════
 * Internal EUR cost model
 * ═══════════════════════════════════════════════════════════════════ */

/** Internal cost per token in EUR — 1 token = €1 */
let TOKEN_COST_EUR = 1.0; // €1 per token → user-facing pricing

/** Minimum fee floor in EUR — no recovery fee can be less than this */
let MIN_FEE_EUR = 50;

export function getTokenCostEur(): number {
  return TOKEN_COST_EUR;
}

export function setTokenCostEur(costEur: number): void {
  TOKEN_COST_EUR = costEur;
}

export function getMinFeeEur(): number {
  return MIN_FEE_EUR;
}

export function setMinFeeEur(minFee: number): void {
  MIN_FEE_EUR = minFee;
}

/** Convert tokens to estimated EUR cost */
export function tokensToEuro(tokens: number): number {
  return Math.round(tokens * TOKEN_COST_EUR * 10000) / 10000; // 4 decimal precision
}

/* ═══════════════════════════════════════════════════════════════════
 * Token cost rules per action type
 * ═══════════════════════════════════════════════════════════════════ */
/**
 * Token costs aligned with RevCore pricing spec:
 * - First scan: FREE (handled in API layer)
 * - Re-scan: 25 tokens
 * - Fix single issue: 10 tokens (handled in playbooks)
 * - Fix all issues: 25–75 tokens (sum of individual, capped)
 * - Execute recovery workflow: 25 tokens
 * - Investigate issue (deep analysis): 75 tokens
 * - Generate recovery report: 25 tokens
 * - Continuous monitoring: 75 tokens
 * - Deep system analysis: 75 tokens
 * - Blueprint generation: 75 tokens
 */
const DEFAULT_TOKEN_COSTS: Record<ActionType, TokenCostRule> = {
  initial_scan: {
    baseCost: 0,           // FREE — first scan is always free
    perRecordCost: 0,
    perIssueCost: 0,
    discountMultiplier: 1.0,
  },
  rescan: {
    baseCost: 25,          // Re-scan: 25 tokens
    perRecordCost: 0,
    perIssueCost: 0,
    discountMultiplier: 1.0,
  },
  continuous_sync: {
    baseCost: 75,          // Continuous monitoring: 75 tokens
    perRecordCost: 0,
    perIssueCost: 0,
    discountMultiplier: 1.0,
  },
  leak_detection: {
    baseCost: 75,          // Deep system analysis: 75 tokens
    perRecordCost: 0,
    perIssueCost: 0,
    discountMultiplier: 1.0,
  },
  fix_execution: {
    baseCost: 10,          // Fix single issue: 10 tokens
    perRecordCost: 0,
    perIssueCost: 0,
    discountMultiplier: 1.0,
  },
  preview: {
    baseCost: 0,           // Preview is always free
    perRecordCost: 0,
    perIssueCost: 0,
    discountMultiplier: 1.0,
  },
};

/* ═══════════════════════════════════════════════════════════════════
 * Plan configurations
 * ═══════════════════════════════════════════════════════════════════ */
const PLAN_CONFIGS: Record<PlanTier, PlanConfig> = {
  starter: {
    tier: "starter",
    monthlyAllocation: 5_000,
    rolloverEnabled: false,
    maxBalanceCap: 10_000,
    hardBlock: true,
    maxRecordsPerJob: 5_000,
    maxTokensPerJob: 2_000,
  },
  growth: {
    tier: "growth",
    monthlyAllocation: 25_000,
    rolloverEnabled: true,
    maxBalanceCap: 75_000,
    hardBlock: true,
    maxRecordsPerJob: 25_000,
    maxTokensPerJob: 5_000,
  },
  enterprise: {
    tier: "enterprise",
    monthlyAllocation: 100_000,
    rolloverEnabled: true,
    maxBalanceCap: null,
    hardBlock: false, // allow overdraft, flag for review
    maxRecordsPerJob: 100_000,
    maxTokensPerJob: 25_000,
  },
  unlimited: {
    tier: "unlimited",
    monthlyAllocation: Infinity,
    rolloverEnabled: false,
    maxBalanceCap: null,
    hardBlock: false,
    maxRecordsPerJob: 500_000,
    maxTokensPerJob: 50_000,
  },
};

/* ═══════════════════════════════════════════════════════════════════
 * Safety limits
 * ═══════════════════════════════════════════════════════════════════ */
const DEFAULT_SAFETY_LIMITS: SafetyLimits = {
  maxTokensPerAction: 50_000,
  maxRecordsPerRun: 100_000,
  overageThresholdRatio: 2.0,
  actionTimeoutMs: 120_000,      // 2 minutes
  maxCostToFeeRatio: 0.5,        // cost must be ≤ 50% of expected fee
  maxOverrunRatio: 1.5,          // stop if actual > 1.5× estimate
  heavyWorkloadBatchSize: 5_000, // process in batches of 5k records
  heavyWorkloadThreshold: 10_000, // trigger batching above 10k records
};

/* ═══════════════════════════════════════════════════════════════════
 * Performance-based fee schedule
 * ═══════════════════════════════════════════════════════════════════ */
export interface FeeScheduleEntry {
  /** Revenue threshold — fee applies up to this amount */
  upTo: number;
  /** Fee percentage (0.05 = 5%) */
  percentage: number;
}

/**
 * Tiered fee schedule — percentage decreases with scale.
 * Applied on a marginal basis (like tax brackets).
 */
const DEFAULT_FEE_SCHEDULE: FeeScheduleEntry[] = [
  { upTo: 10_000, percentage: 0.05 },        // first €10k → 5%
  { upTo: 50_000, percentage: 0.04 },        // €10k–50k → 4%
  { upTo: 100_000, percentage: 0.035 },      // €50k–100k → 3.5%
  { upTo: 500_000, percentage: 0.03 },       // €100k–500k → 3%
  { upTo: 1_000_000, percentage: 0.025 },    // €500k–1M → 2.5%
  { upTo: Infinity, percentage: 0.02 },      // >€1M → 2%
];

/* ═══════════════════════════════════════════════════════════════════
 * Mutable config store
 * ═══════════════════════════════════════════════════════════════════ */
let tokenCosts = { ...DEFAULT_TOKEN_COSTS };
let planConfigs = { ...PLAN_CONFIGS };
let safetyLimits = { ...DEFAULT_SAFETY_LIMITS };
let feeSchedule = [...DEFAULT_FEE_SCHEDULE];

/* ═══════════════════════════════════════════════════════════════════
 * Public accessors
 * ═══════════════════════════════════════════════════════════════════ */
export function getTokenCost(action: ActionType): TokenCostRule {
  return tokenCosts[action];
}

export function getPlanConfig(tier: PlanTier): PlanConfig {
  return planConfigs[tier];
}

export function getSafetyLimits(): SafetyLimits {
  return safetyLimits;
}

export function getFeeSchedule(): FeeScheduleEntry[] {
  return feeSchedule;
}

/* ═══════════════════════════════════════════════════════════════════
 * Config overrides (for testing or runtime changes)
 * ═══════════════════════════════════════════════════════════════════ */
export function overrideTokenCost(action: ActionType, rule: Partial<TokenCostRule>): void {
  tokenCosts[action] = { ...tokenCosts[action], ...rule };
}

export function overrideSafetyLimits(limits: Partial<SafetyLimits>): void {
  safetyLimits = { ...safetyLimits, ...limits };
}

export function overrideFeeSchedule(schedule: FeeScheduleEntry[]): void {
  feeSchedule = [...schedule];
}

export function resetConfig(): void {
  tokenCosts = { ...DEFAULT_TOKEN_COSTS };
  planConfigs = { ...PLAN_CONFIGS };
  safetyLimits = { ...DEFAULT_SAFETY_LIMITS };
  feeSchedule = [...DEFAULT_FEE_SCHEDULE];
  TOKEN_COST_EUR = 1.0;
  MIN_FEE_EUR = 50;
}
