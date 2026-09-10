import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// New coverage — fetchTimeline / bucketFromAggregates / WINDOW_DAYS were
// extracted out of src/app/trends/page.tsx into this module. Harness mirrors
// blindspots-query.test.ts / timeline-query.test.ts's shared-fake wiring.
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
      trends_daily_bias_counts: (state: unknown) => {
        fixture.lastState = state;
        return { data: fixture.data, error: fixture.error };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import { fetchTimeline, bucketFromAggregates, WINDOW_DAYS } from "./trends-query";

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

describe("bucketFromAggregates", () => {
  it("builds a gap-free 30-day window and folds matching rows into the right day/zone", () => {
    const today = new Date().toISOString().slice(0, 10);
    const buckets = bucketFromAggregates([
      { day: today, zone: "iktidar", count: 3 },
      { day: today, zone: "muhalefet", count: 2 },
    ]);

    expect(buckets).toHaveLength(WINDOW_DAYS);
    expect(buckets[buckets.length - 1]!.day).toBe(today);
    expect(buckets[buckets.length - 1]!.counts).toEqual({
      iktidar: 3,
      bagimsiz: 0,
      muhalefet: 2,
    });
    expect(buckets[buckets.length - 1]!.total).toBe(5);
    // A day with no rows still gets an all-zero bucket, not a gap.
    expect(buckets[0]!.total).toBe(0);
  });

  it("drops rows outside the window instead of throwing", () => {
    expect(() =>
      bucketFromAggregates([{ day: "1999-01-01", zone: "iktidar", count: 1 }])
    ).not.toThrow();
    const buckets = bucketFromAggregates([
      { day: "1999-01-01", zone: "iktidar", count: 1 },
    ]);
    expect(buckets.reduce((acc, b) => acc + b.total, 0)).toBe(0);
  });
});

describe("fetchTimeline", () => {
  it("happy path: resolves a 30-day bucketed series from the aggregate view", async () => {
    const today = new Date().toISOString().slice(0, 10);
    fixture.data = [
      { day: today, zone: "iktidar", count: 4 },
      { day: today, zone: "bagimsiz", count: 1 },
    ];

    const buckets = await fetchTimeline();

    expect(buckets).toHaveLength(WINDOW_DAYS);
    const totalArticles = buckets.reduce((acc, b) => acc + b.total, 0);
    expect(totalArticles).toBe(5);
  });

  it("rejects (never returns an all-zero series) on a Supabase error", async () => {
    fixture.error = { message: "canceling statement due to statement timeout" };

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(fetchTimeline()).rejects.toThrow(/\[trends\] fetchTimeline error/);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
