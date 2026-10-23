import crypto from "node:crypto";

import {
  apiError,
  apiNotFound,
  apiServerError,
  apiTooManyRequests,
  apiUnauthorized,
} from "@/lib/api/errors";
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
    // Without this a browser hides every non-CORS-safelisted response header
    // from `fetch()`, so a cross-origin client could read the 429 body but not
    // when to retry, nor which tier it was served as. Kept in step with the
    // "Tarayıcıdan okunabilen başlıklar" note in v1-docs.ts (V1_COMMON_NOTES_TR).
    "Access-Control-Expose-Headers": "X-Tayf-Tier, Retry-After",
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

type V1RateLimitCode = "ip_floor" | "key_minute" | "key_day";

/**
 * 429 for every limiter under /api/v1: the shared `apiTooManyRequests` body
 * (`{error, code, details: {retryAfterMs}}`, `Retry-After` in whole seconds and
 * never below 1, so a client that honours it cannot spin), wrapped with the
 * v1 CORS / cache-control contract. `code` names WHICH limit tripped. `tier`
 * is passed only where the key was resolved (key_minute / key_day).
 */
function v1TooManyRequests(
  retryAfterMs: number,
  code: V1RateLimitCode,
  tier?: ApiTier,
): Response {
  const message = code === "key_day" ? "Daily limit exceeded" : "Too many requests";
  return withApiV1Headers(apiTooManyRequests(retryAfterMs, { message, code }), tier);
}

/**
 * 401 with the RFC 6750 challenge. `invalidToken` is false when the caller
 * sent no Authorization header at all (bare realm: "authenticate here"), and
 * true when it sent a credential that is malformed or not on file
 * (`error="invalid_token"`: "what you sent is no good"). The body is the same
 * either way.
 */
function v1Unauthorized(invalidToken: boolean): Response {
  const res = withApiV1Headers(apiUnauthorized("Missing or invalid API key"));
  res.headers.set(
    "WWW-Authenticate",
    invalidToken ? 'Bearer realm="tayf-api", error="invalid_token"' : 'Bearer realm="tayf-api"',
  );
  return res;
}

/**
 * 405 for every method a /api/v1 route does not serve. Routes bind
 * `export const POST = methodNotAllowed` (and PUT/PATCH/DELETE) so a wrong
 * method gets the JSON envelope, CORS and an `Allow` header instead of
 * Next's bodyless default. HEAD is allowed because Next derives it from GET.
 * Async + argument-free on purpose: it is a valid route handler as-is, and it
 * touches no key, database or limiter.
 */
export async function methodNotAllowed(): Promise<Response> {
  const res = withApiV1Headers(apiError(405, "Method not allowed"));
  res.headers.set("Allow", "GET, HEAD, OPTIONS");
  return res;
}

/** 404 for an unknown /api/v1/* path (used by the `[...path]` catch-all). */
export async function v1NotFound(): Promise<Response> {
  return withApiV1Headers(apiNotFound("Not found"));
}

// Strict per-IP floor for callers WITHOUT a working key: keyed by
// clientKey(request), NOT by API key, so an unauthenticated burst (garbage or
// missing Authorization headers) never even reaches Supabase to look up a
// hash. It is charged to (a) requests with no / malformed credentials and
// (b) requests whose well-formed key turns out to be unknown or revoked. A
// VALID key is never charged here: a partner on a shared egress IP must not
// be throttled to the anonymous rate.
//
// Exported so /gelistirici (src/app/gelistirici/page.tsx) can derive its
// "a single IP is capped at ~60/min" copy from the same numbers this limiter
// actually runs on, instead of a hand-typed "30" and "1" the two could
// silently drift apart on.
export const API_V1_ANON_LIMIT = { capacity: 30, refillPerSecond: 1 } as const;
const anonLimiter = createRateLimiter("api-v1-anon", API_V1_ANON_LIMIT);

// Generous per-IP ceiling for requests that PRESENT a syntactically valid key,
// checked BEFORE the api_key_touch round trip. Without it, a flood of made-up
// well-formed keys would each cost a database RPC (the anonymous bucket is
// only charged after the lookup says "unknown"). Sized so it never binds a
// legitimate caller: burst = 2x the free per-minute cap, sustained = the
// partner per-minute cap, i.e. it only ever trips on a single IP doing more
// than the best tier is entitled to anyway. Exported for /gelistirici.
export const API_V1_KEYED_IP_LIMIT = {
  capacity: 2 * API_TIER_LIMITS.free.perMinute,
  refillPerSecond: API_TIER_LIMITS.partner.perMinute / 60,
} as const;
const keyedIpLimiter = createRateLimiter("api-v1-keyed-ip", API_V1_KEYED_IP_LIMIT);

// Per-minute buckets, one per tier, keyed by `h${sha256 of the key}` (never by
// IP — a partner key legitimately fans out across many client IPs). The hash,
// not the key id, because for a key this instance has already seen the bucket
// is charged BEFORE the `api_key_touch` round trip, which is the call that
// reveals the id. Capacity equals the advertised per-minute ceiling; refill
// spreads that same ceiling evenly across 60s so a key that spends its whole
// minute budget immediately has to wait roughly a minute for the next token.
const minuteLimiterFree = createRateLimiter("api-v1-min-free", {
  capacity: API_TIER_LIMITS.free.perMinute,
  refillPerSecond: API_TIER_LIMITS.free.perMinute / 60,
});
const minuteLimiterPartner = createRateLimiter("api-v1-min-partner", {
  capacity: API_TIER_LIMITS.partner.perMinute,
  refillPerSecond: API_TIER_LIMITS.partner.perMinute / 60,
});

// Process-local memo of the tier `api_key_touch` last reported for a key hash,
// so a repeat caller's per-minute bucket can be charged BEFORE the touch (a
// refused request then costs neither a database round trip nor a unit of the
// key's DAILY quota, which the touch increments as a side effect). Only keys
// the database vouched for are ever stored: an unknown or revoked key is never
// memoised, so a flood of made-up keys cannot grow it. Capped at
// API_TIER_MEMO_CAP entries; the oldest insertion is evicted first (a plain
// Map keeps insertion order). A wrong or missing entry is harmless: it only
// decides WHEN the minute bucket is charged, never whether a key is valid.
const API_TIER_MEMO_CAP = 5000;
const tierMemo = new Map<string, ApiTier>();

function memoiseTier(hash: string, tier: ApiTier): void {
  // Re-inserting (a tier change) moves the entry to the newest position.
  tierMemo.delete(hash);
  while (tierMemo.size >= API_TIER_MEMO_CAP) {
    const oldest = tierMemo.keys().next();
    if (oldest.done) break;
    tierMemo.delete(oldest.value);
  }
  tierMemo.set(hash, tier);
}

function minuteBucketFor(tier: ApiTier, hash: string): { allowed: boolean; retryAfterMs: number } {
  const limiter = tier === "partner" ? minuteLimiterPartner : minuteLimiterFree;
  return limiter(`h${hash}`);
}

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
 *   1. Parse the `Authorization: Bearer tayf_<40 hex>` header
 *      (`parseBearerApiKey`, pure: no I/O, no limiter).
 *   2. NO VALID KEY (header missing, wrong scheme, malformed token): charge the
 *      strict anonymous bucket (`api-v1-anon`, keyed by client IP). Denied ->
 *      429 `ip_floor`. Otherwise -> 401 with a `WWW-Authenticate` challenge
 *      (`error="invalid_token"` only if an Authorization header was present).
 *      No database call on this path, ever.
 *   3. VALID-FORMAT KEY: charge the generous keyed-IP bucket
 *      (`api-v1-keyed-ip`) BEFORE any database call. Denied -> 429
 *      `ip_floor`. This bounds a flood of made-up well-formed keys, which
 *      would otherwise each cost an `api_key_touch` round trip.
 *   4. Hash the presented key (sha256 hex). If this instance has seen the key
 *      before (the tier memo), charge that tier's per-minute bucket
 *      (`h${hash}`) BEFORE the database: denied -> 429 `key_minute` with that
 *      tier and NO `api_key_touch` call, so a refused request costs the key no
 *      daily quota. Then call the `api_key_touch` RPC: a SINGLE round trip that
 *      ALSO durably increments today's `api_key_usage_daily.calls` row for a
 *      live, non-revoked key as a side effect (migration 069) — by the time
 *      step 5 reads that counter, THIS call has already been counted.
 *      Empty result (`api_key_touch` returns unknown OR revoked keys as an
 *      empty row set, indistinguishably): drop any memo entry for the key,
 *      charge the strict anonymous bucket for this IP (denied -> 429
 *      `ip_floor`, and the extra lookup is skipped), then ONE extra lookup,
 *      ONLY on this failure path, to tell the two apart for the caller:
 *      `.from('api_keys').select('id').eq('key_hash', h).not('revoked_at','is',null).maybeSingle()`.
 *      A row -> 403 (revoked). No row -> 401 `invalid_token` (never existed).
 *   5. A VALID key: memoise the tier the touch reported. A key with no memo
 *      entry (first sight on this instance, or evicted) is charged to its
 *      tier's per-minute bucket now — the only post-touch charge, because the
 *      tier was unknown until the touch answered; a key whose tier changed is
 *      charged to the NEW tier's bucket (the pre-touch charge went to the old
 *      one). Denied -> 429 `key_minute`. Then the durable per-day check
 *      against `api_key_usage_daily` for (key_id, UTC today) (429 `key_day`).
 *      Because step 4 already incremented the counter, the comparison is
 *      `calls > perDay` — the call that pushes the count one PAST the cap is
 *      the one that gets refused, not the call that reaches exactly the cap.
 *
 * The anonymous bucket is never charged for a valid key, so a partner sharing
 * an egress IP with noisy keyless traffic is not throttled by it.
 *
 * Never logs, returns, or Sentry-captures the presented key or its hash
 * anywhere in this function or its error paths.
 */
export async function requireApiKey(request: Request): Promise<ApiKeyAuth> {
  const ip = clientKey(request);
  const authorization = request.headers.get("authorization");
  const presented = parseBearerApiKey(authorization);

  if (presented === null) {
    const anonRl = anonLimiter(ip);
    if (!anonRl.allowed) {
      return { ok: false, response: v1TooManyRequests(anonRl.retryAfterMs, "ip_floor") };
    }
    return { ok: false, response: v1Unauthorized(authorization !== null) };
  }

  const keyedIpRl = keyedIpLimiter(ip);
  if (!keyedIpRl.allowed) {
    return { ok: false, response: v1TooManyRequests(keyedIpRl.retryAfterMs, "ip_floor") };
  }

  const hash = hashApiKey(presented);

  // A key this instance has seen: charge its per-minute bucket before the
  // touch, so a refused request never reaches the database or the daily count.
  const memoTier = tierMemo.get(hash);
  if (memoTier !== undefined) {
    const preRl = minuteBucketFor(memoTier, hash);
    if (!preRl.allowed) {
      return {
        ok: false,
        response: v1TooManyRequests(preRl.retryAfterMs, "key_minute", memoTier),
      };
    }
  }

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
    // Unknown or revoked: forget anything remembered about the key, and note
    // that this IP is presenting a credential that does not work, which is
    // exactly what the strict anonymous bucket is for.
    tierMemo.delete(hash);
    const anonRl = anonLimiter(ip);
    if (!anonRl.allowed) {
      return { ok: false, response: v1TooManyRequests(anonRl.retryAfterMs, "ip_floor") };
    }
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
    return { ok: false, response: v1Unauthorized(true) };
  }

  const touched = touchRows[0]!;
  const keyId = Number(touched.key_id);
  const tier: ApiTier = touched.tier === "partner" ? "partner" : "free";

  // Memo hit with the same tier: already charged before the touch. A miss
  // (tier unknown until now) or a changed tier (the pre-touch charge hit the
  // old tier's bucket) is remembered and charged to THIS tier's bucket here.
  if (memoTier !== tier) {
    memoiseTier(hash, tier);
    const postRl = minuteBucketFor(tier, hash);
    if (!postRl.allowed) {
      return {
        ok: false,
        response: v1TooManyRequests(postRl.retryAfterMs, "key_minute", tier),
      };
    }
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
      response: v1TooManyRequests(msUntilNextUtcMidnight(now), "key_day", tier),
    };
  }

  return { ok: true, keyId, tier };
}
