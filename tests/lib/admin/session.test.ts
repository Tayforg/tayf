import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// hunt-26 security-4: the admin session token used to carry only {expiresAt},
// so a copied cookie outlived a logout and an ADMIN_PASSWORD rotation for up to
// 7 days. The token is now {expiresAt, iat, pwd}: pwd binds it to the password
// it was minted under, iat/expiresAt cap its life at 24 h. The Edge middleware
// mirrors the check (tests/app/middleware-routing.test.ts).
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

const cookieJar = vi.hoisted(() => {
  const values = new Map<string, string>();
  const setCalls: Array<{
    name: string;
    value: string;
    options: Record<string, unknown>;
  }> = [];
  const deleted: string[] = [];
  return { values, setCalls, deleted };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.values.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string, options: Record<string, unknown>) => {
      cookieJar.values.set(name, value);
      cookieJar.setCalls.push({ name, value, options });
    },
    delete: (name: string) => {
      cookieJar.values.delete(name);
      cookieJar.deleted.push(name);
    },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

import {
  checkAdminPassword,
  createAdminSession,
  deleteAdminSession,
  derivePasswordTag,
  hasAdminSession,
  requireAdminSession,
} from "@/lib/admin/session";

const COOKIE = "admin_session";
const SECRET = "unit-test-session-secret-0123456789";
const PASSWORD_A = "correct horse battery staple";
const PASSWORD_B = "rotated-password-after-leak";
const NOW = new Date("2026-11-02T12:00:00.000Z").getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * The pwd tag as session.ts derives it: PBKDF2-HMAC-SHA256, never a fast hash of
 * the password (see the derivePasswordTag block below for the documented
 * parameters and the fixed vectors).
 */
function pwdTag(password: string, secret = SECRET): string {
  return derivePasswordTag(secret, password);
}

/** Same wire shape as session.ts: base64url(JSON payload) "." base64url(HMAC(body)). */
function signRaw(payload: unknown, secret = SECRET): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

interface TokenParts {
  expiresAt?: number;
  iat?: number;
  pwd?: unknown;
}

/** A correctly signed, currently valid token; override any field to forge a variant. */
function token(over: TokenParts = {}, password = PASSWORD_A): string {
  return signRaw({
    expiresAt: NOW + 1 * HOUR,
    iat: NOW,
    pwd: pwdTag(password),
    ...over,
  });
}

function present(value: string): void {
  cookieJar.values.set(COOKIE, value);
}

describe("admin session", () => {
  beforeEach(() => {
    cookieJar.values.clear();
    cookieJar.setCalls.length = 0;
    cookieJar.deleted.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("ADMIN_SESSION_SECRET", SECRET);
    vi.stubEnv("ADMIN_PASSWORD", PASSWORD_A);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("createAdminSession", () => {
    it("mints a cookie that hasAdminSession accepts", async () => {
      await createAdminSession();
      expect(cookieJar.setCalls).toHaveLength(1);
      expect(cookieJar.setCalls[0]!.name).toBe(COOKIE);
      expect(await hasAdminSession()).toBe(true);
    });

    it("sets a 24 h httpOnly lax cookie on path /, not secure outside production", async () => {
      vi.stubEnv("NODE_ENV", "test");
      await createAdminSession();
      const { options } = cookieJar.setCalls[0]!;
      expect(options.httpOnly).toBe(true);
      expect(options.sameSite).toBe("lax");
      expect(options.path).toBe("/");
      expect(options.maxAge).toBe(86_400);
      expect(options.expires).toEqual(new Date(NOW + 24 * HOUR));
      expect(options.secure).toBe(false);
    });

    it("sets the secure flag in production", async () => {
      vi.stubEnv("NODE_ENV", "production");
      await createAdminSession();
      expect(cookieJar.setCalls[0]!.options.secure).toBe(true);
    });

    it("signs {expiresAt, iat, pwd} with the documented password tag", async () => {
      await createAdminSession();
      const value = cookieJar.setCalls[0]!.value;
      const body = value.slice(0, value.indexOf("."));
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<
        string,
        unknown
      >;
      expect(Object.keys(payload).sort()).toEqual(["expiresAt", "iat", "pwd"]);
      expect(payload.iat).toBe(NOW);
      expect(payload.expiresAt).toBe(NOW + 24 * HOUR);
      expect(payload.pwd).toBe(pwdTag(PASSWORD_A));
      expect(payload.pwd).toMatch(/^[0-9a-f]{16}$/);
    });

    it("does not put the password or the secret into the cookie", async () => {
      await createAdminSession();
      const value = cookieJar.setCalls[0]!.value;
      const body = value.slice(0, value.indexOf("."));
      const decoded = Buffer.from(body, "base64url").toString("utf8");
      expect(decoded).not.toContain(PASSWORD_A);
      expect(decoded).not.toContain(SECRET);
    });
  });

  describe("password binding", () => {
    it("rejects a token minted under ADMIN_PASSWORD=A once the password is B, and accepts it again under A", async () => {
      await createAdminSession();
      expect(await hasAdminSession()).toBe(true);

      vi.stubEnv("ADMIN_PASSWORD", PASSWORD_B);
      expect(await hasAdminSession()).toBe(false);

      vi.stubEnv("ADMIN_PASSWORD", PASSWORD_A);
      expect(await hasAdminSession()).toBe(true);
    });

    it("rejects a token minted under another password even though its signature is valid", async () => {
      present(token({}, PASSWORD_B));
      expect(await hasAdminSession()).toBe(false);
    });

    it("rejects every token after ADMIN_SESSION_SECRET is rotated", async () => {
      await createAdminSession();
      vi.stubEnv("ADMIN_SESSION_SECRET", "a-completely-different-secret-value");
      expect(await hasAdminSession()).toBe(false);
    });

    it("returns false (and does not throw) when ADMIN_PASSWORD is unset or empty", async () => {
      await createAdminSession();
      vi.stubEnv("ADMIN_PASSWORD", undefined);
      await expect(hasAdminSession()).resolves.toBe(false);
      vi.stubEnv("ADMIN_PASSWORD", "");
      await expect(hasAdminSession()).resolves.toBe(false);
    });

    it("returns false (and does not throw) when ADMIN_SESSION_SECRET is unset or short", async () => {
      present(token());
      vi.stubEnv("ADMIN_SESSION_SECRET", "short");
      await expect(hasAdminSession()).resolves.toBe(false);
      vi.stubEnv("ADMIN_SESSION_SECRET", undefined);
      await expect(hasAdminSession()).resolves.toBe(false);
    });
  });

  describe("lifetime", () => {
    it("is valid at exactly 24 h and invalid one millisecond later", async () => {
      await createAdminSession();
      vi.setSystemTime(NOW + 24 * HOUR);
      expect(await hasAdminSession()).toBe(true);
      vi.setSystemTime(NOW + 24 * HOUR + 1);
      expect(await hasAdminSession()).toBe(false);
    });

    it("is invalid 24 h and one second after minting", async () => {
      await createAdminSession();
      vi.setSystemTime(NOW + 24 * HOUR + 1000);
      expect(await hasAdminSession()).toBe(false);
    });

    it("is still valid 23 h after minting", async () => {
      await createAdminSession();
      vi.setSystemTime(NOW + 23 * HOUR);
      expect(await hasAdminSession()).toBe(true);
    });

    it("rejects an expired token", async () => {
      present(token({ expiresAt: NOW - 1 }));
      expect(await hasAdminSession()).toBe(false);
    });

    it("rejects a correctly signed token whose iat is 25 h old even with a future expiresAt", async () => {
      present(token({ iat: NOW - 25 * HOUR, expiresAt: NOW + 1 * HOUR }));
      expect(await hasAdminSession()).toBe(false);
    });

    it("rejects a token whose lifetime (expiresAt - iat) exceeds 24 h, e.g. a legacy 7-day window", async () => {
      present(token({ iat: NOW, expiresAt: NOW + 7 * DAY }));
      expect(await hasAdminSession()).toBe(false);
      present(token({ iat: NOW, expiresAt: NOW + 24 * HOUR + 1 }));
      expect(await hasAdminSession()).toBe(false);
    });

    it("rejects a token whose iat is more than 60 s in the future, accepts one within the skew", async () => {
      present(token({ iat: NOW + 61_000, expiresAt: NOW + 1 * HOUR }));
      expect(await hasAdminSession()).toBe(false);
      present(token({ iat: NOW + 60_000, expiresAt: NOW + 1 * HOUR }));
      expect(await hasAdminSession()).toBe(true);
    });
  });

  describe("payload shape", () => {
    const badPwds: Array<[string, unknown]> = [
      ["wrong", "0123456789abcdef"],
      ["upper-case hex", pwdTag(PASSWORD_A).toUpperCase()],
      ["15 chars", pwdTag(PASSWORD_A).slice(0, 15)],
      ["17 chars", pwdTag(PASSWORD_A) + "0"],
      ["non-hex", "zzzzzzzzzzzzzzzz"],
      ["empty", ""],
      ["a number", 1234567890123456],
      ["null", null],
      ["an array", [pwdTag(PASSWORD_A)]],
      ["an object", { tag: pwdTag(PASSWORD_A) }],
    ];

    for (const [label, pwd] of badPwds) {
      it(`rejects a correctly signed token whose pwd is ${label}`, async () => {
        present(token({ pwd }));
        expect(await hasAdminSession()).toBe(false);
      });
    }

    it("rejects a correctly signed token with no pwd", async () => {
      present(signRaw({ expiresAt: NOW + HOUR, iat: NOW }));
      expect(await hasAdminSession()).toBe(false);
    });

    it("rejects a legacy {expiresAt}-only token", async () => {
      present(signRaw({ expiresAt: NOW + HOUR }));
      expect(await hasAdminSession()).toBe(false);
    });

    it("rejects a token with a missing or non-numeric iat or expiresAt", async () => {
      present(signRaw({ expiresAt: NOW + HOUR, pwd: pwdTag(PASSWORD_A) }));
      expect(await hasAdminSession()).toBe(false);
      present(token({ iat: "now" as unknown as number }));
      expect(await hasAdminSession()).toBe(false);
      present(token({ expiresAt: String(NOW + HOUR) as unknown as number }));
      expect(await hasAdminSession()).toBe(false);
      present(signRaw({ iat: NOW, pwd: pwdTag(PASSWORD_A) }));
      expect(await hasAdminSession()).toBe(false);
    });

    it("rejects payloads that are not objects", async () => {
      for (const payload of [null, 42, "text", [1, 2, 3], true]) {
        present(signRaw(payload));
        expect(await hasAdminSession(), JSON.stringify(payload)).toBe(false);
      }
    });
  });

  describe("signature and cookie handling", () => {
    it("rejects a tampered signature", async () => {
      const good = token();
      const dot = good.indexOf(".");
      const flipped = good[good.length - 1] === "A" ? "B" : "A";
      present(good.slice(0, -1) + flipped);
      expect(await hasAdminSession()).toBe(false);
      // Tampered body, original signature.
      const forgedBody = Buffer.from(
        JSON.stringify({ expiresAt: NOW + 5 * DAY, iat: NOW, pwd: pwdTag(PASSWORD_A) }),
      ).toString("base64url");
      present(`${forgedBody}.${good.slice(dot + 1)}`);
      expect(await hasAdminSession()).toBe(false);
    });

    it("rejects a token signed with a different secret", async () => {
      present(signRaw({ expiresAt: NOW + HOUR, iat: NOW, pwd: pwdTag(PASSWORD_A) }, "another-secret-value-123"));
      expect(await hasAdminSession()).toBe(false);
    });

    it("rejects a missing cookie and malformed cookie values", async () => {
      expect(await hasAdminSession()).toBe(false);
      for (const value of ["", "abc", ".abc", "abc.", "a.b.c", "....", "%%%.%%%"]) {
        present(value);
        expect(await hasAdminSession(), value).toBe(false);
      }
    });

    it("rejects a validly signed body that is not JSON", async () => {
      const body = Buffer.from("not json {").toString("base64url");
      const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
      present(`${body}.${sig}`);
      expect(await hasAdminSession()).toBe(false);
    });
  });

  describe("constant-time comparisons", () => {
    it("compares the signature and the pwd tag with timingSafeEqual, on equal-length buffers", async () => {
      const spy = vi.spyOn(crypto, "timingSafeEqual");
      present(token());
      expect(await hasAdminSession()).toBe(true);

      expect(spy).toHaveBeenCalledTimes(2);
      const [sigCall, pwdCall] = spy.mock.calls;
      for (const call of [sigCall!, pwdCall!]) {
        const [a, b] = call as [Buffer, Buffer];
        expect(a.length).toBe(b.length);
      }
      expect((pwdCall![0] as Buffer).length).toBe(16);
      expect((sigCall![0] as Buffer).length).toBe(43); // base64url SHA-256, no padding
    });

    it("still compares the pwd tag in constant time when it is well-formed but wrong", async () => {
      const spy = vi.spyOn(crypto, "timingSafeEqual");
      present(token({ pwd: "0123456789abcdef" }));
      expect(await hasAdminSession()).toBe(false);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it("checks lengths first: a signature of the wrong length never reaches timingSafeEqual", async () => {
      const spy = vi.spyOn(crypto, "timingSafeEqual");
      const good = token();
      present(good + "AAAA");
      await expect(hasAdminSession()).resolves.toBe(false);
      present(good.slice(0, -4));
      await expect(hasAdminSession()).resolves.toBe(false);
      expect(spy).not.toHaveBeenCalled();
    });

    it("never calls timingSafeEqual on a malformed pwd (shape is checked first)", async () => {
      const spy = vi.spyOn(crypto, "timingSafeEqual");
      present(token({ pwd: "abc" }));
      await expect(hasAdminSession()).resolves.toBe(false);
      // Only the signature compare ran.
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe("requireAdminSession / deleteAdminSession", () => {
    it("passes with a valid session", async () => {
      await createAdminSession();
      await expect(requireAdminSession()).resolves.toBeUndefined();
    });

    it("redirects to /admin/login without one, and after a password rotation", async () => {
      await expect(requireAdminSession()).rejects.toThrow("NEXT_REDIRECT:/admin/login");
      await createAdminSession();
      vi.stubEnv("ADMIN_PASSWORD", PASSWORD_B);
      await expect(requireAdminSession()).rejects.toThrow("NEXT_REDIRECT:/admin/login");
    });

    it("deleteAdminSession only deletes the browser cookie", async () => {
      await createAdminSession();
      const stolen = cookieJar.setCalls[0]!.value;
      await deleteAdminSession();
      expect(cookieJar.deleted).toEqual([COOKIE]);
      expect(await hasAdminSession()).toBe(false);
      // Documented limitation: logout does not revoke a copied cookie; only
      // rotating ADMIN_PASSWORD or ADMIN_SESSION_SECRET (or the 24 h expiry) does.
      present(stolen);
      expect(await hasAdminSession()).toBe(true);
    });
  });

  describe("checkAdminPassword", () => {
    it("still accepts the right password and rejects others", () => {
      expect(checkAdminPassword(PASSWORD_A)).toBe(true);
      expect(checkAdminPassword(PASSWORD_B)).toBe(false);
      expect(checkAdminPassword("")).toBe(false);
    });
  });

  describe("pwd tag domain separation", () => {
    // The tag is PBKDF2-HMAC-SHA256 keyed on the admin password, salted with
    // "tayf-admin-pwd-tag:" + ADMIN_SESSION_SECRET. The other derivations that use
    // the secret are HMACs keyed on the secret over fixed "tayf..." labels, and a
    // token body is base64url (no ':'), so the two can never yield the same value.
    // Pin the salt label to its two owners so nothing else reuses it.
    it("only session.ts and middleware.ts use the pwd-tag salt label", () => {
      const label = "tayf-admin-pwd-tag:";
      const owners = ["src/lib/admin/session.ts", "src/middleware.ts"];
      const others = [
        "src/lib/api/db-throttle.ts",
        "src/lib/admin/login-throttle.ts",
        "src/lib/game/framing-session.ts",
      ];
      for (const rel of owners) {
        const src = readFileSync(resolve(__dirname, "../../..", rel), "utf8");
        expect(src.includes(label), rel).toBe(true);
      }
      for (const rel of others) {
        const src = readFileSync(resolve(__dirname, "../../..", rel), "utf8");
        expect(src.includes(label), rel).toBe(false);
      }
    });
  });

  describe("derivePasswordTag", () => {
    // Documented derivation: PBKDF2-HMAC-SHA256, password = utf8(ADMIN_PASSWORD),
    // salt = utf8("tayf-admin-pwd-tag:" + ADMIN_SESSION_SECRET), 100_000
    // iterations, 8 bytes, lower hex (16 chars). Vectors computed independently
    // with crypto.pbkdf2Sync; src/middleware.ts must reproduce them with Web Crypto
    // (tests/app/middleware-routing.test.ts uses the same three inputs).
    const VECTORS: Array<[string, string, string]> = [
      ["unit-test-session-secret-0123456789", "correct horse battery staple", "89166a88751eff7c"],
      ["test-secret", "test-password", "00849fb04b81aa7f"],
      ["ünïcode-secret-0123456789-ğüşiçö", "pä55 wörd 🔑 ÇŞĞ", "bc114dba05f96308"],
    ];

    for (const [secret, password, expected] of VECTORS) {
      it(`matches the fixed vector for secret ${JSON.stringify(secret)}`, () => {
        expect(derivePasswordTag(secret, password)).toBe(expected);
        const independent = crypto
          .pbkdf2Sync(
            Buffer.from(password, "utf8"),
            Buffer.from("tayf-admin-pwd-tag:" + secret, "utf8"),
            100_000,
            8,
            "sha256",
          )
          .toString("hex");
        expect(derivePasswordTag(secret, password)).toBe(independent);
      });
    }

    it("returns 16 lower-case hex chars and changes with either input", () => {
      const base = derivePasswordTag(SECRET, PASSWORD_A);
      expect(base).toMatch(/^[0-9a-f]{16}$/);
      expect(derivePasswordTag(SECRET, PASSWORD_B)).not.toBe(base);
      expect(derivePasswordTag("another-secret-value-123", PASSWORD_A)).not.toBe(base);
      // Back to the first pair: same value again (deterministic).
      expect(derivePasswordTag(SECRET, PASSWORD_A)).toBe(base);
    });

    it("does not leak the password or the secret into the tag", () => {
      const tag = derivePasswordTag(SECRET, PASSWORD_A);
      expect(tag).not.toContain(PASSWORD_A);
      expect(tag).not.toContain(SECRET);
    });

    it("memoizes: a repeated (secret, password) pair does not run PBKDF2 again", () => {
      const spy = vi.spyOn(crypto, "pbkdf2Sync");
      const secret = "memo-test-secret-value-000111222";
      const password = "memo-test-password-xyz";

      const first = derivePasswordTag(secret, password);
      expect(spy).toHaveBeenCalledTimes(1);
      const second = derivePasswordTag(secret, password);
      const third = derivePasswordTag(secret, password);
      expect(second).toBe(first);
      expect(third).toBe(first);
      expect(spy).toHaveBeenCalledTimes(1);

      // A different pair is derived afresh (and is not served from the cache).
      const other = derivePasswordTag(secret, password + "!");
      expect(other).not.toBe(first);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it("memoizes across hasAdminSession calls: one derivation for many verifications", async () => {
      const secret = "memo-session-secret-value-333444";
      const password = "memo-session-password-abc";
      vi.stubEnv("ADMIN_SESSION_SECRET", secret);
      vi.stubEnv("ADMIN_PASSWORD", password);
      const spy = vi.spyOn(crypto, "pbkdf2Sync");

      await createAdminSession();
      expect(await hasAdminSession()).toBe(true);
      expect(await hasAdminSession()).toBe(true);
      expect(await hasAdminSession()).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});
