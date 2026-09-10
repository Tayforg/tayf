import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Harness mirrors src/lib/clusters/blindspots-query.test.ts's shared-fake
// wiring (createSupabaseFake + the "use cache" next/cache mocks), plus a
// thin call-tracking proxy layered on top of the fake's builder. The shared
// fake's `BuilderState.limit` only records the row-cap argument, not the
// `{ referencedTable }` options object — so the query-shape test below
// wraps `from()`'s return value to record every method call (name + raw
// args) and asserts on that instead of on `BuilderState`.
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

const tracker = vi.hoisted(() => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  function wrapTracking<T extends object>(obj: T): T {
    return new Proxy(obj, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls.push({ method: String(prop), args });
          const result = (value as (...a: unknown[]) => unknown).apply(
            target,
            args,
          );
          return result && typeof result === "object"
            ? wrapTracking(result as object)
            : result;
        };
      },
    });
  }
  return { calls, wrapTracking };
});

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
  createClient: () => ({
    ...supabaseFake.client,
    from: (table: string) =>
      tracker.wrapTracking(supabaseFake.client.from(table)),
  }),
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
  tracker.calls.length = 0;
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("countDeliveringSources", () => {
  it("counts only rows with a non-empty `recent` existence-probe array", () => {
    const rows = [
      { recent: [{ id: "a1" }] },
      { recent: [] as Array<{ id: string }> },
      { recent: [{ id: "a2" }] },
      { recent: [] as Array<{ id: string }> },
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
      { id: "s1", recent: [{ id: "a1" }] },
      { id: "s2", recent: [] },
      { id: "s3", recent: [{ id: "a2" }] },
      { id: "s4", recent: [] },
    ];

    await expect(getDeliveringSourceCount()).resolves.toBe(2);
  });

  it("filters on active sources, a 7-day gte window on recent.published_at, and probes with limit(1, { referencedTable: 'recent' })", async () => {
    fixture.data = [];

    await getDeliveringSourceCount();

    const state = fixture.lastState as BuilderState;
    expect(state.table).toBe("sources");
    expect(state.eq).toContainEqual({ col: "active", val: true });

    const gte = state.gte.find((g) => g.col === "recent.published_at");
    expect(gte).toBeDefined();
    const gteMs = new Date(gte!.val as string).getTime();
    const expectedMs = Date.now() - ACTIVE_SOURCE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    expect(Math.abs(gteMs - expectedMs)).toBeLessThan(1000);

    expect(tracker.calls).toContainEqual({
      method: "limit",
      args: [1, { referencedTable: "recent" }],
    });
  });

  it("returns null (never throws) on a query error, so a build-time prerender can't fail on a transient failure", async () => {
    fixture.error = { message: "canceling statement due to statement timeout" };

    await expect(getDeliveringSourceCount()).resolves.toBeNull();
  });
});
