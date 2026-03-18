/**
 * Stripe Connector
 * Abstracts invoice and subscription fetching from Stripe.
 * Currently uses mock data — swap with real Stripe API calls when ready.
 */
import type { Invoice, Subscription } from "../engine/types.js";
import { MOCK_INVOICES, MOCK_SUBSCRIPTIONS } from "../engine/mockData.js";

export interface StripeConnectorConfig {
  apiKey?: string;
}

export class StripeConnector {
  private connected = false;

  async connect(_config?: StripeConnectorConfig): Promise<void> {
    // Simulate connection delay
    await new Promise((r) => setTimeout(r, 1000));
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async getInvoices(): Promise<Invoice[]> {
    if (!this.connected) throw new Error("Stripe not connected");
    return MOCK_INVOICES;
  }

  async getSubscriptions(): Promise<Subscription[]> {
    if (!this.connected) throw new Error("Stripe not connected");
    return MOCK_SUBSCRIPTIONS;
  }
}
