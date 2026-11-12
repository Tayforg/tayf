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
 *
 * Device variant (migration 207): `checkAdminDeviceLoginThrottle` serves a
 * browser that carries a valid signed `admin_device` cookie (see
 * src/lib/admin/session.ts). It calls public.admin_login_throttle_device(text),
 * which has the per-key cap but no global counter, with a key derived from the
 * device id instead of the client address. Both functions share one RPC call,
 * one timeout and one row check below, and fail closed the same way. The only
 * thing the caller does differently on "unavailable" is fall back to
 * `checkAdminLoginThrottle` (never to "allowed"), except after a timeout
 * (`timedOut: true`): the timed-out RPC is not cancelled and may still record
 * its attempt, so a fallback could count the same attempt twice and add
 * another 3 s of waiting while the database is degraded.
 */

export const LOGIN_THROTTLE_RPC = "admin_login_throttle";
export const LOGIN_THROTTLE_DEVICE_RPC = "admin_login_throttle_device";
export const LOGIN_THROTTLE_TIMEOUT_MS = 3000;

/** Domain-separation label: keeps this HMAC subkey unrelated to (and
 * non-invertible from) the session-cookie signature that also derives from
 * ADMIN_SESSION_SECRET (src/lib/admin/session.ts). */
const HMAC_DOMAIN = "tayf/admin-login-throttle/v1";

export type LoginThrottleDecision =
  | { allowed: true }
  | { allowed: false; reason: "limited"; retryAfterSeconds: number }
  | { allowed: false; reason: "unavailable"; timedOut?: true };

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

/** Prefix that keeps device keys apart from client keys: no client key (an IP address or "anon") starts with it. */
const DEVICE_KEY_PREFIX = "device:";
/** The id `issueAdminDeviceCookie` mints: 16 random bytes, lowercase hex. */
const DEVICE_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * One throttle RPC, shared by the per-IP and the per-device check: call
 * `rpcName` with the finished digest as `p_key_hash`, bound the call by
 * LOGIN_THROTTLE_TIMEOUT_MS and turn the answer into a decision. Every failure
 * (error, exception, timeout, malformed row) is "unavailable".
 */
async function callThrottleRpc(rpcName: string, keyHash: string): Promise<LoginThrottleDecision> {
  let data: unknown;
  let error: { code?: string; message?: string } | null;
  try {
    const call = createServerClient().rpc(rpcName, { p_key_hash: keyHash });
    const result = await withTimeout(Promise.resolve(call), LOGIN_THROTTLE_TIMEOUT_MS);
    data = (result as { data: unknown; error: { code?: string; message?: string } | null }).data;
    error = (result as { data: unknown; error: { code?: string; message?: string } | null }).error;
  } catch (err) {
    if (err instanceof TimeoutError) {
      // The timed-out RPC is not cancelled and may still record its attempt,
      // so say so: the caller must not retry it on another path.
      console.warn("[admin-login] throttle unavailable: TimeoutError");
      return { allowed: false, reason: "unavailable", timedOut: true };
    }
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

  return callThrottleRpc(LOGIN_THROTTLE_RPC, hashLoginKey(clientKey, secret));
}

/**
 * Per-device throttle for a browser holding a valid `admin_device` cookie
 * (migration 207): the per-key cap of 5 attempts / 15 minutes, no global
 * counter. `deviceId` is the id `readAdminDeviceId()` returned; anything that
 * is not 32 lowercase hex characters is refused before the RPC, so a malformed
 * id can never mint an unrelated bucket. Fails closed exactly like
 * `checkAdminLoginThrottle`. Never logs the id.
 */
export async function checkAdminDeviceLoginThrottle(deviceId: string): Promise<LoginThrottleDecision> {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 16) {
    console.warn("[admin-login] throttle unavailable: secret not configured");
    return { allowed: false, reason: "unavailable" };
  }

  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    console.warn("[admin-login] throttle unavailable: malformed device id");
    return { allowed: false, reason: "unavailable" };
  }

  return callThrottleRpc(LOGIN_THROTTLE_DEVICE_RPC, hashLoginKey(DEVICE_KEY_PREFIX + deviceId, secret));
}
