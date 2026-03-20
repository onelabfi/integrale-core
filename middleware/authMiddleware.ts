/**
 * Auth Middleware for integrale-core
 *
 * Validates Supabase JWT and extracts org_id from the user's profile.
 * In development, falls back to DEFAULT_ORG_ID when no auth header is present.
 */
import type { Request, Response, NextFunction } from "express";
import { getSupabaseAdmin } from "../lib/supabaseAdmin.js";

// Extend Express Request to include orgId and userId
declare global {
  namespace Express {
    interface Request {
      orgId?: string;
      userId?: string;
    }
  }
}

/**
 * Cache org_id lookups to avoid repeated DB queries within the same process.
 * Map<userId, orgId>
 */
const orgIdCache = new Map<string, string>();

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;

  // ── Try JWT auth ─────────────────────────────────────────────────
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const supabase = getSupabaseAdmin();

    if (!supabase) {
      // No Supabase client — can't validate tokens
      console.warn("[auth] Supabase not configured — cannot validate JWT");
      res.status(500).json({ error: "Auth service unavailable" });
      return;
    }

    try {
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser(token);

      if (error || !user) {
        res.status(401).json({ error: "Invalid or expired token" });
        return;
      }

      // Look up org_id from profiles
      let orgId = orgIdCache.get(user.id);
      if (!orgId) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("organization_id")
          .or(`id.eq.${user.id},user_id.eq.${user.id}`)
          .limit(1)
          .single();

        orgId = profile?.organization_id ?? undefined;

        if (orgId) {
          orgIdCache.set(user.id, orgId);
        }
      }

      if (!orgId) {
        res.status(403).json({ error: "No organization found for user" });
        return;
      }

      req.orgId = orgId;
      req.userId = user.id;
      next();
      return;
    } catch (err) {
      console.error("[auth] Token validation error:", err);
      res.status(401).json({ error: "Token validation failed" });
      return;
    }
  }

  // ── Dev fallback: use DEFAULT_ORG_ID when no auth header ─────────
  if (process.env.NODE_ENV !== "production") {
    const fallbackOrg =
      req.body?.orgId || req.query?.org_id || process.env.DEFAULT_ORG_ID;

    if (fallbackOrg) {
      req.orgId = fallbackOrg as string;
      req.userId = "dev-user";
      next();
      return;
    }
  }

  res.status(401).json({ error: "Authorization required" });
}
