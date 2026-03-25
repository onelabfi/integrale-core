/**
 * Integrale Core — REST API Server
 *
 * Endpoints:
 *   POST /api/connectors/:name/connect   — Connect a data source (hubspot | stripe | salesforce | sap)
 *   POST /api/connectors/:name/disconnect — Disconnect a data source
 *   GET  /api/connectors                 — Get connector statuses
 *   POST /api/scan                       — Run leak detection scan
 *   GET  /api/issues                     — Get current leak issues
 *   POST /api/fix/:leakId               — Fix a single leak
 *   POST /api/fix-all                   — Fix all open leaks
 *   POST /api/fix-past                  — Retroactively fix past issues
 *   GET  /api/workflows                 — Get workflow execution history
 *
 * Recovery Engine (playbook-based):
 *   GET  /api/recovery/scan              — Detect recovery opportunities
 *   GET  /api/recovery/preview/:id       — Preview actions (dry run)
 *   POST /api/recovery/execute/:id       — Execute recovery (safe, idempotent)
 *   GET  /api/recovery/history           — Recovery action audit log
 *
 * Reports:
 *   GET  /api/reports                    — List all recovery reports
 *   GET  /api/reports/:id/download       — Download recovery report PDF
 *   GET  /api/reports/recovery/:id       — Download report by recovery ID
 */
import "dotenv/config";
import express from "express";
import cors from "cors";
import { HubSpotConnector } from "../connectors/hubspot.js";
import { StripeConnector } from "../connectors/stripe.js";
import { SalesforceConnector } from "../connectors/salesforce.js";
import { SAPConnector } from "../connectors/sap.js";
import { detectLeaks, generateLeakSummary, generateRootCause, deduplicateDeals } from "../engine/detectionEngine.js";
import { MOCK_DEALS, MOCK_INVOICES, MOCK_SUBSCRIPTIONS, MOCK_CUSTOMERS } from "../engine/mockData.js";
import { WorkflowEngine } from "../workflows/workflowEngine.js";
import { RecoveryEngine, DEFAULT_AUTO_RECOVERY_CONFIG } from "../modules/recovery-engine/index.js";
import type { SafetyEnvelope, AutoRecoveryConfig } from "../modules/recovery-engine/index.js";
import type { RevenueLeak, DetectionOutput, ConnectorState, LeakSummary, LeakCategory } from "../engine/types.js";
import * as tokenEngine from "../modules/token-engine/index.js";
import * as pdfGenerator from "../modules/pdf-generator/index.js";
import { authMiddleware } from "../middleware/authMiddleware.js";
import * as findingsService from "../services/findingsService.js";
import { invalidateCache as invalidateSalesforceCache } from "../lib/salesforceTokenManager.js";

const app = express();

// Base URL for OAuth callbacks — uses PUBLIC_URL env var in production, falls back to localhost
const BASE_URL = process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3001}`;

// ── Health check (Railway / load balancer) ──────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

/* ── Computed state helpers ─────────────────────────────────────────
 * All aggregation and business logic lives here in the core.
 * The frontend receives ready-to-display data.
 */
function computeLiveSummary(currentLeaks: RevenueLeak[]): LeakSummary {
  const open = currentLeaks.filter((l) => l.status === "open");
  const byCategory = (cat: LeakCategory) => open.filter((l) => l.category === cat);
  const sumAmount = (items: RevenueLeak[]) => items.reduce((s, l) => s + l.amount, 0);
  const uninvoiced = byCategory("uninvoiced");
  const renewals = byCategory("missing_renewal");
  const churn = byCategory("churn_risk");
  return {
    uninvoiced_total: sumAmount(uninvoiced),
    uninvoiced_count: uninvoiced.length,
    missing_renewal_total: sumAmount(renewals),
    missing_renewal_count: renewals.length,
    churn_risk_total: sumAmount(churn),
    churn_risk_count: churn.length,
    total: sumAmount(open),
    total_count: open.length,
  };
}

function buildIssuesResponse(currentLeaks: RevenueLeak[]) {
  return {
    leaks: currentLeaks,
    liveSummary: computeLiveSummary(currentLeaks),
    openCount: currentLeaks.filter((l) => l.status === "open").length,
    fixedCount: currentLeaks.filter((l) => l.status === "fixed").length,
    fixedTotal: currentLeaks.filter((l) => l.status === "fixed").reduce((s, l) => s + l.amount, 0),
  };
}
app.use(
  cors({
    origin: [
      "https://integrale-app.vercel.app",
      /\.vercel\.app$/,
      "http://localhost:5173",
      "http://localhost:5175",
      "http://localhost:8080",
    ],
    credentials: true,
  }),
);
app.use(express.json());

// ── State ──────────────────────────────────────────────────────────
const hubspot = new HubSpotConnector();
const stripe = new StripeConnector();
const salesforce = new SalesforceConnector();
const sap = new SAPConnector();
const workflow = new WorkflowEngine();
const recoveryEngine = new RecoveryEngine();

// Build customer email map from mock data for normalization
const customerEmailMap = new Map<string, string>();
for (const c of MOCK_CUSTOMERS) {
  customerEmailMap.set(c.id, c.email);
}
recoveryEngine.setCustomerEmails(customerEmailMap);

let scanResult: DetectionOutput | null = null;
let leaks: RevenueLeak[] = [];
let lastScan: string | null = null;

// ── User credits & auto-recovery state ──────────────────────────────
let userCredits = 1000;
let autoRecoveryConfig: AutoRecoveryConfig = { ...DEFAULT_AUTO_RECOVERY_CONFIG };

// ── Token engine — internal cost tracking (never exposed to users) ──
const tokenAccount = tokenEngine.getOrCreateAccount("default", "growth");
console.log(`[TokenEngine] Initialized account: ${tokenAccount.tokenBalance} tokens (${tokenAccount.planTier} plan)`);

/** Credit purchase plans — 1 token = €1 */
const CREDIT_PLANS = [
  { id: "starter", price: 50, credits: 50, label: "Fix a few issues" },
  { id: "growth", price: 100, credits: 100, label: "Full recovery", recommended: true },
  { id: "scale", price: 200, credits: 200, label: "Recovery + monitoring" },
] as const;

/** Track whether first scan has been used (free) */
let firstScanUsed = false;

// ── GET /api/connectors ────────────────────────────────────────────
app.get("/api/connectors", (_req, res) => {
  const state: ConnectorState = {
    hubspot: hubspot.isConnected() ? "connected" : "disconnected",
    stripe: stripe.isConnected() ? "connected" : "disconnected",
    salesforce: salesforce.isConnected() ? "connected" : "disconnected",
    sap: sap.isConnected() ? "connected" : "disconnected",
  };
  res.json({
    ...state,
    live: {
      hubspot: hubspot.isLive(),
      stripe: stripe.isLive(),
      salesforce: salesforce.isLive(),
      sap: sap.isLive(),
    },
  });
});

// ── POST /api/connectors/:name/connect ─────────────────────────────
app.post("/api/connectors/:name/connect", async (req, res) => {
  const { name } = req.params;
  const orgId = req.body.orgId || process.env.DEFAULT_ORG_ID;
  try {
    if (name === "hubspot") {
      await hubspot.connect({ orgId });
    } else if (name === "stripe") {
      await stripe.connect({ apiKey: process.env.STRIPE_SECRET_KEY });
    } else if (name === "salesforce") {
      invalidateSalesforceCache(); // Always fetch fresh token from Supabase
      await salesforce.connect({ orgId });
    } else if (name === "sap") {
      await sap.connect({ apiKey: process.env.SAP_API_KEY });
    } else {
      res.status(400).json({ error: `Unknown connector: ${name}` });
      return;
    }

    const liveMap: Record<string, () => boolean> = {
      hubspot: () => hubspot.isLive(),
      stripe: () => stripe.isLive(),
      salesforce: () => salesforce.isLive(),
      sap: () => sap.isLive(),
    };

    // Auto-scan after successful connection (fire-and-forget)
    if (orgId) {
      findingsService.runScan(orgId).catch((err) => {
        console.warn(`[auto-scan] Post-connect scan failed:`, err);
      });
    }

    res.json({
      status: "connected",
      live: liveMap[name]?.() ?? false,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/connectors/:name/disconnect ──────────────────────────
app.post("/api/connectors/:name/disconnect", (req, res) => {
  const { name } = req.params;
  if (name === "hubspot") {
    hubspot.disconnect();
  } else if (name === "stripe") {
    stripe.disconnect();
  } else if (name === "salesforce") {
    salesforce.disconnect();
  } else if (name === "sap") {
    sap.disconnect();
  } else {
    res.status(400).json({ error: `Unknown connector: ${name}` });
    return;
  }
  res.json({ status: "disconnected" });
});

// ── POST /api/scan (unified — async, returns scanId) ──────────────
app.post("/api/scan", authMiddleware, async (req, res) => {
  try {
    const result = await findingsService.runScan(req.orgId!);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/findings ─────────────────────────────────────────────
app.get("/api/findings", authMiddleware, async (req, res) => {
  try {
    const filters: findingsService.FindingsFilters = {};
    if (req.query.status) filters.status = req.query.status as string;
    if (req.query.category) filters.category = req.query.category as string;
    const findings = await findingsService.getFindings(req.orgId!, filters);
    res.json({ findings });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/summary ──────────────────────────────────────────────
app.get("/api/summary", authMiddleware, async (req, res) => {
  try {
    const summary = await findingsService.getSummary(req.orgId!);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/scan/status ──────────────────────────────────────────
app.get("/api/scan/status", authMiddleware, async (req, res) => {
  try {
    const status = await findingsService.getScanStatus(req.orgId!);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── PATCH /api/findings/:id ───────────────────────────────────────
app.patch("/api/findings/:id", authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    if (!status || !["open", "fixing", "fixed", "ignored"].includes(status)) {
      res.status(400).json({ error: "Invalid status. Must be: open, fixing, fixed, ignored" });
      return;
    }
    const finding = await findingsService.updateFinding(req.orgId!, req.params.id, status);
    if (!finding) {
      res.status(404).json({ error: "Finding not found" });
      return;
    }
    res.json({ finding });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/scan/legacy (backwards compat — full response) ──────
app.post("/api/scan/legacy", async (_req, res) => {
  try {
    // Ensure connectors are initialized
    const orgId = process.env.DEFAULT_ORG_ID;
    if (!hubspot.isConnected()) await hubspot.connect({ orgId }).catch(() => {});
    if (!stripe.isConnected()) await stripe.connect({ apiKey: process.env.STRIPE_SECRET_KEY }).catch(() => {});
    if (!salesforce.isConnected()) await salesforce.connect({ orgId }).catch(() => {});

    const [hubspotDeals, salesforceDeals, invoices, subscriptions] = await Promise.all([
      hubspot.getDeals().catch(() => MOCK_DEALS),
      salesforce.isConnected() ? salesforce.getDeals().catch(() => []) : Promise.resolve([]),
      stripe.getInvoices().catch(() => MOCK_INVOICES),
      stripe.getSubscriptions().catch(() => MOCK_SUBSCRIPTIONS),
    ]);

    const deals = deduplicateDeals(hubspotDeals, salesforceDeals);

    scanResult = detectLeaks(deals, invoices, subscriptions);
    leaks = scanResult.leaks;
    lastScan = new Date().toISOString();

    const aiSummary = generateLeakSummary(scanResult);
    const { rootCause, recommendation } = generateRootCause(scanResult);

    res.json({
      ...buildIssuesResponse(leaks),
      summary: scanResult.summary,
      aiSummary,
      rootCause,
      recommendation,
      lastScan,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/issues ────────────────────────────────────────────────
app.get("/api/issues", (_req, res) => {
  if (!scanResult) {
    res.json({ leaks: [], summary: null, lastScan: null });
    return;
  }
  res.json({ ...buildIssuesResponse(leaks), summary: scanResult.summary, lastScan });
});

// ── POST /api/fix/:leakId ──────────────────────────────────────────
app.post("/api/fix/:leakId", async (req, res) => {
  const { leakId } = req.params;
  const leak = leaks.find((l) => l.id === leakId);
  if (!leak) {
    res.status(404).json({ error: `Leak not found: ${leakId}` });
    return;
  }

  leak.status = "fixing";

  // Track fix cost via token engine (internal only)
  const tokenResult = await tokenEngine.runWithTokens(
    {
      actionType: "fix_execution",
      recordCount: 1,
      expectedRecoveryEur: leak.amount,
      metadata: { leakId, category: leak.category, amount: leak.amount },
    },
    async () => {
      const result = await workflow.activateFix(leak);
      return result;
    }
  );

  if (tokenResult.blocked) {
    console.warn(`[TokenEngine] Fix blocked: ${tokenResult.blockReason}`);
    // Proceed anyway — tokens are internal, never block user-facing actions
  }

  leak.status = "fixed";

  // Record recovery fee (internal margin tracking)
  if (leak.amount > 0) {
    tokenEngine.recordRecoveryFee("default", leakId, leak.amount, "EUR", tokenResult.tokensUsed);
  }

  res.json({ result: tokenResult.data, leak, ...buildIssuesResponse(leaks) });
});

// ── POST /api/fix-all ──────────────────────────────────────────────
app.post("/api/fix-all", async (_req, res) => {
  const openLeaks = leaks.filter((l) => l.status === "open");
  const totalAmount = openLeaks.reduce((s, l) => s + l.amount, 0);
  openLeaks.forEach((l) => (l.status = "fixing"));

  // Track batch fix cost via token engine (internal only)
  const tokenResult = await tokenEngine.runWithTokens(
    {
      actionType: "fix_execution",
      recordCount: openLeaks.length,
      expectedRecoveryEur: totalAmount,
      metadata: { batchSize: openLeaks.length, totalAmount },
    },
    async () => {
      const results = await workflow.fixAll(openLeaks);
      return results;
    }
  );

  if (tokenResult.blocked) {
    console.warn(`[TokenEngine] Fix-all blocked: ${tokenResult.blockReason}`);
  }

  openLeaks.forEach((l) => (l.status = "fixed"));

  // Record recovery fees for each fixed leak (internal margin tracking)
  for (const leak of openLeaks) {
    if (leak.amount > 0) {
      tokenEngine.recordRecoveryFee("default", leak.id, leak.amount, "EUR", 0);
    }
  }

  res.json({ results: tokenResult.data, ...buildIssuesResponse(leaks) });
});

// ── POST /api/fix-past ─────────────────────────────────────────────
app.post("/api/fix-past", async (_req, res) => {
  const results = await workflow.fixPastIssues(leaks);
  for (const r of results) {
    const leak = leaks.find((l) => l.id === r.leakId);
    if (leak) leak.status = "fixed";
  }
  res.json({ results, ...buildIssuesResponse(leaks) });
});

// ── GET /api/workflows ─────────────────────────────────────────────
app.get("/api/workflows", (_req, res) => {
  res.json({ message: "Workflow history not yet implemented" });
});

/* ═══════════════════════════════════════════════════════════════════
 * RECOVERY ENGINE ENDPOINTS — Playbook-based recovery
 *
 * These endpoints expose the new recovery engine which provides:
 *   - Structured detection (playbook.detect)
 *   - Dry-run preview (playbook.preview)
 *   - Safe execution (playbook.execute with idempotency)
 *   - Audit trail (recovery action log)
 * ═══════════════════════════════════════════════════════════════════ */

// ── GET /api/recovery/scan ─────────────────────────────────────────
// Runs all playbook detectors and returns recovery opportunities.
// Each opportunity includes: id, amount, description, confidence, creditsRequired, safety status
app.get("/api/recovery/scan", async (_req, res) => {
  try {
    // Ensure connectors are initialized (loads OAuth tokens from DB)
    const orgId = process.env.DEFAULT_ORG_ID;
    if (!hubspot.isConnected()) await hubspot.connect({ orgId }).catch(() => {});
    if (!stripe.isConnected()) await stripe.connect({ apiKey: process.env.STRIPE_SECRET_KEY }).catch(() => {});
    if (!salesforce.isConnected()) await salesforce.connect({ orgId }).catch(() => {});

    // Fetch deals from all connected CRMs in parallel
    const [hubspotDeals, salesforceDeals, invoices, subscriptions] = await Promise.all([
      hubspot.getDeals().catch(() => MOCK_DEALS),
      salesforce.isConnected() ? salesforce.getDeals().catch(() => []) : Promise.resolve([]),
      stripe.getInvoices().catch(() => MOCK_INVOICES),
      stripe.getSubscriptions().catch(() => MOCK_SUBSCRIPTIONS),
    ]);

    // Merge deals from both CRMs
    const deals = deduplicateDeals(hubspotDeals, salesforceDeals);

    // Build customer email map from live deal data (supplements mock customer map)
    for (const deal of deals) {
      if (deal.contact_email) {
        customerEmailMap.set(deal.customer_id, deal.contact_email);
      }
    }
    recoveryEngine.setCustomerEmails(customerEmailMap);

    const opportunities = recoveryEngine.scan(deals, invoices, subscriptions);

    // Attach safety status to each opportunity
    const enrichedOpportunities = opportunities.map((opp) => ({
      ...opp,
      safety: recoveryEngine.getSafetyStatus(opp.id),
    }));

    // Trigger auto-recovery after scan (if enabled)
    let autoResult = null;
    if (autoRecoveryConfig.autoRecoveryEnabled) {
      autoResult = await recoveryEngine.runAutoRecovery(autoRecoveryConfig, userCredits);
      userCredits -= autoResult.creditsUsed;
    }

    // Re-fetch opportunities after auto-recovery may have consumed some
    const finalOpportunities = recoveryEngine.getOpportunities();
    const finalEnriched = finalOpportunities.map((opp) => ({
      ...opp,
      safety: recoveryEngine.getSafetyStatus(opp.id),
    }));

    // Build per-source summary
    const sourceMap = new Map<string, { count: number; total: number }>();
    for (const opp of finalOpportunities) {
      const src = opp.source || "unknown";
      const existing = sourceMap.get(src) || { count: 0, total: 0 };
      existing.count++;
      existing.total += opp.amount;
      sourceMap.set(src, existing);
    }
    const sources = Object.fromEntries(sourceMap);

    // Also report which connectors were scanned (even if 0 results)
    const scannedSources: Record<string, { connected: boolean; live: boolean; itemsFound: number; total: number }> = {
      hubspot: {
        connected: hubspot.isConnected(),
        live: hubspot.isLive(),
        itemsFound: sourceMap.get("hubspot")?.count ?? 0,
        total: sourceMap.get("hubspot")?.total ?? 0,
      },
      stripe: {
        connected: stripe.isConnected(),
        live: stripe.isLive(),
        itemsFound: sourceMap.get("stripe")?.count ?? 0,
        total: sourceMap.get("stripe")?.total ?? 0,
      },
      salesforce: {
        connected: salesforce.isConnected(),
        live: salesforce.isLive(),
        itemsFound: sourceMap.get("salesforce")?.count ?? 0,
        total: sourceMap.get("salesforce")?.total ?? 0,
      },
      sap: {
        connected: sap.isConnected(),
        live: sap.isLive(),
        itemsFound: 0,
        total: 0,
      },
    };

    // Track first scan (free) vs re-scan (25 tokens)
    if (!firstScanUsed) {
      firstScanUsed = true;
      console.log("[Scan] First scan — FREE");
    } else {
      // Re-scan costs 25 tokens
      if (userCredits >= 25) {
        userCredits -= 25;
        console.log(`[Scan] Re-scan — deducted 25 tokens. Balance: ${userCredits}`);
      } else {
        console.warn(`[Scan] Re-scan — insufficient tokens (${userCredits}). Scan proceeds but no deduction.`);
      }
    }

    res.json({
      status: "ok",
      opportunities: finalEnriched,
      totalRecoverable: finalOpportunities.reduce((s, o) => s + o.amount, 0),
      count: finalOpportunities.length,
      sources,
      scannedSources,
      credits: userCredits,
      firstScanFree: !firstScanUsed, // false after first scan is used
      autoRecovery: autoResult,
      scannedAt: new Date().toISOString(),
      safety: {
        idempotent: true,
        previewRequired: true,
        previewed: false,
        locked: false,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      error: String(err),
      safety: { idempotent: true, previewRequired: true, previewed: false, locked: false },
      timestamp: new Date().toISOString(),
    });
  }
});

// ── GET /api/recovery/preview/:id ──────────────────────────────────
// Returns a dry-run preview of what execute() would do. No side effects.
// Issues a preview token required for subsequent execute() call.
app.get("/api/recovery/preview/:id", (req, res) => {
  const { id } = req.params;
  const preview = recoveryEngine.preview(id);

  if (!preview) {
    res.status(404).json({
      status: "error",
      error: `Opportunity not found: ${id}. Run /api/recovery/scan first.`,
      safety: { idempotent: true, previewRequired: true, previewed: false, locked: false },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const opportunity = recoveryEngine.getOpportunity(id);
  const safety = recoveryEngine.getSafetyStatus(id);

  res.json({
    status: "ok",
    preview,
    opportunity,
    safety,
    timestamp: new Date().toISOString(),
  });
});

// ── POST /api/recovery/execute/:id ─────────────────────────────────
// Executes recovery for a specific opportunity.
//
// Safety gates enforced (in order):
//   1. Rate limiting — max concurrent + per-minute
//   2. Idempotency — deal already recovered → no-op
//   3. Preview enforcement — must call preview first
//   4. Execution lock — no parallel execution on same deal
//   5. Validation — amount, email, age, exclusions
//   6. Stripe duplicate check — metadata.dealId lookup
//   7. Atomic action record — pending → success | failed
app.post("/api/recovery/execute/:id", async (req, res) => {
  const { id } = req.params;
  const opportunity = recoveryEngine.getOpportunity(id);

  if (!opportunity) {
    res.status(404).json({
      status: "error",
      error: `Opportunity not found: ${id}. Run /api/recovery/scan first.`,
      safety: { idempotent: true, previewRequired: true, previewed: false, locked: false },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  try {
    const result = await recoveryEngine.execute(id);

    if (!result) {
      res.status(500).json({
        status: "error",
        error: "Execution returned no result",
        safety: recoveryEngine.getSafetyStatus(id),
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Also update the legacy leak status if this opportunity corresponds to one
    const legacyLeakId = `leak-uninv-${opportunity.dealId}`;
    const legacyLeak = leaks.find((l) => l.id === legacyLeakId);
    if (legacyLeak && result.success) {
      legacyLeak.status = "fixed";
    }

    // Deduct credits on success
    if (result.success) {
      userCredits -= opportunity.creditsRequired;

      // Token engine: margin guard + cost tracking (internal)
      const estimate = tokenEngine.estimateTokens("fix_execution", 1);
      const marginCheck = tokenEngine.checkMarginGuard(
        estimate.estimatedTokens,
        opportunity.amount,
        "default"
      );

      const deduction = tokenEngine.deductTokens("default", estimate.estimatedTokens, "fix_execution");
      tokenEngine.logUsage({
        workspaceId: "default",
        actionType: "fix_execution",
        tokensEstimated: estimate.estimatedTokens,
        tokensUsed: deduction.tokensDeducted,
        recordsProcessed: 1,
        issuesFound: 0,
        metadata: {
          opportunityId: id,
          amount: opportunity.amount,
          playbook: opportunity.playbook,
          marginGuard: {
            costToFeeRatio: marginCheck.costToFeeRatio,
            estimatedCostEur: marginCheck.estimatedCostEur,
            expectedFeeEur: marginCheck.expectedFeeEur,
          },
        },
        timestamp: new Date().toISOString(),
        durationMs: 0,
        success: true,
        marginGuardTriggered: !marginCheck.allowed,
      });

      // Record performance-based recovery fee with margin data (internal)
      const feeRecord = tokenEngine.recordRecoveryFee(
        "default",
        id,
        opportunity.amount,
        opportunity.currency || "EUR",
        deduction.tokensDeducted
      );
      console.log(
        `[TokenEngine] Recovery: ${feeRecord.recoveredAmount}€ → fee ${feeRecord.finalFee.toFixed(2)}€ (${(feeRecord.appliedPercentage * 100).toFixed(1)}%) | ` +
        `cost ${feeRecord.costEur.toFixed(4)}€ | margin ${feeRecord.marginEur.toFixed(2)}€`
      );
    }

    // Generate recovery report PDF (on success)
    let reportId: string | null = null;
    if (result.success) {
      try {
        const report = await pdfGenerator.generateAndStoreReport(
          opportunity,
          result,
          "default",
          "RevCore Workspace",
          0,
        );
        reportId = report.reportId;
        console.log(`[PDFGenerator] Recovery report generated: ${report.reportId} (${(report.buffer.length / 1024).toFixed(1)} KB)`);
      } catch (pdfErr) {
        console.error("[PDFGenerator] Failed to generate report:", pdfErr);
        // Non-blocking — recovery still succeeded
      }
    }

    // Trigger auto-recovery after manual recovery (if enabled)
    let autoResult = null;
    if (result.success && autoRecoveryConfig.autoRecoveryEnabled) {
      autoResult = await recoveryEngine.runAutoRecovery(autoRecoveryConfig, userCredits);
      userCredits -= autoResult.creditsUsed;
    }

    const remaining = recoveryEngine.getOpportunities();

    res.json({
      status: result.success ? "ok" : "error",
      result,
      amountRecovered: result.success ? opportunity.amount : 0,
      reportId,
      remainingOpportunities: remaining,
      remainingTotal: remaining.reduce((s, o) => s + o.amount, 0),
      credits: userCredits,
      autoRecovery: autoResult,
      safety: recoveryEngine.getSafetyStatus(id),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      error: String(err),
      safety: recoveryEngine.getSafetyStatus(id),
      timestamp: new Date().toISOString(),
    });
  }
});

// ── GET /api/recovery/history ──────────────────────────────────────
// Returns the audit log of all recovery actions.
app.get("/api/recovery/history", (_req, res) => {
  const history = recoveryEngine.getHistory();
  res.json({
    status: "ok",
    actions: history,
    count: history.length,
    retryable: recoveryEngine.getRetryableActions().length,
    timestamp: new Date().toISOString(),
  });
});

// ── GET /api/recovery/safety/:id ───────────────────────────────────
// Returns safety status for a specific opportunity (for UI signals).
app.get("/api/recovery/safety/:id", (req, res) => {
  const { id } = req.params;
  const safety = recoveryEngine.getSafetyStatus(id);
  res.json({
    status: "ok",
    opportunityId: id,
    safety,
    timestamp: new Date().toISOString(),
  });
});

/* ═══════════════════════════════════════════════════════════════════
 * CREDITS ENDPOINTS
 * ═══════════════════════════════════════════════════════════════════ */

// ── GET /api/credits ──────────────────────────────────────────────
app.get("/api/credits", (_req, res) => {
  const opportunities = recoveryEngine.getOpportunities();
  const totalRecoverable = opportunities.reduce((s, o) => s + o.amount, 0);
  const totalCreditsNeeded = opportunities.reduce((s, o) => s + o.creditsRequired, 0);

  res.json({
    status: "ok",
    credits: userCredits,
    plans: CREDIT_PLANS,
    context: {
      totalRecoverable,
      totalCreditsNeeded,
      opportunityCount: opportunities.length,
    },
    timestamp: new Date().toISOString(),
  });
});

// ── POST /api/credits/purchase ────────────────────────────────────
app.post("/api/credits/purchase", (req, res) => {
  const { planId } = req.body;
  const plan = CREDIT_PLANS.find((p) => p.id === planId);

  if (!plan) {
    res.status(400).json({
      status: "error",
      error: `Unknown plan: ${planId}. Valid plans: ${CREDIT_PLANS.map((p) => p.id).join(", ")}`,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  userCredits += plan.credits;

  console.log(`[Credits] Purchased ${plan.id}: +${plan.credits} credits (total: ${userCredits})`);

  res.json({
    status: "ok",
    creditsAdded: plan.credits,
    totalCredits: userCredits,
    plan: { id: plan.id, price: plan.price, credits: plan.credits },
    timestamp: new Date().toISOString(),
  });
});

/* ═══════════════════════════════════════════════════════════════════
 * AUTO-RECOVERY ENDPOINTS
 * ═══════════════════════════════════════════════════════════════════ */

// ── GET /api/recovery/auto/config ─────────────────────────────────
app.get("/api/recovery/auto/config", (_req, res) => {
  res.json({
    status: "ok",
    config: autoRecoveryConfig,
    timestamp: new Date().toISOString(),
  });
});

// ── PUT /api/recovery/auto/config ─────────────────────────────────
app.put("/api/recovery/auto/config", (req, res) => {
  const update = req.body;

  if (typeof update.autoRecoveryEnabled === "boolean") {
    autoRecoveryConfig.autoRecoveryEnabled = update.autoRecoveryEnabled;
  }
  if (typeof update.maxPerAction === "number" && update.maxPerAction > 0) {
    autoRecoveryConfig.maxPerAction = update.maxPerAction;
  }
  if (typeof update.maxPerDay === "number" && update.maxPerDay > 0) {
    autoRecoveryConfig.maxPerDay = update.maxPerDay;
  }
  if (Array.isArray(update.allowedConfidence)) {
    autoRecoveryConfig.allowedConfidence = update.allowedConfidence;
  }
  if (Array.isArray(update.allowedRisk)) {
    autoRecoveryConfig.allowedRisk = update.allowedRisk;
  }

  console.log("[AutoRecovery] Config updated:", JSON.stringify(autoRecoveryConfig));

  res.json({
    status: "ok",
    config: autoRecoveryConfig,
    timestamp: new Date().toISOString(),
  });
});

// ── POST /api/recovery/auto/run ───────────────────────────────────
// Triggers auto-recovery manually. Also runs after scan and after manual recovery.
app.post("/api/recovery/auto/run", async (_req, res) => {
  try {
    const result = await recoveryEngine.runAutoRecovery(autoRecoveryConfig, userCredits);

    // Deduct credits for successful recoveries
    userCredits -= result.creditsUsed;

    res.json({
      status: "ok",
      result,
      creditsRemaining: userCredits,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      error: String(err),
      timestamp: new Date().toISOString(),
    });
  }
});

/* ═══════════════════════════════════════════════════════════════════
 * HUBSPOT OAUTH FLOW — Connect HubSpot via OAuth
 * ═══════════════════════════════════════════════════════════════════ */
import { getSupabaseAdmin } from "../lib/supabaseAdmin.js";

// ── GET /api/hubspot/auth-url ────────────────────────────────────
// Returns the HubSpot OAuth authorization URL
app.get("/api/hubspot/auth-url", (_req, res) => {
  const clientId = process.env.HUBSPOT_CLIENT_ID;
  if (!clientId) {
    res.status(500).json({ error: "HUBSPOT_CLIENT_ID not configured" });
    return;
  }

  const redirectUri = `${BASE_URL}/api/hubspot/callback`;
  const scopes = ["oauth", "crm.objects.companies.read", "crm.objects.deals.read", "crm.objects.contacts.read"];

  const url = new URL("https://app-eu1.hubspot.com/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes.join(" "));

  res.redirect(url.toString());
});

// ── GET /api/hubspot/callback ────────────────────────────────────
// HubSpot redirects here with ?code=... after user authorizes
app.get("/api/hubspot/callback", async (req, res) => {
  const code = req.query.code as string;
  const error = req.query.error as string;

  if (error) {
    res.send(`<html><body><h2>HubSpot OAuth Error</h2><p>${error}</p><script>setTimeout(()=>window.close(),3000)</script></body></html>`);
    return;
  }

  if (!code) {
    res.status(400).send("Missing authorization code");
    return;
  }

  const clientId = process.env.HUBSPOT_CLIENT_ID!;
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET!;
  const redirectUri = `${BASE_URL}/api/hubspot/callback`;
  const orgId = process.env.DEFAULT_ORG_ID!;

  try {
    // Exchange code for tokens
    const tokenRes = await fetch("https://api.hubapi.com/oauth/v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error("[HubSpot OAuth] Token exchange failed:", tokenData);
      res.send(`<html><body><h2>Token Exchange Failed</h2><pre>${JSON.stringify(tokenData, null, 2)}</pre></body></html>`);
      return;
    }

    console.log("[HubSpot OAuth] Token exchange successful");

    // Fetch account info
    let hubId: string | null = null;
    let hubDomain: string | null = null;
    let userEmail: string | null = null;
    try {
      const infoRes = await fetch(`https://api.hubapi.com/oauth/v1/access-tokens/${tokenData.access_token}`);
      if (infoRes.ok) {
        const info = await infoRes.json();
        hubId = info.hub_id?.toString() || null;
        hubDomain = info.hub_domain || null;
        userEmail = info.user || null;
        console.log(`[HubSpot OAuth] Account: ${hubDomain} (${userEmail})`);
      }
    } catch (e) {
      console.warn("[HubSpot OAuth] Could not fetch account info:", e);
    }

    // Store in Supabase hubspot_connections table
    const sb = getSupabaseAdmin();
    if (sb && orgId) {
      const expiresAt = tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
        : null;

      const { error: upsertError } = await sb
        .from("hubspot_connections")
        .upsert(
          {
            organization_id: orgId,
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token || null,
            expires_at: expiresAt,
            hub_id: hubId,
            hub_domain: hubDomain,
            user_email: userEmail,
            token_type: "Bearer",
          },
          { onConflict: "organization_id" }
        );

      if (upsertError) {
        console.error("[HubSpot OAuth] Failed to store connection:", upsertError);
      } else {
        console.log("[HubSpot OAuth] Connection stored in Supabase ✓");
      }
    }

    // Auto-reconnect the HubSpot connector with the new token
    hubspot.disconnect();
    await hubspot.connect({ orgId });

    res.send(`
      <html>
        <body style="font-family:system-ui;text-align:center;padding:60px">
          <h2 style="color:#22c55e">✓ HubSpot Connected!</h2>
          <p>Account: <strong>${hubDomain || "unknown"}</strong></p>
          <p>Email: ${userEmail || "unknown"}</p>
          <p>Live data: <strong>${hubspot.isLive() ? "YES ✓" : "Mock mode"}</strong></p>
          <p style="color:#888;margin-top:20px">You can close this tab and return to RevCore.</p>
          <script>setTimeout(()=>window.close(),5000)</script>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("[HubSpot OAuth] Error:", err);
    res.status(500).send(`<html><body><h2>Error</h2><pre>${String(err)}</pre></body></html>`);
  }
});

/* ═══════════════════════════════════════════════════════════════════
 * SALESFORCE OAUTH FLOW — Connect Salesforce via OAuth (with PKCE)
 * ═══════════════════════════════════════════════════════════════════ */
import crypto from "node:crypto";

// Store PKCE code_verifier between auth-url and callback
let sfPkceCodeVerifier: string | null = null;

// ── GET /api/salesforce/auth-url ────────────────────────────────
// Returns the Salesforce OAuth authorization URL (PKCE-enabled)
app.get("/api/salesforce/auth-url", (_req, res) => {
  const clientId = process.env.SALESFORCE_CLIENT_ID;
  if (!clientId) {
    res.status(500).json({ error: "SALESFORCE_CLIENT_ID not configured" });
    return;
  }

  const redirectUri = `${BASE_URL}/api/salesforce/callback`;
  const scopes = ["api", "refresh_token", "offline_access"];

  // Generate PKCE code_verifier (43–128 chars, URL-safe)
  const codeVerifier = crypto.randomBytes(64).toString("base64url").slice(0, 128);
  sfPkceCodeVerifier = codeVerifier;

  // SHA-256 hash → base64url = code_challenge
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

  const url = new URL("https://login.salesforce.com/services/oauth2/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  res.redirect(url.toString());
});

// ── GET /api/salesforce/callback ────────────────────────────────
// Salesforce redirects here with ?code=... after user authorizes
app.get("/api/salesforce/callback", async (req, res) => {
  const code = req.query.code as string;
  const error = req.query.error as string;

  if (error) {
    const desc = req.query.error_description || error;
    res.send(`<html><body><h2>Salesforce OAuth Error</h2><p>${desc}</p><script>setTimeout(()=>window.close(),3000)</script></body></html>`);
    return;
  }

  if (!code) {
    res.status(400).send("Missing authorization code");
    return;
  }

  const clientId = process.env.SALESFORCE_CLIENT_ID!;
  const clientSecret = process.env.SALESFORCE_CLIENT_SECRET!;
  const redirectUri = `${BASE_URL}/api/salesforce/callback`;
  const orgId = process.env.DEFAULT_ORG_ID!;

  try {
    // Exchange code for tokens (with PKCE code_verifier)
    const tokenParams: Record<string, string> = {
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    };
    if (sfPkceCodeVerifier) {
      tokenParams.code_verifier = sfPkceCodeVerifier;
      sfPkceCodeVerifier = null; // consume it
    }
    const tokenRes = await fetch("https://login.salesforce.com/services/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(tokenParams),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error("[Salesforce OAuth] Token exchange failed:", tokenData);
      res.send(`<html><body><h2>Token Exchange Failed</h2><pre>${JSON.stringify(tokenData, null, 2)}</pre></body></html>`);
      return;
    }

    console.log("[Salesforce OAuth] Token exchange successful");

    // Extract instance URL and identity info
    const instanceUrl = tokenData.instance_url || "https://login.salesforce.com";
    let userEmail: string | null = null;
    let orgName: string | null = null;

    // Fetch user info from identity URL
    if (tokenData.id) {
      try {
        const idRes = await fetch(tokenData.id, {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        if (idRes.ok) {
          const idData = await idRes.json();
          userEmail = idData.email || null;
          orgName = idData.organization_id || null;
          console.log(`[Salesforce OAuth] User: ${userEmail}, Org: ${orgName}`);
        }
      } catch (e) {
        console.warn("[Salesforce OAuth] Could not fetch identity info:", e);
      }
    }

    // Store in Supabase salesforce_connections table
    const sb = getSupabaseAdmin();
    if (sb && orgId) {
      const { error: upsertError } = await sb
        .from("salesforce_connections")
        .upsert(
          {
            organization_id: orgId,
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token || null,
            instance_url: instanceUrl,
            token_type: tokenData.token_type || "Bearer",
            sf_username: userEmail,
          },
          { onConflict: "organization_id" }
        );

      if (upsertError) {
        console.error("[Salesforce OAuth] Failed to store connection:", upsertError);
      } else {
        console.log("[Salesforce OAuth] Connection stored in Supabase ✓");
      }
    }

    // Auto-reconnect the Salesforce connector with the new token
    salesforce.disconnect();
    await salesforce.connect({ orgId });

    res.send(`
      <html>
        <body style="font-family:system-ui;text-align:center;padding:60px">
          <h2 style="color:#22c55e">✓ Salesforce Connected!</h2>
          <p>Instance: <strong>${instanceUrl}</strong></p>
          <p>Email: ${userEmail || "unknown"}</p>
          <p>Live data: <strong>${salesforce.isLive() ? "YES ✓" : "Mock mode"}</strong></p>
          <p style="color:#888;margin-top:20px">You can close this tab and return to RevCore.</p>
          <script>setTimeout(()=>window.close(),5000)</script>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("[Salesforce OAuth] Error:", err);
    res.status(500).send(`<html><body><h2>Error</h2><pre>${String(err)}</pre></body></html>`);
  }
});

/* ═══════════════════════════════════════════════════════════════════
 * INTERNAL ADMIN ENDPOINTS — Token Engine Dashboard
 * These are NEVER exposed to end users. Admin-only for margin
 * visibility, cost monitoring, and anomaly detection.
 * ═══════════════════════════════════════════════════════════════════ */

// ── GET /api/admin/tokens/account ─────────────────────────────────
app.get("/api/admin/tokens/account", (_req, res) => {
  const account = tokenEngine.getAccount("default");
  if (!account) {
    res.status(404).json({ error: "No token account found" });
    return;
  }
  res.json({ status: "ok", account, timestamp: new Date().toISOString() });
});

// ── GET /api/admin/tokens/usage ──────────────────────────────────
app.get("/api/admin/tokens/usage", (req, res) => {
  const limit = parseInt(req.query.limit as string) || 100;
  const logs = tokenEngine.getUsageLogs("default", limit);
  res.json({
    status: "ok",
    entries: logs,
    count: logs.length,
    timestamp: new Date().toISOString(),
  });
});

// ── GET /api/admin/tokens/report ─────────────────────────────────
app.get("/api/admin/tokens/report", (req, res) => {
  const start = req.query.start as string | undefined;
  const end = req.query.end as string | undefined;
  const report = tokenEngine.generateAdminReport("default", start, end);
  res.json({ status: "ok", report, timestamp: new Date().toISOString() });
});

// ── GET /api/admin/token-report — alias for convenience ─────────
app.get("/api/admin/token-report", (req, res) => {
  const start = req.query.start as string | undefined;
  const end = req.query.end as string | undefined;
  const report = tokenEngine.generateAdminReport("default", start, end);
  res.json({ status: "ok", report, timestamp: new Date().toISOString() });
});

// ── GET /api/admin/tokens/fees ───────────────────────────────────
app.get("/api/admin/tokens/fees", (_req, res) => {
  const fees = tokenEngine.getRecoveryFees("default");
  const totalRecovered = fees.reduce((s, f) => s + f.recoveredAmount, 0);
  const totalFees = fees.reduce((s, f) => s + f.finalFee, 0);
  res.json({
    status: "ok",
    fees,
    summary: {
      totalRecovered,
      totalFees,
      effectiveRate: totalRecovered > 0 ? (totalFees / totalRecovered * 100).toFixed(2) + "%" : "0%",
      count: fees.length,
    },
    timestamp: new Date().toISOString(),
  });
});

// ── POST /api/admin/tokens/topup ─────────────────────────────────
app.post("/api/admin/tokens/topup", (req, res) => {
  const { amount = 10000, reason = "manual_topup" } = req.body;
  const account = tokenEngine.addTokens("default", amount, reason);
  console.log(`[TokenEngine] Admin top-up: +${amount} tokens (reason: ${reason})`);
  res.json({ status: "ok", account, timestamp: new Date().toISOString() });
});

// ── POST /api/admin/tokens/upgrade ───────────────────────────────
app.post("/api/admin/tokens/upgrade", (req, res) => {
  const { tier } = req.body;
  if (!["starter", "growth", "enterprise", "unlimited"].includes(tier)) {
    res.status(400).json({ error: `Invalid tier: ${tier}` });
    return;
  }
  const account = tokenEngine.upgradePlan("default", tier);
  console.log(`[TokenEngine] Plan upgraded to: ${tier}`);
  res.json({ status: "ok", account, timestamp: new Date().toISOString() });
});

// ── GET /api/reports ──────────────────────────────────────────────
// List all recovery reports for the workspace.
app.get("/api/reports", (_req, res) => {
  const reports = pdfGenerator.listReports("default");
  res.json({
    status: "ok",
    reports,
    count: reports.length,
    timestamp: new Date().toISOString(),
  });
});

// ── GET /api/reports/:reportId/download ──────────────────────────
// Download a specific recovery report PDF.
app.get("/api/reports/:reportId/download", (req, res) => {
  const { reportId } = req.params;
  const report = pdfGenerator.getReportById("default", reportId);

  if (!report) {
    res.status(404).json({
      status: "error",
      error: `Report not found: ${reportId}`,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${report.fileName}"`);
  res.setHeader("Content-Length", report.buffer.length);
  res.send(report.buffer);
});

// ── GET /api/reports/recovery/:recoveryId ────────────────────────
// Get report by recovery/opportunity ID.
app.get("/api/reports/recovery/:recoveryId", (req, res) => {
  const { recoveryId } = req.params;
  const report = pdfGenerator.getReportByRecoveryId("default", recoveryId);

  if (!report) {
    res.status(404).json({
      status: "error",
      error: `No report found for recovery: ${recoveryId}`,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${report.fileName}"`);
  res.setHeader("Content-Length", report.buffer.length);
  res.send(report.buffer);
});

// ── Start ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Integrale Core API running on port ${PORT}`);
  console.log(`Public URL: ${BASE_URL}`);
});
