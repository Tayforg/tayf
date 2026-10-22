import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// The per-IP floor under /api/v1.
//
// Before: ONE 30-burst / 1-per-second bucket per client IP was charged on
// every request, keyed or not, so a partner key (600/min) sharing an egress IP
// was capped at ~60/min and 429'd on its 31st rapid call.
//
// Now:
//   - a request with no (or a malformed) key is charged to the strict
//     anonymous bucket (30 burst, 60/min) and refused 401 / 429 ip_floor;
//   - a syntactically valid key first passes a generous keyed-IP bucket
//     (120 burst, 600/min) BEFORE any database call, so a flood of made-up
//     keys is bounded and cannot turn into unbounded api_key_touch RPCs;
//   - a key the database does not know / has revoked is ALSO charged to the
//     strict anonymous bucket;
//   - a VALID key is never charged to the anonymous bucket, only to its own
//     per-key minute / daily limits.
//
// Date is frozen (fake timers with only Date faked) so a token bucket cannot
// refill between requests: the counts below are exact, not racy.
// ---------------------------------------------------------------------------

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

const FREE_KEY = `tayf_${"a".repeat(40)}`;
const PARTNER_KEY = `tayf_${"b".repeat(40)}`;

const KEYS_DB = [
  { id: 1001, hash: sha256(FREE_KEY), tier: "free", revoked: false },
  { id: 2002, hash: sha256(PARTNER_KEY), tier: "partner", revoked: false },
];

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      sources: () => ({ data: [], error: null }),
      api_keys: () => ({ data: [], error: null }),
      api_key_usage_daily: () => ({ data: [{ calls: 0 }], error: null }),
    },
    rpc: {
      api_key_touch: (args) => {
        const { p_key_hash } = args as { p_key_hash: string };
        const found = KEYS_DB.find((k) => k.hash === p_key_hash);
        if (!found) return { data: [], error: null };
        return { data: [{ key_id: found.id, tier: found.tier }], error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: async () => {} };
});

const ORIGINAL_ENV = { ...process.env };
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `192.0.2.${1 + (ipCounter % 250)}.${ipCounter}`;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  supabaseFake.calls.rpc.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.resetModules();
});

function req(ip: string, key?: string): Request {
  const headers: Record<string, string> = { "x-forwarded-for": ip };
  if (key) headers.authorization = `Bearer ${key}`;
  return new Request("http://example.com/api/v1/sources", { headers });
}

function touchCalls(): number {
  return supabaseFake.calls.rpc.filter((c) => c.name === "api_key_touch").length;
}

describe("per-IP floor: keyless vs keyed", () => {
  it("1. 31 keyless requests from one IP: 30 are 401, the 31st is 429 ip_floor with Retry-After >= 1", async () => {
    const { GET } = await import("@/app/api/v1/sources/route");
    const ip = nextIp();

    for (let i = 0; i < 30; i++) {
      const res = await GET(req(ip));
      expect(res.status, `request ${i + 1}`).toBe(401);
    }
    const res = await GET(req(ip));
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("ip_floor");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    // None of that reached the database.
    expect(touchCalls()).toBe(0);
  });

  it("2. 100 requests on a partner key from ONE IP are all 200 (the old shared floor 429'd the 31st)", async () => {
    const { GET } = await import("@/app/api/v1/sources/route");
    const ip = nextIp();

    for (let i = 0; i < 100; i++) {
      const res = await GET(req(ip, PARTNER_KEY));
      expect(res.status, `request ${i + 1}`).toBe(200);
    }
  });

  it("3. 61 requests on a free key from one IP: 60 are 200 and the 61st is 429 key_minute", async () => {
    const { GET } = await import("@/app/api/v1/sources/route");
    const ip = nextIp();

    for (let i = 0; i < 60; i++) {
      const res = await GET(req(ip, FREE_KEY));
      expect(res.status, `request ${i + 1}`).toBe(200);
    }
    const res = await GET(req(ip, FREE_KEY));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("key_minute");
    expect(body.error).toBe("Too many requests");
    expect(res.headers.get("X-Tayf-Tier")).toBe("free");
  });

  it("4. 200 valid-format UNKNOWN keys from one IP: api_key_touch runs exactly 120 times; 30 are 401, 90 are 429 ip_floor, the last 80 are 429 ip_floor with no database call", async () => {
    const { GET } = await import("@/app/api/v1/sources/route");
    const ip = nextIp();
    const unknown = `tayf_${"c".repeat(40)}`;
    const statuses: number[] = [];
    const codes: Array<string | undefined> = [];
    const touchAfter: number[] = [];

    for (let i = 0; i < 200; i++) {
      const res = await GET(req(ip, unknown));
      statuses.push(res.status);
      codes.push(res.status === 429 ? (await res.json()).code : undefined);
      touchAfter.push(touchCalls());
    }

    // 1-30: anonymous bucket still has tokens -> plain 401.
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    // 31-120: past the anonymous bucket but inside the keyed-IP burst -> the
    // database was asked, the key was unknown, the anon bucket said stop.
    expect(statuses.slice(30, 120).every((s) => s === 429)).toBe(true);
    expect(codes.slice(30, 120).every((c) => c === "ip_floor")).toBe(true);
    // 121-200: refused by the keyed-IP bucket BEFORE any database call.
    expect(statuses.slice(120).every((s) => s === 429)).toBe(true);
    expect(codes.slice(120).every((c) => c === "ip_floor")).toBe(true);

    expect(touchAfter[119]).toBe(120);
    expect(touchAfter[199]).toBe(120);
    expect(touchCalls()).toBe(120);
  });

  it("5. once a keyless flood has drained the anonymous bucket for an IP, a partner key from that IP still gets 200", async () => {
    const { GET } = await import("@/app/api/v1/sources/route");
    const ip = nextIp();

    for (let i = 0; i < 31; i++) await GET(req(ip));
    const drained = await GET(req(ip));
    expect(drained.status).toBe(429);

    const res = await GET(req(ip, PARTNER_KEY));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Tayf-Tier")).toBe("partner");
  });
});

describe("per-IP floor: ordering guarantees", () => {
  it("a valid key is never charged to the anonymous bucket", async () => {
    const { GET } = await import("@/app/api/v1/sources/route");
    const ip = nextIp();

    // 100 valid-key calls, then a full anonymous burst must still be intact.
    for (let i = 0; i < 100; i++) {
      expect((await GET(req(ip, PARTNER_KEY))).status).toBe(200);
    }
    for (let i = 0; i < 30; i++) {
      expect((await GET(req(ip))).status, `anon ${i + 1}`).toBe(401);
    }
    expect((await GET(req(ip))).status).toBe(429);
  });

  it("a syntactically valid key is refused by the keyed-IP bucket before the database is consulted", async () => {
    const { GET } = await import("@/app/api/v1/sources/route");
    const ip = nextIp();
    // Burn the whole 120-token keyed-IP burst with a real key.
    for (let i = 0; i < 120; i++) {
      await GET(req(ip, PARTNER_KEY));
    }
    const before = touchCalls();
    const res = await GET(req(ip, PARTNER_KEY));
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("ip_floor");
    expect(touchCalls()).toBe(before);
  });

  it("the keyed-IP floor is per IP: another IP is unaffected", async () => {
    const { GET } = await import("@/app/api/v1/sources/route");
    const flooded = nextIp();
    for (let i = 0; i < 125; i++) await GET(req(flooded, PARTNER_KEY));
    expect((await GET(req(flooded, PARTNER_KEY))).status).toBe(429);

    expect((await GET(req(nextIp(), PARTNER_KEY))).status).toBe(200);
  });

  it("a malformed key counts as keyless: charged to the anonymous bucket, never reaching the database", async () => {
    const { GET } = await import("@/app/api/v1/sources/route");
    const ip = nextIp();
    for (let i = 0; i < 30; i++) {
      const res = await GET(req(ip, "not-a-tayf-key"));
      expect(res.status).toBe(401);
    }
    const res = await GET(req(ip, "not-a-tayf-key"));
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("ip_floor");
    expect(touchCalls()).toBe(0);
  });
});

describe("per-IP floor: advertised numbers", () => {
  it("API_V1_ANON_LIMIT is unchanged and API_V1_KEYED_IP_LIMIT is 120 burst / 600 per minute", async () => {
    const { API_V1_ANON_LIMIT, API_V1_KEYED_IP_LIMIT, API_TIER_LIMITS } = await import(
      "@/lib/api/keys"
    );
    expect(API_V1_ANON_LIMIT).toEqual({ capacity: 30, refillPerSecond: 1 });
    expect(API_V1_KEYED_IP_LIMIT).toEqual({ capacity: 120, refillPerSecond: 10 });
    expect(API_V1_KEYED_IP_LIMIT.capacity).toBe(2 * API_TIER_LIMITS.free.perMinute);
    expect(API_V1_KEYED_IP_LIMIT.refillPerSecond * 60).toBe(API_TIER_LIMITS.partner.perMinute);
  });
});
