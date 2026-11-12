import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// hunt-26 security-4: the admin session token used to carry only {expiresAt},
// so a copied cookie outlived a logout and an ADMIN_PASSWORD rotation for up to
// 7 days. The token is now {expiresAt, iat} (24 h cap) and is bound to the
// password through the SIGNING KEY, not the payload: the HMAC key is
// PBKDF2-HMAC-SHA256(ADMIN_PASSWORD, salt = "tayf-admin-session-key:" + secret).
// Rotating either value changes the key, so every older token stops verifying.
// The Edge middleware mirrors the check (tests/app/middleware-routing.test.ts).
//
// No test here computes an HMAC over data derived from a password variable:
// tokens are minted with the session.ts helpers (mintSessionTokenForTest,
// deriveSessionSigningKey + signSessionBody), whose payloads carry only
// timestamps.
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
  // When set, cookies() rejects, like a call outside a request scope.
  const state = { fail: false };
  return { values, setCalls, deleted, state };
});

vi.mock("next/headers", () => ({
  cookies: async () => {
    if (cookieJar.state.fail) {
      throw new Error("cookies() called outside a request scope");
    }
    return {
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
    };
  },
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
  deriveDeviceSigningKey,
  deriveSessionSigningKey,
  hasAdminSession,
  issueAdminDeviceCookie,
  mintDeviceTokenForTest,
  mintSessionTokenForTest,
  readAdminDeviceId,
  requireAdminSession,
  signSessionBody,
} from "@/lib/admin/session";

const COOKIE = "admin_session";
const DEVICE_COOKIE = "admin_device";
const SECRET = "unit-test-session-secret-0123456789";
const OTHER_SECRET = "a-completely-different-secret-value";
const PASSWORD_A = "correct horse battery staple";
const PASSWORD_B = "rotated-password-after-leak";
const NOW = new Date("2026-11-02T12:00:00.000Z").getTime();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// A 16-hex tag as the previous token format carried it. Only ever used as an
// opaque literal inside legacy-format payloads; nothing derives it from a
// password here.
const LEGACY_PWD_TAG = "89166a88751eff7c";

interface TokenParts {
  expiresAt?: unknown;
  iat?: unknown;
  [extra: string]: unknown;
}

/**
 * A correctly signed, currently valid token minted under (secret, password);
 * override any payload field to forge a variant. Same wire shape as session.ts:
 * base64url(JSON payload) "." base64url(HMAC-SHA256(signing key, body)).
 */
function token(
  over: TokenParts = {},
  password = PASSWORD_A,
  secret = SECRET,
): string {
  return mintSessionTokenForTest(
    { expiresAt: NOW + 1 * HOUR, iat: NOW, ...over },
    secret,
    password,
  );
}

/** A token as the previous release minted it: HMAC keyed directly on the secret. */
function legacyToken(payload: unknown, secret = SECRET): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${signSessionBody(secret, body)}`;
}

function present(value: string): void {
  cookieJar.values.set(COOKIE, value);
}

const DEVICE_ID = "0123456789abcdef0123456789abcdef";
const DEVICE_LIFETIME = 30 * DAY;

/**
 * A correctly signed, currently valid device token minted under
 * (secret, password); override any payload field to forge a variant. Wire
 * shape: base64url(JSON {kind, id, iat, expiresAt}) "." base64url(HMAC-SHA256(
 * device key, body)), where the device key is domain-separated from the
 * session signing key.
 */
function deviceToken(
  over: TokenParts = {},
  password = PASSWORD_A,
  secret = SECRET,
): string {
  return mintDeviceTokenForTest(
    { kind: "device", id: DEVICE_ID, iat: NOW, expiresAt: NOW + DEVICE_LIFETIME, ...over },
    secret,
    password,
  );
}

function presentDevice(value: string): void {
  cookieJar.values.set(DEVICE_COOKIE, value);
}

describe("admin session", () => {
  beforeEach(() => {
    cookieJar.values.clear();
    cookieJar.setCalls.length = 0;
    cookieJar.deleted.length = 0;
    cookieJar.state.fail = false;
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

    it("signs a bare {expiresAt, iat} payload: nothing derived from the password is in the token body", async () => {
      await createAdminSession();
      const value = cookieJar.setCalls[0]!.value;
      const body = value.slice(0, value.indexOf("."));
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<
        string,
        unknown
      >;
      expect(Object.keys(payload).sort()).toEqual(["expiresAt", "iat"]);
      expect(payload.iat).toBe(NOW);
      expect(payload.expiresAt).toBe(NOW + 24 * HOUR);
    });

    it("signs the body with the PBKDF2-derived key, not with the bare secret", async () => {
      await createAdminSession();
      const value = cookieJar.setCalls[0]!.value;
      const dot = value.indexOf(".");
      const body = value.slice(0, dot);
      const sig = value.slice(dot + 1);
      expect(sig).toBe(signSessionBody(deriveSessionSigningKey(SECRET, PASSWORD_A), body));
      expect(sig).not.toBe(signSessionBody(SECRET, body));
    });

    it("does not put the password or the secret into the cookie", async () => {
      await createAdminSession();
      const value = cookieJar.setCalls[0]!.value;
      const body = value.slice(0, value.indexOf("."));
      const decoded = Buffer.from(body, "base64url").toString("utf8");
      expect(decoded).not.toContain(PASSWORD_A);
      expect(decoded).not.toContain(SECRET);
      expect(value).not.toContain(PASSWORD_A);
      expect(value).not.toContain(SECRET);
    });
  });

  describe("key binding", () => {
    it("rejects a token minted under ADMIN_PASSWORD=A once the password is B, and accepts it again under A", async () => {
      await createAdminSession();
      expect(await hasAdminSession()).toBe(true);

      vi.stubEnv("ADMIN_PASSWORD", PASSWORD_B);
      expect(await hasAdminSession()).toBe(false);

      vi.stubEnv("ADMIN_PASSWORD", PASSWORD_A);
      expect(await hasAdminSession()).toBe(true);
    });

    it("rejects a token minted under the old password after rotation, accepts one minted under the new password", async () => {
      const oldToken = token({}, PASSWORD_A);
      const newToken = token({}, PASSWORD_B);
      vi.stubEnv("ADMIN_PASSWORD", PASSWORD_B);
      present(oldToken);
      expect(await hasAdminSession()).toBe(false);
      present(newToken);
      expect(await hasAdminSession()).toBe(true);
    });

    it("rejects a token minted under the old secret after ADMIN_SESSION_SECRET is rotated", async () => {
      const oldToken = token({}, PASSWORD_A, SECRET);
      vi.stubEnv("ADMIN_SESSION_SECRET", OTHER_SECRET);
      present(oldToken);
      expect(await hasAdminSession()).toBe(false);
      present(token({}, PASSWORD_A, OTHER_SECRET));
      expect(await hasAdminSession()).toBe(true);
    });

    it("rejects every freshly created session after ADMIN_SESSION_SECRET is rotated", async () => {
      await createAdminSession();
      vi.stubEnv("ADMIN_SESSION_SECRET", OTHER_SECRET);
      expect(await hasAdminSession()).toBe(false);
    });

    it("rejects a legacy token (payload with a pwd field, HMAC keyed on the bare secret)", async () => {
      present(legacyToken({ expiresAt: NOW + HOUR, iat: NOW, pwd: LEGACY_PWD_TAG }));
      expect(await hasAdminSession()).toBe(false);
    });

    it("rejects a legacy {expiresAt}-only token signed under the old scheme", async () => {
      present(legacyToken({ expiresAt: NOW + HOUR }));
      expect(await hasAdminSession()).toBe(false);
    });

    it("ignores unknown payload fields: only the key and the timestamps decide", async () => {
      // A pwd field is not read. With the right signing key it is harmless ...
      present(token({ pwd: LEGACY_PWD_TAG }));
      expect(await hasAdminSession()).toBe(true);
      present(token({ pwd: "anything at all", extra: { nested: true } }));
      expect(await hasAdminSession()).toBe(true);
      // ... and it cannot make a wrongly keyed token pass.
      present(token({ pwd: LEGACY_PWD_TAG }, PASSWORD_B));
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
    it("rejects a correctly signed token with no iat (a legacy {expiresAt}-only payload)", async () => {
      present(mintSessionTokenForTest({ expiresAt: NOW + HOUR }, SECRET, PASSWORD_A));
      expect(await hasAdminSession()).toBe(false);
    });

    it("rejects a token with a missing or non-numeric iat or expiresAt", async () => {
      present(token({ iat: undefined }));
      expect(await hasAdminSession()).toBe(false);
      present(token({ iat: "now" }));
      expect(await hasAdminSession()).toBe(false);
      present(token({ expiresAt: String(NOW + HOUR) }));
      expect(await hasAdminSession()).toBe(false);
      present(token({ expiresAt: undefined }));
      expect(await hasAdminSession()).toBe(false);
      present(token({ expiresAt: null }));
      expect(await hasAdminSession()).toBe(false);
    });

    it("rejects payloads that are not objects", async () => {
      for (const payload of [null, 42, "text", [1, 2, 3], true]) {
        present(mintSessionTokenForTest(payload, SECRET, PASSWORD_A));
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
      // A change in the first signature character (a real bit change).
      const first = good[dot + 1] === "A" ? "B" : "A";
      present(good.slice(0, dot + 1) + first + good.slice(dot + 2));
      expect(await hasAdminSession()).toBe(false);
      // Tampered body, original signature.
      const forgedBody = Buffer.from(
        JSON.stringify({ expiresAt: NOW + 5 * DAY, iat: NOW }),
      ).toString("base64url");
      present(`${forgedBody}.${good.slice(dot + 1)}`);
      expect(await hasAdminSession()).toBe(false);
    });

    it("rejects a token signed with a different secret", async () => {
      present(token({}, PASSWORD_A, "another-secret-value-123"));
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
      const sig = signSessionBody(deriveSessionSigningKey(SECRET, PASSWORD_A), body);
      present(`${body}.${sig}`);
      expect(await hasAdminSession()).toBe(false);
    });
  });

  describe("constant-time comparison and cheap checks first", () => {
    it("compares the signature with timingSafeEqual, once, on equal-length buffers", async () => {
      present(token());
      const spy = vi.spyOn(crypto, "timingSafeEqual");
      expect(await hasAdminSession()).toBe(true);

      expect(spy).toHaveBeenCalledTimes(1);
      const [a, b] = spy.mock.calls[0] as [Buffer, Buffer];
      expect(a.length).toBe(b.length);
      expect(a.length).toBe(43); // base64url SHA-256, no padding
    });

    it("still compares in constant time when the signature is well-formed but wrong", async () => {
      const spy = vi.spyOn(crypto, "timingSafeEqual");
      present(token({}, PASSWORD_B));
      expect(await hasAdminSession()).toBe(false);
      expect(spy).toHaveBeenCalledTimes(1);
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

    it("runs no PBKDF2 for structurally broken cookies or a wrong-length signature (fresh secret/password pair)", async () => {
      const secret = "structural-secret-value-0011223344";
      const password = "structural-password-xyz";
      vi.stubEnv("ADMIN_SESSION_SECRET", secret);
      vi.stubEnv("ADMIN_PASSWORD", password);
      const spy = vi.spyOn(crypto, "pbkdf2Sync");
      const good = token({}, password, secret);
      // Minting derived the key once; later checks must not derive anything new,
      // and for the broken values they must not even ask for it.
      const baseline = spy.mock.calls.length;
      const broken = ["", "abc", ".abc", "abc.", "....", good + "AAAA", good.slice(0, -4)];
      for (const value of broken) {
        present(value);
        expect(await hasAdminSession(), value).toBe(false);
      }
      expect(spy.mock.calls.length).toBe(baseline);
    });

    it("derives nothing for an unset ADMIN_PASSWORD (no session can be valid)", async () => {
      const good = token();
      vi.stubEnv("ADMIN_PASSWORD", undefined);
      const spy = vi.spyOn(crypto, "pbkdf2Sync");
      present(good);
      await expect(hasAdminSession()).resolves.toBe(false);
      expect(spy).not.toHaveBeenCalled();
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

  // -------------------------------------------------------------------------
  // Device cookie (migration 207). A browser that logged in with the current
  // password carries a signed `admin_device` cookie. It lets that browser be
  // throttled per device instead of through the shared per-IP + global bucket.
  // It is NOT a login: hasAdminSession() never accepts it, and it is bound to
  // the password and the secret through a key that is domain-separated from the
  // session signing key.
  // -------------------------------------------------------------------------
  describe("device cookie", () => {
    describe("issueAdminDeviceCookie", () => {
      it("sets one 30-day httpOnly strict cookie named admin_device on path /admin", async () => {
        vi.stubEnv("NODE_ENV", "test");
        await issueAdminDeviceCookie();
        expect(cookieJar.setCalls).toHaveLength(1);
        const { name, options } = cookieJar.setCalls[0]!;
        expect(name).toBe(DEVICE_COOKIE);
        expect(options.httpOnly).toBe(true);
        expect(options.sameSite).toBe("strict");
        expect(options.path).toBe("/admin");
        expect(options.maxAge).toBe(30 * 86_400);
        expect(options.expires).toEqual(new Date(NOW + DEVICE_LIFETIME));
        expect(options.secure).toBe(false);
      });

      it("sets the secure flag in production", async () => {
        vi.stubEnv("NODE_ENV", "production");
        await issueAdminDeviceCookie();
        expect(cookieJar.setCalls[0]!.options.secure).toBe(true);
      });

      it("round-trips: the id readAdminDeviceId returns is the 32-hex id inside the token", async () => {
        await issueAdminDeviceCookie();
        const value = cookieJar.setCalls[0]!.value;
        const body = value.slice(0, value.indexOf("."));
        const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<
          string,
          unknown
        >;
        expect(Object.keys(payload).sort()).toEqual(["expiresAt", "iat", "id", "kind"]);
        expect(payload.kind).toBe("device");
        expect(payload.iat).toBe(NOW);
        expect(payload.expiresAt).toBe(NOW + DEVICE_LIFETIME);

        const id = await readAdminDeviceId();
        expect(id).not.toBeNull();
        expect(id).toMatch(/^[0-9a-f]{32}$/);
        expect(id).toBe(payload.id);
      });

      it("mints a fresh random id on every issue", async () => {
        await issueAdminDeviceCookie();
        const first = await readAdminDeviceId();
        await issueAdminDeviceCookie();
        const second = await readAdminDeviceId();
        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        expect(second).not.toBe(first);
      });

      it("does not put the password or the secret into the cookie", async () => {
        await issueAdminDeviceCookie();
        const value = cookieJar.setCalls[0]!.value;
        const body = value.slice(0, value.indexOf("."));
        const decoded = Buffer.from(body, "base64url").toString("utf8");
        for (const text of [decoded, value]) {
          expect(text).not.toContain(PASSWORD_A);
          expect(text).not.toContain(SECRET);
        }
      });

      it("signs with the device key, not with the session signing key", async () => {
        await issueAdminDeviceCookie();
        const value = cookieJar.setCalls[0]!.value;
        const dot = value.indexOf(".");
        const body = value.slice(0, dot);
        const sig = value.slice(dot + 1);
        expect(sig).toBe(signSessionBody(deriveDeviceSigningKey(SECRET, PASSWORD_A), body));
        expect(sig).not.toBe(signSessionBody(deriveSessionSigningKey(SECRET, PASSWORD_A), body));
      });

      it("is best effort: without ADMIN_PASSWORD it sets nothing and does not throw (the session is already set)", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.stubEnv("ADMIN_PASSWORD", undefined);
        await expect(issueAdminDeviceCookie()).resolves.toBeUndefined();
        expect(cookieJar.setCalls).toHaveLength(0);
      });

      it("createAdminSession sets no device cookie, and deleteAdminSession (logout) leaves the device cookie alone", async () => {
        await createAdminSession();
        expect(cookieJar.setCalls.map((c) => c.name)).toEqual([COOKIE]);
        await issueAdminDeviceCookie();
        const id = await readAdminDeviceId();
        await deleteAdminSession();
        expect(cookieJar.deleted).toEqual([COOKIE]);
        expect(await readAdminDeviceId()).toBe(id);
      });
    });

    describe("readAdminDeviceId", () => {
      it("returns the id of a valid token", async () => {
        presentDevice(deviceToken());
        expect(await readAdminDeviceId()).toBe(DEVICE_ID);
      });

      it("returns null without a cookie and for malformed cookie values", async () => {
        expect(await readAdminDeviceId()).toBeNull();
        for (const value of ["", "abc", ".abc", "abc.", "a.b.c", "....", "%%%.%%%"]) {
          presentDevice(value);
          expect(await readAdminDeviceId(), value).toBeNull();
        }
      });

      it("returns null for a tampered signature or body", async () => {
        const good = deviceToken();
        const dot = good.indexOf(".");
        const flippedLast = good[good.length - 1] === "A" ? "B" : "A";
        presentDevice(good.slice(0, -1) + flippedLast);
        expect(await readAdminDeviceId()).toBeNull();
        const flippedFirst = good[dot + 1] === "A" ? "B" : "A";
        presentDevice(good.slice(0, dot + 1) + flippedFirst + good.slice(dot + 2));
        expect(await readAdminDeviceId()).toBeNull();
        // Tampered body (another id), original signature.
        const forgedBody = Buffer.from(
          JSON.stringify({
            kind: "device",
            id: "ffffffffffffffffffffffffffffffff",
            iat: NOW,
            expiresAt: NOW + DEVICE_LIFETIME,
          }),
        ).toString("base64url");
        presentDevice(`${forgedBody}.${good.slice(dot + 1)}`);
        expect(await readAdminDeviceId()).toBeNull();
      });

      it("returns null for an expired token, valid up to the last millisecond", async () => {
        presentDevice(deviceToken({ expiresAt: NOW - 1 }));
        expect(await readAdminDeviceId()).toBeNull();

        presentDevice(deviceToken());
        vi.setSystemTime(NOW + DEVICE_LIFETIME - 1);
        expect(await readAdminDeviceId()).toBe(DEVICE_ID);
        vi.setSystemTime(NOW + DEVICE_LIFETIME);
        expect(await readAdminDeviceId()).toBeNull();
      });

      it("returns null for a token whose lifetime (expiresAt - iat) is over 30 days", async () => {
        presentDevice(deviceToken({ iat: NOW, expiresAt: NOW + DEVICE_LIFETIME + 1 }));
        expect(await readAdminDeviceId()).toBeNull();
        presentDevice(deviceToken({ iat: NOW, expiresAt: NOW + 365 * DAY }));
        expect(await readAdminDeviceId()).toBeNull();
        // Exactly 30 days is the longest accepted lifetime.
        presentDevice(deviceToken({ iat: NOW, expiresAt: NOW + DEVICE_LIFETIME }));
        expect(await readAdminDeviceId()).toBe(DEVICE_ID);
      });

      it("returns null for an iat more than 60 s in the future, accepts one within the skew", async () => {
        presentDevice(deviceToken({ iat: NOW + 61_000, expiresAt: NOW + 61_000 + DAY }));
        expect(await readAdminDeviceId()).toBeNull();
        presentDevice(deviceToken({ iat: NOW + 60_000, expiresAt: NOW + 60_000 + DAY }));
        expect(await readAdminDeviceId()).toBe(DEVICE_ID);
      });

      it("returns null for a token minted under the old ADMIN_PASSWORD, and accepts it again under the old one", async () => {
        presentDevice(deviceToken({}, PASSWORD_A));
        expect(await readAdminDeviceId()).toBe(DEVICE_ID);

        vi.stubEnv("ADMIN_PASSWORD", PASSWORD_B);
        expect(await readAdminDeviceId()).toBeNull();
        presentDevice(deviceToken({}, PASSWORD_B));
        expect(await readAdminDeviceId()).toBe(DEVICE_ID);

        vi.stubEnv("ADMIN_PASSWORD", PASSWORD_A);
        presentDevice(deviceToken({}, PASSWORD_B));
        expect(await readAdminDeviceId()).toBeNull();
      });

      it("returns null for a token minted under another ADMIN_SESSION_SECRET", async () => {
        presentDevice(deviceToken({}, PASSWORD_A, OTHER_SECRET));
        expect(await readAdminDeviceId()).toBeNull();
        vi.stubEnv("ADMIN_SESSION_SECRET", OTHER_SECRET);
        expect(await readAdminDeviceId()).toBe(DEVICE_ID);
        vi.stubEnv("ADMIN_SESSION_SECRET", SECRET);
        expect(await readAdminDeviceId()).toBeNull();
      });

      it("returns null for a valid admin_session token presented as admin_device", async () => {
        presentDevice(token());
        expect(await readAdminDeviceId()).toBeNull();
        // Even if the payload is made to look like a device payload, the
        // session signing key is not the device key.
        presentDevice(token({ kind: "device", id: DEVICE_ID, expiresAt: NOW + DEVICE_LIFETIME }));
        expect(await readAdminDeviceId()).toBeNull();
        await createAdminSession();
        presentDevice(cookieJar.setCalls[0]!.value);
        expect(await readAdminDeviceId()).toBeNull();
      });

      it("returns null for a payload that is not kind 'device', even when correctly signed", async () => {
        for (const kind of [undefined, "session", "Device", "device ", 1, null, ["device"]]) {
          presentDevice(deviceToken({ kind }));
          expect(await readAdminDeviceId(), JSON.stringify(kind) ?? "undefined").toBeNull();
        }
      });

      it("returns null unless the id is exactly 32 lowercase hex characters", async () => {
        const bad: unknown[] = [
          undefined,
          null,
          42,
          ["0123456789abcdef0123456789abcdef"],
          "",
          "0123456789abcdef0123456789abcde",
          "0123456789abcdef0123456789abcdef0",
          "0123456789ABCDEF0123456789ABCDEF",
          "0123456789abcdeg0123456789abcdef",
          "0123456789abcdef0123456789abcdef\n",
          " 0123456789abcdef0123456789abcdef",
        ];
        for (const id of bad) {
          presentDevice(deviceToken({ id }));
          expect(await readAdminDeviceId(), JSON.stringify(id) ?? "undefined").toBeNull();
        }
      });

      it("returns null for a missing or non-numeric iat or expiresAt, and for non-object payloads", async () => {
        for (const over of [
          { iat: undefined },
          { iat: "now" },
          { iat: null },
          { expiresAt: undefined },
          { expiresAt: String(NOW + DAY) },
          { expiresAt: null },
        ]) {
          presentDevice(deviceToken(over));
          expect(await readAdminDeviceId(), JSON.stringify(over)).toBeNull();
        }
        for (const payload of [null, 42, "text", [1, 2, 3], true]) {
          presentDevice(mintDeviceTokenForTest(payload, SECRET, PASSWORD_A));
          expect(await readAdminDeviceId(), JSON.stringify(payload)).toBeNull();
        }
      });

      it("returns null for a validly signed body that is not JSON", async () => {
        const body = Buffer.from("not json {").toString("base64url");
        const sig = signSessionBody(deriveDeviceSigningKey(SECRET, PASSWORD_A), body);
        presentDevice(`${body}.${sig}`);
        expect(await readAdminDeviceId()).toBeNull();
      });

      it("returns null (and does not throw) without ADMIN_PASSWORD or with a short or missing secret", async () => {
        presentDevice(deviceToken());
        vi.stubEnv("ADMIN_PASSWORD", undefined);
        await expect(readAdminDeviceId()).resolves.toBeNull();
        vi.stubEnv("ADMIN_PASSWORD", "");
        await expect(readAdminDeviceId()).resolves.toBeNull();
        vi.stubEnv("ADMIN_PASSWORD", PASSWORD_A);
        vi.stubEnv("ADMIN_SESSION_SECRET", "short");
        await expect(readAdminDeviceId()).resolves.toBeNull();
        vi.stubEnv("ADMIN_SESSION_SECRET", undefined);
        await expect(readAdminDeviceId()).resolves.toBeNull();
      });

      it("returns null when the cookie store itself fails", async () => {
        presentDevice(deviceToken());
        cookieJar.state.fail = true;
        await expect(readAdminDeviceId()).resolves.toBeNull();
      });

      it("compares the signature with timingSafeEqual, once, on equal-length buffers", async () => {
        presentDevice(deviceToken());
        const spy = vi.spyOn(crypto, "timingSafeEqual");
        expect(await readAdminDeviceId()).toBe(DEVICE_ID);
        expect(spy).toHaveBeenCalledTimes(1);
        const [a, b] = spy.mock.calls[0] as [Buffer, Buffer];
        expect(a.length).toBe(b.length);
        expect(a.length).toBe(43);
      });

      it("still compares in constant time for a well-formed but wrong signature", async () => {
        const spy = vi.spyOn(crypto, "timingSafeEqual");
        presentDevice(deviceToken({}, PASSWORD_B));
        expect(await readAdminDeviceId()).toBeNull();
        expect(spy).toHaveBeenCalledTimes(1);
      });

      it("a signature of the wrong length never reaches timingSafeEqual, and runs no PBKDF2", async () => {
        const secret = "device-structural-secret-0011223344";
        const password = "device-structural-password-xyz";
        vi.stubEnv("ADMIN_SESSION_SECRET", secret);
        vi.stubEnv("ADMIN_PASSWORD", password);
        const good = deviceToken({}, password, secret);
        const compare = vi.spyOn(crypto, "timingSafeEqual");
        const derive = vi.spyOn(crypto, "pbkdf2Sync");
        const baseline = derive.mock.calls.length;
        for (const value of ["", "abc", ".abc", "abc.", "....", good + "AAAA", good.slice(0, -4)]) {
          presentDevice(value);
          expect(await readAdminDeviceId(), value).toBeNull();
        }
        expect(compare).not.toHaveBeenCalled();
        expect(derive.mock.calls.length).toBe(baseline);
      });
    });

    describe("domain separation from the session cookie", () => {
      it("hasAdminSession is false for a valid device token presented as admin_session", async () => {
        present(deviceToken());
        expect(await hasAdminSession()).toBe(false);
        await issueAdminDeviceCookie();
        present(cookieJar.setCalls[0]!.value);
        expect(await hasAdminSession()).toBe(false);
      });

      it("a device token in the admin_device slot does not make a session", async () => {
        presentDevice(deviceToken());
        expect(await hasAdminSession()).toBe(false);
        await expect(requireAdminSession()).rejects.toThrow("NEXT_REDIRECT:/admin/login");
      });

      it("the device signing key is 32 bytes, differs from the session key, and changes with either input", () => {
        const sessionKey = deriveSessionSigningKey(SECRET, PASSWORD_A);
        const deviceKey = deriveDeviceSigningKey(SECRET, PASSWORD_A);
        expect(deviceKey.length).toBe(32);
        expect(deviceKey.equals(sessionKey)).toBe(false);
        expect(deriveDeviceSigningKey(SECRET, PASSWORD_B).equals(deviceKey)).toBe(false);
        expect(deriveDeviceSigningKey(OTHER_SECRET, PASSWORD_A).equals(deviceKey)).toBe(false);
        expect(deriveDeviceSigningKey(SECRET, PASSWORD_A).equals(deviceKey)).toBe(true);
      });

      // deviceKey = HMAC-SHA256(sessionSigningKey, "tayf/admin-device/v1"). The
      // vectors were computed in a scratch script with crypto.pbkdf2Sync and
      // crypto.createHmac, independently of session.ts.
      const FIXED_DEVICE_BODY =
        "eyJraW5kIjoiZGV2aWNlIiwiaWQiOiIwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZiIsImlhdCI6MTc5MzYyMDgwMDAwMCwiZXhwaXJlc0F0IjoxNzk2MjEyODAwMDAwfQ";
      const DEVICE_VECTORS: Array<[string, string, string, string]> = [
        [
          "unit-test-session-secret-0123456789",
          "correct horse battery staple",
          "9db720ce854fc194dfa01438ee3f1dc69849c00a11945d1f055a1f0109f7b06b",
          "HyTDncWESfoi-yfb-uW99Rsmh-LIr1ihqHv0zHpvjWs",
        ],
        [
          "test-secret",
          "test-password",
          "0667005dab768e065dcc55fcabe4a22dc96caba504d1911a856bc9d4b0bd3ccc",
          "DD2Bk94j7oH4vZo_tjoyalC0KwgkXfeuStSir6my950",
        ],
      ];

      it("decodes to the fixed device body the vectors sign", () => {
        expect(JSON.parse(Buffer.from(FIXED_DEVICE_BODY, "base64url").toString("utf8"))).toEqual({
          kind: "device",
          id: DEVICE_ID,
          iat: NOW,
          expiresAt: NOW + DEVICE_LIFETIME,
        });
      });

      for (const [secret, password, keyHex, signature] of DEVICE_VECTORS) {
        it(`matches the fixed device key and signature vectors for secret ${JSON.stringify(secret)}`, () => {
          const key = deriveDeviceSigningKey(secret, password);
          expect(key.toString("hex")).toBe(keyHex);
          expect(signSessionBody(key, FIXED_DEVICE_BODY)).toBe(signature);
        });
      }

      it("only session.ts holds the device domain label", () => {
        const label = "tayf/admin-device/v1";
        const owner = readFileSync(resolve(__dirname, "../../..", "src/lib/admin/session.ts"), "utf8");
        expect(owner.includes(label)).toBe(true);
        for (const rel of [
          "src/middleware.ts",
          "src/lib/admin/login-throttle.ts",
          "src/lib/api/db-throttle.ts",
          "src/lib/game/framing-session.ts",
        ]) {
          const src = readFileSync(resolve(__dirname, "../../..", rel), "utf8");
          expect(src.includes(label), rel).toBe(false);
        }
      });
    });
  });

  describe("signing-key domain separation", () => {
    // The key is PBKDF2-HMAC-SHA256 keyed on the admin password, salted with
    // "tayf-admin-session-key:" + ADMIN_SESSION_SECRET. The other derivations
    // that use the secret are HMACs keyed on the secret over fixed "tayf..."
    // labels, and a token body is base64url (no ':'), so none can collide.
    // Pin the salt label to its two owners so nothing else reuses it.
    it("only session.ts and middleware.ts use the session-key salt label", () => {
      const label = "tayf-admin-session-key:";
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

    it("the previous password-tag derivation is gone from both implementations", () => {
      for (const rel of ["src/lib/admin/session.ts", "src/middleware.ts"]) {
        const src = readFileSync(resolve(__dirname, "../../..", rel), "utf8");
        expect(src.includes("tayf-admin-pwd-tag:"), rel).toBe(false);
        expect(src.includes("derivePasswordTag"), rel).toBe(false);
      }
    });
  });

  describe("deriveSessionSigningKey / signSessionBody", () => {
    // Documented derivation: PBKDF2-HMAC-SHA256, password = utf8(ADMIN_PASSWORD),
    // salt = utf8("tayf-admin-session-key:" + ADMIN_SESSION_SECRET), 100_000
    // iterations, 32 bytes. The signature is base64url(HMAC-SHA256(key, body))
    // over the fixed body below. Vectors computed independently with
    // crypto.pbkdf2Sync + createHmac in a scratch script; src/middleware.ts must
    // reproduce them with Web Crypto (tests/app/middleware-routing.test.ts uses
    // the same three inputs and the same literals).
    const FIXED_BODY =
      "eyJleHBpcmVzQXQiOjE3OTM2MjQ0MDAwMDAsImlhdCI6MTc5MzYyMDgwMDAwMH0";
    const VECTORS: Array<[string, string, string, string]> = [
      [
        "unit-test-session-secret-0123456789",
        "correct horse battery staple",
        "f793266c2ea2aa7b341bfe6b36e59aa9bcac71343b8ff5e9316127bcfa15ede3",
        "gc052KVHWUNCzdSt9jBLApzZeIaOiToPGMzBxKTzS2g",
      ],
      [
        "test-secret",
        "test-password",
        "20aded096c820783f3070e4b50fd3d511c189d7df60dcdb3b38c3287550ce005",
        "EVFudx1Y_xIYGQOQkQHXM2YBgXf7az6_1uam-ACX_0s",
      ],
      [
        "ünïcode-secret-0123456789-ğüşiçö",
        "pä55 wörd 🔑 ÇŞĞ",
        "0b8e4e62b5b64bea7ba0fbd022595381cd521ae174cd6160b1fabfb6709920cd",
        "1GJbjGuzS4Hzs2K98sTXb9fCxwnzAMzGapt0IdiN7B8",
      ],
    ];

    it("decodes to the fixed body the vectors sign", () => {
      expect(JSON.parse(Buffer.from(FIXED_BODY, "base64url").toString("utf8"))).toEqual({
        expiresAt: NOW + HOUR,
        iat: NOW,
      });
    });

    for (const [secret, password, keyHex, signature] of VECTORS) {
      it(`matches the fixed key and signature vectors for secret ${JSON.stringify(secret)}`, () => {
        const key = deriveSessionSigningKey(secret, password);
        expect(key.toString("hex")).toBe(keyHex);
        const independent = crypto
          .pbkdf2Sync(
            Buffer.from(password, "utf8"),
            Buffer.from("tayf-admin-session-key:" + secret, "utf8"),
            100_000,
            32,
            "sha256",
          )
          .toString("hex");
        expect(key.toString("hex")).toBe(independent);
        expect(signSessionBody(key, FIXED_BODY)).toBe(signature);
      });
    }

    it("returns 32 bytes and changes with either input", () => {
      const base = deriveSessionSigningKey(SECRET, PASSWORD_A);
      expect(base.length).toBe(32);
      expect(deriveSessionSigningKey(SECRET, PASSWORD_B).equals(base)).toBe(false);
      expect(deriveSessionSigningKey("another-secret-value-123", PASSWORD_A).equals(base)).toBe(
        false,
      );
      // Back to the first pair: same value again (deterministic).
      expect(deriveSessionSigningKey(SECRET, PASSWORD_A).equals(base)).toBe(true);
    });

    it("does not leak the password or the secret into the key", () => {
      const hex = deriveSessionSigningKey(SECRET, PASSWORD_A).toString("hex");
      expect(hex).not.toContain(Buffer.from(PASSWORD_A).toString("hex"));
      expect(hex).not.toContain(Buffer.from(SECRET).toString("hex"));
    });

    it("signSessionBody yields 43 base64url chars and depends on the key and the body", () => {
      const key = deriveSessionSigningKey(SECRET, PASSWORD_A);
      const sig = signSessionBody(key, "abc");
      expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(signSessionBody(key, "abd")).not.toBe(sig);
      expect(signSessionBody(deriveSessionSigningKey(SECRET, PASSWORD_B), "abc")).not.toBe(sig);
    });

    it("memoizes: a repeated (secret, password) pair does not run PBKDF2 again", () => {
      const spy = vi.spyOn(crypto, "pbkdf2Sync");
      const secret = "memo-test-secret-value-000111222";
      const password = "memo-test-password-xyz";

      const first = deriveSessionSigningKey(secret, password);
      expect(spy).toHaveBeenCalledTimes(1);
      const second = deriveSessionSigningKey(secret, password);
      const third = deriveSessionSigningKey(secret, password);
      expect(second).toBe(first);
      expect(third).toBe(first);
      expect(spy).toHaveBeenCalledTimes(1);

      // A different password is derived afresh (and is not served from the cache).
      const other = deriveSessionSigningKey(secret, password + "!");
      expect(other.equals(first)).toBe(false);
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it("misses the cache when only the secret changes: (S1,P) -> (S2,P) derives again", () => {
      const spy = vi.spyOn(crypto, "pbkdf2Sync");
      const s1 = "memo-secret-one-value-aaaabbbbcccc";
      const s2 = "memo-secret-two-value-ddddeeeeffff";
      const password = "memo-shared-password-123";

      const k1 = deriveSessionSigningKey(s1, password);
      expect(spy).toHaveBeenCalledTimes(1);
      const k2 = deriveSessionSigningKey(s2, password);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(k2.equals(k1)).toBe(false);
      // The slot is single: going back to S1 derives again, to the same value.
      const k1Again = deriveSessionSigningKey(s1, password);
      expect(spy).toHaveBeenCalledTimes(3);
      expect(k1Again.equals(k1)).toBe(true);
    });

    it("compares secret and password separately: (S,P1) and (S,P2) never share an entry", () => {
      const spy = vi.spyOn(crypto, "pbkdf2Sync");
      const secret = "memo-split-secret-value-99887766";
      const k1 = deriveSessionSigningKey(secret, "pw-one");
      const k2 = deriveSessionSigningKey(secret, "pw-two");
      expect(spy).toHaveBeenCalledTimes(2);
      expect(k1.equals(k2)).toBe(false);
      // "a" + "bc" and "ab" + "c" must not collide into one cache entry.
      const k3 = deriveSessionSigningKey("memo-concat-secret-value-1a", "bc");
      const k4 = deriveSessionSigningKey("memo-concat-secret-value-1", "abc");
      expect(spy).toHaveBeenCalledTimes(4);
      expect(k3.equals(k4)).toBe(false);
    });

    it("does not cache a failed derivation: the next call derives and then memoizes", () => {
      const secret = "memo-fail-secret-value-5544332211";
      const password = "memo-fail-password-abc";
      const spy = vi.spyOn(crypto, "pbkdf2Sync").mockImplementationOnce(() => {
        throw new Error("simulated PBKDF2 failure");
      });
      expect(() => deriveSessionSigningKey(secret, password)).toThrow("simulated PBKDF2 failure");
      const key = deriveSessionSigningKey(secret, password);
      expect(key.length).toBe(32);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(deriveSessionSigningKey(secret, password)).toBe(key);
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
