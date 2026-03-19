/**
 * Token Engine — Type Definitions
 *
 * Internal cost-tracking, margin-protection, and resource-control layer.
 * Tokens are NEVER exposed to end users — only used for:
 *   - monitoring computational cost in EUR
 *   - preventing abuse / runaway jobs
 *   - margin visibility: cost vs revenue
 *   - workload safety: batching, throttling, timeouts
 */

/* ── Action types the system can perform ─────────────────────────── */
export type ActionType =
  | "initial_scan"
  | "rescan"
  | "continuous_sync"
  | "leak_detection"
  | "fix_execution"
  | "preview";

/* ── Token cost rule — fully configurable per action ─────────────── */
export interface TokenCostRule {
  /** Fixed base cost for the action */
  baseCost: number;
  /** Variable cost per record processed */
  perRecordCost: number;
  /** Variable cost per issue detected */
  perIssueCost: number;
  /** Discount multiplier (1.0 = no discount, 0.8 = 20% off) */
  discountMultiplier: number;
  /** Dynamic multiplier — can be set per-integration or per-AI-model */
  dynamicMultiplier?: number;
}

/* ── Usage log entry — one per action executed ───────────────────── */
export interface TokenUsageEntry {
  id: string;
  workspaceId: string;
  actionType: ActionType;
  tokensEstimated: number;
  tokensUsed: number;
  /** Estimated internal cost in EUR */
  costEurEstimate: number;
  recordsProcessed: number;
  issuesFound: number;
  metadata: Record<string, unknown>;
  timestamp: string;
  /** Duration of the action in milliseconds */
  durationMs: number;
  /** Whether the action completed successfully */
  success: boolean;
  /** If margin guard intervened */
  marginGuardTriggered?: boolean;
  /** If runaway protection intervened */
  runawayProtectionTriggered?: boolean;
}

/* ── Workspace token account ─────────────────────────────────────── */
export interface TokenAccount {
  workspaceId: string;
  tokenBalance: number;
  /** Lifetime tokens consumed */
  totalConsumed: number;
  /** Lifetime cost in EUR (tokens × TOKEN_COST_EUR) */
  totalCostEur: number;
  /** Optional monthly cap (null = unlimited) */
  monthlyLimit: number | null;
  /** Tokens consumed this billing period */
  monthlyConsumed: number;
  /** When the current billing period started */
  periodStart: string;
  /** ISO timestamp of last monthly reset (prevents double-reset) */
  lastResetAt: string | null;
  /** Plan tier for replenishment logic */
  planTier: PlanTier;
  /** Whether unused tokens roll over */
  rolloverEnabled: boolean;
  /** Total revenue recovered by this workspace (for margin analysis) */
  totalRecoveredEur: number;
  /** Total fees generated from this workspace */
  totalFeesEur: number;
  createdAt: string;
  updatedAt: string;
}

export type PlanTier = "starter" | "growth" | "enterprise" | "unlimited";

/* ── Plan configuration ──────────────────────────────────────────── */
export interface PlanConfig {
  tier: PlanTier;
  /** Monthly token allocation */
  monthlyAllocation: number;
  /** Whether unused tokens roll over to next period */
  rolloverEnabled: boolean;
  /** Max token balance cap (prevents hoarding) — null = no cap */
  maxBalanceCap: number | null;
  /** Whether to hard-block on insufficient tokens, or allow overdraft */
  hardBlock: boolean;
  /** Max records per job for this tier */
  maxRecordsPerJob: number;
  /** Max tokens per single job for this tier */
  maxTokensPerJob: number;
}

/* ── Recovery fee record — performance-based pricing ─────────────── */
export interface RecoveryFeeRecord {
  id: string;
  workspaceId: string;
  opportunityId: string;
  recoveredAmount: number;
  /** Fee percentage applied (e.g. 0.03 for 3%) */
  appliedPercentage: number;
  /** Raw percentage-based fee before floor applied */
  calculatedFeeEur: number;
  /** Final fee after minimum fee floor applied */
  finalFeeEur: number;
  /** Final fee in currency units (equals finalFeeEur) */
  finalFee: number;
  currency: string;
  /** Tokens consumed for this recovery */
  tokensConsumed: number;
  /** Internal cost in EUR for this recovery */
  costEur: number;
  /** Estimated cost in EUR (pre-execution) */
  costEurEstimate: number;
  /** Margin: fee - cost */
  marginEur: number;
  /** Margin ratio: margin / fee (higher is better, must be > 0) */
  marginRatio: number;
  timestamp: string;
}

/* ── Token estimate (returned before an action runs) ─────────────── */
export interface TokenEstimate {
  actionType: ActionType;
  estimatedTokens: number;
  estimatedCostEur: number;
  currentBalance: number;
  sufficient: boolean;
  /** If insufficient, how many more tokens are needed */
  deficit: number;
}

/* ── Margin status — always non-blocking ─────────────────────────── */
export type MarginStatus = "healthy" | "warning" | "low";

/* ── Margin guard result ─────────────────────────────────────────── */
export interface MarginGuardResult {
  /** @deprecated Use marginStatus instead. Margin guard is always non-blocking. */
  allowed: boolean;
  estimatedCostEur: number;
  expectedFeeEur: number;
  costToFeeRatio: number;
  /** Non-blocking margin health indicator */
  marginStatus: MarginStatus;
  reason?: string;
  /** Suggested optimization if margin is low */
  suggestion?: "reduce_records" | "upgrade_plan" | "manual_approval" | "batch_processing";
  /** If scope was reduced to protect margin */
  scopeReduced?: boolean;
  /** Max records recommended for acceptable margin */
  recommendedMaxRecords?: number;
}

/* ── Safety limits — prevent runaway jobs ─────────────────────────── */
export interface SafetyLimits {
  /** Max tokens any single action can consume */
  maxTokensPerAction: number;
  /** Max records processed in a single run */
  maxRecordsPerRun: number;
  /** If actual usage exceeds estimate by this ratio, stop */
  overageThresholdRatio: number;
  /** Timeout in milliseconds for any single action */
  actionTimeoutMs: number;
  /** Max cost-to-fee ratio (e.g. 0.5 = cost must be ≤ 50% of expected fee) */
  maxCostToFeeRatio: number;
  /** If actual tokens exceed estimate by this ratio, trigger runaway protection */
  maxOverrunRatio: number;
  /** Batch size for heavy workloads (split large jobs) */
  heavyWorkloadBatchSize: number;
  /** Record count threshold to trigger batched processing */
  heavyWorkloadThreshold: number;
}

/* ── Admin dashboard data ────────────────────────────────────────── */
export interface AdminUsageReport {
  workspaceId: string;
  totalTokensConsumed: number;
  totalCostEur: number;
  totalRevenueRecovered: number;
  totalFeesGenerated: number;
  /** Margin: fees - cost */
  marginEur: number;
  /** Margin percentage: margin / fees */
  marginPct: number;
  /** Average margin ratio across all recovery fee records */
  averageMarginRatio: number;
  /** Tokens per EUR recovered — efficiency metric */
  tokensPerEurRecovered: number;
  /** Cost per EUR recovered */
  costPerEurRecovered: number;
  actionBreakdown: Record<ActionType, { count: number; tokens: number; costEur: number }>;
  /** Per-integration token usage */
  integrationBreakdown: Record<string, { tokens: number; costEur: number }>;
  /** Per-customer efficiency with efficiency_score = recovered / tokens */
  customerEfficiency: CustomerEfficiency[];
  /** Flagged if usage is anomalous */
  anomalyFlag: boolean;
  anomalyReasons: string[];
  /** Low-margin recovery IDs */
  lowMarginRecoveries: string[];
  /** High-cost action IDs (above 2x average) */
  highCostAnomalies: string[];
  /** Recoveries with marginRatio < 0.3 — candidates for optimization */
  optimizationCandidates: RecoveryFeeRecord[];
  /** Top 5 customers sorted by efficiency_score descending */
  topEfficientCustomers: CustomerEfficiency[];
  period: { start: string; end: string };
}

/* ── Per-customer efficiency metrics ─────────────────────────────── */
export interface CustomerEfficiency {
  workspaceId: string;
  tokensUsed: number;
  costEur: number;
  recoveredEur: number;
  feesEur: number;
  /** recovered / tokens — higher is better */
  efficiencyRatio: number;
  /** Efficiency score: recovered_eur / tokens_used (EUR recovered per token) */
  efficiencyScore: number;
  /** cost / fee — lower is better (must be < 1 to be profitable) */
  costToFeeRatio: number;
  /** Flag: low efficiency or negative margin */
  flagged: boolean;
  flagReasons: string[];
}
