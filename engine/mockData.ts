/**
 * Mock HubSpot deals, Stripe invoices & subscriptions.
 * Used when no live connector is available.
 */
import type { Customer, Deal, Invoice, Subscription } from "./types.js";

const today = new Date();
const daysAgo = (n: number) => new Date(today.getTime() - n * 86_400_000).toISOString();

/* ── Customers (matched across systems by email) ─────────────────── */
export const MOCK_CUSTOMERS: Customer[] = [
  { id: "cust-001", name: "Virtanen Group", email: "billing@virtanen.fi", source: "both" },
  { id: "cust-002", name: "Mäkinen Logistics", email: "finance@makinen.fi", source: "both" },
  { id: "cust-003", name: "Korhonen Tech", email: "ap@korhonen.io", source: "both" },
  { id: "cust-004", name: "Järvinen Capital", email: "ops@jarvinen.fi", source: "hubspot" },
  { id: "cust-005", name: "Leinonen Group", email: "admin@leinonen.fi", source: "both" },
  { id: "cust-006", name: "Heikkinen Manufacturing", email: "procurement@heikkinen.fi", source: "both" },
  { id: "cust-007", name: "Niemi Retail", email: "accounts@niemi.fi", source: "both" },
  { id: "cust-008", name: "Rantanen Solutions", email: "billing@rantanen.io", source: "both" },
  { id: "cust-009", name: "Lehtonen Holdings", email: "cfo@lehtonen.fi", source: "hubspot" },
  { id: "cust-010", name: "Saarinen Group", email: "finance@saarinen.fi", source: "both" },
  { id: "cust-011", name: "Hakala Partners", email: "billing@hakala.fi", source: "both" },
  { id: "cust-012", name: "Tuominen Digital", email: "admin@tuominen.io", source: "stripe" },
];

/* ── HubSpot Deals (Closed Won) ──────────────────────────────────── */
export const MOCK_DEALS: Deal[] = [
  { id: "deal-001", customer_id: "cust-001", company: "Virtanen Group", name: "Enterprise License", amount: 28400, currency: "EUR", stage: "closed_won", close_date: daysAgo(14), source: "hubspot" },
  { id: "deal-002", customer_id: "cust-002", company: "Mäkinen Logistics", name: "CRM Expansion", amount: 16750, currency: "EUR", stage: "closed_won", close_date: daysAgo(21), source: "hubspot" },
  { id: "deal-003", customer_id: "cust-003", company: "Korhonen Tech", name: "Professional Services", amount: 9200, currency: "EUR", stage: "closed_won", close_date: daysAgo(8), source: "hubspot" },
  { id: "deal-004", customer_id: "cust-004", company: "Järvinen Capital", name: "Advisory Retainer", amount: 4800, currency: "EUR", stage: "closed_won", close_date: daysAgo(35), source: "hubspot" },
  { id: "deal-005", customer_id: "cust-007", company: "Niemi Retail", name: "CRM Implementation", amount: 22000, currency: "EUR", stage: "closed_won", close_date: daysAgo(6), source: "hubspot" },
  { id: "deal-006", customer_id: "cust-008", company: "Rantanen Solutions", name: "Integration Package", amount: 14500, currency: "EUR", stage: "closed_won", close_date: daysAgo(3), source: "hubspot" },
  { id: "deal-007", customer_id: "cust-009", company: "Lehtonen Holdings", name: "Strategic Platform", amount: 31000, currency: "EUR", stage: "closed_won", close_date: daysAgo(18), source: "hubspot" },
  { id: "deal-008", customer_id: "cust-011", company: "Hakala Partners", name: "Consulting Engagement", amount: 5600, currency: "EUR", stage: "closed_won", close_date: daysAgo(2), source: "hubspot" },
];

/* ── Stripe Invoices ─────────────────────────────────────────────── */
export const MOCK_INVOICES: Invoice[] = [
  { id: "inv-003", customer_id: "cust-003", company: "Korhonen Tech", amount: 9200, currency: "EUR", status: "paid", created_at: daysAgo(7), due_date: daysAgo(-23), source: "stripe" },
  { id: "inv-005", customer_id: "cust-007", company: "Niemi Retail", amount: 22000, currency: "EUR", status: "paid", created_at: daysAgo(5), due_date: daysAgo(-25), source: "stripe" },
  { id: "inv-006", customer_id: "cust-008", company: "Rantanen Solutions", amount: 14500, currency: "EUR", status: "paid", created_at: daysAgo(2), due_date: daysAgo(-28), source: "stripe" },
  { id: "inv-008", customer_id: "cust-011", company: "Hakala Partners", amount: 5600, currency: "EUR", status: "paid", created_at: daysAgo(1), due_date: daysAgo(-29), source: "stripe" },
  { id: "inv-009", customer_id: "cust-012", company: "Tuominen Digital", amount: 3200, currency: "EUR", status: "paid", created_at: daysAgo(10), due_date: daysAgo(-20), source: "stripe" },
];

/* ── Stripe Subscriptions ────────────────────────────────────────── */
export const MOCK_SUBSCRIPTIONS: Subscription[] = [
  { id: "sub-001", customer_id: "cust-005", company: "Leinonen Group", plan: "Annual SaaS", amount: 18600, currency: "EUR", status: "canceled", current_period_end: daysAgo(15), canceled_at: daysAgo(15), source: "stripe" },
  { id: "sub-002", customer_id: "cust-006", company: "Heikkinen Manufacturing", plan: "Support Contract", amount: 7400, currency: "EUR", status: "canceled", current_period_end: daysAgo(5), canceled_at: daysAgo(5), source: "stripe" },
  { id: "sub-003", customer_id: "cust-010", company: "Saarinen Group", plan: "Growth Plan", amount: 12800, currency: "EUR", status: "past_due", current_period_end: daysAgo(32), canceled_at: null, source: "stripe" },
  { id: "sub-004", customer_id: "cust-012", company: "Tuominen Digital", plan: "Starter Plan", amount: 3200, currency: "EUR", status: "active", current_period_end: daysAgo(-45), canceled_at: null, source: "stripe" },
  { id: "sub-005", customer_id: "cust-001", company: "Virtanen Group", plan: "Enterprise Support", amount: 9600, currency: "EUR", status: "active", current_period_end: daysAgo(-90), canceled_at: null, source: "stripe" },
];
