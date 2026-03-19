/**
 * Supabase Admin Client
 * Uses service role key to bypass RLS — for reading OAuth tokens from
 * hubspot_connections and salesforce_connections tables.
 */
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

let _client: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient | null {
  if (_client) return _client;
  if (!url || !key) {
    console.warn(
      "[supabaseAdmin] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — connectors will fall back to mock data"
    );
    return null;
  }
  _client = createClient(url, key);
  return _client;
}
