import "server-only";

import crypto from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

/**
 * Admin session — tiny, stateless, password-gated.
 *
 * Why this instead of an auth library: Tayf has exactly one admin (the dev
 * building it). A full auth stack (users table, OAuth, etc.) is overkill;
 * a signed cookie keyed off two env vars is enough to keep the panel away
 * from casual visitors and prevent accidental ingest/nuke clicks by anyone
 * who stumbles onto /admin.
 *
 * Flow:
 *   1. User POSTs password to the login Server Action.
 *   2. Password is compared in constant time against ADMIN_PASSWORD.
 *   3. On match we set `admin_session`: `base64url({expiresAt, iat}) "."
 *      base64url(HMAC-SHA256(signingKey, body))`. The payload carries only two
 *      timestamps; nothing derived from the password is ever put into the token
 *      or hashed as data.
 *   4. Every admin page / route calls `requireAdminSession()` which verifies
 *      the signature and the lifetime, redirecting to /admin/login on failure.
 *      src/middleware.ts mirrors the same checks with Web Crypto at the edge.
 *
 * The session is bound to the password through the SIGNING KEY, not the payload:
 *   signingKey = PBKDF2-HMAC-SHA256(password = utf8(ADMIN_PASSWORD),
 *                  salt = utf8("tayf-admin-session-key:" + ADMIN_SESSION_SECRET),
 *                  100 000 iterations, 32 bytes)
 * (`deriveSessionSigningKey`). The password therefore only ever feeds a
 * password-hashing KDF whose output is used as an HMAC *key*; the HMAC input is
 * the token body, which holds no password-derived data. Rotating ADMIN_PASSWORD
 * or ADMIN_SESSION_SECRET changes the key, so every outstanding token stops
 * verifying (it was signed under a different key) without the token having to
 * say which password it belongs to. A token of the previous format (`pwd` tag,
 * HMAC keyed on the bare secret) fails the same way. Unknown payload fields are
 * ignored.
 *
 * Cost: the signature check needs the key, so the key is derived (PBKDF2, tens
 * of milliseconds) before the signature is compared. It is memoized for the
 * last (secret, password) pair, i.e. one derivation per process per pair, and
 * only cheap structural checks (cookie shape, signature length, ADMIN_PASSWORD
 * present) run before it, so junk cookies never trigger it.
 *
 * The cookie is stateless: no DB lookup, no user ID, just a "this browser
 * proved it knew the password within the last 24 hours" token.
 *
 * Ending sessions: rotating ADMIN_PASSWORD or ADMIN_SESSION_SECRET invalidates
 * every outstanding session at once (the signature no longer verifies);
 * otherwise a session ends at expiry, 24 h after login. Logout only deletes the
 * browser's cookie: a copy of it stays valid until one of those happens,
 * because server-side revocation is not implemented (it would need a table,
 * i.e. a migration).
 *
 * Device cookie (`admin_device`, migration 207): a second, much weaker signed
 * cookie, set only after a successful login. It is NOT a session:
 * `hasAdminSession()` never accepts it and it grants nothing by itself. Its only
 * use is to tell /admin/login "this browser has already proved the current
 * password", so the login throttle can count the browser's attempts per device
 * instead of through the per-IP and global buckets that every other caller
 * shares (the OWASP device-cookie pattern; see src/app/admin/login/actions.ts).
 * Token = `base64url({kind:"device", id, iat, expiresAt}) "." base64url(HMAC-
 * SHA256(deviceKey, body))`, `id` being 16 random bytes in hex. The device key
 * is HMAC-SHA256(sessionSigningKey, "tayf/admin-device/v1"): derived from the
 * session signing key, so rotating ADMIN_PASSWORD or ADMIN_SESSION_SECRET kills
 * every device cookie, and carrying its own domain label, so a session token can
 * never verify as a device token or the reverse. Lifetime 30 days, bounded on
 * both sides like the session. A device cookie that is missing, forged,
 * expired or minted under another password simply reads as "no device", and the
 * caller takes the normal per-IP + global path.
 */

const COOKIE_NAME = "admin_session";
const DEVICE_COOKIE_NAME = "admin_device";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24; // 24 hours
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;
const DEVICE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
const DEVICE_MAX_AGE_MS = DEVICE_MAX_AGE_SECONDS * 1000;
// Domain label of the device key. Only this module holds it, and it differs from
// every other label in use, so no other token can verify under the device key.
const DEVICE_KEY_LABEL = "tayf/admin-device/v1";
// 16 random bytes, lowercase hex. The login throttle hashes it, and the database
// only ever sees that digest.
const DEVICE_ID_PATTERN = /^[0-9a-f]{32}$/;
// A token minted by another instance may carry an iat slightly ahead of this
// instance's clock; anything further ahead than this is forged or broken.
const CLOCK_SKEW_MS = 60_000;
// base64url (no padding) of a 32-byte HMAC-SHA256 digest.
const SIGNATURE_LENGTH = 43;
// Salt label + cost + length of the signing-key derivation. src/middleware.ts
// repeats all three for its Web Crypto copy; tests/lib/admin/session.test.ts
// pins fixed vectors that the middleware tests reproduce, so the two cannot
// drift apart unnoticed.
const SIGNING_KEY_SALT_LABEL = "tayf-admin-session-key:";
const SIGNING_KEY_ITERATIONS = 100_000;
const SIGNING_KEY_BYTES = 32;

function getSessionSecret(): string {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "ADMIN_SESSION_SECRET is missing or too short (need >= 16 chars). " +
        "Generate one with `openssl rand -base64 32` and add to .env.local."
    );
  }
  return secret;
}

function getAdminPassword(): string {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) {
    throw new Error(
      "ADMIN_PASSWORD is not set. Add it to .env.local to enable admin login."
    );
  }
  return pw;
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function fromBase64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

/**
 * HMAC-SHA256 of the token body under `key`, base64url without padding. `key`
 * is the derived signing key (or, for tests that build a legacy-format token,
 * the bare secret). The body is the base64url JSON payload, which never holds
 * anything derived from the password.
 */
export function signSessionBody(key: Buffer | string, body: string): string {
  return base64url(crypto.createHmac("sha256", key).update(body).digest());
}

// The last (secret, password) pair and its signing key. PBKDF2 at 100k
// iterations costs tens of milliseconds, and every verification of every admin
// request needs the same key, so it is derived once per process per pair and
// then reused. A single slot is enough: the pair only changes when the env does.
// Held in memory only (the inputs are already in process.env); never logged or
// serialised. The two strings are compared separately, so ("a","bc") and
// ("ab","c") can never share an entry.
let cachedSigningKey: { secret: string; password: string; key: Buffer } | null =
  null;

/**
 * Derives the HMAC key that signs and verifies session tokens:
 * PBKDF2-HMAC-SHA256(password = utf8(ADMIN_PASSWORD),
 * salt = utf8("tayf-admin-session-key:" + ADMIN_SESSION_SECRET),
 * 100 000 iterations, 32 bytes). The password goes only into a password-hashing
 * KDF, never into a fast hash or an HMAC input, and its output is used only as
 * an HMAC key. The secret in the salt keeps keys from one deployment from
 * matching another's, and rotating either ADMIN_PASSWORD or ADMIN_SESSION_SECRET
 * changes the key, so every older token stops verifying. The label is unique to
 * this derivation (the throttles and the Çerçeve session HMAC fixed "tayf..."
 * labels *keyed on* the secret, a different construction).
 * src/middleware.ts computes the same bytes with Web Crypto.
 *
 * Memoized for the last (secret, password) pair. A derivation that throws is
 * not cached (the slot is assigned only after pbkdf2Sync returns), so the next
 * call simply derives again.
 */
export function deriveSessionSigningKey(secret: string, password: string): Buffer {
  const hit = cachedSigningKey;
  if (hit && hit.secret === secret && hit.password === password) return hit.key;
  const key = crypto.pbkdf2Sync(
    Buffer.from(password, "utf8"),
    Buffer.from(SIGNING_KEY_SALT_LABEL + secret, "utf8"),
    SIGNING_KEY_ITERATIONS,
    SIGNING_KEY_BYTES,
    "sha256",
  );
  cachedSigningKey = { secret, password, key };
  return key;
}

interface SessionPayload {
  expiresAt: number;
  iat: number;
}

function encodeToken(payload: unknown, key: Buffer): string {
  const body = base64url(JSON.stringify(payload));
  return `${body}.${signSessionBody(key, body)}`;
}

function makeToken(payload: SessionPayload): string {
  return encodeToken(
    payload,
    deriveSessionSigningKey(getSessionSecret(), getAdminPassword()),
  );
}

/**
 * Test helper: mints a token for an arbitrary payload under (secret, password)
 * with the production wire format and key derivation. Lets tests (here and in
 * tests/app/middleware-routing.test.ts) build valid and forged tokens, including
 * foreign-secret and old-password ones, without computing an HMAC themselves
 * over anything derived from a password. Production code does not call it.
 */
export function mintSessionTokenForTest(
  payload: unknown,
  secret: string,
  password: string,
): string {
  // Test-only: a production call would also evict the real key from the
  // single-slot cache.
  if (process.env.NODE_ENV === "production") {
    throw new Error("mintSessionTokenForTest is not available in production");
  }
  return encodeToken(payload, deriveSessionSigningKey(secret, password));
}

/**
 * Key that signs and verifies device tokens: HMAC-SHA256(sessionSigningKey,
 * "tayf/admin-device/v1"). It inherits the password and secret binding of the
 * session key (rotating either changes it) and is a different key, so a token
 * signed for one cookie never verifies for the other. One HMAC over a short
 * label is cheap; the expensive PBKDF2 step is the memoized session key.
 */
export function deriveDeviceSigningKey(secret: string, password: string): Buffer {
  return crypto
    .createHmac("sha256", deriveSessionSigningKey(secret, password))
    .update(DEVICE_KEY_LABEL)
    .digest();
}

/**
 * Test helper, the device-cookie twin of mintSessionTokenForTest: mints a token
 * for an arbitrary payload under (secret, password) with the production wire
 * format, so tests can build valid and forged device tokens. Production code
 * does not call it.
 */
export function mintDeviceTokenForTest(
  payload: unknown,
  secret: string,
  password: string,
): string {
  if (process.env.NODE_ENV === "production") {
    throw new Error("mintDeviceTokenForTest is not available in production");
  }
  return encodeToken(payload, deriveDeviceSigningKey(secret, password));
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.expiresAt === "number" &&
    Number.isFinite(p.expiresAt) &&
    typeof p.iat === "number" &&
    Number.isFinite(p.iat)
  );
}

function parseToken(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  // 0. Cheap structural checks, before any key derivation: a signature of the
  // wrong length can never match, and without ADMIN_PASSWORD no session can be
  // valid. Neither costs a PBKDF2 run.
  if (sig.length !== SIGNATURE_LENGTH) return null;
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return null;

  // 1. Signature. This needs the signing key, so the (memoized) PBKDF2
  // derivation happens here: one per process per (secret, password) pair.
  // getSessionSecret() throws on a missing or short secret; hasAdminSession
  // turns that into "no session".
  const key = deriveSessionSigningKey(getSessionSecret(), password);
  const expected = signSessionBody(key, body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64url(body).toString("utf8"));
  } catch {
    return null;
  }

  // 2. Shape. A legacy `{expiresAt}` token, or any other payload without a
  // well-formed iat, is refused here. Unknown fields (e.g. the old `pwd`) are
  // ignored: the key, not the payload, binds the session to the password.
  if (!isSessionPayload(parsed)) return null;
  const payload = parsed;

  // 3-5. Lifetime. `iat` is signed, so it cannot be moved without the key,
  // but it is still bounded on both sides.
  const now = Date.now();
  if (payload.expiresAt < now) return null;
  if (payload.iat > now + CLOCK_SKEW_MS) return null;
  if (now - payload.iat > SESSION_MAX_AGE_MS) return null;
  if (payload.expiresAt - payload.iat > SESSION_MAX_AGE_MS) return null;

  return payload;
}

interface DevicePayload {
  kind: "device";
  id: string;
  iat: number;
  expiresAt: number;
}

function isDevicePayload(value: unknown): value is DevicePayload {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    p.kind === "device" &&
    typeof p.id === "string" &&
    DEVICE_ID_PATTERN.test(p.id) &&
    typeof p.iat === "number" &&
    Number.isFinite(p.iat) &&
    typeof p.expiresAt === "number" &&
    Number.isFinite(p.expiresAt)
  );
}

/**
 * Verifies a device token and returns its id, or null. Same order as
 * parseToken: cheap structural checks first (so junk cookies never trigger the
 * key derivation), then the constant-time signature compare, then the shape and
 * the lifetime. Throws only if ADMIN_SESSION_SECRET is missing or short;
 * readAdminDeviceId turns that into null.
 */
function parseDeviceToken(token: string | undefined): string | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  if (sig.length !== SIGNATURE_LENGTH) return null;
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return null;

  const key = deriveDeviceSigningKey(getSessionSecret(), password);
  const a = Buffer.from(sig);
  const b = Buffer.from(signSessionBody(key, body));
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64url(body).toString("utf8"));
  } catch {
    return null;
  }
  if (!isDevicePayload(parsed)) return null;

  const now = Date.now();
  if (parsed.expiresAt <= now) return null;
  if (parsed.iat > now + CLOCK_SKEW_MS) return null;
  if (parsed.expiresAt - parsed.iat > DEVICE_MAX_AGE_MS) return null;

  return parsed.id;
}

/**
 * Constant-time password check. Both sides are run through scrypt so the
 * comparison is over equal-length digests (no length leak through timing)
 * and so the derived value is not a cheap hash of the password. Nothing is
 * stored; the fixed salt only normalises the two sides. Cost is ~50 ms per
 * attempt, which the login limiter in actions.ts already bounds.
 */
const PASSWORD_CHECK_SALT = "tayf-admin-login-v1";

export function checkAdminPassword(input: string): boolean {
  const expected = getAdminPassword();
  const a = crypto.scryptSync(input, PASSWORD_CHECK_SALT, 32);
  const b = crypto.scryptSync(expected, PASSWORD_CHECK_SALT, 32);
  return crypto.timingSafeEqual(a, b);
}

export async function createAdminSession(): Promise<void> {
  const iat = Date.now();
  const expiresAt = iat + SESSION_MAX_AGE_MS;
  const token = makeToken({ expiresAt, iat });
  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
    expires: new Date(expiresAt),
  });
}

export async function deleteAdminSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

/**
 * Marks this browser as one that has logged in with the current password: sets
 * the signed `admin_device` cookie (HttpOnly, SameSite=Strict, Secure in
 * production, path /admin, 30 days) with a fresh random id. Call it right after
 * createAdminSession(), only after the password check has passed.
 *
 * Best effort by design: the session cookie is already set when this runs, and
 * a device cookie that cannot be set only means the next login takes the normal
 * per-IP + global throttle path. Never throws; logs only an exception name.
 */
export async function issueAdminDeviceCookie(): Promise<void> {
  try {
    const key = deriveDeviceSigningKey(getSessionSecret(), getAdminPassword());
    const iat = Date.now();
    const expiresAt = iat + DEVICE_MAX_AGE_MS;
    const id = crypto.randomBytes(16).toString("hex");
    const token = encodeToken({ kind: "device", id, iat, expiresAt }, key);
    const store = await cookies();
    store.set(DEVICE_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/admin",
      maxAge: DEVICE_MAX_AGE_SECONDS,
      expires: new Date(expiresAt),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    console.warn(`[admin-login] device cookie not issued: ${name}`);
  }
}

/**
 * The id inside a valid `admin_device` cookie, or null when the cookie is
 * absent, forged, expired, over-long, minted under another password or secret,
 * or the environment is not configured. Swallows every error: a caller treats
 * null as "not a known device" and uses the normal throttle path. The id is a
 * throttle key, not a credential; never log it.
 */
export async function readAdminDeviceId(): Promise<string | null> {
  try {
    const store = await cookies();
    return parseDeviceToken(store.get(DEVICE_COOKIE_NAME)?.value);
  } catch {
    return null;
  }
}

/**
 * Non-redirecting check. Use this from layout/nav code that just needs
 * to decide whether to render the admin link.
 *
 * Swallows errors on purpose: this runs on every page render via Header,
 * and if ADMIN_SESSION_SECRET is misconfigured on a preview deploy we
 * want public pages to still render. No secret → no valid session could
 * have been issued anyway, so returning false is correct.
 */
export async function hasAdminSession(): Promise<boolean> {
  try {
    const store = await cookies();
    return parseToken(store.get(COOKIE_NAME)?.value) !== null;
  } catch {
    return false;
  }
}

/**
 * Redirects to /admin/login if the caller is not authenticated. Call this
 * at the top of every admin page/route that mutates data or reveals
 * internal stats.
 */
export async function requireAdminSession(): Promise<void> {
  if (!(await hasAdminSession())) {
    redirect("/admin/login");
  }
}
