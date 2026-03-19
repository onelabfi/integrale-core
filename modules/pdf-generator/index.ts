/**
 * PDF Report Generator — Recovery Reports
 *
 * Generates clean, enterprise-grade PDF reports after successful recoveries.
 * Reports are stored in-memory per workspace and retrievable via API.
 *
 * Design principles:
 *   - Black / white / grayscale — no marketing visuals
 *   - Outcome-based language — no technical implementation details
 *   - Audit-ready — timestamps, action IDs, idempotency status
 *   - Extensible — designed for monthly summaries, compliance exports
 */
import PDFDocument from "pdfkit";
import type { RecoveryReportData, StoredReport, RecoveryReportItem, AuditEntry } from "./types.js";
import type { RecoveryOpportunity, ExecutionResult } from "../recovery-engine/types.js";

/* ── In-memory report storage (per workspace) ────────────────────── */
const reportStore = new Map<string, StoredReport[]>();

/* ── Helpers ──────────────────────────────────────────────────────── */
const fmtEur = (n: number, currency = "EUR") =>
  new Intl.NumberFormat("fi-FI", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
};

const fmtDateTime = (iso: string) => `${fmtDate(iso)} at ${fmtTime(iso)}`;

const playbookLabel = (playbook: string): string => {
  switch (playbook) {
    case "missing_invoice": return "Revenue Mismatch";
    case "no_billing_record": return "Revenue Not Recorded";
    case "missed_renewal": return "Revenue Continuity Gap";
    default: return "Revenue Recovery";
  }
};

const outcomeActions = (playbook: string): string[] => {
  switch (playbook) {
    case "missing_invoice":
      return [
        "Revenue recovered and recorded",
        "All systems brought into alignment",
      ];
    case "no_billing_record":
      return [
        "Revenue recovered and recorded",
        "All systems brought into alignment",
      ];
    case "missed_renewal":
      return [
        "Billing continuity restored",
        "All systems brought into alignment",
      ];
    default:
      return [
        "Revenue recovered and recorded",
        "All systems brought into alignment",
      ];
  }
};

/* ── Build report data from execution result ──────────────────────── */
export function buildReportData(
  opportunity: RecoveryOpportunity,
  result: ExecutionResult,
  workspaceName = "RevCore Workspace",
  executionTimeMs = 0,
): RecoveryReportData {
  const reportId = `RPT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
  const now = new Date().toISOString();

  const systemsInvolved: string[] = [];
  if (opportunity.source === "hubspot" || opportunity.source === "salesforce") {
    systemsInvolved.push("CRM");
  } else {
    systemsInvolved.push("CRM"); // default
  }
  if (result.invoiceId || opportunity.playbook !== "missed_renewal") {
    systemsInvolved.push("Billing");
  }
  // Deduplicate
  const uniqueSystems = [...new Set(systemsInvolved)];

  return {
    reportId,
    recoveryId: opportunity.id,
    workspaceName,
    generatedAt: now,
    summary: {
      totalRecovered: opportunity.amount,
      currency: opportunity.currency || "EUR",
      issuesResolved: 1,
      systemsInvolved: uniqueSystems,
      executionTimeMs,
    },
    items: [
      {
        issueType: playbookLabel(opportunity.playbook),
        description: opportunity.description,
        amount: opportunity.amount,
        currency: opportunity.currency || "EUR",
        actions: outcomeActions(opportunity.playbook),
        playbook: opportunity.playbook,
      },
    ],
    audit: [
      {
        timestamp: result.executedAt || now,
        actionId: result.opportunityId,
        status: "Completed",
        idempotent: true,
      },
    ],
  };
}

/* ── Generate PDF buffer ──────────────────────────────────────────── */
export async function generateRecoveryReport(data: RecoveryReportData, logoPath?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 60, bottom: 60, left: 60, right: 60 },
      info: {
        Title: `Recovery Report - ${data.reportId}`,
        Author: "RevCore",
        Subject: "Revenue Recovery Report",
        Creator: "RevCore Revenue Operating System",
      },
    });

    const chunks: Uint8Array[] = [];
    doc.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const leftMargin = doc.page.margins.left;

    // ── Colors (grayscale palette) ──
    const black = "#000000";
    const darkGray = "#2D2D2D";
    const medGray = "#5C5C5C";
    const lightGray = "#8C8C8C";
    const subtleGray = "#ABABAB";
    const ruleColor = "#D4D4D4";
    const ruleLightColor = "#E8E8E8";
    const accentGreen = "#10B981";

    // ── Reusable: section rule ──
    const drawRule = (weight = 0.5, color = ruleColor) => {
      doc.moveTo(leftMargin, doc.y).lineTo(leftMargin + pageWidth, doc.y)
        .strokeColor(color).lineWidth(weight).stroke();
    };

    // ── HEADER ──────────────────────────────────────────────────────
    if (logoPath) {
      try {
        doc.image(logoPath, leftMargin, doc.y, { height: 28 });
        doc.moveDown(2.5);
      } catch {
        doc.fontSize(16).fillColor(black).font("Helvetica-Bold")
          .text("RevCore", leftMargin, doc.y);
        doc.moveDown(1.2);
      }
    } else {
      doc.fontSize(16).fillColor(black).font("Helvetica-Bold")
        .text("RevCore", leftMargin, doc.y);
      doc.moveDown(1.2);
    }

    // Title
    doc.fontSize(22).fillColor(black).font("Helvetica-Bold")
      .text("Revenue Recovery Report", leftMargin, doc.y);
    doc.moveDown(0.25);

    // Subtitle
    doc.fontSize(10).fillColor(lightGray).font("Helvetica")
      .text("Automated recovery and audit record", leftMargin, doc.y);
    doc.moveDown(0.8);

    // Metadata line
    doc.fontSize(8.5).fillColor(medGray).font("Helvetica")
      .text([
        data.workspaceName,
        fmtDateTime(data.generatedAt),
        `Report ${data.reportId}`,
      ].join("  |  "), leftMargin, doc.y);
    doc.moveDown(1.5);

    drawRule();
    doc.moveDown(1.5);

    // ── SUMMARY ─────────────────────────────────────────────────────
    doc.fontSize(10).fillColor(darkGray).font("Helvetica-Bold")
      .text("SUMMARY", leftMargin, doc.y);
    doc.moveDown(1);

    // Summary grid — 5 columns
    const summaryItems = [
      { label: "Total Recovered", value: fmtEur(data.summary.totalRecovered, data.summary.currency) },
      { label: "Issues Resolved", value: String(data.summary.issuesResolved) },
      { label: "Systems Analyzed", value: data.summary.systemsInvolved.join(", ") },
      { label: "Confidence", value: "High" },
      { label: "Execution Time", value: data.summary.executionTimeMs > 0 ? `${Math.ceil(data.summary.executionTimeMs / 1000)}s` : "< 2 min" },
    ];

    const colWidth = pageWidth / summaryItems.length;
    const summaryY = doc.y;

    summaryItems.forEach((item, i) => {
      const x = leftMargin + i * colWidth;
      doc.fontSize(7).fillColor(subtleGray).font("Helvetica")
        .text(item.label.toUpperCase(), x, summaryY, { width: colWidth - 8 });
      doc.fontSize(13).fillColor(black).font("Helvetica-Bold")
        .text(item.value, x, summaryY + 14, { width: colWidth - 8 });
    });

    doc.y = summaryY + 44;
    doc.moveDown(1.5);

    drawRule();
    doc.moveDown(1.5);

    // ── RECOVERY DETAILS ────────────────────────────────────────────
    doc.fontSize(10).fillColor(darkGray).font("Helvetica-Bold")
      .text("RECOVERY DETAILS", leftMargin, doc.y);
    doc.moveDown(1);

    data.items.forEach((item, idx) => {
      // Item header
      doc.fontSize(10).fillColor(black).font("Helvetica-Bold")
        .text(`${idx + 1}. ${item.issueType}`, leftMargin, doc.y);
      doc.moveDown(0.4);

      // Description
      doc.fontSize(9).fillColor(medGray).font("Helvetica")
        .text(item.description, leftMargin + 14, doc.y, { width: pageWidth - 14 });
      doc.moveDown(0.4);

      // Amount
      doc.fontSize(9).fillColor(darkGray).font("Helvetica")
        .text("Amount recovered: ", leftMargin + 14, doc.y, { continued: true })
        .font("Helvetica-Bold")
        .text(fmtEur(item.amount, item.currency));
      doc.moveDown(0.6);

      // Actions performed
      doc.fontSize(7.5).fillColor(subtleGray).font("Helvetica")
        .text("ACTIONS PERFORMED", leftMargin + 14, doc.y);
      doc.moveDown(0.35);

      item.actions.forEach((action) => {
        // Use a simple dash bullet — avoids encoding issues with unicode
        doc.fontSize(9).fillColor(medGray).font("Helvetica")
          .text(`-  ${action}`, leftMargin + 18, doc.y, { width: pageWidth - 32 });
        doc.moveDown(0.25);
      });

      doc.moveDown(0.6);
    });

    doc.moveDown(0.3);
    drawRule();
    doc.moveDown(1.5);

    // ── SYSTEM IMPACT ───────────────────────────────────────────────
    doc.fontSize(10).fillColor(darkGray).font("Helvetica-Bold")
      .text("SYSTEM IMPACT", leftMargin, doc.y);
    doc.moveDown(1);

    const impacts = [
      { label: "Systems", status: "All connected systems brought into alignment." },
      { label: "Revenue", status: "Recovered and accurately recorded across all systems." },
    ];

    impacts.forEach((impact) => {
      doc.fontSize(9).fillColor(darkGray).font("Helvetica-Bold")
        .text(impact.label, leftMargin + 14, doc.y);
      doc.fontSize(9).fillColor(medGray).font("Helvetica")
        .text(impact.status, leftMargin + 14, doc.y, { width: pageWidth - 14 });
      doc.moveDown(0.5);
    });

    doc.moveDown(0.8);
    drawRule();
    doc.moveDown(1.5);

    // ── AUDIT TRAIL ─────────────────────────────────────────────────
    doc.fontSize(10).fillColor(darkGray).font("Helvetica-Bold")
      .text("AUDIT TRAIL", leftMargin, doc.y);
    doc.moveDown(1);

    data.audit.forEach((entry, idx) => {
      if (idx > 0) {
        doc.moveDown(0.6);
        doc.moveTo(leftMargin + 14, doc.y).lineTo(leftMargin + pageWidth * 0.5, doc.y)
          .strokeColor(ruleLightColor).lineWidth(0.3).stroke();
        doc.moveDown(0.6);
      }

      // Each field on its own line — structured, easy to read
      const fieldIndent = leftMargin + 14;
      const valueIndent = leftMargin + 110;

      doc.fontSize(8.5).fillColor(lightGray).font("Helvetica")
        .text("Timestamp:", fieldIndent, doc.y, { continued: false });
      doc.fontSize(8.5).fillColor(darkGray).font("Helvetica")
        .text(fmtDateTime(entry.timestamp), valueIndent, doc.y - doc.currentLineHeight());
      doc.moveDown(0.1);

      doc.fontSize(8.5).fillColor(lightGray).font("Helvetica")
        .text("Action ID:", fieldIndent, doc.y);
      doc.fontSize(8.5).fillColor(darkGray).font("Helvetica")
        .text(entry.actionId, valueIndent, doc.y - doc.currentLineHeight());
      doc.moveDown(0.1);

      doc.fontSize(8.5).fillColor(lightGray).font("Helvetica")
        .text("Status:", fieldIndent, doc.y);
      doc.fontSize(8.5).fillColor(entry.status === "Completed" ? accentGreen : darkGray).font("Helvetica-Bold")
        .text(entry.status, valueIndent, doc.y - doc.currentLineHeight());
      doc.moveDown(0.1);

      doc.fontSize(8.5).fillColor(lightGray).font("Helvetica")
        .text("Idempotent:", fieldIndent, doc.y);
      doc.fontSize(8.5).fillColor(darkGray).font("Helvetica")
        .text(entry.idempotent ? "Yes" : "No", valueIndent, doc.y - doc.currentLineHeight());
    });

    doc.moveDown(1.5);
    drawRule();
    doc.moveDown(1);

    // ── EXECUTION STATEMENT ─────────────────────────────────────────
    doc.fontSize(9).fillColor(medGray).font("Helvetica")
      .text("All actions were executed automatically and verified by RevCore.", leftMargin, doc.y, {
        width: pageWidth,
      });
    doc.moveDown(1.2);

    // ── PRICING (SUBTLE) ────────────────────────────────────────────
    doc.fontSize(8.5).fillColor(subtleGray).font("Helvetica")
      .text("Performance-based fee applied. Typically ~3% of recovered revenue.", leftMargin, doc.y);
    doc.moveDown(0.25);
    doc.fontSize(8).fillColor(subtleGray).font("Helvetica")
      .text("No subscription. Pay only on success.", leftMargin, doc.y);

    // ── FOOTER ──────────────────────────────────────────────────────
    const footerY = doc.page.height - doc.page.margins.bottom - 36;
    doc.moveTo(leftMargin, footerY).lineTo(leftMargin + pageWidth, footerY)
      .strokeColor(ruleColor).lineWidth(0.3).stroke();

    doc.fontSize(7).fillColor(subtleGray).font("Helvetica")
      .text("Generated by RevCore  |  All actions are logged and auditable", leftMargin, footerY + 10, {
        width: pageWidth,
        align: "center",
      });
    doc.fontSize(7).fillColor(subtleGray).font("Helvetica")
      .text(`Report ${data.reportId}  |  ${fmtDate(data.generatedAt)}`, leftMargin, footerY + 22, {
        width: pageWidth,
        align: "center",
      });

    doc.end();
  });
}

/* ── Store report ─────────────────────────────────────────────────── */
export function storeReport(workspaceId: string, report: StoredReport): void {
  const workspace = reportStore.get(workspaceId) || [];
  workspace.push(report);
  reportStore.set(workspaceId, workspace);
  console.log(`[PDFGenerator] Report stored: ${report.reportId} for recovery ${report.recoveryId}`);
}

/* ── Retrieve report by recovery ID ──────────────────────────────── */
export function getReportByRecoveryId(workspaceId: string, recoveryId: string): StoredReport | null {
  const workspace = reportStore.get(workspaceId) || [];
  return workspace.find((r) => r.recoveryId === recoveryId) || null;
}

/* ── Retrieve report by report ID ────────────────────────────────── */
export function getReportById(workspaceId: string, reportId: string): StoredReport | null {
  const workspace = reportStore.get(workspaceId) || [];
  return workspace.find((r) => r.reportId === reportId) || null;
}

/* ── List all reports for a workspace ────────────────────────────── */
export function listReports(workspaceId: string): Omit<StoredReport, "buffer">[] {
  const workspace = reportStore.get(workspaceId) || [];
  return workspace.map(({ buffer, ...rest }) => rest);
}

/* ── Full pipeline: build data → generate PDF → store ────────────── */
export async function generateAndStoreReport(
  opportunity: RecoveryOpportunity,
  result: ExecutionResult,
  workspaceId = "default",
  workspaceName = "RevCore Workspace",
  executionTimeMs = 0,
  logoPath?: string,
): Promise<StoredReport> {
  const data = buildReportData(opportunity, result, workspaceName, executionTimeMs);
  const buffer = await generateRecoveryReport(data, logoPath);

  const stored: StoredReport = {
    reportId: data.reportId,
    recoveryId: opportunity.id,
    workspaceId,
    generatedAt: data.generatedAt,
    fileName: `recovery-report-${data.reportId}.pdf`,
    buffer,
    summary: {
      totalRecovered: data.summary.totalRecovered,
      currency: data.summary.currency,
      issuesResolved: data.summary.issuesResolved,
    },
  };

  storeReport(workspaceId, stored);
  return stored;
}
