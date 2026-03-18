/**
 * Workflow Engine
 * Manages fix workflows — activating automations for individual or batch leak fixes.
 * Currently simulates execution with delays.
 */
import type { RevenueLeak, LeakStatus } from "../engine/types.js";

export interface WorkflowResult {
  leakId: string;
  previousStatus: LeakStatus;
  newStatus: LeakStatus;
  executedAt: string;
}

export class WorkflowEngine {
  /**
   * Activate a fix for a single leak.
   * In production, this would trigger actual integrations (create invoice, send email, etc.)
   */
  async activateFix(leak: RevenueLeak): Promise<WorkflowResult> {
    // Simulate workflow execution
    await new Promise((r) => setTimeout(r, 800));
    return {
      leakId: leak.id,
      previousStatus: leak.status,
      newStatus: "fixed",
      executedAt: new Date().toISOString(),
    };
  }

  /**
   * Fix all open leaks in batch.
   */
  async fixAll(leaks: RevenueLeak[]): Promise<WorkflowResult[]> {
    const openLeaks = leaks.filter((l) => l.status === "open");
    // Simulate batch execution
    await new Promise((r) => setTimeout(r, 1200));
    return openLeaks.map((leak) => ({
      leakId: leak.id,
      previousStatus: leak.status as LeakStatus,
      newStatus: "fixed" as LeakStatus,
      executedAt: new Date().toISOString(),
    }));
  }

  /**
   * Fix past issues retroactively, one by one with visual cascade.
   */
  async fixPastIssues(leaks: RevenueLeak[]): Promise<WorkflowResult[]> {
    const openLeaks = leaks.filter((l) => l.status === "open");
    const results: WorkflowResult[] = [];
    for (const leak of openLeaks) {
      await new Promise((r) => setTimeout(r, 300));
      results.push({
        leakId: leak.id,
        previousStatus: leak.status,
        newStatus: "fixed",
        executedAt: new Date().toISOString(),
      });
    }
    return results;
  }
}
