/**
 * Integrale Core — REST API Server
 *
 * Endpoints:
 *   POST /api/connectors/:name/connect   — Connect a data source (hubspot | stripe)
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
 */
import express from "express";
import cors from "cors";
import { HubSpotConnector } from "../connectors/hubspot.js";
import { StripeConnector } from "../connectors/stripe.js";
import { detectLeaks, generateLeakSummary, generateRootCause } from "../engine/detectionEngine.js";
import { MOCK_DEALS, MOCK_INVOICES, MOCK_SUBSCRIPTIONS, MOCK_CUSTOMERS } from "../engine/mockData.js";
import { WorkflowEngine } from "../workflows/workflowEngine.js";
import { RecoveryEngine } from "../modules/recovery-engine/index.js";
import type { RevenueLeak, DetectionOutput, ConnectorState, LeakSummary, LeakCategory } from "../engine/types.js";

const app = express();

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
app.use(cors());
app.use(express.json());

// ── State ──────────────────────────────────────────────────────────
const hubspot = new HubSpotConnector();
const stripe = new StripeConnector();
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

// ── GET /api/connectors ────────────────────────────────────────────
app.get("/api/connectors", (_req, res) => {
  const state: ConnectorState = {
    hubspot: hubspot.isConnected() ? "connected" : "disconnected",
    stripe: stripe.isConnected() ? "connected" : "disconnected",
  };
  res.json(state);
});

// ── POST /api/connectors/:name/connect ─────────────────────────────
app.post("/api/connectors/:name/connect", async (req, res) => {
  const { name } = req.params;
  try {
    if (name === "hubspot") {
      await hubspot.connect();
    } else if (name === "stripe") {
      await stripe.connect();
    } else {
      res.status(400).json({ error: `Unknown connector: ${name}` });
      return;
    }
    res.json({ status: "connected" });
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
  } else {
    res.status(400).json({ error: `Unknown connector: ${name}` });
    return;
  }
  res.json({ status: "disconnected" });
});

// ── POST /api/scan ─────────────────────────────────────────────────
app.post("/api/scan", async (_req, res) => {
  try {
    const deals = await hubspot.getDeals().catch(() => MOCK_DEALS);
    const invoices = await stripe.getInvoices().catch(() => MOCK_INVOICES);
    const subscriptions = await stripe.getSubscriptions().catch(() => MOCK_SUBSCRIPTIONS);

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
  const result = await workflow.activateFix(leak);
  leak.status = "fixed";

  res.json({ result, leak, ...buildIssuesResponse(leaks) });
});

// ── POST /api/fix-all ──────────────────────────────────────────────
app.post("/api/fix-all", async (_req, res) => {
  const openLeaks = leaks.filter((l) => l.status === "open");
  openLeaks.forEach((l) => (l.status = "fixing"));

  const results = await workflow.fixAll(openLeaks);
  openLeaks.forEach((l) => (l.status = "fixed"));

  res.json({ results, ...buildIssuesResponse(leaks) });
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
// Each opportunity includes: id, amount, description, confidence, creditsRequired
app.get("/api/recovery/scan", async (_req, res) => {
  try {
    const deals = await hubspot.getDeals().catch(() => MOCK_DEALS);
    const invoices = await stripe.getInvoices().catch(() => MOCK_INVOICES);

    const opportunities = recoveryEngine.scan(deals, invoices);

    res.json({
      opportunities,
      totalRecoverable: opportunities.reduce((s, o) => s + o.amount, 0),
      count: opportunities.length,
      scannedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/recovery/preview/:id ──────────────────────────────────
// Returns a dry-run preview of what execute() would do. No side effects.
app.get("/api/recovery/preview/:id", (req, res) => {
  const { id } = req.params;
  const preview = recoveryEngine.preview(id);

  if (!preview) {
    res.status(404).json({ error: `Opportunity not found: ${id}. Run /api/recovery/scan first.` });
    return;
  }

  const opportunity = recoveryEngine.getOpportunity(id);
  res.json({
    preview,
    opportunity,
  });
});

// ── POST /api/recovery/execute/:id ─────────────────────────────────
// Executes recovery for a specific opportunity. Idempotent and safe.
// Creates Stripe invoice, updates HubSpot deal, logs recovery action.
app.post("/api/recovery/execute/:id", async (req, res) => {
  const { id } = req.params;
  const opportunity = recoveryEngine.getOpportunity(id);

  if (!opportunity) {
    res.status(404).json({ error: `Opportunity not found: ${id}. Run /api/recovery/scan first.` });
    return;
  }

  try {
    const result = await recoveryEngine.execute(id);

    if (!result) {
      res.status(500).json({ error: "Execution returned no result" });
      return;
    }

    // Also update the legacy leak status if this opportunity corresponds to one
    const legacyLeakId = `leak-uninv-${opportunity.dealId}`;
    const legacyLeak = leaks.find((l) => l.id === legacyLeakId);
    if (legacyLeak && result.success) {
      legacyLeak.status = "fixed";
    }

    res.json({
      result,
      // Return updated opportunities list
      remainingOpportunities: recoveryEngine.getOpportunities(),
      remainingTotal: recoveryEngine.getOpportunities().reduce((s, o) => s + o.amount, 0),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/recovery/history ──────────────────────────────────────
// Returns the audit log of all recovery actions.
app.get("/api/recovery/history", (_req, res) => {
  res.json({
    actions: recoveryEngine.getHistory(),
    count: recoveryEngine.getHistory().length,
  });
});

// ── Start ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Integrale Core API running on http://localhost:${PORT}`);
});
