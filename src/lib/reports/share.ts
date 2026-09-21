// Self-serve share links for the per-cluster Yelpaze Raporu (migration 069,
// B9). See supabase/migrations/069_api_keys_reports_llm_budget.sql for the
// `report_share_links` table + `report_share_view()` RPC these functions
// wrap.
//
// CAPABILITY-URL POSTURE: a share token is a bearer secret carried in a
// URL. It is stored in the clear (same posture as the newsletter
// confirm/unsubscribe tokens in migration 040 — see the table comment in
// 069 for the full rationale), short-lived (7-day default, 30-day hard
// ceiling) and revocable. Every function below treats the token as opaque
// and NEVER logs it, puts it in a thrown Error's message, an API error
// body, or a Sentry breadcrumb/tag/extra. Callers (the admin routes, the
// public page, the markdown route) must hold the same line.

import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { siteUrl } from "@/lib/site-url";

export const SHARE_TOKEN_RE = /^[0-9a-f]{32}$/;
export const SHARE_DEFAULT_DAYS = 7;
export const SHARE_MAX_DAYS = 30;
export const SHARE_LIST_LIMIT = 20;

/** 128 bits of randomness, hex-encoded — matches the DB's `token ~
 *  '^[0-9a-f]{32}$'` check constraint exactly. */
export function generateShareToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function isShareToken(value: unknown): value is string {
  return typeof value === "string" && SHARE_TOKEN_RE.test(value);
}

/** undefined/null -> the 7-day default; an integer 1..30 -> itself;
 *  anything else (a float, a numeric string, NaN, 0, >30) -> null so the
 *  caller can 400. */
export function normalizeShareDays(input: unknown): number | null {
  if (input === undefined || input === null) return SHARE_DEFAULT_DAYS;
  if (typeof input !== "number" || !Number.isInteger(input)) return null;
  if (input < 1 || input > SHARE_MAX_DAYS) return null;
  return input;
}

export function shareUrl(token: string): string {
  return `${siteUrl().replace(/\/+$/, "")}/rapor/${token}`;
}

export interface ShareLinkRow {
  token: string;
  cluster_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  views: number;
}

/** Inserts ONLY {token, cluster_id, expires_at} — created_at, views and
 *  revoked_at are DB defaults, not caller-supplied. Returns null on any
 *  Supabase error (never throws) so the route can 500 generically without
 *  ever serializing the raw error into a response body. */
export async function createShareLink(
  supabase: SupabaseClient,
  clusterId: string,
  days: number,
): Promise<ShareLinkRow | null> {
  try {
    const token = generateShareToken();
    const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();

    const { data, error } = await supabase
      .from("report_share_links")
      .insert({ token, cluster_id: clusterId, expires_at: expiresAt })
      .select("token, cluster_id, created_at, expires_at, revoked_at, views")
      .maybeSingle();

    if (error || !data) return null;
    return data as ShareLinkRow;
  } catch (err) {
    console.error("[reports/share] createShareLink failed", err);
    return null;
  }
}

/** Newest first, capped at SHARE_LIST_LIMIT. Never throws — [] on error,
 *  the same "could not read" convention as the /admin status readers
 *  (see src/lib/admin/archive-status.ts). */
export async function listShareLinks(
  supabase: SupabaseClient,
  clusterId: string,
): Promise<ShareLinkRow[]> {
  try {
    const { data, error } = await supabase
      .from("report_share_links")
      .select("token, cluster_id, created_at, expires_at, revoked_at, views")
      .eq("cluster_id", clusterId)
      .order("created_at", { ascending: false })
      .limit(SHARE_LIST_LIMIT);

    if (error || !data) return [];
    return data as ShareLinkRow[];
  } catch (err) {
    console.error("[reports/share] listShareLinks failed", err);
    return [];
  }
}

/** Flips revoked_at only on a row that is still live (`revoked_at is
 *  null`). Returns whether a row actually came back — true only when this
 *  call was the one that revoked it, false for an unknown token or one
 *  already revoked. Never throws. */
export async function revokeShareLink(
  supabase: SupabaseClient,
  token: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("report_share_links")
      .update({ revoked_at: new Date().toISOString() })
      .eq("token", token)
      .is("revoked_at", null)
      .select("token")
      .maybeSingle();

    if (error) return false;
    return data !== null;
  } catch (err) {
    console.error("[reports/share] revokeShareLink failed", err);
    return false;
  }
}

/** Resolves a token to its cluster id via the report_share_view() RPC,
 *  which atomically validates AND counts the view in one statement. Null
 *  for an unknown, malformed, expired or revoked token, or on any RPC
 *  error — the caller (the public page, the markdown route) must not be
 *  able to distinguish those cases from the outside. Never throws. */
export async function resolveShareToken(
  supabase: SupabaseClient,
  token: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc("report_share_view", {
      p_token: token,
    });
    if (error) return null;
    return typeof data === "string" ? data : null;
  } catch (err) {
    console.error("[reports/share] resolveShareToken failed", err);
    return null;
  }
}
