/**
 * Salesforce Token Manager
 * Reads OAuth tokens from Supabase salesforce_connections table.
 * Handles automatic refresh via Salesforce OAuth2 refresh_token grant.
 */
import { getSupabaseAdmin } from "./supabaseAdmin.js";

interface SalesforceConnection {
  id: string;
  organization_id: string;
  instance_url: string;
  access_token: string;
  refresh_token: string | null;
  sf_user_id: string | null;
  sf_username: string | null;
  created_at: string;
  updated_at: string;
}

export interface SalesforceCredentials {
  accessToken: string;
  instanceUrl: string;
}

let cachedCreds: { creds: SalesforceCredentials; expiresAt: Date; orgId: string } | null = null;

/**
 * Get valid Salesforce credentials for the given org.
 * Returns both accessToken and instanceUrl (needed for all SFDC API calls).
 * Automatically refreshes if token appears expired.
 */
export async function getSalesforceToken(orgId: string): Promise<SalesforceCredentials | null> {
  // Check cache (Salesforce tokens typically last ~2 hours but we refresh at 50 min)
  if (
    cachedCreds &&
    cachedCreds.orgId === orgId &&
    cachedCreds.expiresAt > new Date(Date.now() + 60_000)
  ) {
    return cachedCreds.creds;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const { data: conn, error } = await supabase
    .from("salesforce_connections")
    .select("id, organization_id, instance_url, access_token, refresh_token, sf_user_id, sf_username, created_at, updated_at")
    .eq("organization_id", orgId)
    .maybeSingle();

  if (error || !conn) {
    console.warn("[SalesforceTokenManager] No connection found for org:", orgId, error?.message);
    return null;
  }

  const sfConn = conn as SalesforceConnection;

  if (!sfConn.access_token || !sfConn.instance_url) {
    console.warn("[SalesforceTokenManager] Missing access_token or instance_url");
    return null;
  }

  // Salesforce doesn't include expires_at — we verify by making a lightweight call.
  // For now, trust the token and cache it for 50 minutes.
  const creds: SalesforceCredentials = {
    accessToken: sfConn.access_token,
    instanceUrl: sfConn.instance_url,
  };

  cachedCreds = {
    creds,
    expiresAt: new Date(Date.now() + 50 * 60_000),
    orgId,
  };

  return creds;
}

/**
 * Refresh the Salesforce token using the refresh_token grant.
 * Called when a 401 is received during API calls.
 */
export async function refreshSalesforceToken(orgId: string): Promise<SalesforceCredentials | null> {
  invalidateCache();

  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const { data: conn, error } = await supabase
    .from("salesforce_connections")
    .select("id, organization_id, instance_url, access_token, refresh_token, sf_user_id, sf_username, created_at, updated_at")
    .eq("organization_id", orgId)
    .maybeSingle();

  if (error || !conn) return null;

  const sfConn = conn as SalesforceConnection;
  if (!sfConn.refresh_token) {
    console.warn("[SalesforceTokenManager] No refresh_token available — re-auth required");
    return null;
  }

  const clientId = process.env.SALESFORCE_CLIENT_ID;
  const clientSecret = process.env.SALESFORCE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.warn("[SalesforceTokenManager] Missing SALESFORCE_CLIENT_ID/SECRET for refresh");
    return null;
  }

  console.log("[SalesforceTokenManager] Refreshing token...");

  try {
    const resp = await fetch("https://login.salesforce.com/services/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: sfConn.refresh_token,
      }),
    });

    if (!resp.ok) {
      console.error("[SalesforceTokenManager] Refresh failed:", resp.status, await resp.text());
      return null;
    }

    const data = await resp.json();
    if (!data.access_token) {
      console.error("[SalesforceTokenManager] No access_token in refresh response");
      return null;
    }

    // Update in Supabase (Salesforce refresh doesn't return a new refresh_token)
    await supabase
      .from("salesforce_connections")
      .update({
        access_token: data.access_token,
        instance_url: data.instance_url || sfConn.instance_url,
        updated_at: new Date().toISOString(),
      })
      .eq("id", sfConn.id);

    console.log("[SalesforceTokenManager] Token refreshed successfully");

    const creds: SalesforceCredentials = {
      accessToken: data.access_token,
      instanceUrl: data.instance_url || sfConn.instance_url,
    };

    cachedCreds = {
      creds,
      expiresAt: new Date(Date.now() + 50 * 60_000),
      orgId,
    };

    return creds;
  } catch (err) {
    console.error("[SalesforceTokenManager] Refresh error:", err);
    return null;
  }
}

/**
 * Invalidate cached credentials (e.g., after a 401).
 */
export function invalidateCache(): void {
  cachedCreds = null;
}
