import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Unit tests for the Çerçeve session-cookie signer (api-7).
//
// The cookie is `<32-hex id>.<base64url(HMAC-SHA256(key, id))>`. The server
// only COUNTS a vote when the cookie verifies, so a client can no longer pick
// its own session id (and with it a fresh `unique (article_id, session_hash)`
// slot per vote). The expected signatures below are computed with node:crypto
// in the TEST, independently of the module under test, which is WebCrypto-only.
//
// Every test re-imports the module (vi.resetModules) so the warn-once flag and
// the cached key start fresh.
// ---------------------------------------------------------------------------

const ADMIN_SECRET = "x".repeat(32);
const OTHER_SECRET = "y".repeat(32);
const FRAMING_SECRET = "framing-secret-0123456789";
const ID = "0123456789abcdef0123456789abcdef";
const OTHER_ID = "fedcba9876543210fedcba9876543210";
const SIG_RE = /^[A-Za-z0-9_-]{43}$/;
const COOKIE_RE = /^[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/;
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** HMAC key the module must derive from ADMIN_SESSION_SECRET. */
function adminDerivedKey(secret: string): Buffer {
  return crypto.createHmac("sha256", secret).update("tayf-cerceve-v1").digest();
}

function sigWith(key: Buffer | string, id: string): string {
  return crypto.createHmac("sha256", key).update(id).digest("base64url");
}

function requestWithCookie(value: string | null, name = "tayf_cerceve_sid"): Request {
  const headers: Record<string, string> = {};
  if (value !== null) headers["Cookie"] = `${name}=${value}`;
  return new Request("http://example.com/", { headers });
}

const ORIGINAL_ENV = { ...process.env };

async function load() {
  vi.resetModules();
  return import("./framing-session");
}

beforeEach(() => {
  process.env.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  delete process.env.FRAMING_SESSION_SECRET;
});

afterEach(() => {
  for (const k of ["ADMIN_SESSION_SECRET", "FRAMING_SESSION_SECRET"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.restoreAllMocks();
});

describe("signSessionId", () => {
  it("returns `<id>.<43 base64url chars>` equal to HMAC-SHA256(HMAC(admin, 'tayf-cerceve-v1'), id)", async () => {
    const { signSessionId } = await load();
    const signed = await signSessionId(ID);
    expect(signed).toMatch(COOKIE_RE);
    expect(signed).toBe(`${ID}.${sigWith(adminDerivedKey(ADMIN_SECRET), ID)}`);
  });

  it("is deterministic per id and differs between ids", async () => {
    const { signSessionId } = await load();
    expect(await signSessionId(ID)).toBe(await signSessionId(ID));
    expect(await signSessionId(ID)).not.toBe(await signSessionId(OTHER_ID));
  });

  it("uses FRAMING_SESSION_SECRET's UTF-8 bytes directly when it is >= 16 chars", async () => {
    process.env.FRAMING_SESSION_SECRET = FRAMING_SECRET;
    const { signSessionId } = await load();
    expect(await signSessionId(ID)).toBe(`${ID}.${sigWith(FRAMING_SECRET, ID)}`);
  });

  it("ignores a FRAMING_SESSION_SECRET shorter than 16 chars and falls back to the admin-derived key", async () => {
    process.env.FRAMING_SESSION_SECRET = "short-secret"; // 12 chars
    const { signSessionId } = await load();
    expect(await signSessionId(ID)).toBe(`${ID}.${sigWith(adminDerivedKey(ADMIN_SECRET), ID)}`);
  });

  it("returns null (and warns once) when neither secret is usable", async () => {
    process.env.ADMIN_SESSION_SECRET = "too-short";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { signSessionId } = await load();
    expect(await signSessionId(ID)).toBeNull();
    expect(await signSessionId(OTHER_ID)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[oyun/cerceve] session signing unavailable");
  });

  it("returns null when both secrets are absent, never throwing", async () => {
    delete process.env.ADMIN_SESSION_SECRET;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { signSessionId } = await load();
    await expect(signSessionId(ID)).resolves.toBeNull();
  });
});

describe("readSignedSessionCookie", () => {
  it("returns the 32-hex id for a cookie signed by this server", async () => {
    const { signSessionId, readSignedSessionCookie } = await load();
    const cookie = (await signSessionId(ID)) as string;
    expect(await readSignedSessionCookie(requestWithCookie(cookie))).toBe(ID);
  });

  it("finds the cookie among others in the header", async () => {
    const { signSessionId, readSignedSessionCookie } = await load();
    const cookie = (await signSessionId(ID)) as string;
    const req = new Request("http://example.com/", {
      headers: { Cookie: `a=1; tayf_cerceve_sid=${cookie}; b=2` },
    });
    expect(await readSignedSessionCookie(req)).toBe(ID);
  });

  it("returns null for an absent header, an absent cookie and an empty value", async () => {
    const { readSignedSessionCookie } = await load();
    expect(await readSignedSessionCookie(requestWithCookie(null))).toBeNull();
    expect(
      await readSignedSessionCookie(requestWithCookie("1", "some_other_cookie")),
    ).toBeNull();
    expect(await readSignedSessionCookie(requestWithCookie(""))).toBeNull();
  });

  it("rejects an unsigned 32-hex value (the pre-signing cookie shape)", async () => {
    const { readSignedSessionCookie } = await load();
    expect(await readSignedSessionCookie(requestWithCookie(ID))).toBeNull();
  });

  it("rejects a malformed shape without verifying it", async () => {
    const { signSessionId, readSignedSessionCookie } = await load();
    const sig = ((await signSessionId(ID)) as string).split(".")[1] as string;
    for (const bad of [
      `${ID.toUpperCase()}.${sig}`, // uppercase id
      `${ID.slice(1)}.${sig}`, // 31-hex id
      `${ID}a.${sig}`, // 33-hex id
      `${"g".repeat(32)}.${sig}`, // non-hex id
      `${ID}.${sig.slice(1)}`, // 42-char signature
      `${ID}.${sig}A`, // 44-char signature
      `${ID}.${sig.slice(0, 42)}=`, // padding char
      `${ID}.${sig.slice(0, 42)}+`, // standard-alphabet char
      `${ID}.${sig}.${sig}`, // extra segment
      `${ID}${sig}`, // missing dot
      `.${sig}`,
      `${ID}.`,
    ]) {
      expect(await readSignedSessionCookie(requestWithCookie(bad)), bad).toBeNull();
    }
  });

  it("rejects a signature that belongs to a different id", async () => {
    const { signSessionId, readSignedSessionCookie } = await load();
    const otherSig = ((await signSessionId(OTHER_ID)) as string).split(".")[1];
    expect(await readSignedSessionCookie(requestWithCookie(`${ID}.${otherSig}`))).toBeNull();
  });

  it("rejects a flipped last signature char, including the base64 padding-bit aliases", async () => {
    const { signSessionId, readSignedSessionCookie } = await load();
    const signed = (await signSessionId(ID)) as string;
    const last = signed.slice(-1);
    const head = signed.slice(0, -1);
    // The last base64url char of a 32-byte value carries 4 data bits + 2
    // padding bits, so up to three alternatives decode to the SAME bytes in
    // a lenient decoder. Every one of the 63 other chars must still fail.
    for (const c of B64URL) {
      if (c === last) continue;
      expect(await readSignedSessionCookie(requestWithCookie(head + c)), c).toBeNull();
    }
  });

  it("rejects a flipped first signature char", async () => {
    const { signSessionId, readSignedSessionCookie } = await load();
    const signed = (await signSessionId(ID)) as string;
    const i = ID.length + 1;
    const flipped = signed.slice(0, i) + (signed[i] === "A" ? "B" : "A") + signed.slice(i + 1);
    expect(await readSignedSessionCookie(requestWithCookie(flipped))).toBeNull();
  });

  it("rejects a cookie signed under another ADMIN_SESSION_SECRET", async () => {
    const forged = `${ID}.${sigWith(adminDerivedKey(OTHER_SECRET), ID)}`;
    const { readSignedSessionCookie } = await load();
    expect(await readSignedSessionCookie(requestWithCookie(forged))).toBeNull();
  });

  it("rejects the raw ADMIN secret used directly as the key (the derivation is part of the contract)", async () => {
    const forged = `${ID}.${sigWith(ADMIN_SECRET, ID)}`;
    const { readSignedSessionCookie } = await load();
    expect(await readSignedSessionCookie(requestWithCookie(forged))).toBeNull();
  });

  it("with FRAMING_SESSION_SECRET set, rejects a cookie signed with the admin-derived key", async () => {
    process.env.FRAMING_SESSION_SECRET = FRAMING_SECRET;
    const adminSigned = `${ID}.${sigWith(adminDerivedKey(ADMIN_SECRET), ID)}`;
    const { readSignedSessionCookie } = await load();
    expect(await readSignedSessionCookie(requestWithCookie(adminSigned))).toBeNull();
  });

  it("with FRAMING_SESSION_SECRET set, accepts a cookie signed with it", async () => {
    process.env.FRAMING_SESSION_SECRET = FRAMING_SECRET;
    const { readSignedSessionCookie } = await load();
    const ok = `${ID}.${sigWith(FRAMING_SECRET, ID)}`;
    expect(await readSignedSessionCookie(requestWithCookie(ok))).toBe(ID);
  });

  it("returns null for everything, never throwing, and warns once without a usable secret", async () => {
    delete process.env.ADMIN_SESSION_SECRET;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { readSignedSessionCookie } = await load();
    const signedElsewhere = `${ID}.${sigWith(adminDerivedKey(ADMIN_SECRET), ID)}`;
    expect(await readSignedSessionCookie(requestWithCookie(signedElsewhere))).toBeNull();
    expect(await readSignedSessionCookie(requestWithCookie(ID))).toBeNull();
    expect(await readSignedSessionCookie(requestWithCookie(null))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[oyun/cerceve] session signing unavailable");
  });

  it("picks up a changed secret without a restart (the key is derived from the live env)", async () => {
    const { signSessionId, readSignedSessionCookie } = await load();
    const cookie = (await signSessionId(ID)) as string;
    expect(await readSignedSessionCookie(requestWithCookie(cookie))).toBe(ID);
    process.env.ADMIN_SESSION_SECRET = OTHER_SECRET;
    expect(await readSignedSessionCookie(requestWithCookie(cookie))).toBeNull();
  });
});

describe("mintSignedSession", () => {
  it("mints a fresh 32-hex id whose cookieValue verifies back to that id", async () => {
    const { mintSignedSession, readSignedSessionCookie } = await load();
    const a = await mintSignedSession();
    const b = await mintSignedSession();
    expect(a.id).toMatch(/^[0-9a-f]{32}$/);
    expect(a.cookieValue).toMatch(COOKIE_RE);
    expect(a.cookieValue.startsWith(`${a.id}.`)).toBe(true);
    expect(a.cookieValue.split(".")[1]).toMatch(SIG_RE);
    expect(a.id).not.toBe(b.id);
    expect(await readSignedSessionCookie(requestWithCookie(a.cookieValue))).toBe(a.id);
  });

  it("returns the plain id as the cookieValue when no key is available", async () => {
    delete process.env.ADMIN_SESSION_SECRET;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { mintSignedSession } = await load();
    const minted = await mintSignedSession();
    expect(minted.id).toMatch(/^[0-9a-f]{32}$/);
    expect(minted.cookieValue).toBe(minted.id);
  });
});

describe("module constraints", () => {
  const source = readFileSync(resolve(__dirname, "framing-session.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/gm, "$1");

  it("is WebCrypto only: no node: import and no `crypto` package import", () => {
    expect(code).not.toMatch(/from\s+["']node:/);
    expect(code).not.toMatch(/require\(\s*["']node:/);
    expect(code).not.toMatch(/from\s+["']crypto["']/);
    expect(code).toMatch(/crypto\.subtle/);
  });

  it("verifies through crypto.subtle.verify (constant-time), not a string compare", () => {
    expect(code).toMatch(/subtle\s*\.\s*verify\s*\(/);
  });

  it("logs exactly one constant warning and never an id, cookie or key", () => {
    const logCalls = code.match(/console\.\w+\s*\([^)]*\)/g) ?? [];
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]).toMatch(
      /^console\.warn\(\s*["']\[oyun\/cerceve\] session signing unavailable["']\s*\)$/,
    );
  });
});
