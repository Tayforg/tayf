/**
 * src/lib/game/framing-session.ts -- server-side signing of the Çerçeve
 * ("Framing") session cookie.
 *
 * WHY: a vote is stored under `unique (article_id, session_hash)` where
 * `session_hash = sha256(id)`. While the cookie was a bare 32-hex string, any
 * client could pick (or rotate) its own id and so cast unlimited votes on one
 * headline. The cookie is now `<32-hex id>.<base64url(HMAC-SHA256(key, id))>`;
 * the server COUNTS a vote only when the signature verifies, i.e. only for an
 * id this server minted. The id never leaves the cookie jar: only its sha256
 * (`hashSessionId`, framing.ts) reaches the database.
 *
 * KEY (read from the live environment on every call, so a rotation needs no
 * restart; no new required env var):
 *   1. `FRAMING_SESSION_SECRET` (>= 16 chars): its UTF-8 bytes are the HMAC key.
 *   2. otherwise `ADMIN_SESSION_SECRET` (>= 16 chars, already required by the
 *      admin panel): the key is HMAC-SHA256(ADMIN_SESSION_SECRET,
 *      "tayf-cerceve-v1"), a domain-separated derivation so an admin-session
 *      MAC and a Çerçeve MAC can never be swapped for one another.
 *   3. otherwise there is no key: nothing verifies, so no vote is counted
 *      (fail closed), `mintSignedSession` hands back the bare id, and one
 *      `console.warn` per process says so. Nothing ever throws.
 *
 * WEB CRYPTO ONLY (`crypto.subtle`), never `node:crypto`, so the module runs
 * unchanged in every Next.js runtime. Verification goes through
 * `crypto.subtle.verify`, which compares in constant time. The signature must
 * also be CANONICAL base64url: the last char of a 32-byte value carries two
 * padding bits that a lenient decoder ignores, which would otherwise let
 * several different strings verify as the same MAC.
 *
 * Never log an id, a cookie value, a signature or a key.
 */

import { FRAMING_SESSION_COOKIE, newSessionId } from "@/lib/game/framing";

const MIN_SECRET_LENGTH = 16;
const DERIVATION_LABEL = "tayf-cerceve-v1";

/** `<32 lowercase hex>.<43 base64url chars>` (a SHA-256 MAC is 32 bytes). */
const SIGNED_COOKIE_RE = /^([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/;

const encoder = new TextEncoder();

function hmacKeyFromBytes(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function deriveKey(
  framingSecret: string | undefined,
  adminSecret: string | undefined,
): Promise<CryptoKey | null> {
  if (framingSecret && framingSecret.length >= MIN_SECRET_LENGTH) {
    return hmacKeyFromBytes(encoder.encode(framingSecret));
  }
  if (adminSecret && adminSecret.length >= MIN_SECRET_LENGTH) {
    const root = await hmacKeyFromBytes(encoder.encode(adminSecret));
    const derived = await crypto.subtle.sign("HMAC", root, encoder.encode(DERIVATION_LABEL));
    return hmacKeyFromBytes(new Uint8Array(derived));
  }
  return null;
}

// One cached derivation, keyed by the secrets it came from: a rotated secret
// yields a different cache key and so a fresh derivation.
let cached: { fingerprint: string; key: Promise<CryptoKey | null> } | null = null;
let warnedUnavailable = false;

async function getSigningKey(): Promise<CryptoKey | null> {
  const framingSecret = process.env.FRAMING_SESSION_SECRET;
  const adminSecret = process.env.ADMIN_SESSION_SECRET;
  const fingerprint = `${framingSecret ?? ""}\u0000${adminSecret ?? ""}`;

  if (cached === null || cached.fingerprint !== fingerprint) {
    cached = { fingerprint, key: deriveKey(framingSecret, adminSecret) };
  }

  let key: CryptoKey | null = null;
  try {
    key = await cached.key;
  } catch {
    key = null;
  }
  if (key === null && !warnedUnavailable) {
    warnedUnavailable = true;
    console.warn("[oyun/cerceve] session signing unavailable");
  }
  return key;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict decode: null unless `value` is the canonical base64url of 32 bytes. */
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  let binary: string;
  try {
    binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=");
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.length !== 32 || toBase64Url(bytes) !== value) return null;
  return bytes;
}

/** `<id>.<base64url(HMAC-SHA256(key, id))>`, or null when there is no key. */
export async function signSessionId(id: string): Promise<string | null> {
  const key = await getSigningKey();
  if (key === null) return null;
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(id));
  return `${id}.${toBase64Url(new Uint8Array(mac))}`;
}

/**
 * The 32-hex session id from the request's `tayf_cerceve_sid` cookie, but
 * ONLY when its signature verifies; an absent cookie, a wrong shape, an
 * unsigned legacy value, a forged or tampered MAC, a MAC from another secret,
 * or a missing key all fold to `null` (the caller mints a fresh session).
 */
export async function readSignedSessionCookie(request: Request): Promise<string | null> {
  const header = request.headers.get("cookie");
  if (!header) return null;

  let raw: string | null = null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== FRAMING_SESSION_COOKIE) continue;
    raw = part.slice(eq + 1).trim();
    break;
  }
  if (raw === null) return null;

  const match = SIGNED_COOKIE_RE.exec(raw);
  if (!match) return null;
  const id = match[1] as string;
  const signature = fromBase64Url(match[2] as string);
  if (signature === null) return null;

  const key = await getSigningKey();
  if (key === null) return null;

  const ok = await crypto.subtle.verify("HMAC", key, signature, encoder.encode(id));
  return ok ? id : null;
}

/**
 * A fresh session: the opaque `id` (what `hashSessionId` hashes) and the
 * `cookieValue` to put in `tayf_cerceve_sid`. Without a key the cookie value
 * is the bare id, which `readSignedSessionCookie` will never accept.
 */
export async function mintSignedSession(): Promise<{ id: string; cookieValue: string }> {
  const id = newSessionId();
  const cookieValue = (await signSessionId(id)) ?? id;
  return { id, cookieValue };
}
