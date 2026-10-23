import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// getRisingEntities() reads the per-entity daily rollup (migration 112)
// through the 4 s reader client, inside a "use cache" scope, and must never
// throw (a throw crossing the cache boundary fails the /trends prerender).
// Same harness as daily-zones.test.ts.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  data: [] as unknown[],
  error: null as { message: string } | null,
  lastState: null as unknown,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      trends_daily_entity_counts_ist_rollup: (state: unknown) => {
        fixture.lastState = state;
        return { data: fixture.data, error: fixture.error };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import { cacheLife, cacheTag } from "next/cache";

import { getRisingEntities } from "./rising-query";

const ORIGINAL_ENV = { ...process.env };

// 2026-10-23 09:20 UTC is 12:20 in Istanbul: the Istanbul "today" is
// 2026-10-23 and the hour bucket is 09:00 UTC.
const NOW = new Date("2026-10-23T09:20:00Z");
const TODAY = "2026-10-23";

type Row = { day: string; entity: string; count: number };

function risingFixture(): Row[] {
  const rows: Row[] = [];
  for (let off = 1; off <= 7; off++) {
    const d = new Date(Date.UTC(2026, 9, 23 - off)).toISOString().slice(0, 10);
    rows.push({ day: d, entity: "erdogan", count: 3 });
  }
  rows.push({ day: TODAY, entity: "erdogan", count: 15 });
  return rows;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.data = [];
  fixture.error = null;
  fixture.lastState = null;
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("getRisingEntities: query shape", () => {
  it("reads the rollup table with a .gte('day', today - 8) lower bound and a row limit", async () => {
    fixture.data = risingFixture();

    await getRisingEntities();

    const state = fixture.lastState as {
      table: string;
      selectArgs: unknown[];
      gte: Array<{ col: string; val: unknown }>;
      limit: number | null;
    };
    expect(state.table).toBe("trends_daily_entity_counts_ist_rollup");
    expect(state.selectArgs[0]).toBe("day, entity, count");
    expect(state.gte).toEqual([{ col: "day", val: "2026-10-15" }]);
    expect(state.limit).toBe(2000);
  });

  it("tags the cache entry 'trends' (revalidated with the rest of /trends)", async () => {
    fixture.data = risingFixture();
    await getRisingEntities();
    expect(cacheTag).toHaveBeenCalledWith("trends");
  });

  it("reads the wall clock exactly once per fetch, inside the cached scope", async () => {
    fixture.data = risingFixture();
    const spy = vi.spyOn(Date, "now");
    const before = spy.mock.calls.length;

    await getRisingEntities();

    expect(spy.mock.calls.length - before).toBe(1);
    spy.mockRestore();
  });
});

describe("getRisingEntities: results", () => {
  it("returns the ranked result for a spiking entity", async () => {
    fixture.data = risingFixture();

    const r = await getRisingEntities();

    expect(r).toMatchObject({ status: "ok", dayLabel: "Bugün", day: TODAY });
    if (r?.status !== "ok") throw new Error("expected ok");
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ key: "erdogan", count: 15, ratioLabel: "5,0" });
  });

  it("passes an 'insufficient' answer through (not null: the table answered)", async () => {
    fixture.data = [
      { day: "2026-10-22", entity: "erdogan", count: 3 },
      { day: "2026-10-21", entity: "erdogan", count: 3 },
      { day: TODAY, entity: "erdogan", count: 40 },
    ];

    await expect(getRisingEntities()).resolves.toEqual({ status: "insufficient" });
  });

  it("anchors 'today' on the Istanbul day, not the UTC day", async () => {
    // 22:30 UTC on the 22nd is already the 23rd in Istanbul (UTC+3).
    vi.setSystemTime(new Date("2026-10-22T22:30:00Z"));
    fixture.data = risingFixture();

    const r = await getRisingEntities();

    expect(r).toMatchObject({ status: "ok", day: TODAY });
    const state = fixture.lastState as { gte: Array<{ col: string; val: unknown }> };
    expect(state.gte[0]?.val).toBe("2026-10-15");
  });
});

describe("getRisingEntities: never throws", () => {
  it("resolves null on a Supabase error", async () => {
    fixture.error = { message: "canceling statement due to statement timeout" };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(getRisingEntities()).resolves.toBeNull();

    errSpy.mockRestore();
  });

  it("resolves null on an EMPTY result (an unpopulated rollup is not an answer)", async () => {
    fixture.data = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(getRisingEntities()).resolves.toBeNull();

    errSpy.mockRestore();
  });

  it("resolves null when Supabase env vars are missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(getRisingEntities()).resolves.toBeNull();

    errSpy.mockRestore();
  });
});

// One cacheLife call per invocation, chosen after the outcome is known; the
// literal must be a profile name ("hours" / "minutes"), never a conditional
// expression (tests/guards/cache-life-literal.test.ts).
describe("getRisingEntities: cache lifetime", () => {
  it("success: exactly one cacheLife('hours')", async () => {
    fixture.data = risingFixture();
    await getRisingEntities();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("hours");
  });

  it("insufficient (still a successful read): 'hours'", async () => {
    fixture.data = [{ day: TODAY, entity: "erdogan", count: 1 }];
    await getRisingEntities();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("hours");
  });

  it("Supabase error: exactly one cacheLife('minutes')", async () => {
    fixture.error = { message: "boom" };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await getRisingEntities();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    errSpy.mockRestore();
  });

  it("empty result: 'minutes'", async () => {
    fixture.data = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await getRisingEntities();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    errSpy.mockRestore();
  });

  it("missing env vars (a throw inside the fetch): 'minutes'", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await getRisingEntities();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    errSpy.mockRestore();
  });
});
