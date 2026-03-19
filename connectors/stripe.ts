/**
 * Stripe Connector
 * Fetches real invoices and subscriptions from Stripe using the official SDK.
 * Falls back to mock data when no API key is available.
 */
import type { Invoice, Subscription as AppSubscription } from "../engine/types.js";
import { MOCK_INVOICES, MOCK_SUBSCRIPTIONS } from "../engine/mockData.js";
import { normalizeCustomerId } from "../lib/customerMatcher.js";
import Stripe from "stripe";

export interface StripeConnectorConfig {
  apiKey?: string;
  useMock?: boolean;
}

export class StripeConnector {
  private connected = false;
  private client: Stripe | null = null;
  private useMock = false;

  async connect(config?: StripeConnectorConfig): Promise<void> {
    const apiKey = config?.apiKey || process.env.STRIPE_SECRET_KEY;
    this.useMock = config?.useMock || false;

    if (this.useMock || !apiKey) {
      console.log("[Stripe] Using mock data (no API key or mock forced)");
      this.useMock = true;
      this.connected = true;
      return;
    }

    try {
      this.client = new Stripe(apiKey, { apiVersion: "2024-12-18.acacia" as any });

      // Verify the key works
      await this.client.accounts.retrieve();
      this.connected = true;
      console.log("[Stripe] Connected with live API key");
    } catch (err) {
      console.warn("[Stripe] Connection error — falling back to mock data:", err);
      this.client = null;
      this.useMock = true;
      this.connected = true;
    }
  }

  disconnect(): void {
    this.connected = false;
    this.client = null;
    this.useMock = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  isLive(): boolean {
    return this.connected && !this.useMock && !!this.client;
  }

  async getInvoices(): Promise<Invoice[]> {
    if (!this.connected) throw new Error("Stripe not connected");
    if (this.useMock || !this.client) return MOCK_INVOICES;

    try {
      const invoices = await this.fetchAllInvoices();
      console.log(`[Stripe] Fetched ${invoices.length} invoices from live API`);
      return invoices;
    } catch (err) {
      console.error("[Stripe] Error fetching invoices — falling back to mock:", err);
      return MOCK_INVOICES;
    }
  }

  async getSubscriptions(): Promise<AppSubscription[]> {
    if (!this.connected) throw new Error("Stripe not connected");
    if (this.useMock || !this.client) return MOCK_SUBSCRIPTIONS;

    try {
      const subs = await this.fetchAllSubscriptions();
      console.log(`[Stripe] Fetched ${subs.length} subscriptions from live API`);
      return subs;
    } catch (err) {
      console.error("[Stripe] Error fetching subscriptions — falling back to mock:", err);
      return MOCK_SUBSCRIPTIONS;
    }
  }

  private async fetchAllInvoices(): Promise<Invoice[]> {
    const invoices: Invoice[] = [];
    const stripe = this.client!;

    // Fetch invoices from the last 90 days
    const since = Math.floor((Date.now() - 90 * 86_400_000) / 1000);

    for await (const inv of stripe.invoices.list({
      limit: 100,
      created: { gte: since },
      expand: ["data.customer"],
    })) {
      const mapped = this.mapInvoice(inv);
      if (mapped) invoices.push(mapped);
    }

    return invoices;
  }

  private mapInvoice(inv: Stripe.Invoice): Invoice | null {
    // Get customer info
    const customer =
      typeof inv.customer === "object" && inv.customer !== null
        ? (inv.customer as Stripe.Customer)
        : null;

    const customerEmail = customer?.email || null;
    const customerName = customer?.name || "Unknown Company";
    const customerId = normalizeCustomerId(customerEmail, customerName);

    // Map status
    let status: Invoice["status"];
    switch (inv.status) {
      case "paid":
        status = "paid";
        break;
      case "open":
        status = "open";
        break;
      case "void":
        status = "void";
        break;
      case "uncollectible":
        status = "uncollectible";
        break;
      default:
        return null; // Skip draft invoices
    }

    return {
      id: inv.id,
      customer_id: customerId,
      company: customerName,
      amount: (inv.amount_due || 0) / 100, // Stripe uses cents
      currency: (inv.currency || "eur").toUpperCase(),
      status,
      created_at: new Date((inv.created || 0) * 1000).toISOString(),
      due_date: inv.due_date
        ? new Date(inv.due_date * 1000).toISOString()
        : new Date((inv.created || 0) * 1000 + 30 * 86_400_000).toISOString(),
      source: "stripe",
    };
  }

  private async fetchAllSubscriptions(): Promise<AppSubscription[]> {
    const subs: AppSubscription[] = [];
    const stripe = this.client!;

    for await (const sub of stripe.subscriptions.list({
      limit: 100,
      status: "all",
      expand: ["data.customer", "data.items.data.price"],
    })) {
      const mapped = this.mapSubscription(sub);
      if (mapped) subs.push(mapped);
    }

    return subs;
  }

  private mapSubscription(sub: Stripe.Subscription): AppSubscription | null {
    // Get customer info
    const customer =
      typeof sub.customer === "object" && sub.customer !== null
        ? (sub.customer as Stripe.Customer)
        : null;

    const customerEmail = customer?.email || null;
    const customerName = customer?.name || "Unknown Company";
    const customerId = normalizeCustomerId(customerEmail, customerName);

    // Get plan name
    let planName = "Unknown Plan";
    const firstItem = sub.items?.data?.[0];
    if (firstItem?.price) {
      const product = firstItem.price.product;
      if (typeof product === "object" && product !== null && "name" in product) {
        planName = (product as Stripe.Product).name || planName;
      } else if (firstItem.price.nickname) {
        planName = firstItem.price.nickname;
      }
    }

    // Calculate amount
    const amount = firstItem?.price
      ? ((firstItem.price.unit_amount || 0) / 100) * (firstItem.quantity || 1)
      : 0;

    // Map status
    let status: AppSubscription["status"];
    switch (sub.status) {
      case "active":
        status = "active";
        break;
      case "canceled":
        status = "canceled";
        break;
      case "past_due":
        status = "past_due";
        break;
      case "unpaid":
        status = "unpaid";
        break;
      default:
        status = "active"; // trialing, incomplete → treat as active
    }

    return {
      id: sub.id,
      customer_id: customerId,
      company: customerName,
      plan: planName,
      amount,
      currency: (sub.currency || "eur").toUpperCase(),
      status,
      current_period_end: new Date((firstItem?.current_period_end || 0) * 1000).toISOString(),
      canceled_at: sub.canceled_at
        ? new Date(sub.canceled_at * 1000).toISOString()
        : null,
      source: "stripe",
    };
  }
}
