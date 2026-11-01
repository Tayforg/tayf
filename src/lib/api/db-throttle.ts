import crypto from "node:crypto";
import { createServerClient } from "@/lib/supabase/server";

/**
 * Fleet-wide, DB-backed per-client throttle for the anonymous write routes
 * (migration 118): POST /api/oyun, POST /api/corrections, GET
 * /api/oyun/cerceve/next and POST /api/oyun/cerceve.
 *
 * src/lib/rate-limit.ts's in-memory limiter is process-local -- on Vercel
 * every instance has its own Map and a cold start resets it -- so on its own
 * it bounds one instance, not the fleet. This module calls
 * public.api_throttle(...) (a SECURITY DEFINER Postgres function) so the
 * counters live in the database. The in-memory limiter stays in front of it
 * as the cheap first filter; this is the second layer.
 *
 * Same shape as src/lib/admin/login-throttle.ts (createServerClient, a
 * Promise.race timeout, no server-only import so it is unit-testable), with
 * ONE deliberate difference: it FAILS OPEN. Login must not pass unchecked, so
 * its throttle fails closed. These routes are a game and a feedback form; a
 * throttle outage must never take them down, so every degraded path (missing
 * or short secret, shared "anon" key, invalid arguments, RPC error, thrown
 * error, timeout, malformed row) resolves `{ allowed: true, degraded: true }`
 * and warns. It never throws.
 *
 * Client key: the caller passes clientKey(request), which is the IP ONLY. The
 * User-Agent is deliberately NOT mixed in: it is attacker-controlled, so
 * IP+UA would let one IP mint unlimited buckets.
 *
 * Privacy (KVKK): only key_hash = HMAC-SHA256(subkey, clientKey) ever leaves
 * the process, where subkey = HMAC-SHA256(ADMIN_SESSION_SECRET, HMAC_DOMAIN).
 * The raw IP is never sent to the database and never logged: warnings carry
 * only an error code or name, and the bucket PREFIX (never the per-outlet id).
 */

export const DB_THROTTLE_RPC = "api_throttle";
export const DB_THROTTLE_TIMEOUT_MS = 3000;

/**
 * The thresholds in force, in one place so the routes, the tests and the
 * agreement.ts gameability note share the same numbers. (Next.js rejects
 * non-handler exports from a route.ts file, so they cannot live in the routes.)
 *
 *   oyun:all                 40 / hour  per client, any outlet     POST /api/oyun
 *   oyun:src:<source uuid>    3 / day   per client, per outlet     POST /api/oyun
 *   corrections:all           5 / hour  per client                 POST /api/corrections
 *   cerceve:vote            200 / hour  per client, counted votes  POST /api/oyun/cerceve
 *   cerceve:art:<article>     2 / day   per client, per headline   POST /api/oyun/cerceve
 *   cerceve:mint             20 / hour  per client, NEW sessions   POST /api/oyun/cerceve,
 *                                                                  GET /api/oyun/cerceve/next
 *
 * The Çerçeve buckets exist because the session cookie is signed: a vote is
 * counted only for an id the server minted, so the way to stuff the tally is
 * to keep minting fresh sessions. `cerceve:mint` caps that per client;
 * `cerceve:vote` caps the votes a client can land in total and
 * `cerceve:art:<article>` the votes one client can put on ONE headline, which
 * is what actually bounds a crowd split (the session cookie carries no expiry,
 * so a client can hold many valid ones). Same chain as /api/oyun: the
 * per-headline check is spent only when the hourly bucket allowed.
 *
 * `cerceve:vote` is sized to real play, not to abuse: a round is 60 s and a
 * player answers a headline every few seconds, so a heavy hour is well under
 * 200, and everyone behind one office, school or CGNAT address shares it.
 * Neither Çerçeve vote bucket ever answers 429: a full one skips the write and
 * still reveals the tally (200, ok:false), so a script cannot read when to
 * rotate IPs and an honest player behind a shared address never loses the
 * reveal, which is the game's payoff.
 *
 * They bound stuffing from one IP; they do not prevent it from many (the key
 * is the IP only). No migration: api_throttle accepts any bucket matching
 * BUCKET_RE below.
 */
export const THROTTLE_POLICY = {
  oyunAll: { bucket: "oyun:all", limit: 40, windowSeconds: 3600 },
  oyunSourcePrefix: "oyun:src:",
  oyunSourceLimit: 3,
  oyunSourceWindowSeconds: 86_400,
  corrections: { bucket: "corrections:all", limit: 5, windowSeconds: 3600 },
  cerceveVote: { bucket: "cerceve:vote", limit: 200, windowSeconds: 3600 },
  cerceveArticlePrefix: "cerceve:art:",
  cerceveArticleLimit: 2,
  cerceveArticleWindowSeconds: 86_400,
  cerceveMint: { bucket: "cerceve:mint", limit: 20, windowSeconds: 3600 },
} as const;

/** Domain-separation label: keeps this HMAC subkey unrelated to (and
 * non-invertible from) the admin-login digest (086) and the session-cookie
 * signature that also derive from ADMIN_SESSION_SECRET. */
const HMAC_DOMAIN = "tayf/api-throttle/v1";

/** Mirrors the table's CHECK constraint and the function's validation. */
const BUCKET_RE = /^[a-z0-9:_-]{1,80}$/;
const LIMIT_MAX = 1000;
const WINDOW_MAX_SECONDS = 86_400;

/** clientKey()'s fallback when no IP header is present. Every caller that
 * hits it would otherwise share ONE bucket, letting one client throttle
 * everyone else; refuse rather than mint a shared bucket. */
const ANON_CLIENT_KEY = "anon";

export interface DbThrottleDecision {
  /** false only when the database said this client is over the limit. */
  allowed: boolean;
  /** Seconds until the oldest counted hit ages out; 0 when allowed. */
  retryAfterSeconds: number;
  /** true when the throttle could not be consulted and the request was let through. */
  degraded: boolean;
}

export interface DbThrottleInput {
  /** e.g. "oyun:all" -- must match /^[a-z0-9:_-]{1,80}$/. */
  bucket: string;
  /** clientKey(request): the IP only. Hashed before it leaves the process. */
  clientKey: string;
  /** 1..1000 hits allowed per window. */
  limit: number;
  /** 1..86400 seconds. */
  windowSeconds: number;
}

/**
 * key_hash = HMAC-SHA256(subkey, clientKey), where
 * subkey = HMAC-SHA256(ADMIN_SESSION_SECRET, HMAC_DOMAIN).
 *
 * Two HMAC passes domain-separate this digest from any other consumer of
 * ADMIN_SESSION_SECRET: the same clientKey hashed for the admin-login
 * throttle, or for a session cookie, yields an unrelated value.
 */
export function hashThrottleKey(clientKey: string, secret: string): string {
  const subkey = crypto.createHmac("sha256", secret).update(HMAC_DOMAIN).digest();
  return crypto.createHmac("sha256", subkey).update(clientKey).digest("hex");
}

class TimeoutError extends Error {
  constructor() {
    super("api throttle RPC timed out");
    this.name = "TimeoutError";
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isThrottleRow(value: unknown): value is { allowed: boolean; retry_after_seconds?: unknown } {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { allowed?: unknown }).allowed === "boolean"
  );
}

/** "oyun:src:<uuid>" -> "oyun:src"; "oyun:all" -> "oyun:all". Never the id. */
function bucketPrefix(bucket: string): string {
  return bucket.split(":").slice(0, 2).join(":");
}

/** A short token safe to log: letters, digits, `_`, `.`, `-` only. */
function safeToken(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[\w.-]{1,32}$/.test(value) ? value : fallback;
}

function degraded(reason: string, bucket?: string): DbThrottleDecision {
  // The reason is a code or an error name; the bucket (when valid) is
  // reduced to its prefix. Neither the client key nor its digest is logged.
  if (bucket === undefined) console.warn(`[db-throttle] unavailable: ${reason}`);
  else console.warn(`[db-throttle] unavailable: ${reason}`, { bucket: bucketPrefix(bucket) });
  return { allowed: true, retryAfterSeconds: 0, degraded: true };
}

function validArgs(input: DbThrottleInput): boolean {
  return (
    BUCKET_RE.test(input.bucket) &&
    Number.isInteger(input.limit) &&
    input.limit >= 1 &&
    input.limit <= LIMIT_MAX &&
    Number.isInteger(input.windowSeconds) &&
    input.windowSeconds >= 1 &&
    input.windowSeconds <= WINDOW_MAX_SECONDS
  );
}

export async function checkDbThrottle(input: DbThrottleInput): Promise<DbThrottleDecision> {
  const { bucket, clientKey, limit, windowSeconds } = input;

  // Validated first, and the (possibly hostile) bucket string is NOT logged.
  if (typeof bucket !== "string" || !BUCKET_RE.test(bucket)) return degraded("bad_bucket");
  if (!validArgs(input)) return degraded("bad_args", bucket);

  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 16) return degraded("no_secret", bucket);

  if (clientKey === ANON_CLIENT_KEY) return degraded("anon_key", bucket);

  const keyHash = hashThrottleKey(clientKey, secret);

  let data: unknown;
  let error: { code?: unknown } | null;
  try {
    const call = createServerClient().rpc(DB_THROTTLE_RPC, {
      p_bucket: bucket,
      p_key_hash: keyHash,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    const result = await withTimeout(Promise.resolve(call), DB_THROTTLE_TIMEOUT_MS);
    data = (result as { data: unknown }).data;
    error = (result as { error: { code?: unknown } | null }).error;
  } catch (err) {
    return degraded(safeToken(err instanceof Error ? err.name : undefined, "Error"), bucket);
  }

  if (error) return degraded(safeToken(error.code, "error"), bucket);

  const row = Array.isArray(data) ? data[0] : data;
  if (!isThrottleRow(row)) return degraded("bad_row", bucket);

  if (row.allowed) {
    return { allowed: true, retryAfterSeconds: 0, degraded: false };
  }

  const raw = Math.floor(Number(row.retry_after_seconds));
  const retryAfterSeconds = Number.isFinite(raw) ? Math.max(1, raw) : 60;
  return { allowed: false, retryAfterSeconds, degraded: false };
}
