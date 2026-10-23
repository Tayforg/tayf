import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// ORDER of the per-minute limiter vs the api_key_touch RPC (api-9).
//
// `api_key_touch` durably increments today's `api_key_usage_daily.calls` as a
// side effect (migration 069). The per-minute bucket used to be consulted
// AFTER that touch, so every request the bucket refused had already been
// charged to the key's DAILY quota: a client hammering a throttled key burned
// its day while getting nothing back.
//
// Now a key the instance has already seen (a process-local hash -> tier memo)
// is charged to its per-minute bucket BEFORE the touch, so a refusal costs
// neither a database round trip nor a daily-quota unit. On a memo miss the
// tier is unknown until the touch answers, so the charge happens right after
// it (the only post-touch charge). A tier change charges the NEW tier's bucket
// after the touch. An empty touch result drops the memo entry. The memo is
// capped at 5000 entries, oldest evicted.
//
// Date is frozen (fake timers with only Date faked) so a token bucket cannot
// refill between requests: every count below is exact, not racy.
// ---------------------------------------------------------------------------

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

const FREE_KEY = `tayf_${"a1".repeat(20)}`;
const FREE_KEY_2 = `tayf_${"a2".repeat(20)}`;
const SWITCH_KEY = `tayf_${"b1".repeat(20)}`;
const REVOKE_KEY = `tayf_${"c1".repeat(20)}`;

interface KeyRow {
  id: number;
  tier: "free" | "partner";
  revoked: boolean;
}

const dbState = vi.hoisted(() => ({
  /** hash -> row; mutable so a test can flip a key's tier or revoke it. */
  keys: new Map<string, { id: number; tier: "free" | "partner"; revoked: boolean }>(),
  /** What api_key_touch added to api_key_usage_daily, per key id. */
  dailyCalls: {} as Record<number, number>,
  /** Accept ANY hash as a free key whose id is the number in its first 8 hex digits. */
  acceptAnyKey: false,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      sources: () => ({ data: [], error: null }),
      api_keys: (state) => {
        const hashEq = state.eq.find((e) => e.col === "key_hash");
        const row = hashEq ? dbState.keys.get(String(hashEq.val)) : undefined;
        return row && row.revoked ? { data: [{ id: row.id }], error: null } : { data: [], error: null };
      },
      api_key_usage_daily: (state) => {
        const keyIdEq = state.eq.find((e) => e.col === "key_id");
        const keyId = keyIdEq ? Number(keyIdEq.val) : undefined;
        const calls = keyId !== undefined ? (dbState.dailyCalls[keyId] ?? 0) : 0;
        return { data: [{ calls }], error: null };
      },
    },
    rpc: {
      api_key_touch: (args) => {
        const { p_key_hash } = args as { p_key_hash: string };
        let row = dbState.keys.get(p_key_hash);
        if (!row && dbState.acceptAnyKey) {
          row = { id: Number.parseInt(p_key_hash.slice(0, 8), 16), tier: "free", revoked: false };
        }
        if (!row || row.revoked) return { data: [], error: null };
        dbState.dailyCalls[row.id] = (dbState.dailyCalls[row.id] ?? 0) + 1;
        return { data: [{ key_id: row.id, tier: row.tier }], error: null };
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
/** A fresh IP per call: the keyed-IP floor (120 burst) must never be the limiter under test. */
function nextIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

function setKey(key: string, row: KeyRow): void {
  dbState.keys.set(sha256(key), row);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  dbState.keys.clear();
  dbState.dailyCalls = {};
  dbState.acceptAnyKey = false;
  setKey(FREE_KEY, { id: 1001, tier: "free", revoked: false });
  setKey(FREE_KEY_2, { id: 1002, tier: "free", revoked: false });
  setKey(SWITCH_KEY, { id: 3003, tier: "free", revoked: false });
  setKey(REVOKE_KEY, { id: 4004, tier: "free", revoked: false });
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

function req(key: string, ip = nextIp()): Request {
  return new Request("http://example.com/api/v1/sources", {
    headers: { "x-forwarded-for": ip, authorization: `Bearer ${key}` },
  });
}

function touchCalls(): number {
  return supabaseFake.calls.rpc.filter((c) => c.name === "api_key_touch").length;
}

async function getSources() {
  return (await import("@/app/api/v1/sources/route")).GET;
}

describe("per-minute limiter runs before the touch for a known key", () => {
  it("a free key's 60 calls are 200 with 60 touches; the 61st is 429 key_minute with no further touch", async () => {
    const GET = await getSources();

    for (let i = 0; i < 60; i++) {
      const res = await GET(req(FREE_KEY));
      expect(res.status, `request ${i + 1}`).toBe(200);
    }
    expect(touchCalls()).toBe(60);

    const res = await GET(req(FREE_KEY));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("key_minute");
    expect(body.error).toBe("Too many requests");
    expect(body.details.retryAfterMs).toBeGreaterThan(0);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(res.headers.get("Retry-After")).toBe(
      String(Math.max(1, Math.ceil(body.details.retryAfterMs / 1000))),
    );
    expect(res.headers.get("X-Tayf-Tier")).toBe("free");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toContain("no-store");

    // The refusal never reached the database.
    expect(touchCalls()).toBe(60);
  });

  it("a refused per-minute request does not cost the key any daily quota", async () => {
    const GET = await getSources();

    for (let i = 0; i < 60; i++) await GET(req(FREE_KEY));
    for (let i = 0; i < 25; i++) {
      expect((await GET(req(FREE_KEY))).status).toBe(429);
    }

    // 60 accepted calls were counted; the 25 refused ones were not.
    expect(dbState.dailyCalls[1001]).toBe(60);
    expect(touchCalls()).toBe(60);
  });

  it("the memo is per key: another key on the same tier is unaffected by an exhausted one", async () => {
    const GET = await getSources();

    for (let i = 0; i < 61; i++) await GET(req(FREE_KEY));
    expect((await GET(req(FREE_KEY))).status).toBe(429);

    const other = await GET(req(FREE_KEY_2));
    expect(other.status).toBe(200);
    expect(other.headers.get("X-Tayf-Tier")).toBe("free");
  });

  it("the very first call of a never-seen key is touched and then charged (a memo miss)", async () => {
    const GET = await getSources();
    const res = await GET(req(FREE_KEY));
    expect(res.status).toBe(200);
    expect(touchCalls()).toBe(1);
    expect(dbState.dailyCalls[1001]).toBe(1);
  });

  it("a memo miss whose post-touch charge is refused is still a 429 key_minute with the resolved tier", async () => {
    // Exhaust the bucket, drop the memo by evicting it (5000 other keys),
    // then call again: unknown tier -> touch -> charge -> refused.
    dbState.acceptAnyKey = true;
    const GET = await getSources();
    for (let i = 0; i < 60; i++) await GET(req(FREE_KEY));
    expect(touchCalls()).toBe(60);

    for (let i = 0; i < 5000; i++) {
      await GET(req(`tayf_${(0x10000000 + i).toString(16).padStart(40, "0")}`));
    }
    const before = touchCalls();

    const res = await GET(req(FREE_KEY));
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("key_minute");
    expect(res.headers.get("X-Tayf-Tier")).toBe("free");
    // Memo miss: the tier had to be learned from the touch first.
    expect(touchCalls()).toBe(before + 1);
  }, 30_000);
});

describe("tier changes", () => {
  it("charges the NEW tier's bucket after the touch when a memoised key changes tier", async () => {
    const GET = await getSources();

    // Call 1: memo miss as free; memo = free.
    expect((await GET(req(SWITCH_KEY))).status).toBe(200);

    // The key is upgraded.
    setKey(SWITCH_KEY, { id: 3003, tier: "partner", revoked: false });

    // Call 2: memo says free -> charged to the free bucket before the touch;
    // the touch answers partner -> one token of the PARTNER bucket after it.
    const second = await GET(req(SWITCH_KEY));
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Tayf-Tier")).toBe("partner");

    // Calls 3..601 are memo hits charged to the partner bucket up front.
    // Partner capacity is 600; the tier-change charge took one, so call 601
    // takes the last token and call 602 is refused.
    for (let i = 3; i <= 601; i++) {
      const res = await GET(req(SWITCH_KEY));
      expect(res.status, `request ${i}`).toBe(200);
      expect(res.headers.get("X-Tayf-Tier")).toBe("partner");
    }
    const touchesBefore = touchCalls();
    expect(touchesBefore).toBe(601);

    const refused = await GET(req(SWITCH_KEY));
    expect(refused.status).toBe(429);
    const body = await refused.json();
    expect(body.code).toBe("key_minute");
    expect(refused.headers.get("X-Tayf-Tier")).toBe("partner");
    expect(touchCalls()).toBe(touchesBefore);
  }, 30_000);

  it("a downgrade is re-learned through the touch and reported with the new tier", async () => {
    setKey(SWITCH_KEY, { id: 3003, tier: "partner", revoked: false });
    const GET = await getSources();
    expect((await GET(req(SWITCH_KEY))).headers.get("X-Tayf-Tier")).toBe("partner");

    setKey(SWITCH_KEY, { id: 3003, tier: "free", revoked: false });
    const res = await GET(req(SWITCH_KEY));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Tayf-Tier")).toBe("free");
  });
});

describe("an empty touch result drops the memo entry", () => {
  it("a key revoked after being memoised is refused 403, and is a memo miss again afterwards", async () => {
    const GET = await getSources();

    // Memoise the key, then spend the bucket down to exactly one token
    // (60 capacity - 59 spent; Date is frozen so nothing refills).
    for (let i = 0; i < 59; i++) {
      expect((await GET(req(REVOKE_KEY))).status).toBe(200);
    }
    expect(touchCalls()).toBe(59);
    setKey(REVOKE_KEY, { id: 4004, tier: "free", revoked: true });

    // Memo hit: takes the last token up front, then the touch comes back empty.
    const revoked = await GET(req(REVOKE_KEY));
    expect(revoked.status).toBe(403);
    const touchAfterRevoked = touchCalls();
    expect(touchAfterRevoked).toBe(60); // that touch ran, found nothing, counted nothing
    expect(dbState.dailyCalls[4004]).toBe(59);

    // The key is reinstated. Had the memo survived, the bucket (now empty)
    // would refuse this call BEFORE the touch. It was dropped, so the tier is
    // unknown: the touch runs first, and only then the charge is refused.
    setKey(REVOKE_KEY, { id: 4004, tier: "free", revoked: false });
    const reinstated = await GET(req(REVOKE_KEY));
    expect(reinstated.status).toBe(429);
    expect((await reinstated.json()).code).toBe("key_minute");
    expect(touchCalls()).toBe(touchAfterRevoked + 1);
  });

  it("an unknown key is touched on every request: nothing is memoised for it", async () => {
    const GET = await getSources();
    const unknown = `tayf_${"d1".repeat(20)}`;
    expect((await GET(req(unknown))).status).toBe(401);
    expect((await GET(req(unknown))).status).toBe(401);
    expect(touchCalls()).toBe(2);
  });
});

describe("the memo is capped at 5000 entries, oldest evicted", () => {
  it("evicts the oldest key but keeps the second-oldest", async () => {
    dbState.acceptAnyKey = true;
    const GET = await getSources();

    // k1 and k2: memoised first and second, buckets then emptied.
    for (let i = 0; i < 60; i++) await GET(req(FREE_KEY));
    for (let i = 0; i < 60; i++) await GET(req(FREE_KEY_2));

    // 4999 more distinct keys: 5001 entries wanted -> the oldest (k1) goes.
    dbState.keys.clear();
    dbState.acceptAnyKey = true;
    for (let i = 0; i < 4999; i++) {
      const res = await GET(req(`tayf_${(0x20000000 + i).toString(16).padStart(40, "0")}`));
      expect(res.status).toBe(200);
    }
    const before = touchCalls();

    // k2 is still memoised: refused up front, no touch.
    const k2 = await GET(req(FREE_KEY_2));
    expect(k2.status).toBe(429);
    expect(touchCalls()).toBe(before);

    // k1 was evicted: a memo miss, so the touch runs and the charge is refused.
    // (Its id is 1001 in the first phase; with the table cleared the fake
    // accepts any hash as a free key, so this is still a free-tier miss.)
    const k1 = await GET(req(FREE_KEY));
    expect(k1.status).toBe(429);
    expect((await k1.json()).code).toBe("key_minute");
    expect(touchCalls()).toBe(before + 1);
  }, 60_000);
});
