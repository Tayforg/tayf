import crypto from "node:crypto";

import { apiError, apiServerError, apiUnauthorized } from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { createServerClient } from "@/lib/supabase/server";
import { REGISTRY_LICENCE } from "@/lib/sources/registry";

/**
 * Pack E / B11 — keyed public API (`/api/v1/*`).
 *
 * `api_keys` stores ONLY the sha256 hex of a presented key (migration 069).
 * The plaintext key is generated once by POST /api/admin/api-keys, returned
 * in that 201 body, and NEVER stored, logged, or re-derivable afterwards —
 * every function in this file that touches a presented key or its hash
 * must keep that invariant: no console.*, no Sentry capture, no response
 * field ever carries either value back out.
 */

export const API_KEY_PREFIX = "tayf_";
export const API_KEY_RE = /^tayf_[0-9a-f]{40}$/;

export const API_TIERS = ["free", "partner"] as const;
export type ApiTier = (typeof API_TIERS)[number];

export const API_TIER_LIMITS: Record<ApiTier, { perMinute: number; perDay: number }> = {
  free: { perMinute: 60, perDay: 2000 },
  partner: { perMinute: 600, perDay: 50000 },
};

// Must equal REGISTRY_LICENCE (src/lib/sources/registry.ts) — imported
// rather than hand-duplicated so the two literals can never drift. Every
// v1 response body carries the licence via registryEnvelope(), not this
// constant directly; it exists so callers/tests/docs have a single named
// reference for "the licence string v1 promises."
export const API_V1_LICENCE_NOTE: string = REGISTRY_LICENCE;

/** "tayf_" + 20 random bytes as hex = 45 chars total. */
export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${crypto.randomBytes(20).toString("hex")}`;
}

/** sha256 hex of the WHOLE presented string, including the `tayf_` prefix. */
export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

export function isApiTier(v: unknown): v is ApiTier {
  return typeof v === "string" && (API_TIERS as readonly string[]).includes(v);
}

// Control chars (C0 + DEL) are rejected outright — a label is rendered
// verbatim in the admin table, and this is the cheapest guard against a
// stray newline/escape sequence ending up in that cell.
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

export function normalizeKeyLabel(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  if (CONTROL_CHAR_RE.test(trimmed)) return null;
  return trimmed;
}

const BEARER_RE = /^Bearer\s+(\S+)$/i;

export function parseBearerApiKey(header: string | null): string | null {
  if (!header) return null;
  const match = BEARER_RE.exec(header);
  if (!match) return null;
  const token = match[1] ?? "";
  return API_KEY_RE.test(token) ? token : null;
}

export type ApiKeyAuth =
  | { ok: true; keyId: number; tier: ApiTier }
  | { ok: false; response: Response };

export function apiV1Headers(tier: ApiTier): Record<string, string> {
  return {
    "X-Tayf-Tier": tier,
    "Cache-Control": "private, no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin, Authorization",
  };
}

/**
 * Wrap any /api/v1 response (including refusals from `requireApiKey` and
 * the 4xx returns in the two cluster routes) with the same CORS +
 * cache-control contract every 2xx already carries — a browser consumer
 * cannot read a 401/429 body cross-origin otherwise (E3-V1-ERROR-NO-CORS).
 *
 * `tier` is omitted on the refusal paths where it is genuinely unknown
 * (missing/invalid key, revoked key, anonymous 429) — `X-Tayf-Tier` is
 * only emitted when a tier is supplied; every other header is always
 * present. Never changes status or body.
 */
export function withApiV1Headers(res: Response, tier?: ApiTier): Response {
  const headers = new Headers(res.headers);
  const base = apiV1Headers(tier ?? "free");
  for (const [key, value] of Object.entries(base)) {
    if (key === "X-Tayf-Tier" && tier === undefined) continue;
    headers.set(key, value);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

// Anonymous flood gate: keyed by clientKey(request), NOT by API key, so an
// unauthenticated burst (garbage/missing Authorization headers) never even
// reaches Supabase to look up a hash. Deliberately generous (30/1s) — this
// is a floor under every caller, authenticated or not, not the per-key
// limit itself.
const anonLimiter = createRateLimiter("api-v1-anon", {
  capacity: 30,
  refillPerSecond: 1,
});

// Per-minute buckets, one per tier, keyed by `k${keyId}` (never by IP —
// a partner key legitimately fans out across many client IPs). Capacity
// equals the advertised per-minute ceiling; refill spreads that same
// ceiling evenly across 60s so a key that spends its whole minute budget
// immediately has to wait roughly a minute for the next token.
const minuteLimiterFree = createRateLimiter("api-v1-min-free", {
  capacity: API_TIER_LIMITS.free.perMinute,
  refillPerSecond: API_TIER_LIMITS.free.perMinute / 60,
});
const minuteLimiterPartner = createRateLimiter("api-v1-min-partner", {
  capacity: API_TIER_LIMITS.partner.perMinute,
  refillPerSecond: API_TIER_LIMITS.partner.perMinute / 60,
});

function utcDayString(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function msUntilNextUtcMidnight(now: Date): number {
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0),
  );
  return next.getTime() - now.getTime();
}

interface ApiKeyTouchRow {
  key_id: number | string;
  tier: string;
}

/**
 * Resolve a presented Bearer credential into `{ keyId, tier }`, or a
 * ready-to-return `Response` describing exactly why it was refused.
 *
 * ORDER IS NON-NEGOTIABLE (each step gates the next; do not reorder):
 *   1. Anonymous bucket (`api-v1-anon`, keyed by client IP) — runs before
 *      ANY parsing so an unauthenticated flood never reaches Supabase.
 *   2. Parse the `Authorization: Bearer tayf_<40 hex>` header.
 *      Missing/malformed -> 401 immediately, no DB call at all.
 *   3. Hash the presented key (sha256 hex) and call the `api_key_touch`
 *      RPC. This is a SINGLE round trip that ALSO durably increments
 *      today's `api_key_usage_daily.calls` row for a live, non-revoked
 *      key as a side effect (migration 069) — by the time step 6 below
 *      reads that counter, THIS call has already been counted.
 *   4. Empty result (`api_key_touch` returns unknown OR revoked keys as
 *      an empty row set, indistinguishably) -> ONE extra lookup, ONLY on
 *      this failure path, to tell the two apart for the caller:
 *      `.from('api_keys').select('id').eq('key_hash', h).not('revoked_at','is',null).maybeSingle()`.
 *      A row -> 403 (revoked). No row -> 401 (never existed / bad key).
 *   5. Per-minute bucket, keyed by `k${keyId}` (tier-specific capacity).
 *   6. Durable per-day check against `api_key_usage_daily` for
 *      (key_id, UTC today). Because step 3 already incremented the
 *      counter, the comparison is `calls > perDay` — the call that pushes
 *      the count one PAST the cap is the one that gets refused, not the
 *      call that reaches exactly the cap.
 *
 * Never logs, returns, or Sentry-captures the presented key or its hash
 * anywhere in this function or its error paths.
 */
export async function requireApiKey(request: Request): Promise<ApiKeyAuth> {
  const anonRl = anonLimiter(clientKey(request));
  if (!anonRl.allowed) {
    return {
      ok: false,
      response: withApiV1Headers(
        apiError(429, "Too many requests", {
          details: { retryAfterMs: anonRl.retryAfterMs },
        }),
      ),
    };
  }

  const presented = parseBearerApiKey(request.headers.get("authorization"));
  if (presented === null) {
    return {
      ok: false,
      response: withApiV1Headers(apiUnauthorized("Missing or invalid API key")),
    };
  }

  const hash = hashApiKey(presented);
  const supabase = createServerClient();

  const { data: touchData, error: touchError } = await supabase.rpc("api_key_touch", {
    p_key_hash: hash,
  });
  if (touchError) {
    return { ok: false, response: withApiV1Headers(apiServerError(touchError)) };
  }

  const touchRows: ApiKeyTouchRow[] = Array.isArray(touchData)
    ? (touchData as ApiKeyTouchRow[])
    : touchData
      ? [touchData as ApiKeyTouchRow]
      : [];

  if (touchRows.length === 0) {
    const { data: revokedRow, error: revokedError } = await supabase
      .from("api_keys")
      .select("id")
      .eq("key_hash", hash)
      .not("revoked_at", "is", null)
      .maybeSingle();
    if (revokedError) {
      return { ok: false, response: withApiV1Headers(apiServerError(revokedError)) };
    }
    if (revokedRow) {
      return { ok: false, response: withApiV1Headers(apiError(403, "API key revoked")) };
    }
    return {
      ok: false,
      response: withApiV1Headers(apiUnauthorized("Missing or invalid API key")),
    };
  }

  const touched = touchRows[0]!;
  const keyId = Number(touched.key_id);
  const tier: ApiTier = touched.tier === "partner" ? "partner" : "free";

  const minuteLimiter = tier === "partner" ? minuteLimiterPartner : minuteLimiterFree;
  const minuteRl = minuteLimiter(`k${keyId}`);
  if (!minuteRl.allowed) {
    return {
      ok: false,
      response: withApiV1Headers(
        apiError(429, "Too many requests", {
          details: { retryAfterMs: minuteRl.retryAfterMs },
        }),
        tier,
      ),
    };
  }

  const now = new Date();
  const { data: usageRow, error: usageError } = await supabase
    .from("api_key_usage_daily")
    .select("calls")
    .eq("key_id", keyId)
    .eq("day", utcDayString(now))
    .maybeSingle();
  if (usageError) {
    return { ok: false, response: withApiV1Headers(apiServerError(usageError)) };
  }
  const calls = Number((usageRow as { calls?: number | string } | null)?.calls ?? 0);
  const perDay = API_TIER_LIMITS[tier].perDay;
  if (calls > perDay) {
    return {
      ok: false,
      response: withApiV1Headers(
        apiError(429, "Daily limit exceeded", {
          details: { retryAfterMs: msUntilNextUtcMidnight(now) },
        }),
        tier,
      ),
    };
  }

  return { ok: true, keyId, tier };
}
