import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Harness mirrors src/lib/clusters/blindspots-query.test.ts's shared-fake
// wiring (createSupabaseFake + the "use cache" next/cache mocks).
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
      sources: (state: unknown) => {
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
  countDeliveringSources,
  getDeliveringSourceCount,
  ACTIVE_SOURCE_WINDOW_DAYS,
} from "./active-count";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

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

describe("countDeliveringSources", () => {
  it("counts only rows whose stats[0].count is > 0, defaulting missing stats to 0", () => {
    const rows = [
      { stats: [{ count: 12 }] },
      { stats: [{ count: 0 }] },
      { stats: [{ count: 3 }] },
      { stats: [] as Array<{ count: number }> },
    ];
    expect(countDeliveringSources(rows)).toBe(2);
  });

  it("returns 0 for an empty fixture", () => {
    expect(countDeliveringSources([])).toBe(0);
  });
});

describe("getDeliveringSourceCount", () => {
  it("returns the live count end-to-end through the fake Supabase client", async () => {
    fixture.data = [
      { id: "s1", stats: [{ count: 12 }] },
      { id: "s2", stats: [{ count: 0 }] },
      { id: "s3", stats: [{ count: 3 }] },
      { id: "s4", stats: [] },
    ];

    await expect(getDeliveringSourceCount()).resolves.toBe(2);
  });

  it("filters on active sources and a 7-day gte window on stats.published_at", async () => {
    fixture.data = [];

    await getDeliveringSourceCount();

    const state = fixture.lastState as BuilderState;
    expect(state.table).toBe("sources");
    expect(state.eq).toContainEqual({ col: "active", val: true });

    const gte = state.gte.find((g) => g.col === "stats.published_at");
    expect(gte).toBeDefined();
    const gteMs = new Date(gte!.val as string).getTime();
    const expectedMs = Date.now() - ACTIVE_SOURCE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    expect(Math.abs(gteMs - expectedMs)).toBeLessThan(1000);
  });

  it("throws (never swallows) on a query error, so a transient failure is not cached", async () => {
    fixture.error = { message: "connection reset" };

    await expect(getDeliveringSourceCount()).rejects.toThrow(
      /active source count/,
    );
  });
});
