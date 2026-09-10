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
 *   3. On match we set `admin_session` — an HMAC-signed `{expiresAt}` token.
 *   4. Every admin page / route calls `requireAdminSession()` which verifies
 *      the signature + expiry, redirecting to /admin/login on failure.
 *
 * The cookie is stateless: no DB lookup, no user ID, just a "this browser
 * proved it knew the password within the last 7 days" token signed with
 * ADMIN_SESSION_SECRET. Rotating the secret invalidates all sessions.
 */

const COOKIE_NAME = "admin_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

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

interface SessionPayload {
  expiresAt: number;
}

function makeToken(payload: SessionPayload): string {
  const body = base64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

function parseToken(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(fromBase64url(body).toString("utf8")) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as SessionPayload).expiresAt !== "number"
    ) {
      return null;
    }
    const payload = parsed as SessionPayload;
    if (payload.expiresAt < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
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
  const expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  const token = makeToken({ expiresAt });
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
