import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// DB-backed second layer for /admin/login (migration 086). The in-memory
// limiter in src/lib/rate-limit.ts does not hold across Vercel instances
// and is keyed per-IP, so this module calls public.admin_login_throttle
// via RPC, hashing the client key with HMAC-SHA256 keyed off
// ADMIN_SESSION_SECRET (never the raw IP, never the password).

const fixture = vi.hoisted(() => ({
  rpcImpl: null as null | ((args: unknown) => unknown),
  rpcArgsLog: [] as unknown[],
  neverResolve: false,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  // Both throttle functions answer through the same fixture, so one set of
  // cases drives the per-IP and the per-device wrapper alike.
  const respond = async (args: unknown) => {
    fixture.rpcArgsLog.push(args);
    if (fixture.neverResolve) {
      // Never resolves -- exercises the timeout path.
      return await new Promise(() => {});
    }
    if (fixture.rpcImpl) {
      return fixture.rpcImpl(args) as { data: unknown; error: unknown };
    }
    return { data: null, error: null };
  };
  return helper.createSupabaseFake({
    rpc: {
      admin_login_throttle: respond,
      admin_login_throttle_device: respond,
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import {
  hashLoginKey,
  checkAdminLoginThrottle,
  checkAdminDeviceLoginThrottle,
  LOGIN_THROTTLE_DEVICE_RPC,
  LOGIN_THROTTLE_RPC,
  LOGIN_THROTTLE_TIMEOUT_MS,
} from "./login-throttle";

const SECRET = "a".repeat(32);
const IP = "203.0.113.7";
const DEVICE_ID = "0123456789abcdef0123456789abcdef";

describe("login-throttle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.rpcImpl = null;
    fixture.rpcArgsLog = [];
    fixture.neverResolve = false;
    supabaseFake.calls.rpc.length = 0;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    process.env.ADMIN_SESSION_SECRET = SECRET;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("hashLoginKey", () => {
    it("returns a 64-char hex digest", () => {
      const h = hashLoginKey(IP, SECRET);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic for the same key and secret", () => {
      expect(hashLoginKey(IP, SECRET)).toBe(hashLoginKey(IP, SECRET));
    });

    it("changes when the secret changes", () => {
      expect(hashLoginKey(IP, SECRET)).not.toBe(hashLoginKey(IP, "b".repeat(32)));
    });

    it("changes when the key changes", () => {
      expect(hashLoginKey(IP, SECRET)).not.toBe(hashLoginKey("203.0.113.8", SECRET));
    });

    it("never contains the raw input key or secret", () => {
      const h = hashLoginKey(IP, SECRET);
      expect(h).not.toContain(IP);
      expect(h.toLowerCase()).not.toContain(SECRET.toLowerCase());
    });
  });

  describe("checkAdminLoginThrottle", () => {
    it("returns allowed for an allowed row, sending only p_key_hash and never the raw IP", async () => {
      fixture.rpcImpl = () => ({ data: { allowed: true, retry_after_seconds: 0 }, error: null });

      const decision = await checkAdminLoginThrottle(IP);

      expect(decision).toEqual({ allowed: true });
      expect(fixture.rpcArgsLog).toHaveLength(1);
      const args = fixture.rpcArgsLog[0] as Record<string, unknown>;
      expect(Object.keys(args)).toEqual(["p_key_hash"]);
      expect(args.p_key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(args)).not.toContain(IP);
    });

    it("returns limited with retryAfterSeconds for a blocked row", async () => {
      fixture.rpcImpl = () => ({ data: { allowed: false, retry_after_seconds: 120 }, error: null });

      const decision = await checkAdminLoginThrottle(IP);

      expect(decision).toEqual({ allowed: false, reason: "limited", retryAfterSeconds: 120 });
    });

    it("floors a zero/invalid retry_after_seconds up to 1", async () => {
      fixture.rpcImpl = () => ({ data: { allowed: false, retry_after_seconds: 0 }, error: null });

      const decision = await checkAdminLoginThrottle(IP);

      expect(decision).toEqual({ allowed: false, reason: "limited", retryAfterSeconds: 1 });
    });

    it("returns unavailable on an RPC error and never logs the IP", async () => {
      fixture.rpcImpl = () => ({ data: null, error: { code: "22023", message: `bad key for ${IP}` } });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const decision = await checkAdminLoginThrottle(IP);

      expect(decision).toEqual({ allowed: false, reason: "unavailable" });
      for (const call of warnSpy.mock.calls) {
        for (const arg of call) {
          expect(String(arg)).not.toContain(IP);
        }
      }
    });

    it("returns unavailable when the rpc call throws", async () => {
      fixture.rpcImpl = () => {
        throw new Error("network down");
      };

      const decision = await checkAdminLoginThrottle(IP);

      expect(decision).toEqual({ allowed: false, reason: "unavailable" });
    });

    it("returns unavailable after the timeout when the RPC never resolves", async () => {
      vi.useFakeTimers();
      fixture.neverResolve = true;

      const p = checkAdminLoginThrottle(IP);
      await vi.advanceTimersByTimeAsync(LOGIN_THROTTLE_TIMEOUT_MS);
      const decision = await p;

      expect(decision).toEqual({ allowed: false, reason: "unavailable", timedOut: true });
    });

    it("returns unavailable and never calls the RPC when the secret is missing", async () => {
      delete process.env.ADMIN_SESSION_SECRET;

      const decision = await checkAdminLoginThrottle(IP);

      expect(decision).toEqual({ allowed: false, reason: "unavailable" });
      expect(fixture.rpcArgsLog).toHaveLength(0);
    });

    it("returns unavailable and never calls the RPC when the secret is too short", async () => {
      process.env.ADMIN_SESSION_SECRET = "short";

      const decision = await checkAdminLoginThrottle(IP);

      expect(decision).toEqual({ allowed: false, reason: "unavailable" });
      expect(fixture.rpcArgsLog).toHaveLength(0);
    });

    it("returns unavailable when data is empty", async () => {
      fixture.rpcImpl = () => ({ data: null, error: null });

      const decision = await checkAdminLoginThrottle(IP);

      expect(decision).toEqual({ allowed: false, reason: "unavailable" });
    });

    it("returns unavailable when data is an empty array", async () => {
      fixture.rpcImpl = () => ({ data: [], error: null });

      const decision = await checkAdminLoginThrottle(IP);

      expect(decision).toEqual({ allowed: false, reason: "unavailable" });
    });

    it("returns unavailable when the row is malformed (allowed not boolean)", async () => {
      fixture.rpcImpl = () => ({ data: { allowed: "yes" }, error: null });

      const decision = await checkAdminLoginThrottle(IP);

      expect(decision).toEqual({ allowed: false, reason: "unavailable" });
    });

    // A-M6: clientKey() (src/lib/rate-limit.ts) falls back to the literal
    // "anon" when no x-real-ip / x-vercel-forwarded-for / x-forwarded-for
    // header is present. On any deploy target where that fallback can be
    // hit by more than one caller, every such caller would share one
    // 5-per-15-min DB-backed bucket -- a legitimate admin behind a proxy
    // that strips these headers could be locked out by an unrelated
    // client hitting the same fallback key. Refuse before ever hashing or
    // calling the RPC, so the shared bucket is never created.
    it("refuses (fails closed) and never calls the RPC when clientKey resolves to the 'anon' sentinel", async () => {
      const decision = await checkAdminLoginThrottle("anon");

      expect(decision).toEqual({ allowed: false, reason: "unavailable" });
      expect(fixture.rpcArgsLog).toHaveLength(0);
    });

    it("handles data returned as an array (PostgREST rpc shape)", async () => {
      fixture.rpcImpl = () => ({ data: [{ allowed: true, retry_after_seconds: 0 }], error: null });

      const decision = await checkAdminLoginThrottle(IP);

      expect(decision).toEqual({ allowed: true });
    });
  });

  // Device cookie (migration 207): a browser that has logged in with the
  // current password is throttled per device and skips the global bucket. The
  // wrapper must behave exactly like checkAdminLoginThrottle: same fail-closed
  // rules, same row validation, same timeout; only the RPC name and the hashed
  // key differ.
  describe("checkAdminDeviceLoginThrottle", () => {
    it("calls admin_login_throttle_device with p_key_hash = hashLoginKey('device:' + id, secret) and nothing else", async () => {
      fixture.rpcImpl = () => ({ data: { allowed: true, retry_after_seconds: 0 }, error: null });

      const decision = await checkAdminDeviceLoginThrottle(DEVICE_ID);

      expect(decision).toEqual({ allowed: true });
      expect(LOGIN_THROTTLE_DEVICE_RPC).toBe("admin_login_throttle_device");
      expect(supabaseFake.calls.rpc).toHaveLength(1);
      const call = supabaseFake.calls.rpc[0]!;
      expect(call.name).toBe("admin_login_throttle_device");
      expect(call.args).toEqual({ p_key_hash: hashLoginKey("device:" + DEVICE_ID, SECRET) });
      expect(JSON.stringify(call.args)).not.toContain(DEVICE_ID);
    });

    it("hashes under a different key than the per-IP call, and the per-IP call still uses its own RPC", async () => {
      fixture.rpcImpl = () => ({ data: { allowed: true, retry_after_seconds: 0 }, error: null });

      await checkAdminLoginThrottle(IP);
      await checkAdminDeviceLoginThrottle(DEVICE_ID);

      expect(LOGIN_THROTTLE_RPC).toBe("admin_login_throttle");
      expect(supabaseFake.calls.rpc.map((c) => c.name)).toEqual([
        "admin_login_throttle",
        "admin_login_throttle_device",
      ]);
      expect(hashLoginKey("device:" + DEVICE_ID, SECRET)).not.toBe(hashLoginKey(DEVICE_ID, SECRET));
    });

    it("returns limited with retryAfterSeconds for a blocked row", async () => {
      fixture.rpcImpl = () => ({ data: [{ allowed: false, retry_after_seconds: 240 }], error: null });

      expect(await checkAdminDeviceLoginThrottle(DEVICE_ID)).toEqual({
        allowed: false,
        reason: "limited",
        retryAfterSeconds: 240,
      });
    });

    it("floors a zero retry_after_seconds up to 1", async () => {
      fixture.rpcImpl = () => ({ data: { allowed: false, retry_after_seconds: 0 }, error: null });

      expect(await checkAdminDeviceLoginThrottle(DEVICE_ID)).toEqual({
        allowed: false,
        reason: "limited",
        retryAfterSeconds: 1,
      });
    });

    it("fails closed when the secret is missing or short, without calling the RPC", async () => {
      delete process.env.ADMIN_SESSION_SECRET;
      expect(await checkAdminDeviceLoginThrottle(DEVICE_ID)).toEqual({
        allowed: false,
        reason: "unavailable",
      });
      process.env.ADMIN_SESSION_SECRET = "short";
      expect(await checkAdminDeviceLoginThrottle(DEVICE_ID)).toEqual({
        allowed: false,
        reason: "unavailable",
      });
      expect(supabaseFake.calls.rpc).toHaveLength(0);
    });

    it("fails closed, without calling the RPC, for an id that is not 32 lowercase hex characters", async () => {
      for (const bad of ["", "abc", "anon", "A".repeat(32), "g".repeat(32), DEVICE_ID + "0", DEVICE_ID.slice(1)]) {
        expect(await checkAdminDeviceLoginThrottle(bad), bad).toEqual({
          allowed: false,
          reason: "unavailable",
        });
      }
      expect(supabaseFake.calls.rpc).toHaveLength(0);
    });

    it("fails closed on an RPC error and never logs the device id", async () => {
      fixture.rpcImpl = () => ({ data: null, error: { code: "42883", message: `no function for ${DEVICE_ID}` } });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(await checkAdminDeviceLoginThrottle(DEVICE_ID)).toEqual({
        allowed: false,
        reason: "unavailable",
      });
      expect(warnSpy).toHaveBeenCalled();
      for (const call of warnSpy.mock.calls) {
        for (const arg of call) expect(String(arg)).not.toContain(DEVICE_ID);
      }
    });

    it("fails closed when the rpc call throws", async () => {
      fixture.rpcImpl = () => {
        throw new Error("network down");
      };

      expect(await checkAdminDeviceLoginThrottle(DEVICE_ID)).toEqual({
        allowed: false,
        reason: "unavailable",
      });
    });

    it("fails closed after the 3 s timeout when the RPC never resolves", async () => {
      vi.useFakeTimers();
      fixture.neverResolve = true;

      const p = checkAdminDeviceLoginThrottle(DEVICE_ID);
      await vi.advanceTimersByTimeAsync(LOGIN_THROTTLE_TIMEOUT_MS);

      expect(await p).toEqual({ allowed: false, reason: "unavailable", timedOut: true });
    });

    it("fails closed on an empty, array-empty or malformed row", async () => {
      for (const data of [null, [], { allowed: "yes" }, [{ allowed: 1 }], "allowed"]) {
        fixture.rpcImpl = () => ({ data, error: null });
        expect(await checkAdminDeviceLoginThrottle(DEVICE_ID), JSON.stringify(data)).toEqual({
          allowed: false,
          reason: "unavailable",
        });
      }
    });
  });

  it("does not import 'server-only'", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./login-throttle.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/['"]server-only['"]/);
  });
});
