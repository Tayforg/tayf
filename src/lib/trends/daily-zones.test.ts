import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// New module for /trends: buckets by the Europe/Istanbul calendar day of
// least(published_at, created_at), reading the new voting-kinds-only view
// (trends_daily_zone_counts_ist, migration 087) instead of the old UTC-day,
// all-kinds view (trends_daily_bias_counts, migration 023, owned by
// src/lib/clusters/trends-query.ts -- untouched by this file).
//
// fetchIstanbulTimeline THROWS inside the cached inner fetcher on error or
// on an EMPTY result (the harness rule: a "use cache" function must not
// cache an empty/absent answer as if it were real), and the exported
// wrapper catches, returning null -- mirrors trends-query.ts's discipline.
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
      trends_daily_zone_counts_ist: (state: unknown) => {
        fixture.lastState = state;
        return { data: fixture.data, error: fixture.error };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import {
  istanbulDayKey,
  bucketIstanbulDays,
  fetchIstanbulTimeline,
  hourBucketStart,
  WINDOW_DAYS,
  TRENDS_TIME_ZONE,
} from "./daily-zones";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.data = [];
  fixture.error = null;
  fixture.lastState = null;
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("TRENDS_TIME_ZONE / WINDOW_DAYS", () => {
  it("is Europe/Istanbul over a 30-day window", () => {
    expect(TRENDS_TIME_ZONE).toBe("Europe/Istanbul");
    expect(WINDOW_DAYS).toBe(30);
  });
});

describe("istanbulDayKey", () => {
  it("rolls 22:30 UTC forward into the next Istanbul day (UTC+3)", () => {
    expect(istanbulDayKey(Date.parse("2026-09-28T22:30:00Z"))).toBe(
      "2026-09-29",
    );
  });
});

describe("bucketIstanbulDays", () => {
  const NOW_MS = Date.parse("2026-09-28T22:30:00Z");

  it("has a contiguous 30-day window anchored on the Istanbul 'today'", () => {
    const buckets = bucketIstanbulDays([], NOW_MS);

    expect(buckets).toHaveLength(30);
    expect(buckets[buckets.length - 1]!.day).toBe("2026-09-29");
    expect(buckets[0]!.day).toBe("2026-08-31");

    // Contiguous: each day is exactly one calendar day after the previous.
    const toUtcMs = (key: string) => {
      const [yy, mm, dd] = key.split("-").map(Number) as [number, number, number];
      return Date.UTC(yy, mm - 1, dd);
    };
    for (let i = 1; i < buckets.length; i++) {
      const prev = toUtcMs(buckets[i - 1]!.day);
      const cur = toUtcMs(buckets[i]!.day);
      expect(cur - prev).toBe(24 * 3600 * 1000);
    }
  });

  it("ignores rows outside the window", () => {
    const buckets = bucketIstanbulDays(
      [{ day: "2020-01-01", zone: "iktidar", count: 5 }],
      NOW_MS,
    );
    const total = buckets.reduce((acc, b) => acc + b.total, 0);
    expect(total).toBe(0);
  });

  it("folds matching rows into the right day/zone", () => {
    const buckets = bucketIstanbulDays(
      [
        { day: "2026-09-29", zone: "iktidar", count: 3 },
        { day: "2026-09-29", zone: "muhalefet", count: 2 },
      ],
      NOW_MS,
    );
    const last = buckets[buckets.length - 1]!;
    expect(last.counts).toEqual({ iktidar: 3, bagimsiz: 0, muhalefet: 2 });
    expect(last.total).toBe(5);
  });
});

describe("hourBucketStart", () => {
  it("floors an instant to the start of its UTC hour", () => {
    const ms = Date.parse("2026-09-28T22:47:31.123Z");
    expect(hourBucketStart(ms)).toBe(Date.parse("2026-09-28T22:00:00.000Z"));
  });
});

describe("fetchIstanbulTimeline", () => {
  it("queries trends_daily_zone_counts_ist with a .gte('day', cutoff)", async () => {
    fixture.data = [{ day: "2026-09-29", zone: "iktidar", count: 1 }];

    const buckets = await fetchIstanbulTimeline();

    expect(buckets).not.toBeNull();
    const state = fixture.lastState as {
      table: string;
      gte: Array<{ col: string; val: unknown }>;
    };
    expect(state.table).toBe("trends_daily_zone_counts_ist");
    expect(state.gte.some((g) => g.col === "day")).toBe(true);
  });

  it("reads the wall clock exactly once per fetch, quantized to the hour", async () => {
    fixture.data = [{ day: "2026-09-29", zone: "iktidar", count: 1 }];

    const dateNowSpy = vi.spyOn(Date, "now");
    const before = dateNowSpy.mock.calls.length;

    await fetchIstanbulTimeline();

    // One read, inside the cached fetcher (the uncached wrapper must not
    // touch the clock, or the static /trends prerender fails).
    expect(dateNowSpy.mock.calls.length - before).toBe(1);

    dateNowSpy.mockRestore();
  });

  it("returns null (never throws) on a Supabase error", async () => {
    fixture.error = { message: "boom" };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(fetchIstanbulTimeline()).resolves.toBeNull();

    errSpy.mockRestore();
  });

  it("returns null (never throws) on an EMPTY result -- a 'use cache' function must not cache an empty answer", async () => {
    fixture.data = [];
    fixture.error = null;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(fetchIstanbulTimeline()).resolves.toBeNull();

    errSpy.mockRestore();
  });

  it("returns null (never throws) when Supabase env vars are missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(fetchIstanbulTimeline()).resolves.toBeNull();

    errSpy.mockRestore();
  });
});
