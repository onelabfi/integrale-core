/**
 * HubSpot Connector
 * Fetches real deals from HubSpot CRM using OAuth tokens stored in Supabase.
 * Falls back to mock data when credentials are unavailable.
 */
import type { Deal } from "../engine/types.js";
import { MOCK_DEALS } from "../engine/mockData.js";
import { getHubSpotToken, invalidateCache } from "../lib/hubspotTokenManager.js";
import { normalizeCustomerId } from "../lib/customerMatcher.js";

export interface HubSpotConnectorConfig {
  orgId?: string;
  useMock?: boolean;
}

const HUBSPOT_API = "https://api.hubapi.com";
const DEAL_PROPERTIES = [
  "dealname",
  "amount",
  "dealstage",
  "pipeline",
  "closedate",
  "hs_is_closed_won",
  "hs_is_closed",
  "createdate",
  "hubspot_owner_id",
  "deal_currency_code",
].join(",");

export class HubSpotConnector {
  private connected = false;
  private orgId: string | null = null;
  private accessToken: string | null = null;
  private useMock = false;

  async connect(config?: HubSpotConnectorConfig): Promise<void> {
    this.orgId = config?.orgId || process.env.DEFAULT_ORG_ID || null;
    this.useMock = config?.useMock || false;

    if (this.useMock) {
      console.log("[HubSpot] Using mock data (mock forced)");
      this.useMock = true;
      this.connected = true;
      return;
    }

    // Try personal access token first, then OAuth token from Supabase
    try {
      let token = process.env.HUBSPOT_ACCESS_TOKEN || null;

      if (!token && this.orgId) {
        token = await getHubSpotToken(this.orgId);
      }

      if (!token) {
        console.warn("[HubSpot] No token available — falling back to mock data");
        this.useMock = true;
        this.connected = true;
        return;
      }

      // Verify token with a lightweight call
      const resp = await fetch(`${HUBSPOT_API}/crm/v3/objects/contacts?limit=1`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (resp.ok) {
        this.accessToken = token;
        this.connected = true;
        console.log("[HubSpot] Connected with live OAuth token");
      } else if (resp.status === 401) {
        // Token invalid, try refresh
        invalidateCache();
        const refreshedToken = await getHubSpotToken(this.orgId);
        if (refreshedToken) {
          this.accessToken = refreshedToken;
          this.connected = true;
          console.log("[HubSpot] Connected after token refresh");
        } else {
          console.warn("[HubSpot] Token refresh failed — falling back to mock data");
          this.useMock = true;
          this.connected = true;
        }
      } else {
        console.warn(`[HubSpot] API returned ${resp.status} — falling back to mock data`);
        this.useMock = true;
        this.connected = true;
      }
    } catch (err) {
      console.warn("[HubSpot] Connection error — falling back to mock data:", err);
      this.useMock = true;
      this.connected = true;
    }
  }

  disconnect(): void {
    this.connected = false;
    this.accessToken = null;
    this.orgId = null;
    this.useMock = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  isLive(): boolean {
    return this.connected && !this.useMock && !!this.accessToken;
  }

  async getDeals(): Promise<Deal[]> {
    if (!this.connected) throw new Error("HubSpot not connected");
    if (this.useMock) return MOCK_DEALS;

    try {
      // Refresh token if needed before fetching
      if (this.orgId) {
        const freshToken = await getHubSpotToken(this.orgId);
        if (freshToken) this.accessToken = freshToken;
      }

      const deals = await this.fetchAllDeals();
      console.log(`[HubSpot] Fetched ${deals.length} deals from live API`);

      if (deals.length === 0) {
        console.log("[HubSpot] No deals found — returning empty array (real result)");
        return [];
      }

      return deals;
    } catch (err) {
      console.error("[HubSpot] Error fetching deals — falling back to mock:", err);
      return MOCK_DEALS;
    }
  }

  private async fetchAllDeals(): Promise<Deal[]> {
    const allDeals: Deal[] = [];
    let after: string | undefined;
    let page = 0;

    do {
      const url = new URL(`${HUBSPOT_API}/crm/v3/objects/deals`);
      url.searchParams.set("limit", "100");
      url.searchParams.set("properties", DEAL_PROPERTIES);
      url.searchParams.set("associations", "companies,contacts");
      if (after) url.searchParams.set("after", after);

      const resp = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (!resp.ok) {
        if (resp.status === 401) {
          // Try one refresh
          invalidateCache();
          if (this.orgId) {
            const newToken = await getHubSpotToken(this.orgId);
            if (newToken) {
              this.accessToken = newToken;
              // Retry this page
              continue;
            }
          }
        }
        throw new Error(`HubSpot API error: ${resp.status} ${resp.statusText}`);
      }

      const data = await resp.json();
      const results = data.results || [];

      for (const deal of results) {
        const mapped = await this.mapDeal(deal);
        if (mapped) allDeals.push(mapped);
      }

      after = data.paging?.next?.after;
      page++;

      // Rate limit protection: small delay between pages
      if (after && page > 0) {
        await new Promise((r) => setTimeout(r, 100));
      }
    } while (after && page < 50); // Safety limit: max 5000 deals

    return allDeals;
  }

  private async mapDeal(hubspotDeal: any): Promise<Deal | null> {
    const props = hubspotDeal.properties || {};

    // Determine stage
    const isClosedWon = props.hs_is_closed_won === "true";
    const isClosed = props.hs_is_closed === "true";
    let stage: "closed_won" | "open" | "lost";
    if (isClosedWon) {
      stage = "closed_won";
    } else if (isClosed) {
      stage = "lost";
    } else {
      stage = "open";
    }

    // Get amount
    const amount = parseFloat(props.amount || "0");
    if (!amount || amount <= 0) return null; // Skip deals with no amount

    // Get associated company
    let companyName = "Unknown Company";
    let companyDomain: string | null = null;
    const companyAssociations = hubspotDeal.associations?.companies?.results;
    if (companyAssociations && companyAssociations.length > 0) {
      const companyId = companyAssociations[0].id;
      try {
        const compInfo = await this.fetchCompanyInfo(companyId);
        if (compInfo.name) companyName = compInfo.name;
        if (compInfo.domain) companyDomain = compInfo.domain;
      } catch {
        // Use deal name as fallback
      }
    }

    // Get associated contact email (needed for recovery engine)
    let contactEmail: string | undefined;
    const contactAssociations = hubspotDeal.associations?.contacts?.results;
    if (contactAssociations && contactAssociations.length > 0) {
      const contactId = contactAssociations[0].id;
      try {
        contactEmail = await this.fetchContactEmail(contactId);
      } catch {
        // No contact email available
      }
    }
    // Fallback: generate email from company domain if available
    if (!contactEmail && companyDomain) {
      contactEmail = `billing@${companyDomain}`;
    }

    // Generate customer_id that can match with Stripe
    const customerId = normalizeCustomerId(contactEmail, companyName, companyDomain);

    return {
      id: hubspotDeal.id,
      customer_id: customerId,
      company: companyName,
      name: props.dealname || "Untitled Deal",
      amount,
      currency: (props.deal_currency_code || "EUR").toUpperCase(),
      stage,
      close_date: props.closedate || new Date().toISOString(),
      source: "hubspot",
      contact_email: contactEmail,
    };
  }

  private contactEmailCache = new Map<string, string | undefined>();

  private async fetchContactEmail(contactId: string): Promise<string | undefined> {
    const cached = this.contactEmailCache.get(contactId);
    if (cached !== undefined) return cached || undefined;

    const resp = await fetch(
      `${HUBSPOT_API}/crm/v3/objects/contacts/${contactId}?properties=email`,
      {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!resp.ok) {
      this.contactEmailCache.set(contactId, "");
      return undefined;
    }

    const data = await resp.json();
    const email = data.properties?.email || undefined;
    this.contactEmailCache.set(contactId, email || "");
    return email;
  }

  private companyCache = new Map<string, { name: string; domain: string | null }>();

  private async fetchCompanyInfo(
    companyId: string
  ): Promise<{ name: string; domain: string | null }> {
    // Check cache
    const cached = this.companyCache.get(companyId);
    if (cached) return cached;

    const resp = await fetch(
      `${HUBSPOT_API}/crm/v3/objects/companies/${companyId}?properties=name,domain`,
      {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!resp.ok) {
      return { name: "Unknown Company", domain: null };
    }

    const data = await resp.json();
    const info = {
      name: data.properties?.name || "Unknown Company",
      domain: data.properties?.domain || null,
    };
    this.companyCache.set(companyId, info);
    return info;
  }
}
