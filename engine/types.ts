/* ── Revenue Leak Detector — Domain Types ─────────────────────────── */

export type ConnectorStatus = "disconnected" | "connecting" | "connected" | "error";

export interface ConnectorState {
  hubspot: ConnectorStatus;
  stripe: ConnectorStatus;
  salesforce: ConnectorStatus;
  sap: ConnectorStatus;
}

/* ── Normalized data models ──────────────────────────────────────── */

export interface Customer {
  id: string;
  name: string;
  email: string;
  source: "hubspot" | "stripe" | "salesforce" | "sap" | "both";
}

export interface Deal {
  id: string;
  customer_id: string;
  company: string;
  name: string;
  amount: number;
  currency: string;
  stage: "closed_won" | "open" | "lost";
  close_date: string;
  source: "hubspot" | "salesforce";
  contact_email?: string;
}

export interface Invoice {
  id: string;
  customer_id: string;
  company: string;
  amount: number;
  currency: string;
  status: "paid" | "open" | "void" | "uncollectible";
  created_at: string;
  due_date: string;
  source: "stripe";
}

export interface Subscription {
  id: string;
  customer_id: string;
  company: string;
  plan: string;
  amount: number;
  currency: string;
  status: "active" | "canceled" | "past_due" | "unpaid";
  current_period_end: string;
  canceled_at: string | null;
  source: "stripe";
}

export interface BusinessPartner {
  id: string;
  name: string;
  category: string;
  type: string;
  firstName: string | null;
  lastName: string | null;
  industry: string | null;
  source: "sap";
}

/* ── Detection results ───────────────────────────────────────────── */

export type LeakCategory = "uninvoiced" | "missing_renewal" | "churn_risk";

export type LeakStatus = "open" | "fixing" | "fixed";

export interface LeakFix {
  trigger: string;
  action: string;
  cause: string;
  impact: string;
}

export interface RevenueLeak {
  id: string;
  category: LeakCategory;
  company: string;
  deal_name: string;
  amount: number;
  currency: string;
  date: string;
  issue: string;
  detail: string;
  source_record_id: string;
  status: LeakStatus;
  fix: LeakFix;
}

export interface LeakSummary {
  uninvoiced_total: number;
  uninvoiced_count: number;
  missing_renewal_total: number;
  missing_renewal_count: number;
  churn_risk_total: number;
  churn_risk_count: number;
  total: number;
  total_count: number;
}

export interface DetectionOutput {
  leaks: RevenueLeak[];
  summary: LeakSummary;
}

export type ScanState = "idle" | "scanning" | "done";
