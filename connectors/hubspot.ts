/**
 * HubSpot Connector
 * Abstracts deal fetching from HubSpot CRM.
 * Currently uses mock data — swap with real HubSpot API calls when ready.
 */
import type { Deal } from "../engine/types.js";
import { MOCK_DEALS } from "../engine/mockData.js";

export interface HubSpotConnectorConfig {
  apiKey?: string;
}

export class HubSpotConnector {
  private connected = false;

  async connect(_config?: HubSpotConnectorConfig): Promise<void> {
    // Simulate connection delay
    await new Promise((r) => setTimeout(r, 1200));
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async getDeals(): Promise<Deal[]> {
    if (!this.connected) throw new Error("HubSpot not connected");
    return MOCK_DEALS;
  }
}
