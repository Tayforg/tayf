import crypto from "node:crypto";
import { createServerClient } from "@/lib/supabase/server";

/**
 * DB-backed second layer of the admin-login throttle (migration 086).
 *
 * src/lib/rate-limit.ts's in-memory limiter is process-local -- its own
 * module doc says a multi-instance/serverless deployment (Vercel) needs a
 * shared store for the buckets to hold across replicas, and it's keyed per
 * clientKey() (per IP), so rotating IPs bypasses it even on a single
 * instance. This module calls public.admin_login_throttle(text) (a
 * SECURITY DEFINER Postgres function) so the counters live in the database
 * instead of in a Map that resets every cold start.
 *
 * Unlike src/lib/admin/session.ts, this module does NOT import the
 * server-only package -- that package throws under vitest, and this module
 * is exercised directly by its own unit tests, not only through a mocked
 * session module.
 *
 * Privacy (KVKK): only an HMAC-SHA256 digest of the client key is ever
 * sent to the database. The raw IP and the password never leave this
 * process, and are never logged -- warnings below log only an error code
 * or an exception name, never a message, key or IP.
 *
 * Fail-closed: a missing/short ADMIN_SESSION_SECRET, an RPC error, an
 * exception, a timeout, or a malformed response row all deny the login
 * attempt (`{ allowed: false, reason: "unavailable" }`). The caller
 * (src/app/admin/login/actions.ts) treats "unavailable" the same as
 * "limited": a generic error, never a bypass. The next attempt simply
 * retries the RPC, so a transient DB hiccup can never lock the admin out
 * permanently.
 */

export const LOGIN_THROTTLE_RPC = "admin_login_throttle";
export const LOGIN_THROTTLE_TIMEOUT_MS = 3000;

/** Domain-separation label: keeps this HMAC subkey unrelated to (and
 * non-invertible from) the session-cookie signature that also derives from
 * ADMIN_SESSION_SECRET (src/lib/admin/session.ts). */
const HMAC_DOMAIN = "tayf/admin-login-throttle/v1";

export type LoginThrottleDecision =
  | { allowed: true }
  | { allowed: false; reason: "limited"; retryAfterSeconds: number }
  | { allowed: false; reason: "unavailable" };

/**
 * key_hash = HMAC-SHA256(subkey, clientKey), where
 * subkey = HMAC-SHA256(ADMIN_SESSION_SECRET, HMAC_DOMAIN).
 *
 * Two HMAC passes (rather than a single keyed HMAC over the raw secret)
 * domain-separate this digest from any other consumer of
 * ADMIN_SESSION_SECRET: even if another feature ever HMACs the same
 * clientKey with the raw secret, the two digests will not collide or be
 * derivable from one another.
 */
export function hashLoginKey(clientKey: string, secret: string): string {
  const subkey = crypto.createHmac("sha256", secret).update(HMAC_DOMAIN).digest();
  return crypto.createHmac("sha256", subkey).update(clientKey).digest("hex");
}

function isThrottleRow(value: unknown): value is { allowed: boolean; retry_after_seconds?: unknown } {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { allowed?: unknown }).allowed === "boolean"
  );
}

class TimeoutError extends Error {
  constructor() {
    super("admin login throttle RPC timed out");
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

/** src/lib/rate-limit.ts's clientKey() fallback when no x-real-ip /
 * x-vercel-forwarded-for / x-forwarded-for header is present. Every caller
 * that hits the fallback would otherwise share one DB-backed bucket. */
const ANON_CLIENT_KEY = "anon";

export async function checkAdminLoginThrottle(clientKey: string): Promise<LoginThrottleDecision> {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 16) {
    console.warn("[admin-login] throttle unavailable: secret not configured");
    return { allowed: false, reason: "unavailable" };
  }

  // Refuse before hashing or calling the RPC: on any deploy target where
  // the "anon" sentinel can be reached by more than one caller, sharing
  // one bucket would let one client lock out another. Fail closed the
  // same way an unconfigured secret does, rather than mint a shared
  // bucket for it.
  if (clientKey === ANON_CLIENT_KEY) {
    console.warn("[admin-login] throttle unavailable: anon client key");
    return { allowed: false, reason: "unavailable" };
  }

  const keyHash = hashLoginKey(clientKey, secret);

  let data: unknown;
  let error: { code?: string; message?: string } | null;
  try {
    const call = createServerClient().rpc(LOGIN_THROTTLE_RPC, { p_key_hash: keyHash });
    const result = await withTimeout(Promise.resolve(call), LOGIN_THROTTLE_TIMEOUT_MS);
    data = (result as { data: unknown; error: { code?: string; message?: string } | null }).data;
    error = (result as { data: unknown; error: { code?: string; message?: string } | null }).error;
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    console.warn(`[admin-login] throttle unavailable: ${name}`);
    return { allowed: false, reason: "unavailable" };
  }

  if (error) {
    console.warn(`[admin-login] throttle unavailable: ${error.code ?? "error"}`);
    return { allowed: false, reason: "unavailable" };
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!isThrottleRow(row)) {
    return { allowed: false, reason: "unavailable" };
  }

  if (row.allowed) {
    return { allowed: true };
  }

  const raw = Math.floor(Number(row.retry_after_seconds));
  const retryAfterSeconds = Number.isFinite(raw) ? Math.max(1, raw) : 60;
  return { allowed: false, reason: "limited", retryAfterSeconds };
}
