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
 *   3. On match we set `admin_session` — an HMAC-signed `{expiresAt, iat, pwd}`
 *      token. `pwd` is a short tag derived from ADMIN_PASSWORD (see
 *      `passwordTag`), so the token is bound to the password it was minted under.
 *   4. Every admin page / route calls `requireAdminSession()` which verifies
 *      the signature, the lifetime and the password tag, redirecting to
 *      /admin/login on failure. src/middleware.ts mirrors the same checks with
 *      Web Crypto at the edge.
 *
 * The cookie is stateless: no DB lookup, no user ID, just a "this browser
 * proved it knew the password within the last 24 hours" token signed with
 * ADMIN_SESSION_SECRET.
 *
 * Ending sessions: rotating ADMIN_PASSWORD or ADMIN_SESSION_SECRET invalidates
 * every outstanding session at once (the tag or the signature no longer
 * verifies); otherwise a session ends at expiry, 24 h after login. Logout only
 * deletes the browser's cookie: a copy of it stays valid until one of those
 * happens, because server-side revocation is not implemented (it would need a
 * table, i.e. a migration).
 */

const COOKIE_NAME = "admin_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24; // 24 hours
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;
// A token minted by another instance may carry an iat slightly ahead of this
// instance's clock; anything further ahead than this is forged or broken.
const CLOCK_SKEW_MS = 60_000;
// 16 lower-case hex chars = 64 bits of the password HMAC (see passwordTag).
const PASSWORD_TAG_LENGTH = 16;
const PASSWORD_TAG_PATTERN = /^[0-9a-f]{16}$/;

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

function sign(body: string): string {
  return base64url(
    crypto.createHmac("sha256", getSessionSecret()).update(body).digest()
  );
}

/**
 * Binds a token to the password it was minted under:
 * HMAC-SHA256(ADMIN_SESSION_SECRET, "pwd:" + ADMIN_PASSWORD), hex, first 16
 * chars. "pwd:" is unique among the HMAC labels keyed on the same secret (the
 * throttles and the Çerçeve session use fixed "tayf..." labels, and a token body
 * is base64url, which has no ":"). Rotating ADMIN_PASSWORD changes the tag, so
 * every older token stops verifying. src/middleware.ts computes the same value
 * with Web Crypto.
 */
function passwordTag(secret: string, password: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update("pwd:" + password)
    .digest("hex")
    .slice(0, PASSWORD_TAG_LENGTH);
}

interface SessionPayload {
  expiresAt: number;
  iat: number;
  pwd: string;
}

function makeToken(payload: SessionPayload): string {
  const body = base64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.expiresAt === "number" &&
    Number.isFinite(p.expiresAt) &&
    typeof p.iat === "number" &&
    Number.isFinite(p.iat) &&
    typeof p.pwd === "string" &&
    PASSWORD_TAG_PATTERN.test(p.pwd)
  );
}

function parseToken(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  // 1. Signature.
  const expected = sign(body);
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
  // well-formed iat and pwd tag, is refused here.
  if (!isSessionPayload(parsed)) return null;
  const payload = parsed;

  // 3-5. Lifetime. `iat` is signed, so it cannot be moved without the secret,
  // but it is still bounded on both sides.
  const now = Date.now();
  if (payload.expiresAt < now) return null;
  if (payload.iat > now + CLOCK_SKEW_MS) return null;
  if (now - payload.iat > SESSION_MAX_AGE_MS) return null;
  if (payload.expiresAt - payload.iat > SESSION_MAX_AGE_MS) return null;

  // 6. Password binding. No ADMIN_PASSWORD means no session can be valid.
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return null;
  const expectedTag = Buffer.from(passwordTag(getSessionSecret(), password));
  const actualTag = Buffer.from(payload.pwd);
  if (actualTag.length !== expectedTag.length) return null;
  if (!crypto.timingSafeEqual(actualTag, expectedTag)) return null;

  return payload;
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
  const token = makeToken({
    expiresAt,
    iat,
    pwd: passwordTag(getSessionSecret(), getAdminPassword()),
  });
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
