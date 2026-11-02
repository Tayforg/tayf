import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

// The /admin "API anahtarlari" reader. Shared chainable Supabase fake with
// per-table fixtures-as-functions, so the recorded predicates (usage window,
// key-id scope, row limit) can be asserted. "null" means "could not read".

interface Res {
  data: unknown;
  error: { message: string } | null;
}

const log = vi.hoisted(() => ({
  states: [] as BuilderState[],
  throwOnClient: false,
}));

const fx = vi.hoisted(() => ({
  keys: { data: [], error: null } as Res,
  usage: { data: [], error: null } as Res,
}));

const fake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      api_keys: (s) => {
        log.states.push(s);
        return fx.keys;
      },
      api_key_usage_daily: (s) => {
        log.states.push(s);
        return fx.usage;
      },
    },
  });
});

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: () => {
    if (log.throwOnClient) throw new Error("no env");
    return fake.client;
  },
}));

import { getApiKeysStatus } from "./api-keys-status";

function statesOf(table: string) {
  return log.states.filter((s) => s.table === table);
}

function keyRow(id: number | string, over: Record<string, unknown> = {}) {
  return {
    id,
    label: `key ${id}`,
    tier: "free",
    created_at: "2026-10-01T09:00:00Z",
    revoked_at: null,
    last_used_at: "2026-11-01T08:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  vi.setSystemTime(new Date("2026-11-02T12:00:00Z"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  log.states.length = 0;
  log.throwOnClient = false;
  fx.keys = { data: [], error: null };
  fx.usage = { data: [], error: null };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("getApiKeysStatus failure modes", () => {
  it("returns null when the keys query errors, without reading usage", async () => {
    fx.keys = { data: null, error: { message: "no table" } };
    expect(await getApiKeysStatus()).toBeNull();
    expect(statesOf("api_key_usage_daily")).toHaveLength(0);
  });

  it("returns [] for zero keys and issues no usage query", async () => {
    fx.keys = { data: [], error: null };
    expect(await getApiKeysStatus()).toEqual([]);
    expect(statesOf("api_key_usage_daily")).toHaveLength(0);
  });

  it("treats a non-array keys payload as zero keys", async () => {
    fx.keys = { data: null, error: null };
    expect(await getApiKeysStatus()).toEqual([]);
    expect(statesOf("api_key_usage_daily")).toHaveLength(0);
  });

  it("returns null when the usage query errors", async () => {
    fx.keys = { data: [keyRow(1)], error: null };
    fx.usage = { data: null, error: { message: "boom" } };
    expect(await getApiKeysStatus()).toBeNull();
  });

  it("returns null instead of throwing when the client cannot be built", async () => {
    log.throwOnClient = true;
    await expect(getApiKeysStatus()).resolves.toBeNull();
  });
});

describe("getApiKeysStatus usage aggregation", () => {
  it("sums the 7-day calls per key, coercing string counts", async () => {
    fx.keys = { data: [keyRow(1), keyRow(2)], error: null };
    fx.usage = {
      data: [
        { key_id: 1, day: "2026-11-02", calls: 3 },
        { key_id: 1, day: "2026-11-01", calls: "4" },
        { key_id: 2, day: "2026-11-02", calls: 10 },
      ],
      error: null,
    };
    const out = await getApiKeysStatus();
    expect(out?.map((r) => [r.id, r.calls7d])).toEqual([
      [1, 7],
      [2, 10],
    ]);
  });

  it("reports 0 for a key with no usage rows", async () => {
    fx.keys = { data: [keyRow(1), keyRow(2)], error: null };
    fx.usage = { data: [{ key_id: 1, day: "2026-11-02", calls: 5 }], error: null };
    const out = await getApiKeysStatus();
    expect(out?.find((r) => r.id === 2)?.calls7d).toBe(0);
  });

  it("counts a non-finite calls value as 0 and ignores a row with a non-numeric key id", async () => {
    fx.keys = { data: [keyRow(1)], error: null };
    fx.usage = {
      data: [
        { key_id: 1, day: "2026-11-02", calls: "abc" },
        { key_id: 1, day: "2026-11-01", calls: undefined },
        { key_id: 1, day: "2026-10-31", calls: 2 },
        { key_id: "not-a-number", day: "2026-11-02", calls: 99 },
      ],
      error: null,
    };
    const out = await getApiKeysStatus();
    expect(out?.[0]?.calls7d).toBe(2);
  });

  it("treats a non-array usage payload as no usage", async () => {
    fx.keys = { data: [keyRow(1)], error: null };
    fx.usage = { data: null, error: null };
    const out = await getApiKeysStatus();
    expect(out?.[0]?.calls7d).toBe(0);
  });
});

describe("getApiKeysStatus row mapping", () => {
  it("maps tier to partner or free, and a null label to ''", async () => {
    fx.keys = {
      data: [
        keyRow(1, { tier: "partner" }),
        keyRow(2, { tier: "free" }),
        keyRow(3, { tier: "enterprise" }),
        keyRow(4, { tier: null }),
        keyRow(5, { label: null }),
      ],
      error: null,
    };
    const out = await getApiKeysStatus();
    expect(out?.map((r) => r.tier)).toEqual(["partner", "free", "free", "free", "free"]);
    expect(out?.[4]?.label).toBe("");
  });

  it("passes timestamps through and normalises missing ones", async () => {
    fx.keys = {
      data: [
        keyRow(1, { revoked_at: "2026-10-20T00:00:00Z" }),
        keyRow(2, { created_at: null, revoked_at: undefined, last_used_at: undefined }),
      ],
      error: null,
    };
    const out = await getApiKeysStatus();
    expect(out?.[0]).toMatchObject({
      id: 1,
      created_at: "2026-10-01T09:00:00Z",
      revoked_at: "2026-10-20T00:00:00Z",
      last_used_at: "2026-11-01T08:00:00Z",
    });
    expect(out?.[1]).toMatchObject({ id: 2, created_at: "", revoked_at: null, last_used_at: null });
  });

  it("coerces string key ids to numbers", async () => {
    fx.keys = { data: [keyRow("7")], error: null };
    fx.usage = { data: [{ key_id: "7", day: "2026-11-02", calls: 1 }], error: null };
    const out = await getApiKeysStatus();
    expect(out?.[0]).toMatchObject({ id: 7, calls7d: 1 });
  });
});

describe("getApiKeysStatus queries", () => {
  it("lists the newest 50 keys", async () => {
    await getApiKeysStatus();
    const [s] = statesOf("api_keys");
    expect(String(s?.selectArgs[0])).toBe("id, label, tier, created_at, revoked_at, last_used_at");
    expect(s?.order).toEqual([{ col: "created_at", opts: { ascending: false } }]);
    expect(s?.limit).toBe(50);
  });

  it("scopes usage to the listed key ids, a 7-UTC-day window starting 2026-10-27, and 350 rows", async () => {
    fx.keys = { data: [keyRow(1), keyRow("2"), keyRow(3)], error: null };
    await getApiKeysStatus();
    const [s] = statesOf("api_key_usage_daily");
    expect(s?.gte).toEqual([{ col: "day", val: "2026-10-27" }]);
    expect(s?.in).toEqual([{ col: "key_id", vals: [1, 2, 3] }]);
    expect(s?.limit).toBe(350);
  });
});
