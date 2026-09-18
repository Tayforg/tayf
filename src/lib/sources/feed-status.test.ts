import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Harness mirrors src/lib/sources/active-count.test.ts: next/cache mock +
// the shared chainable Supabase fake (tests/_helpers/supabase-fake.ts). Most
// of this file exercises the pure shapers (`toFeedStatusRows`,
// `toItemsPerDayMap`) and summariser (`summariseFeedStatus`) directly, with
// no Supabase involved. The `getSourceFeedStatuses` / `getSourceItemsPerDay`
// / `getFeedStatusSummary` describe blocks cover the fail-open contract and
// (A-10) the exact query shape end-to-end through the fake Supabase client.
// The query-shape assertions use the same call-tracking proxy as
// feed-health.test.ts: the shared fake's `BuilderState.limit` only records
// the row-cap argument, not the `{ referencedTable }` options object.
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
  toFeedStatusRows,
  toItemsPerDayMap,
  summariseFeedStatus,
  getSourceFeedStatuses,
  getSourceItemsPerDay,
  getFeedStatusSummary,
  type SourceFeedStatusRawRow,
  type SourceFeedStatus,
  type ItemsPerDayRawRow,
} from "./feed-status";
import { FEED_YIELD_WINDOW_MS } from "@/lib/clusters/feed-health";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };
const NOW = Date.parse("2026-09-18T12:00:00.000Z");

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

function rawRow(
  overrides: Partial<SourceFeedStatusRawRow> = {},
): SourceFeedStatusRawRow {
  return {
    slug: "ornek-kaynak",
    name: "Örnek Kaynak",
    bias: "center",
    kind: "outlet",
    fetch_last_status: 200,
    fetch_last_at: new Date(NOW - 10 * 60 * 1000).toISOString(),
    latest: [{ published_at: new Date(NOW - 60 * 60 * 1000).toISOString() }],
    ...overrides,
  };
}

describe("toFeedStatusRows", () => {
  it("marks a source silent at exactly 72h + 1ms since its last item", () => {
    const lastItemAt = new Date(
      NOW - (FEED_YIELD_WINDOW_MS + 1),
    ).toISOString();
    const [row] = toFeedStatusRows(
      [rawRow({ latest: [{ published_at: lastItemAt }] })],
      NOW,
    );
    expect(row!.silent).toBe(true);
  });

  it("keeps a source non-silent at 72h - 1ms since its last item", () => {
    const lastItemAt = new Date(
      NOW - (FEED_YIELD_WINDOW_MS - 1),
    ).toISOString();
    const [row] = toFeedStatusRows(
      [rawRow({ latest: [{ published_at: lastItemAt }] })],
      NOW,
    );
    expect(row!.silent).toBe(false);
  });

  it("marks a source with a null lastItemAt silent, regardless of nowMs", () => {
    const [row] = toFeedStatusRows([rawRow({ latest: [] })], NOW);
    expect(row!.lastItemAt).toBeNull();
    expect(row!.silent).toBe(true);
  });

  it("SEC-01: marks a future-dated lastItemAt silent (not delivering), even though it's within the 72h window", () => {
    const futureItemAt = new Date(NOW + 60 * 60 * 1000).toISOString(); // +1h
    const [row] = toFeedStatusRows(
      [rawRow({ latest: [{ published_at: futureItemAt }] })],
      NOW,
    );
    expect(row!.lastItemAt).toBe(futureItemAt);
    expect(row!.silent).toBe(true);
  });

  it("DURUM-01: a row whose only article is 45 days old still yields a non-null lastItemAt (not '—'), and silent: true", () => {
    const oldItemAt = new Date(NOW - 45 * 24 * 60 * 60 * 1000).toISOString();
    const [row] = toFeedStatusRows(
      [rawRow({ latest: [{ published_at: oldItemAt }] })],
      NOW,
    );
    expect(row!.lastItemAt).toBe(oldItemAt);
    expect(row!.silent).toBe(true);
  });

  it("never throws on a row missing the embedded `latest` array entirely", () => {
    const bareRow: SourceFeedStatusRawRow = {
      slug: "bare",
      name: "Bare Kaynak",
      bias: "center",
      kind: "outlet",
      fetch_last_status: null,
      fetch_last_at: null,
      // `latest` key intentionally absent, not just an empty array.
    };

    expect(() => toFeedStatusRows([bareRow], NOW)).not.toThrow();

    const [row] = toFeedStatusRows([bareRow], NOW);
    expect(row!.lastItemAt).toBeNull();
    expect(row!.silent).toBe(true);
    expect(row!.lastHttpStatus).toBeNull();
    expect(row!.lastFetchAt).toBeNull();
  });

  it("derives `zone` from `bias` via the shared bias -> zone map", () => {
    const [row] = toFeedStatusRows([rawRow({ bias: "opposition" })], NOW);
    expect(row!.zone).toBe("muhalefet");
  });

  it("SEC-03: drops (never throws on) a row whose bias has no zone mapping", () => {
    const unmapped = rawRow({ bias: "unmapped_bias" as SourceFeedStatusRawRow["bias"] });
    expect(() => toFeedStatusRows([unmapped], NOW)).not.toThrow();
    expect(toFeedStatusRows([unmapped], NOW)).toHaveLength(0);
  });

  it("normalizes a missing/unknown `kind` to the default voting kind", () => {
    const [row] = toFeedStatusRows(
      [rawRow({ kind: undefined })],
      NOW,
    );
    expect(row!.kind).toBe("outlet");
  });

  it("shapes every row of a multi-row input independently", () => {
    const rows = toFeedStatusRows(
      [
        rawRow({ slug: "a" }),
        rawRow({ slug: "b", latest: [] }),
      ],
      NOW,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.slug).toBe("a");
    expect(rows[1]!.slug).toBe("b");
    expect(rows[1]!.silent).toBe(true);
  });
});

describe("toItemsPerDayMap", () => {
  function statsRow(overrides: Partial<ItemsPerDayRawRow> = {}): ItemsPerDayRawRow {
    return { slug: "ornek-kaynak", stats: [{ count: 14 }], ...overrides };
  }

  it("computes itemsPerDay as stats[0].count / 7, rounded to one decimal", () => {
    const map = toItemsPerDayMap([statsRow({ stats: [{ count: 5 }] })]);
    expect(map["ornek-kaynak"]).toBeCloseTo(0.7, 5);
  });

  it("returns 0 when the 7-day count is zero", () => {
    const map = toItemsPerDayMap([statsRow({ stats: [{ count: 0 }] })]);
    expect(map["ornek-kaynak"]).toBe(0);
  });

  it("rounds a non-terminating quotient to one decimal (10/7 -> 1.4)", () => {
    const map = toItemsPerDayMap([statsRow({ stats: [{ count: 10 }] })]);
    expect(map["ornek-kaynak"]).toBe(1.4);
  });

  it("never throws on a row missing `stats` entirely, and defaults it to 0", () => {
    const bare: ItemsPerDayRawRow = { slug: "bare" };
    expect(() => toItemsPerDayMap([bare])).not.toThrow();
    expect(toItemsPerDayMap([bare])["bare"]).toBe(0);
  });

  it("keys the map by slug across multiple rows", () => {
    const map = toItemsPerDayMap([
      statsRow({ slug: "a", stats: [{ count: 7 }] }),
      statsRow({ slug: "b", stats: [{ count: 0 }] }),
    ]);
    expect(map).toEqual({ a: 1, b: 0 });
  });
});

describe("summariseFeedStatus", () => {
  function statusRow(overrides: Partial<SourceFeedStatus>): SourceFeedStatus {
    return {
      slug: "s",
      name: "S",
      bias: "center",
      zone: "bagimsiz",
      kind: "outlet",
      lastItemAt: null,
      lastHttpStatus: null,
      lastFetchAt: null,
      silent: false,
      ...overrides,
    };
  }

  it("tallies total/delivering/silent both directory-wide and per zone, on the `all` tally", () => {
    const rows: SourceFeedStatus[] = [
      statusRow({ zone: "iktidar", silent: false }),
      statusRow({ zone: "iktidar", silent: true }),
      statusRow({ zone: "muhalefet", silent: false }),
      statusRow({ zone: "bagimsiz", silent: true }),
    ];

    const { all } = summariseFeedStatus(rows);

    expect(all.total).toBe(4);
    expect(all.delivering).toBe(2);
    expect(all.silent).toBe(2);

    expect(all.byZone.iktidar).toEqual({ total: 2, delivering: 1, silent: 1 });
    expect(all.byZone.muhalefet).toEqual({ total: 1, delivering: 1, silent: 0 });
    expect(all.byZone.bagimsiz).toEqual({ total: 1, delivering: 0, silent: 1 });
  });

  it("A-H1: the `voting` tally excludes aggregator/niche rows from delivering/total", () => {
    const rows: SourceFeedStatus[] = [
      statusRow({ kind: "outlet", silent: false }),
      statusRow({ kind: "wire", silent: false }),
      statusRow({ kind: "aggregator", silent: false }),
      statusRow({ kind: "niche", silent: true }),
    ];

    const { all, voting } = summariseFeedStatus(rows);

    expect(all.total).toBe(4);
    expect(all.delivering).toBe(3);

    expect(voting.total).toBe(2);
    expect(voting.delivering).toBe(2);
    expect(voting.silent).toBe(0);
  });

  it("returns an all-zero pair (with every zone present) for an empty input", () => {
    const { all, voting } = summariseFeedStatus([]);
    const emptySummary = {
      total: 0,
      delivering: 0,
      silent: 0,
      byZone: {
        iktidar: { total: 0, delivering: 0, silent: 0 },
        bagimsiz: { total: 0, delivering: 0, silent: 0 },
        muhalefet: { total: 0, delivering: 0, silent: 0 },
      },
    };
    expect(all).toEqual(emptySummary);
    expect(voting).toEqual(emptySummary);
  });

  it("SEC-03: never throws on a hand-built row whose zone is outside the known union", () => {
    const bogus = statusRow({
      zone: "unmapped_zone" as SourceFeedStatus["zone"],
    });
    expect(() => summariseFeedStatus([bogus])).not.toThrow();
    const { all } = summariseFeedStatus([bogus]);
    // The row is dropped (its zone bucket doesn't exist), not counted.
    expect(all.total).toBe(0);
  });
});

describe("getSourceFeedStatuses", () => {
  it("resolves to the shaped rows end-to-end through the fake Supabase client", async () => {
    fixture.data = [rawRow()];

    const rows = await getSourceFeedStatuses();

    expect(rows).not.toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows![0]!.slug).toBe("ornek-kaynak");
  });

  it("filters on active sources", async () => {
    fixture.data = [];

    await getSourceFeedStatuses();

    const state = fixture.lastState as BuilderState;
    expect(state.table).toBe("sources");
    expect(state.eq).toContainEqual({ col: "active", val: true });
  });

  it("returns null (never throws) on a query error, so a 'use cache' prerender can't fail the build", async () => {
    fixture.error = { message: "canceling statement due to statement timeout" };

    await expect(getSourceFeedStatuses()).resolves.toBeNull();
  });

  it("returns an empty array (not null) when there are simply no active sources", async () => {
    fixture.data = [];

    await expect(getSourceFeedStatuses()).resolves.toEqual([]);
  });

  // ---------------------------------------------------------------------
  // A-10: pin the exact query shape, so PERF-01 (no `stats`)/DURUM-01 (no
  // `latest` lower bound)/SEC-01 (`latest` upper bound) can't silently
  // regress. Mirrors feed-health.test.ts's query-shape assertions.
  // ---------------------------------------------------------------------

  it("A-10: selects latest:articles(published_at) and never stats:articles(count)", async () => {
    await getSourceFeedStatuses();
    const state = fixture.lastState as BuilderState;
    const select = String(state.selectArgs[0] ?? "");
    expect(select).toContain("latest:articles(published_at)");
    expect(select).not.toContain("stats:articles");
  });

  it("A-10 / DURUM-01: has NO gte lower bound on latest.published_at", async () => {
    await getSourceFeedStatuses();
    const state = fixture.lastState as BuilderState;
    expect(state.gte.find((g) => g.col === "latest.published_at")).toBeUndefined();
  });

  it("A-10 / SEC-01: has an lte upper bound on latest.published_at at ~now", async () => {
    const before = Date.now();
    await getSourceFeedStatuses();
    const after = Date.now();
    const state = fixture.lastState as BuilderState;
    const lte = state.lte.find((l) => l.col === "latest.published_at");
    expect(lte).toBeDefined();
    const lteMs = new Date(lte!.val as string).getTime();
    expect(lteMs).toBeGreaterThanOrEqual(before);
    expect(lteMs).toBeLessThanOrEqual(after);
  });

  it("A-10: orders latest.published_at descending and probes with limit(1, { referencedTable: 'latest' })", async () => {
    await getSourceFeedStatuses();
    const state = fixture.lastState as BuilderState;
    expect(state.order).toContainEqual({
      col: "published_at",
      opts: { referencedTable: "latest", ascending: false },
    });
    expect(tracker.calls).toContainEqual({
      method: "limit",
      args: [1, { referencedTable: "latest" }],
    });
  });
});

describe("getSourceItemsPerDay", () => {
  it("resolves to a slug -> itemsPerDay map end-to-end through the fake Supabase client", async () => {
    fixture.data = [{ slug: "ornek-kaynak", stats: [{ count: 7 }] }];

    const map = await getSourceItemsPerDay();

    expect(map).not.toBeNull();
    expect(map!["ornek-kaynak"]).toBe(1);
  });

  it("filters on active sources and a 7-day gte on stats.published_at", async () => {
    fixture.data = [];

    await getSourceItemsPerDay();

    const state = fixture.lastState as BuilderState;
    expect(state.table).toBe("sources");
    expect(state.eq).toContainEqual({ col: "active", val: true });
    expect(state.gte.find((g) => g.col === "stats.published_at")).toBeDefined();
  });

  it("returns null (never throws) on a query error", async () => {
    fixture.error = { message: "canceling statement due to statement timeout" };

    await expect(getSourceItemsPerDay()).resolves.toBeNull();
  });
});

describe("getFeedStatusSummary", () => {
  it("resolves the voting-kind delivering/total pair end-to-end through the fake Supabase client", async () => {
    fixture.data = [
      { kind: "outlet", recent: [{ id: "r1" }] },
      { kind: "wire", recent: [] },
      { kind: "aggregator", recent: [{ id: "r2" }] },
    ];

    const summary = await getFeedStatusSummary();

    expect(summary).toEqual({ total: 2, delivering: 1 });
  });

  it("probes with the cheap recent:articles(id) existence shape, never stats:articles(count)", async () => {
    await getFeedStatusSummary();
    const state = fixture.lastState as BuilderState;
    const select = String(state.selectArgs[0] ?? "");
    expect(select).toContain("recent:articles(id)");
    expect(select).not.toContain("stats:articles");
    expect(tracker.calls).toContainEqual({
      method: "limit",
      args: [1, { referencedTable: "recent" }],
    });
  });

  it("SEC-01: bounds recent.published_at with both a 72h gte and an ~now lte", async () => {
    const before = Date.now();
    await getFeedStatusSummary();
    const after = Date.now();
    const state = fixture.lastState as BuilderState;

    const gte = state.gte.find((g) => g.col === "recent.published_at");
    expect(gte).toBeDefined();

    const lte = state.lte.find((l) => l.col === "recent.published_at");
    expect(lte).toBeDefined();
    const lteMs = new Date(lte!.val as string).getTime();
    expect(lteMs).toBeGreaterThanOrEqual(before);
    expect(lteMs).toBeLessThanOrEqual(after);
  });

  it("returns null (never throws) on a query error", async () => {
    fixture.error = { message: "connection reset" };

    await expect(getFeedStatusSummary()).resolves.toBeNull();
  });
});
