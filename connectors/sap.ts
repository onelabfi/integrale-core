/**
 * SAP S/4HANA Connector
 * Fetches Business Partners from SAP Business Accelerator Hub via OData API.
 * Uses API key authentication (simpler than OAuth).
 * Falls back to mock data when no API key is available.
 */
import type { BusinessPartner } from "../engine/types.js";

export interface SAPConnectorConfig {
  apiKey?: string;
  useMock?: boolean;
}

const SAP_BASE_URL =
  "https://sandbox.api.sap.com/s4hanacloud/sap/opu/odata/sap";
const BP_ENDPOINT = "API_BUSINESS_PARTNER/A_BusinessPartner";
const PAGE_SIZE = 50;

/* ── Mock Business Partners (used when no API key) ─────────────── */
const MOCK_BUSINESS_PARTNERS: BusinessPartner[] = [
  { id: "BP-1001", name: "Nordic Steel Oy", category: "1", type: "CUST", firstName: null, lastName: null, industry: "Manufacturing", source: "sap" },
  { id: "BP-1002", name: "Helsinki Digital Solutions", category: "1", type: "CUST", firstName: null, lastName: null, industry: "Technology", source: "sap" },
  { id: "BP-1003", name: "Tampere Logistics AB", category: "1", type: "CUST", firstName: null, lastName: null, industry: "Logistics", source: "sap" },
  { id: "BP-1004", name: "Turku Energy Partners", category: "1", type: "CUST", firstName: null, lastName: null, industry: "Energy", source: "sap" },
  { id: "BP-1005", name: "Oulu Manufacturing Group", category: "1", type: "CUST", firstName: null, lastName: null, industry: "Manufacturing", source: "sap" },
];

export class SAPConnector {
  private connected = false;
  private apiKey: string | null = null;
  private useMock = false;

  async connect(config?: SAPConnectorConfig): Promise<void> {
    const key = config?.apiKey || process.env.SAP_API_KEY || null;
    this.useMock = config?.useMock || false;

    if (this.useMock || !key) {
      console.log("[SAP] Using mock data (no API key or mock forced)");
      this.useMock = true;
      this.connected = true;
      return;
    }

    try {
      // Verify API key with a minimal request
      const resp = await fetch(
        `${SAP_BASE_URL}/${BP_ENDPOINT}?$top=1&$format=json`,
        {
          headers: {
            APIKey: key,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(15_000),
        }
      );

      if (resp.ok) {
        this.apiKey = key;
        this.connected = true;
        console.log("[SAP] Connected to SAP Business Accelerator Hub");
      } else if (resp.status === 401 || resp.status === 403) {
        console.warn("[SAP] API key rejected — falling back to mock data");
        this.useMock = true;
        this.connected = true;
      } else {
        const text = await resp.text();
        // Check for rate limit
        if (resp.status === 429 || text.includes("QuotaViolation") || text.includes("ratelimit")) {
          console.warn("[SAP] Rate limited — falling back to mock data");
        } else {
          console.warn(`[SAP] API returned ${resp.status} — falling back to mock data`);
        }
        this.useMock = true;
        this.connected = true;
      }
    } catch (err) {
      console.warn("[SAP] Connection error — falling back to mock data:", err);
      this.useMock = true;
      this.connected = true;
    }
  }

  disconnect(): void {
    this.connected = false;
    this.apiKey = null;
    this.useMock = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  isLive(): boolean {
    return this.connected && !this.useMock && !!this.apiKey;
  }

  async getBusinessPartners(): Promise<BusinessPartner[]> {
    if (!this.connected) throw new Error("SAP not connected");
    if (this.useMock) return MOCK_BUSINESS_PARTNERS;

    try {
      const partners = await this.fetchAllBusinessPartners();
      console.log(`[SAP] Fetched ${partners.length} business partners from live API`);
      return partners;
    } catch (err) {
      console.error("[SAP] Error fetching business partners — falling back to mock:", err);
      return MOCK_BUSINESS_PARTNERS;
    }
  }

  private async fetchAllBusinessPartners(): Promise<BusinessPartner[]> {
    const all: BusinessPartner[] = [];
    let offset = 0;
    let page = 0;

    while (page < 20) {
      const url = `${SAP_BASE_URL}/${BP_ENDPOINT}?$top=${PAGE_SIZE}&$skip=${offset}&$format=json`;

      const resp = await fetch(url, {
        headers: {
          APIKey: this.apiKey!,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15_000),
      });

      const text = await resp.text();

      // Rate limit check
      if (
        resp.status === 429 ||
        text.includes("QuotaViolation") ||
        text.includes("ratelimit")
      ) {
        console.warn("[SAP] Rate limit reached — stopping pagination");
        break;
      }

      if (!resp.ok) {
        throw new Error(`SAP API error: ${resp.status}`);
      }

      const json = JSON.parse(text);
      const results: any[] = json?.d?.results ?? [];

      for (const bp of results) {
        all.push({
          id: bp.BusinessPartner || bp.BusinessPartnerKey || `sap-${offset}`,
          name: bp.BusinessPartnerName || bp.BusinessPartnerFullName || "Unknown",
          category: bp.BusinessPartnerCategory || "",
          type: bp.BusinessPartnerGrouping || "",
          firstName: bp.FirstName || null,
          lastName: bp.LastName || null,
          industry: bp.Industry || null,
          source: "sap",
        });
      }

      if (results.length < PAGE_SIZE) break; // Last page

      offset += PAGE_SIZE;
      page++;

      // Rate limit protection: 500ms between pages
      await new Promise((r) => setTimeout(r, 500));
    }

    return all;
  }
}
