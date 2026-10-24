import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Harness mirrors src/lib/clusters/blindspots-query.test.ts's shared-fake
// wiring (createSupabaseFake + the "use cache" next/cache mocks), plus a
// thin call-tracking proxy layered on top of the fake's builder. The shared
// fake's `BuilderState.limit` only records the row-cap argument, not the
// `{ referencedTable }` options object — so the query-shape test below
// wraps `from()`'s return value to record every method call (name + raw
// args) and asserts on that instead of on `BuilderState`.
//
// 2026-10-24 /sources '—' incident: a failed read used to be cached for the
// full 1 h `source-directory` life (cacheLife ran before the query), hiding
// the footer chip for an hour. The "cache lifetime" block pins the fix.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  data: [] as unknown[],
  error: null as { message: string } | null,
  lastState: null as unknown,
  // a query that throws (client blew up) instead of answering with an error
  throwOnQuery: false,
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
        if (fixture.throwOnQuery) throw new Error("connection reset");
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

import { cacheLife, cacheTag } from "next/cache";
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
  fixture.throwOnQuery = false;
  tracker.calls.length = 0;
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
  // attemptCached logs every failed attempt with console.error
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
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

// ---------------------------------------------------------------------------
// Cache lifetime: `cacheLife` is chosen AFTER the query ran. A failed read is
// memoised for `minutes`, a success (even zero delivering sources) for the
// `source-directory` window. `null` stays the "unknown" contract: the footer
// hides the chip rather than showing a wrong number.
// ---------------------------------------------------------------------------

describe("getDeliveringSourceCount cache lifetime", () => {
  it("a Supabase error resolves null and is cached for minutes only (exactly one cacheLife)", async () => {
    fixture.error = { message: "canceling statement due to statement timeout" };

    await expect(getDeliveringSourceCount()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("source-directory");
  });

  it("a thrown query resolves null and is cached for minutes only (exactly one cacheLife)", async () => {
    fixture.throwOnQuery = true;

    await expect(getDeliveringSourceCount()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("source-directory");
  });

  it("missing Supabase env resolves null and is cached for minutes only", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    await expect(getDeliveringSourceCount()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("logs a failed attempt once through attemptCached ('[label] error: ...')", async () => {
    fixture.error = { message: "connection refused" };

    await getDeliveringSourceCount();

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls[0]![0]).toMatch(
      /^\[[a-z-]+\] error: .*connection refused/,
    );
  });

  it("success returns the count and is cached for source-directory, once", async () => {
    fixture.data = [
      { id: "s1", recent: [{ id: "a1" }] },
      { id: "s2", recent: [] },
    ];

    await expect(getDeliveringSourceCount()).resolves.toBe(1);

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("source-directory");
    expect(cacheLife).not.toHaveBeenCalledWith("minutes");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("an empty successful read returns 0 (not null) and keeps source-directory", async () => {
    fixture.data = [];

    await expect(getDeliveringSourceCount()).resolves.toBe(0);

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("source-directory");
  });

  it("tags the entry 'sources' before cacheLife runs (cacheTag precedes cacheLife), on success and failure", async () => {
    await getDeliveringSourceCount();
    expect(cacheTag).toHaveBeenCalledWith("sources");
    expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
    );

    vi.mocked(cacheTag).mockClear();
    vi.mocked(cacheLife).mockClear();
    fixture.error = { message: "boom" };
    await getDeliveringSourceCount();
    expect(cacheTag).toHaveBeenCalledWith("sources");
    expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
    );
  });
});
