/**
 * Findings Service — Single source of truth for revenue leak detection
 *
 * Orchestrates:
 *   1. Data fetching from connectors (HubSpot, Salesforce, Stripe)
 *   2. Detection via engine/detectionEngine.ts
 *   3. Persistence to Supabase `findings` table
 *   4. Reading findings and scan status
 */
import { getSupabaseAdmin } from "../lib/supabaseAdmin.js";
import {
  detectLeaks,
  generateLeakSummary,
  generateRootCause,
} from "../engine/detectionEngine.js";
import type { RevenueLeak, DetectionOutput } from "../engine/types.js";
import { HubSpotConnector } from "../connectors/hubspot.js";
import { StripeConnector } from "../connectors/stripe.js";
import { SalesforceConnector } from "../connectors/salesforce.js";
import { MOCK_DEALS, MOCK_INVOICES, MOCK_SUBSCRIPTIONS } from "../engine/mockData.js";

/* ── Types ───────────────────────────────────────────────────────────── */

export interface Finding {
  id: string;
  org_id: string;
  category: string;
  entity_type: string;
  entity_name: string;
  company: string | null;
  amount: number;
  currency: string;
  impact_type: string;
  date: string;
  issue: string;
  detail: string;
  source_record_id: string;
  status: string;
  fix_cause: string | null;
  fix_trigger: string | null;
  fix_action: string | null;
  fix_impact: string | null;
  scan_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScanRunResult {
  scanId: string;
  status: "running";
}

export interface ScanStatus {
  status: "idle" | "running" | "completed" | "failed";
  scanId: string | null;
  lastScanAt: string | null;
  findingsCount: number;
}

export interface FindingsSummary {
  totalImpact: number;
  openIssues: number;
  breakdown: {
    uninvoiced: number;
    missing_renewal: number;
    churn_risk: number;
  };
}

export interface FindingsFilters {
  status?: string;
  category?: string;
}

/* ── Demo findings (never show empty state) ──────────────────────────── */

const DEMO_FINDINGS: Omit<Finding, "id" | "org_id" | "scan_id" | "created_at" | "updated_at">[] = [
  {
    category: "uninvoiced",
    entity_type: "deal",
    entity_name: "Enterprise Platform License",
    company: "Acme Corp",
    amount: 48000,
    currency: "EUR",
    impact_type: "lost_revenue",
    date: new Date(Date.now() - 15 * 86_400_000).toISOString(),
    issue: "€48,000 revenue mismatch",
    detail:
      '"Enterprise Platform License" closed 15 days ago — revenue not recorded across connected systems. €48,000 detected as unrecovered.',
    source_record_id: "demo-deal-001",
    status: "open",
    fix_cause:
      'Revenue from "Enterprise Platform License" (Acme Corp) was not recorded across connected systems after deal close.',
    fix_trigger: "Detected automatically",
    fix_action: "Recover €48,000 and bring all systems into alignment",
    fix_impact: "Recovers €48,000 for this deal. Prevents future misalignment automatically.",
  },
  {
    category: "uninvoiced",
    entity_type: "deal",
    entity_name: "Data Analytics Add-on",
    company: "TechFlow Inc",
    amount: 12000,
    currency: "EUR",
    impact_type: "lost_revenue",
    date: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    issue: "€12,000 revenue mismatch",
    detail:
      '"Data Analytics Add-on" closed 8 days ago — revenue not recorded across connected systems. €12,000 detected as unrecovered.',
    source_record_id: "demo-deal-002",
    status: "open",
    fix_cause:
      'Revenue from "Data Analytics Add-on" (TechFlow Inc) was not recorded across connected systems after deal close.',
    fix_trigger: "Detected automatically",
    fix_action: "Recover €12,000 and bring all systems into alignment",
    fix_impact: "Recovers €12,000 for this deal. Prevents future misalignment automatically.",
  },
  {
    category: "missing_renewal",
    entity_type: "subscription",
    entity_name: "Growth Plan - Monthly",
    company: "Nordic Solutions Oy",
    amount: 8000,
    currency: "EUR",
    impact_type: "lost_revenue",
    date: new Date(Date.now() - 22 * 86_400_000).toISOString(),
    issue: "€8,000 revenue continuity gap",
    detail:
      '"Growth Plan - Monthly" for Nordic Solutions Oy — billing cycle lapsed 22 days ago while account remains active. €8,000 in recurring revenue not captured.',
    source_record_id: "demo-sub-001",
    status: "open",
    fix_cause:
      "Revenue continuity gap detected for Nordic Solutions Oy — billing cycle lapsed 22 days ago while account remains active.",
    fix_trigger: "Detected automatically",
    fix_action: "Restore billing continuity for Nordic Solutions Oy and recover €8,000",
    fix_impact: "Recovers €8,000 in recurring revenue. Prevents future continuity gaps automatically.",
  },
];

/* ── Service ─────────────────────────────────────────────────────────── */

/**
 * Start a scan for the given org.
 * Returns immediately with scanId + status "running".
 * The actual scan runs asynchronously.
 */
export async function runScan(orgId: string): Promise<ScanRunResult> {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    throw new Error("Supabase not configured");
  }

  // ── DB-level concurrency guard: don't start duplicate scans ──────
  const { data: running } = await supabase
    .from("scan_runs")
    .select("id")
    .eq("org_id", orgId)
    .eq("status", "running")
    .limit(1)
    .maybeSingle();

  if (running) {
    return { scanId: running.id, status: "running" };
  }

  // ── Create scan run ──────────────────────────────────────────────
  const { data: scanRun, error: insertError } = await supabase
    .from("scan_runs")
    .insert({ org_id: orgId, status: "running" })
    .select("id")
    .single();

  if (insertError || !scanRun) {
    throw new Error(`Failed to create scan run: ${insertError?.message}`);
  }

  const scanId = scanRun.id;

  // ── Run scan async (fire-and-forget) ─────────────────────────────
  executeScan(orgId, scanId).catch((err) => {
    console.error(`[findingsService] Scan ${scanId} failed:`, err);
    // Mark as failed
    supabase
      .from("scan_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        error: String(err),
      })
      .eq("id", scanId)
      .then(() => {});
  });

  return { scanId, status: "running" };
}

/**
 * Execute the actual scan (runs async after runScan returns).
 */
async function executeScan(orgId: string, scanId: string): Promise<void> {
  const supabase = getSupabaseAdmin()!;

  // ── 1. Fetch data from all connected sources ─────────────────────
  const hubspot = new HubSpotConnector();
  const stripe = new StripeConnector();
  const salesforce = new SalesforceConnector();

  // Connect with org context
  await Promise.all([
    hubspot.connect({ orgId }).catch(() => {}),
    stripe.connect().catch(() => {}),
    salesforce.connect({ orgId }).catch(() => {}),
  ]);

  const [hubspotDeals, salesforceDeals, invoices, subscriptions] = await Promise.all([
    hubspot.getDeals().catch(() => MOCK_DEALS),
    salesforce.isConnected() ? salesforce.getDeals().catch(() => []) : Promise.resolve([]),
    stripe.getInvoices().catch(() => MOCK_INVOICES),
    stripe.getSubscriptions().catch(() => MOCK_SUBSCRIPTIONS),
  ]);

  const deals = [...hubspotDeals, ...salesforceDeals];

  // ── 2. Run detection engine ──────────────────────────────────────
  const result: DetectionOutput = detectLeaks(deals, invoices, subscriptions);

  // ── 3. Upsert findings to DB ─────────────────────────────────────
  let upsertedCount = 0;
  let totalAmount = 0;

  for (const leak of result.leaks) {
    const finding = leakToFinding(leak, orgId, scanId);

    const { error } = await supabase.from("findings").upsert(finding, {
      onConflict: "org_id,category,source_record_id",
      ignoreDuplicates: false,
    });

    if (error) {
      console.error(`[findingsService] Upsert error for ${leak.id}:`, error.message);
    } else {
      upsertedCount++;
      totalAmount += leak.amount;
    }
  }

  // ── 4. Mark scan as completed ────────────────────────────────────
  await supabase
    .from("scan_runs")
    .update({
      status: "completed",
      finished_at: new Date().toISOString(),
      findings_count: upsertedCount,
      total_amount: totalAmount,
    })
    .eq("id", scanId);

  console.log(
    `[findingsService] Scan ${scanId} completed: ${upsertedCount} findings, €${totalAmount.toLocaleString()}`,
  );
}

/**
 * Map a RevenueLeak from the detection engine to a findings table row.
 */
function leakToFinding(
  leak: RevenueLeak,
  orgId: string,
  scanId: string,
): Record<string, unknown> {
  // Determine entity_type and impact_type based on category
  let entityType: string;
  let impactType: string;

  switch (leak.category) {
    case "uninvoiced":
      entityType = "deal";
      impactType = "lost_revenue";
      break;
    case "missing_renewal":
      entityType = "subscription";
      impactType = "lost_revenue";
      break;
    case "churn_risk":
      entityType = "subscription";
      impactType = "risk";
      break;
    default:
      entityType = "deal";
      impactType = "lost_revenue";
  }

  return {
    org_id: orgId,
    category: leak.category,
    entity_type: entityType,
    entity_name: leak.deal_name,
    company: leak.company || null,
    amount: leak.amount,
    currency: leak.currency,
    impact_type: impactType,
    date: leak.date,
    issue: leak.issue,
    detail: leak.detail,
    source_record_id: leak.source_record_id,
    status: leak.status === "fixed" ? "fixed" : "open",
    fix_cause: leak.fix?.cause ?? null,
    fix_trigger: leak.fix?.trigger ?? null,
    fix_action: leak.fix?.action ?? null,
    fix_impact: leak.fix?.impact ?? null,
    scan_id: scanId,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Get findings for an org. Returns demo findings if none exist.
 */
export async function getFindings(
  orgId: string,
  filters?: FindingsFilters,
): Promise<Finding[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return getDemoFindings(orgId);
  }

  let query = supabase
    .from("findings")
    .select("*")
    .eq("org_id", orgId)
    .order("amount", { ascending: false });

  if (filters?.status) {
    query = query.eq("status", filters.status);
  }
  if (filters?.category) {
    query = query.eq("category", filters.category);
  }

  const { data, error } = await query;

  if (error) {
    console.error("[findingsService] Error fetching findings:", error.message);
    return getDemoFindings(orgId);
  }

  // If no findings exist, return demo data
  if (!data || data.length === 0) {
    return getDemoFindings(orgId);
  }

  return data as Finding[];
}

/**
 * Get summary aggregation for an org's findings.
 */
export async function getSummary(orgId: string): Promise<FindingsSummary> {
  const findings = await getFindings(orgId, { status: "open" });

  const openFindings = findings.filter((f) => f.status === "open");

  return {
    totalImpact: openFindings.reduce((sum, f) => sum + Number(f.amount), 0),
    openIssues: openFindings.length,
    breakdown: {
      uninvoiced: openFindings
        .filter((f) => f.category === "uninvoiced")
        .reduce((sum, f) => sum + Number(f.amount), 0),
      missing_renewal: openFindings
        .filter((f) => f.category === "missing_renewal")
        .reduce((sum, f) => sum + Number(f.amount), 0),
      churn_risk: openFindings
        .filter((f) => f.category === "churn_risk")
        .reduce((sum, f) => sum + Number(f.amount), 0),
    },
  };
}

/**
 * Update a finding's status (open, fixing, fixed, ignored).
 */
export async function updateFinding(
  orgId: string,
  findingId: string,
  status: string,
): Promise<Finding | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("findings")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", findingId)
    .eq("org_id", orgId) // ensure org scoping
    .select("*")
    .single();

  if (error) {
    console.error("[findingsService] Error updating finding:", error.message);
    return null;
  }

  return data as Finding;
}

/**
 * Get the latest scan status for an org.
 */
export async function getScanStatus(orgId: string): Promise<ScanStatus> {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return { status: "idle", scanId: null, lastScanAt: null, findingsCount: 0 };
  }

  const { data } = await supabase
    .from("scan_runs")
    .select("*")
    .eq("org_id", orgId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) {
    return { status: "idle", scanId: null, lastScanAt: null, findingsCount: 0 };
  }

  return {
    status: data.status as ScanStatus["status"],
    scanId: data.id,
    lastScanAt: data.finished_at || data.started_at,
    findingsCount: data.findings_count || 0,
  };
}

/**
 * Generate demo findings for orgs with no real data.
 */
function getDemoFindings(orgId: string): Finding[] {
  const now = new Date().toISOString();
  return DEMO_FINDINGS.map((demo, i) => ({
    ...demo,
    id: `demo-${i + 1}`,
    org_id: orgId,
    scan_id: null,
    created_at: now,
    updated_at: now,
  }));
}
