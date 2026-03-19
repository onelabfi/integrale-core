/**
 * Salesforce Connector
 * Fetches Opportunities from Salesforce CRM via SOQL using OAuth tokens stored in Supabase.
 * Maps Opportunities to Deal type for cross-system revenue leak detection.
 * Falls back to mock data when credentials are unavailable.
 */
import type { Deal } from "../engine/types.js";
import { MOCK_DEALS } from "../engine/mockData.js";
import {
  getSalesforceToken,
  refreshSalesforceToken,
  invalidateCache,
} from "../lib/salesforceTokenManager.js";
import type { SalesforceCredentials } from "../lib/salesforceTokenManager.js";
import { normalizeCustomerId } from "../lib/customerMatcher.js";

export interface SalesforceConnectorConfig {
  orgId?: string;
  useMock?: boolean;
}

const SFDC_API_VERSION = "v59.0";

const OPPORTUNITY_SOQL = `
  SELECT Id, Name, StageName, Amount, CloseDate, AccountId,
         Probability, IsClosed, IsWon, CurrencyIsoCode
  FROM Opportunity
  WHERE Amount != null
  ORDER BY CloseDate DESC
  LIMIT 2000
`.trim().replace(/\n\s+/g, " ");

export class SalesforceConnector {
  private connected = false;
  private orgId: string | null = null;
  private creds: SalesforceCredentials | null = null;
  private useMock = false;

  async connect(config?: SalesforceConnectorConfig): Promise<void> {
    this.orgId = config?.orgId || process.env.DEFAULT_ORG_ID || null;
    this.useMock = config?.useMock || false;

    if (this.useMock) {
      console.log("[Salesforce] Using mock data (mock forced)");
      this.connected = true;
      return;
    }

    try {
      if (!this.orgId) {
        console.warn("[Salesforce] No orgId — falling back to mock data");
        this.useMock = true;
        this.connected = true;
        return;
      }

      const creds = await getSalesforceToken(this.orgId);
      if (!creds) {
        console.warn("[Salesforce] No credentials available — falling back to mock data");
        this.useMock = true;
        this.connected = true;
        return;
      }

      // Verify with a lightweight call
      const resp = await fetch(
        `${creds.instanceUrl}/services/data/${SFDC_API_VERSION}/limits`,
        {
          headers: { Authorization: `Bearer ${creds.accessToken}` },
          signal: AbortSignal.timeout(10_000),
        }
      );

      if (resp.ok) {
        this.creds = creds;
        this.connected = true;
        console.log(`[Salesforce] Connected to ${creds.instanceUrl}`);
      } else if (resp.status === 401) {
        // Try refresh
        const refreshed = await refreshSalesforceToken(this.orgId);
        if (refreshed) {
          this.creds = refreshed;
          this.connected = true;
          console.log("[Salesforce] Connected after token refresh");
        } else {
          console.warn("[Salesforce] Token refresh failed — falling back to mock data");
          this.useMock = true;
          this.connected = true;
        }
      } else {
        console.warn(`[Salesforce] API returned ${resp.status} — falling back to mock data`);
        this.useMock = true;
        this.connected = true;
      }
    } catch (err) {
      console.warn("[Salesforce] Connection error — falling back to mock data:", err);
      this.useMock = true;
      this.connected = true;
    }
  }

  disconnect(): void {
    this.connected = false;
    this.creds = null;
    this.orgId = null;
    this.useMock = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  isLive(): boolean {
    return this.connected && !this.useMock && !!this.creds;
  }

  async getDeals(): Promise<Deal[]> {
    if (!this.connected) throw new Error("Salesforce not connected");
    if (this.useMock) {
      // Return Salesforce-branded mock deals
      return MOCK_DEALS.map((d) => ({ ...d, source: "salesforce" as const }));
    }

    try {
      // Refresh token if needed
      if (this.orgId) {
        const fresh = await getSalesforceToken(this.orgId);
        if (fresh) this.creds = fresh;
      }

      const deals = await this.fetchAllOpportunities();
      console.log(`[Salesforce] Fetched ${deals.length} opportunities from live API`);
      return deals;
    } catch (err) {
      console.error("[Salesforce] Error fetching opportunities — falling back to mock:", err);
      return MOCK_DEALS.map((d) => ({ ...d, source: "salesforce" as const }));
    }
  }

  private async fetchAllOpportunities(): Promise<Deal[]> {
    const allDeals: Deal[] = [];
    let url = `${this.creds!.instanceUrl}/services/data/${SFDC_API_VERSION}/query?q=${encodeURIComponent(OPPORTUNITY_SOQL)}`;

    let page = 0;
    while (url && page < 20) {
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.creds!.accessToken}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (!resp.ok) {
        if (resp.status === 401 && this.orgId) {
          // Try one refresh
          const refreshed = await refreshSalesforceToken(this.orgId);
          if (refreshed) {
            this.creds = refreshed;
            continue; // Retry same page
          }
        }
        throw new Error(`Salesforce API error: ${resp.status} ${resp.statusText}`);
      }

      const data = await resp.json();
      const records = data.records || [];

      for (const opp of records) {
        const mapped = await this.mapOpportunity(opp);
        if (mapped) allDeals.push(mapped);
      }

      // Salesforce uses nextRecordsUrl for pagination
      url = data.nextRecordsUrl
        ? `${this.creds!.instanceUrl}${data.nextRecordsUrl}`
        : "";

      page++;

      if (url) await new Promise((r) => setTimeout(r, 100));
    }

    return allDeals;
  }

  private async mapOpportunity(opp: any): Promise<Deal | null> {
    const amount = parseFloat(opp.Amount || "0");
    if (!amount || amount <= 0) return null;

    // Stage mapping using IsWon/IsClosed (more reliable than StageName)
    let stage: "closed_won" | "open" | "lost";
    if (opp.IsWon) {
      stage = "closed_won";
    } else if (opp.IsClosed) {
      stage = "lost";
    } else {
      stage = "open";
    }

    // Resolve Account for company info
    let companyName = opp.Name || "Unknown Company";
    let companyDomain: string | null = null;
    let contactEmail: string | undefined;

    if (opp.AccountId) {
      try {
        const acct = await this.fetchAccountInfo(opp.AccountId);
        if (acct.name) companyName = acct.name;
        if (acct.website) companyDomain = acct.website.replace(/^https?:\/\//, "").replace(/\/$/, "");
        if (acct.contactEmail) contactEmail = acct.contactEmail;
      } catch {
        // Use opportunity name as fallback
      }
    }

    // Fallback email from domain
    if (!contactEmail && companyDomain) {
      contactEmail = `billing@${companyDomain}`;
    }

    const customerId = normalizeCustomerId(contactEmail, companyName, companyDomain);

    return {
      id: opp.Id,
      customer_id: customerId,
      company: companyName,
      name: opp.Name || "Untitled Opportunity",
      amount,
      currency: (opp.CurrencyIsoCode || "EUR").toUpperCase(),
      stage,
      close_date: opp.CloseDate
        ? new Date(opp.CloseDate).toISOString()
        : new Date().toISOString(),
      source: "salesforce",
      contact_email: contactEmail,
    };
  }

  /* ── Account info cache ────────────────────────────────────────── */

  private accountCache = new Map<
    string,
    { name: string; website: string | null; contactEmail: string | null }
  >();

  private async fetchAccountInfo(
    accountId: string
  ): Promise<{ name: string; website: string | null; contactEmail: string | null }> {
    const cached = this.accountCache.get(accountId);
    if (cached) return cached;

    // Fetch Account with primary Contact email in one compound query
    const soql = `SELECT Id, Name, Website,
      (SELECT Email FROM Contacts WHERE Email != null LIMIT 1)
      FROM Account WHERE Id = '${accountId}'`;

    const resp = await fetch(
      `${this.creds!.instanceUrl}/services/data/${SFDC_API_VERSION}/query?q=${encodeURIComponent(soql)}`,
      {
        headers: {
          Authorization: `Bearer ${this.creds!.accessToken}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (!resp.ok) {
      const fallback = { name: "Unknown Company", website: null, contactEmail: null };
      this.accountCache.set(accountId, fallback);
      return fallback;
    }

    const data = await resp.json();
    const record = data.records?.[0];
    if (!record) {
      const fallback = { name: "Unknown Company", website: null, contactEmail: null };
      this.accountCache.set(accountId, fallback);
      return fallback;
    }

    const info = {
      name: record.Name || "Unknown Company",
      website: record.Website || null,
      contactEmail: record.Contacts?.records?.[0]?.Email || null,
    };
    this.accountCache.set(accountId, info);
    return info;
  }
}
