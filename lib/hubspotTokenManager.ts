/**
 * HubSpot Token Manager
 * Reads OAuth tokens from Supabase, handles automatic refresh.
 * Mirrors the refresh logic from integrale-app edge functions.
 */
import { getSupabaseAdmin } from "./supabaseAdmin.js";

interface HubSpotConnection {
  id: string;
  organization_id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  hub_id: string | null;
  hub_domain: string | null;
  user_email: string | null;
}

let cachedToken: { token: string; expiresAt: Date; orgId: string } | null = null;

/**
 * Get a valid HubSpot access token for the given org.
 * Automatically refreshes if expired.
 */
export async function getHubSpotToken(orgId: string): Promise<string | null> {
  // Check cache first
  if (
    cachedToken &&
    cachedToken.orgId === orgId &&
    cachedToken.expiresAt > new Date(Date.now() + 60_000) // 1 min buffer
  ) {
    return cachedToken.token;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const { data: conn, error } = await supabase
    .from("hubspot_connections")
    .select("id, organization_id, access_token, refresh_token, expires_at, hub_id, hub_domain, user_email")
    .eq("organization_id", orgId)
    .maybeSingle();

  if (error || !conn) {
    console.warn("[HubSpotTokenManager] No connection found for org:", orgId, error?.message);
    return null;
  }

  const hsConn = conn as HubSpotConnection;

  // Check if token is expired
  const isExpired =
    hsConn.expires_at && new Date(hsConn.expires_at) < new Date(Date.now() + 60_000);

  if (!isExpired && hsConn.access_token) {
    // Token is still valid
    cachedToken = {
      token: hsConn.access_token,
      expiresAt: hsConn.expires_at ? new Date(hsConn.expires_at) : new Date(Date.now() + 30 * 60_000),
      orgId,
    };
    return hsConn.access_token;
  }

  // Token expired — refresh it
  if (!hsConn.refresh_token) {
    console.warn("[HubSpotTokenManager] Token expired and no refresh_token available");
    return null;
  }

  const refreshed = await refreshToken(hsConn);
  if (refreshed) {
    cachedToken = { token: refreshed, expiresAt: new Date(Date.now() + 25 * 60_000), orgId };
  }
  return refreshed;
}

async function refreshToken(conn: HubSpotConnection): Promise<string | null> {
  const clientId = process.env.HUBSPOT_CLIENT_ID;
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;

  if (!clientId || !clientSecret || !conn.refresh_token) {
    console.warn("[HubSpotTokenManager] Missing HUBSPOT_CLIENT_ID/SECRET for refresh");
    return null;
  }

  console.log("[HubSpotTokenManager] Refreshing token...");

  try {
    const resp = await fetch("https://api.hubapi.com/oauth/v1/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: conn.refresh_token,
      }),
    });

    if (!resp.ok) {
      console.error("[HubSpotTokenManager] Refresh failed:", resp.status, await resp.text());
      return null;
    }

    const data = await resp.json();
    if (!data.access_token) {
      console.error("[HubSpotTokenManager] No access_token in refresh response");
      return null;
    }

    // Update tokens in Supabase
    const supabase = getSupabaseAdmin()!;
    const updateData: Record<string, unknown> = {
      access_token: data.access_token,
      updated_at: new Date().toISOString(),
    };
    if (data.refresh_token) updateData.refresh_token = data.refresh_token;
    if (data.expires_in) {
      updateData.expires_at = new Date(Date.now() + data.expires_in * 1000).toISOString();
    }

    await supabase.from("hubspot_connections").update(updateData).eq("id", conn.id);
    console.log("[HubSpotTokenManager] Token refreshed successfully");

    return data.access_token;
  } catch (err) {
    console.error("[HubSpotTokenManager] Refresh error:", err);
    return null;
  }
}

/**
 * Invalidate cached token (e.g., after a 401).
 */
export function invalidateCache(): void {
  cachedToken = null;
}
