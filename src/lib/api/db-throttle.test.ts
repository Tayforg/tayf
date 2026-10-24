import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Fleet-wide, DB-backed per-client throttle (migration 118) for the public
// write routes. Unlike src/lib/admin/login-throttle.ts (fail-CLOSED: a login
// must not pass unchecked), this one is FAIL-OPEN: it is an abuse brake on a
// game and a feedback form, so an unavailable throttle must never take either
// down. Every degraded path below therefore resolves `{ allowed: true,
// degraded: true }` and never throws.

const fixture = vi.hoisted(() => ({
  rpcImpl: null as null | ((args: unknown) => unknown),
  neverResolve: false,
  throwSync: false,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    rpc: {
      api_throttle: async (args: unknown) => {
        if (fixture.throwSync) throw new Error(`boom for ${JSON.stringify(args)}`);
        if (fixture.neverResolve) return await new Promise(() => {});
        if (fixture.rpcImpl) {
          return fixture.rpcImpl(args) as { data: unknown; error: unknown };
        }
        return { data: null, error: null };
      },
    },
  });
});

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: () => supabaseFake.client,
}));

import { hashLoginKey } from "@/lib/admin/login-throttle";
import {
  DB_THROTTLE_RPC,
  DB_THROTTLE_TIMEOUT_MS,
  THROTTLE_POLICY,
  checkDbThrottle,
  hashThrottleKey,
} from "./db-throttle";

const SECRET = "s".repeat(32);
const IP = "203.0.113.7";
const BASE = { bucket: "oyun:all", clientKey: IP, limit: 40, windowSeconds: 3600 } as const;

function rpcCalls() {
  return supabaseFake.calls.rpc;
}

describe("db-throttle", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fixture.rpcImpl = null;
    fixture.neverResolve = false;
    fixture.throwSync = false;
    supabaseFake.calls.rpc.length = 0;
    process.env.ADMIN_SESSION_SECRET = SECRET;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("constants", () => {
    it("names the RPC and caps the call at 3000 ms", () => {
      expect(DB_THROTTLE_RPC).toBe("api_throttle");
      expect(DB_THROTTLE_TIMEOUT_MS).toBe(3000);
    });

    it("pins the policy numbers the routes rely on", () => {
      expect(THROTTLE_POLICY.oyunAll).toEqual({ bucket: "oyun:all", limit: 40, windowSeconds: 3600 });
      expect(THROTTLE_POLICY.oyunSourceLimit).toBe(3);
      expect(THROTTLE_POLICY.oyunSourceWindowSeconds).toBe(86_400);
      expect(THROTTLE_POLICY.corrections).toEqual({
        bucket: "corrections:all",
        limit: 5,
        windowSeconds: 3600,
      });
    });
  });

  describe("hashThrottleKey", () => {
    it("returns a 64-char lowercase hex digest", () => {
      expect(hashThrottleKey(IP, SECRET)).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic for the same key and secret", () => {
      expect(hashThrottleKey(IP, SECRET)).toBe(hashThrottleKey(IP, SECRET));
    });

    it("varies with the secret and with the key", () => {
      expect(hashThrottleKey(IP, SECRET)).not.toBe(hashThrottleKey(IP, "t".repeat(32)));
      expect(hashThrottleKey(IP, SECRET)).not.toBe(hashThrottleKey("203.0.113.8", SECRET));
    });

    it("is domain-separated from the admin-login digest of the same key and secret", () => {
      expect(hashThrottleKey(IP, SECRET)).not.toBe(hashLoginKey(IP, SECRET));
    });

    it("never contains the raw key or secret", () => {
      const h = hashThrottleKey(IP, SECRET);
      expect(h).not.toContain(IP);
      expect(h).not.toContain(SECRET);
    });
  });

  describe("checkDbThrottle: decisions", () => {
    it("allowed row -> {allowed:true, degraded:false}, calling the RPC with exactly the four params", async () => {
      fixture.rpcImpl = () => ({ data: [{ allowed: true, retry_after_seconds: 0 }], error: null });

      const r = await checkDbThrottle(BASE);

      expect(r).toEqual({ allowed: true, retryAfterSeconds: 0, degraded: false });
      expect(rpcCalls()).toHaveLength(1);
      expect(rpcCalls()[0]?.name).toBe("api_throttle");
      const args = rpcCalls()[0]?.args as Record<string, unknown>;
      expect(Object.keys(args).sort()).toEqual(
        ["p_bucket", "p_key_hash", "p_limit", "p_window_seconds"].sort(),
      );
      expect(args.p_bucket).toBe("oyun:all");
      expect(args.p_key_hash).toBe(hashThrottleKey(IP, SECRET));
      expect(args.p_limit).toBe(40);
      expect(args.p_window_seconds).toBe(3600);
      expect(JSON.stringify(args)).not.toContain(IP);
    });

    it("accepts a bare (non-array) row too", async () => {
      fixture.rpcImpl = () => ({ data: { allowed: true, retry_after_seconds: 0 }, error: null });
      await expect(checkDbThrottle(BASE)).resolves.toMatchObject({ allowed: true, degraded: false });
    });

    it("denied row -> allowed:false with the DB's retry_after_seconds", async () => {
      fixture.rpcImpl = () => ({ data: [{ allowed: false, retry_after_seconds: 120 }], error: null });

      const r = await checkDbThrottle(BASE);

      expect(r).toEqual({ allowed: false, retryAfterSeconds: 120, degraded: false });
    });

    it("a garbage retry_after_seconds falls back to 60", async () => {
      for (const garbage of ["soon", undefined, Number.NaN, {}]) {
        fixture.rpcImpl = () => ({ data: [{ allowed: false, retry_after_seconds: garbage }], error: null });
        const r = await checkDbThrottle(BASE);
        expect(r).toEqual({ allowed: false, retryAfterSeconds: 60, degraded: false });
      }
    });

    it("a retry_after_seconds below 1 is raised to 1 (never a Retry-After: 0 storm)", async () => {
      for (const low of [0, -5, 0.4, null]) {
        fixture.rpcImpl = () => ({ data: [{ allowed: false, retry_after_seconds: low }], error: null });
        const r = await checkDbThrottle(BASE);
        expect(r).toEqual({ allowed: false, retryAfterSeconds: 1, degraded: false });
      }
    });
  });

  describe("checkDbThrottle: fail-open", () => {
    const OPEN = { allowed: true, retryAfterSeconds: 0, degraded: true } as const;

    it("an RPC error is degraded-open and warns with the error code only", async () => {
      fixture.rpcImpl = () => ({
        data: null,
        error: { code: "57014", message: `statement timeout for ${IP}` },
      });

      await expect(checkDbThrottle(BASE)).resolves.toEqual(OPEN);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toBe("[db-throttle] unavailable: 57014");
      expect(warn.mock.calls[0]?.[1]).toEqual({ bucket: "oyun:all" });
    });

    it("an RPC error without a code is reported as 'error'", async () => {
      fixture.rpcImpl = () => ({ data: null, error: { message: "boom" } });
      await expect(checkDbThrottle(BASE)).resolves.toEqual(OPEN);
      expect(warn.mock.calls[0]?.[0]).toBe("[db-throttle] unavailable: error");
    });

    it("a thrown error is degraded-open and warns with the error NAME only", async () => {
      fixture.throwSync = true;

      await expect(checkDbThrottle(BASE)).resolves.toEqual(OPEN);

      expect(warn.mock.calls[0]?.[0]).toBe("[db-throttle] unavailable: Error");
      expect(JSON.stringify(warn.mock.calls)).not.toContain("boom");
    });

    it("an RPC that never answers is abandoned after 3000 ms", async () => {
      vi.useFakeTimers();
      fixture.neverResolve = true;

      const pending = checkDbThrottle(BASE);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(DB_THROTTLE_TIMEOUT_MS - 1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual(OPEN);
      expect(warn.mock.calls[0]?.[0]).toBe("[db-throttle] unavailable: TimeoutError");
    });

    it("a malformed row is degraded-open", async () => {
      for (const data of [null, [], [{}], [{ allowed: "yes" }], "allowed", 7]) {
        fixture.rpcImpl = () => ({ data, error: null });
        await expect(checkDbThrottle(BASE)).resolves.toEqual(OPEN);
      }
    });

    it("a missing or short ADMIN_SESSION_SECRET is degraded-open and never calls the RPC", async () => {
      delete process.env.ADMIN_SESSION_SECRET;
      await expect(checkDbThrottle(BASE)).resolves.toEqual(OPEN);

      process.env.ADMIN_SESSION_SECRET = "x".repeat(15);
      await expect(checkDbThrottle(BASE)).resolves.toEqual(OPEN);

      expect(rpcCalls()).toHaveLength(0);
    });

    it("the shared 'anon' client key is degraded-open and never calls the RPC", async () => {
      await expect(checkDbThrottle({ ...BASE, clientKey: "anon" })).resolves.toEqual(OPEN);
      expect(rpcCalls()).toHaveLength(0);
    });

    it("an invalid bucket is degraded-open and never calls the RPC", async () => {
      for (const bucket of ["", "OYUN:ALL", "oyun all", "oyun/all", "a".repeat(81)]) {
        await expect(checkDbThrottle({ ...BASE, bucket })).resolves.toEqual(OPEN);
      }
      expect(rpcCalls()).toHaveLength(0);
    });

    it("an out-of-range limit or window is degraded-open and never calls the RPC", async () => {
      for (const patch of [
        { limit: 0 },
        { limit: 1001 },
        { limit: 1.5 },
        { windowSeconds: 0 },
        { windowSeconds: 86_401 },
        { windowSeconds: Number.NaN },
      ]) {
        await expect(checkDbThrottle({ ...BASE, ...patch })).resolves.toEqual(OPEN);
      }
      expect(rpcCalls()).toHaveLength(0);
    });

    it("accepts the boundary values 1/1000 and 1/86400", async () => {
      fixture.rpcImpl = () => ({ data: [{ allowed: true, retry_after_seconds: 0 }], error: null });
      await expect(checkDbThrottle({ ...BASE, limit: 1, windowSeconds: 1 })).resolves.toMatchObject({
        degraded: false,
      });
      await expect(
        checkDbThrottle({ ...BASE, limit: 1000, windowSeconds: 86_400 }),
      ).resolves.toMatchObject({ degraded: false });
      expect(rpcCalls()).toHaveLength(2);
    });
  });

  describe("privacy: warnings never carry the raw key", () => {
    it("no failure path puts the IP, the secret or the digest in console.warn", async () => {
      const scenarios: Array<() => Promise<unknown>> = [
        async () => {
          fixture.rpcImpl = () => ({ data: null, error: { code: "42501", message: IP } });
          return checkDbThrottle(BASE);
        },
        async () => {
          fixture.rpcImpl = null;
          fixture.throwSync = true;
          return checkDbThrottle(BASE);
        },
        async () => {
          fixture.throwSync = false;
          fixture.rpcImpl = () => ({ data: "junk", error: null });
          return checkDbThrottle(BASE);
        },
        async () => {
          delete process.env.ADMIN_SESSION_SECRET;
          return checkDbThrottle(BASE);
        },
        async () => {
          process.env.ADMIN_SESSION_SECRET = SECRET;
          return checkDbThrottle({ ...BASE, clientKey: "anon" });
        },
        async () => checkDbThrottle({ ...BASE, bucket: `Bad ${IP}` }),
      ];

      for (const run of scenarios) await run();

      expect(warn).toHaveBeenCalled();
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain(IP);
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain(hashThrottleKey(IP, SECRET));
    });

    it("logs only the bucket PREFIX of a per-outlet bucket, never the outlet id", async () => {
      fixture.rpcImpl = () => ({ data: null, error: { code: "57014" } });
      const sourceId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

      await checkDbThrottle({ ...BASE, bucket: `oyun:src:${sourceId}`, limit: 3, windowSeconds: 86_400 });

      expect(warn.mock.calls[0]?.[1]).toEqual({ bucket: "oyun:src" });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(sourceId);
    });
  });
});
