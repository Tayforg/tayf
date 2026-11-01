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
//
// Hunt 12 (h12-ops-2): getSourceItemsPerDay reads the set-based RPC
// public.source_items_7d() (migration 137) instead of the per-source
// stats:articles(count) embed, which timed out at 8 s about 12 times a day. The
// fake answers that RPC from `fixture.rpcRows` / `fixture.rpcError`; the legacy
// embed stays as the fallback for a database without 137 (PostgREST PGRST202),
// and the `getSourceItemsPerDay` block pins both paths and the contract.
//
// 2026-10-24 /sources '—' incident: a failed read used to be cached for the
// full 1 h `source-directory` life because `cacheLife` ran before the query.
// The "cache lifetime" block pins the fix for all three readers: a failure
// (a Supabase error OR a thrown query) is cached for `minutes` only, a
// success (even an empty one) for `source-directory`, exactly one cacheLife
// per invocation, cacheTag first.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  data: [] as unknown[],
  error: null as { message: string } | null,
  lastState: null as unknown,
  // migration 119: every sources select string, in call order, and a switch that
  // answers a select naming fetch_items_count with Postgres 42703 (column missing)
  selects: [] as string[],
  failNewColumns: false,
  retryError: null as { message: string; code?: string } | null,
  // a query that throws (client blew up) instead of answering with an error
  throwOnQuery: false,
  // migration 137: rows / error of rpc('source_items_7d')
  rpcRows: [] as unknown,
  rpcError: null as { message: string; code?: string } | null,
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
    rpc: {
      source_items_7d: () => {
        if (fixture.throwOnQuery) throw new Error("connection reset");
        if (fixture.rpcError) return { data: null, error: fixture.rpcError };
        if (fixture.error) return { data: null, error: fixture.error };
        return { data: fixture.rpcRows, error: null };
      },
    },
    tables: {
      sources: (state: unknown) => {
        fixture.lastState = state;
        const select = String(
          (state as { selectArgs?: unknown[] }).selectArgs?.[0] ?? "",
        );
        fixture.selects.push(select);
        if (fixture.throwOnQuery) throw new Error("connection reset");
        if (fixture.failNewColumns && select.includes("fetch_items_count")) {
          return {
            data: null,
            error: {
              message: "column sources.fetch_items_count does not exist",
              code: "42703",
            },
          };
        }
        if (fixture.failNewColumns && fixture.retryError) {
          return { data: null, error: fixture.retryError };
        }
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
  toItemsPerDayMapFromRpc,
  summariseFeedStatus,
  getSourceFeedStatuses,
  getSourceItemsPerDay,
  getFeedStatusSummary,
  type SourceFeedStatusRawRow,
  type SourceFeedStatus,
  type ItemsPerDayRawRow,
  type ItemsPerDayRpcRow,
} from "./feed-status";
import { cacheLife, cacheTag } from "next/cache";
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
  fixture.selects = [];
  fixture.failNewColumns = false;
  fixture.retryError = null;
  fixture.throwOnQuery = false;
  fixture.rpcRows = [];
  fixture.rpcError = null;
  supabaseFake.calls.rpc.length = 0;
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

describe("toFeedStatusRows quarantine [migration 074]", () => {
  it("marks a row quarantined when fetch_quarantined_until is in the future", () => {
    const [row] = toFeedStatusRows(
      [
        rawRow({
          fetch_fail_streak: 20,
          fetch_quarantined_until: new Date(NOW + 60 * 60 * 1000).toISOString(),
        }),
      ],
      NOW,
    );
    expect(row!.quarantined).toBe(true);
    expect(row!.failStreak).toBe(20);
  });

  it("marks a row not quarantined when fetch_quarantined_until is in the past (expired)", () => {
    const [row] = toFeedStatusRows(
      [
        rawRow({
          fetch_fail_streak: 20,
          fetch_quarantined_until: new Date(NOW - 60 * 1000).toISOString(),
        }),
      ],
      NOW,
    );
    expect(row!.quarantined).toBe(false);
  });

  it("defaults failStreak to 0 and quarantined to false when the columns are absent", () => {
    const [row] = toFeedStatusRows([rawRow({ fetch_fail_streak: undefined, fetch_quarantined_until: undefined })], NOW);
    expect(row!.failStreak).toBe(0);
    expect(row!.quarantined).toBe(false);
  });
});

describe("toFeedStatusRows silenceReason [migration 119]", () => {
  const HOUR = 60 * 60 * 1000;
  // A source that delivered nothing for 4 days: silent in every case below.
  const silentLatest = [{ published_at: new Date(NOW - 96 * HOUR).toISOString() }];
  const reasonOf = (overrides: Partial<SourceFeedStatusRawRow>) => {
    const [row] = toFeedStatusRows([rawRow({ latest: silentLatest, ...overrides })], NOW);
    expect(row!.silent).toBe(true);
    return row!.silenceReason;
  };

  it("is null for a source that delivered in the last 72 h, even if its feed looks frozen", () => {
    const [row] = toFeedStatusRows(
      [rawRow({ fetch_items_count: 0, fetch_newest_item_at: null })],
      NOW,
    );
    expect(row!.silent).toBe(false);
    expect(row!.silenceReason).toBeNull();
  });

  it("a feed that answers 200 but whose newest item is 100 h old is akis_donmus", () => {
    expect(
      reasonOf({
        fetch_last_status: 200,
        fetch_items_count: 12,
        fetch_newest_item_at: new Date(NOW - 100 * HOUR).toISOString(),
      }),
    ).toBe("akis_donmus");
  });

  it("a feed that answers 200 whose newest item is only 30 h old (a paused outlet) is sessiz", () => {
    expect(
      reasonOf({
        fetch_last_status: 200,
        fetch_items_count: 12,
        fetch_newest_item_at: new Date(NOW - 30 * HOUR).toISOString(),
      }),
    ).toBe("sessiz");
  });

  it("an empty feed (count 0) is akis_donmus", () => {
    expect(reasonOf({ fetch_items_count: 0, fetch_newest_item_at: null })).toBe("akis_donmus");
  });

  it("a blocked feed (403, 0, 500) or an unknown status is erisim_yok, even with a stale newest item", () => {
    const stale = new Date(NOW - 30 * HOUR).toISOString();
    for (const status of [403, 404, 500, 0]) {
      expect(reasonOf({ fetch_last_status: status, fetch_items_count: 12, fetch_newest_item_at: stale }), String(status)).toBe(
        "erisim_yok",
      );
    }
    expect(reasonOf({ fetch_last_status: null })).toBe("erisim_yok");
  });

  it("a quarantined source and a source with a fail streak are erisim_yok", () => {
    expect(
      reasonOf({ fetch_fail_streak: 21, fetch_quarantined_until: new Date(NOW + HOUR).toISOString() }),
    ).toBe("erisim_yok");
    expect(reasonOf({ fetch_last_status: 200, fetch_fail_streak: 2 })).toBe("erisim_yok");
  });

  it("an expired quarantine with a zero streak does not make it erisim_yok", () => {
    expect(
      reasonOf({
        fetch_fail_streak: 0,
        fetch_quarantined_until: new Date(NOW - HOUR).toISOString(),
        fetch_items_count: 10,
        fetch_newest_item_at: new Date(NOW - HOUR).toISOString(),
      }),
    ).toBe("sessiz");
  });

  it("304 counts as reachable: a current feed is sessiz", () => {
    expect(
      reasonOf({
        fetch_last_status: 304,
        fetch_items_count: 10,
        fetch_newest_item_at: new Date(NOW - HOUR).toISOString(),
      }),
    ).toBe("sessiz");
  });

  it("a source never measured (columns null or absent) and reachable is sessiz", () => {
    expect(reasonOf({ fetch_items_count: null, fetch_newest_item_at: null })).toBe("sessiz");
    expect(reasonOf({})).toBe("sessiz");
  });

  it("an undated feed (count > 0, newest null) is sessiz, not frozen", () => {
    expect(reasonOf({ fetch_items_count: 8, fetch_newest_item_at: null })).toBe("sessiz");
  });

  it("exactly 72 h is not frozen, 72 h + 1 ms is", () => {
    expect(
      reasonOf({ fetch_items_count: 8, fetch_newest_item_at: new Date(NOW - 72 * HOUR).toISOString() }),
    ).toBe("sessiz");
    expect(
      reasonOf({ fetch_items_count: 8, fetch_newest_item_at: new Date(NOW - 72 * HOUR - 1).toISOString() }),
    ).toBe("akis_donmus");
  });

  it("never exposes the raw timestamps or the count on the shaped row", () => {
    const [row] = toFeedStatusRows(
      [rawRow({ latest: silentLatest, fetch_items_count: 8, fetch_newest_item_at: new Date(NOW - 30 * HOUR).toISOString() })],
      NOW,
    );
    expect(Object.keys(row!)).not.toContain("fetch_newest_item_at");
    expect(Object.keys(row!)).not.toContain("fetch_items_count");
    expect(JSON.stringify(row)).not.toContain(new Date(NOW - 30 * HOUR).toISOString());
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

describe("toItemsPerDayMapFromRpc", () => {
  it("maps rows [{slug, items}] to slug -> items / 7 rounded to one decimal", () => {
    expect(
      toItemsPerDayMapFromRpc([
        { slug: "a", items: 70 },
        { slug: "b", items: 0 },
      ]),
    ).toEqual({ a: 10, b: 0 });
    expect(toItemsPerDayMapFromRpc([{ slug: "c", items: 5 }])["c"]).toBeCloseTo(0.7, 5);
    expect(toItemsPerDayMapFromRpc([{ slug: "d", items: 10 }])["d"]).toBe(1.4);
  });

  it("treats a non-finite, negative or non-numeric items value as 0 and never throws", () => {
    const rows = [
      { slug: "nan", items: Number.NaN },
      { slug: "inf", items: Number.POSITIVE_INFINITY },
      { slug: "neg", items: -7 },
      { slug: "nul", items: null },
      { slug: "str", items: "70" },
      { slug: "ok", items: 14 },
    ] as unknown as ItemsPerDayRpcRow[];
    expect(() => toItemsPerDayMapFromRpc(rows)).not.toThrow();
    expect(toItemsPerDayMapFromRpc(rows)).toEqual({ nan: 0, inf: 0, neg: 0, nul: 0, str: 0, ok: 2 });
  });

  it("returns an empty map for no rows", () => {
    expect(toItemsPerDayMapFromRpc([])).toEqual({});
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

  it("migration 074: selects fetch_fail_streak and fetch_quarantined_until", async () => {
    await getSourceFeedStatuses();
    const state = fixture.lastState as BuilderState;
    const select = String(state.selectArgs[0] ?? "");
    expect(select).toContain("fetch_fail_streak");
    expect(select).toContain("fetch_quarantined_until");
  });

  it("migration 119: selects fetch_newest_item_at and fetch_items_count", async () => {
    await getSourceFeedStatuses();
    expect(fixture.selects).toHaveLength(1);
    expect(fixture.selects[0]).toContain("fetch_newest_item_at");
    expect(fixture.selects[0]).toContain("fetch_items_count");
  });

  it("migration 119: maps the reasons end-to-end through the fake Supabase client", async () => {
    fixture.data = [
      rawRow({
        slug: "donmus",
        name: "Donmuş",
        latest: [{ published_at: new Date(Date.now() - 96 * 3_600_000).toISOString() }],
        fetch_items_count: 5,
        fetch_newest_item_at: new Date(Date.now() - 80 * 3_600_000).toISOString(),
        fetch_last_at: new Date().toISOString(),
      }),
      rawRow({
        slug: "engelli",
        name: "Engelli",
        latest: [{ published_at: new Date(Date.now() - 96 * 3_600_000).toISOString() }],
        fetch_last_status: 403,
      }),
    ];
    const rows = await getSourceFeedStatuses();
    expect(rows!.map((r) => [r.slug, r.silenceReason])).toEqual([
      ["donmus", "akis_donmus"],
      ["engelli", "erisim_yok"],
    ]);
  });

  it("migration 119: on Postgres 42703 (column missing) it retries ONCE with the legacy select and still returns rows", async () => {
    fixture.failNewColumns = true;
    fixture.data = [rawRow()];

    const rows = await getSourceFeedStatuses();

    expect(rows).not.toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows![0]!.slug).toBe("ornek-kaynak");
    expect(fixture.selects).toHaveLength(2);
    expect(fixture.selects[0]).toContain("fetch_items_count");
    expect(fixture.selects[1]).not.toContain("fetch_items_count");
    expect(fixture.selects[1]).not.toContain("fetch_newest_item_at");
    // the legacy select is the one that ran before 119, query shape intact
    expect(fixture.selects[1]).toContain("fetch_quarantined_until");
    expect(fixture.selects[1]).toContain("latest:articles(published_at)");
    // the retry keeps the whole query shape (active filter, upper bound, ordering)
    const state = fixture.lastState as BuilderState;
    expect(state.eq).toContainEqual({ col: "active", val: true });
    expect(state.lte.find((l) => l.col === "latest.published_at")).toBeDefined();
  });

  it("migration 119: the legacy rows of a 42703 fallback classify as sessiz when silent", async () => {
    fixture.failNewColumns = true;
    fixture.data = [rawRow({ latest: [{ published_at: new Date(Date.now() - 96 * 3_600_000).toISOString() }] })];
    const rows = await getSourceFeedStatuses();
    expect(rows![0]!.silent).toBe(true);
    expect(rows![0]!.silenceReason).toBe("sessiz");
  });

  it("migration 119: any other error does not retry and resolves to null", async () => {
    fixture.error = { message: "canceling statement due to statement timeout" };
    await expect(getSourceFeedStatuses()).resolves.toBeNull();
    expect(fixture.selects).toHaveLength(1);
  });

  it("migration 119: an error on the retry resolves to null too (never throws)", async () => {
    fixture.failNewColumns = true;
    fixture.retryError = { message: "canceling statement due to statement timeout", code: "57014" };
    await expect(getSourceFeedStatuses()).resolves.toBeNull();
    expect(fixture.selects).toHaveLength(2);
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
  it("calls rpc('source_items_7d') once with no arguments and never selects stats:articles(count)", async () => {
    fixture.rpcRows = [{ slug: "ornek-kaynak", items: 7 }];

    await getSourceItemsPerDay();

    expect(supabaseFake.calls.rpc).toHaveLength(1);
    expect(supabaseFake.calls.rpc[0]!.name).toBe("source_items_7d");
    expect(supabaseFake.calls.rpc[0]!.args).toBeUndefined();
    // the set-based RPC replaces the per-source embed entirely
    expect(fixture.selects).toEqual([]);
    expect(fixture.lastState).toBeNull();
  });

  it("resolves to a slug -> itemsPerDay map end-to-end through the fake Supabase client", async () => {
    fixture.rpcRows = [
      { slug: "a", items: 70 },
      { slug: "b", items: 0 },
    ];

    await expect(getSourceItemsPerDay()).resolves.toEqual({ a: 10, b: 0 });
  });

  it("an empty RPC answer (no active source) is an empty map, not null", async () => {
    fixture.rpcRows = [];
    await expect(getSourceItemsPerDay()).resolves.toEqual({});
    fixture.rpcRows = null;
    await expect(getSourceItemsPerDay()).resolves.toEqual({});
  });

  it("returns null (never throws) on an RPC error, and does not fall back to the embed", async () => {
    fixture.rpcError = { message: "canceling statement due to statement timeout", code: "57014" };

    await expect(getSourceItemsPerDay()).resolves.toBeNull();
    expect(supabaseFake.calls.rpc).toHaveLength(1);
    expect(fixture.selects).toEqual([]);
  });

  it("returns null on an error without a code, and when the RPC call throws", async () => {
    fixture.error = { message: "canceling statement due to statement timeout" };
    await expect(getSourceItemsPerDay()).resolves.toBeNull();
    expect(fixture.selects).toEqual([]);

    fixture.error = null;
    fixture.throwOnQuery = true;
    await expect(getSourceItemsPerDay()).resolves.toBeNull();
  });

  describe("PGRST202 (migration 137 not applied yet): legacy embed fallback", () => {
    const missing = {
      message: "Could not find the function public.source_items_7d without parameters in the schema cache",
      code: "PGRST202",
    };

    it("falls back to the stats:articles(count) embed with the 7-day gte and maps its rows", async () => {
      fixture.rpcError = missing;
      fixture.data = [{ slug: "ornek-kaynak", stats: [{ count: 7 }] }];

      const map = await getSourceItemsPerDay();

      expect(map).toEqual({ "ornek-kaynak": 1 });
      expect(supabaseFake.calls.rpc).toHaveLength(1);
      expect(fixture.selects).toEqual(["slug, stats:articles(count)"]);
      const state = fixture.lastState as BuilderState;
      expect(state.table).toBe("sources");
      expect(state.eq).toContainEqual({ col: "active", val: true });
      const gte = state.gte.find((g) => g.col === "stats.published_at");
      expect(gte).toBeDefined();
      const ageMs = Date.now() - new Date(gte!.val as string).getTime();
      expect(ageMs).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000 - 1000);
      expect(ageMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 5000);
    });

    it("an error on the fallback resolves null (never throws) after exactly one embed query", async () => {
      fixture.rpcError = missing;
      fixture.error = { message: "canceling statement due to statement timeout" };

      await expect(getSourceItemsPerDay()).resolves.toBeNull();
      expect(fixture.selects).toEqual(["slug, stats:articles(count)"]);
      expect(supabaseFake.calls.rpc).toHaveLength(1);
    });

    it("the fallback is cached for source-directory on success and minutes on failure (one cacheLife each)", async () => {
      fixture.rpcError = missing;
      fixture.data = [{ slug: "x", stats: [{ count: 1 }] }];
      await getSourceItemsPerDay();
      expect(cacheLife).toHaveBeenCalledTimes(1);
      expect(cacheLife).toHaveBeenCalledWith("source-directory");

      vi.mocked(cacheLife).mockClear();
      fixture.error = { message: "boom" };
      await getSourceItemsPerDay();
      expect(cacheLife).toHaveBeenCalledTimes(1);
      expect(cacheLife).toHaveBeenCalledWith("minutes");
    });
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

// ---------------------------------------------------------------------------
// Cache lifetime (2026-10-24 /sources '—' incident). The three readers are
// `"use cache"` functions; `cacheLife` must be chosen AFTER the query ran, so a
// failed read is memoised for `minutes` and not the 1 h `source-directory`
// window. `null` stays the "unknown" contract for every caller.
// ---------------------------------------------------------------------------

interface ReaderCase {
  name: string;
  call: () => Promise<unknown>;
  /** Rows of the reader's own read: sources table rows, or rpc rows when `viaRpc`. */
  viaRpc?: boolean;
  okRows: unknown[];
  okResult: unknown;
  emptyResult: unknown;
}

const READERS: ReaderCase[] = [
  {
    name: "getSourceFeedStatuses",
    call: getSourceFeedStatuses,
    okRows: [rawRow()],
    okResult: expect.arrayContaining([expect.objectContaining({ slug: "ornek-kaynak" })]),
    emptyResult: [],
  },
  {
    name: "getSourceItemsPerDay",
    call: getSourceItemsPerDay,
    viaRpc: true,
    okRows: [{ slug: "ornek-kaynak", items: 7 }],
    okResult: { "ornek-kaynak": 1 },
    emptyResult: {},
  },
  {
    name: "getFeedStatusSummary",
    call: getFeedStatusSummary,
    okRows: [{ kind: "outlet", recent: [{ id: "r1" }] }],
    okResult: { total: 1, delivering: 1 },
    emptyResult: { total: 0, delivering: 0 },
  },
];

describe.each(READERS)("$name cache lifetime", ({ call, okRows, okResult, emptyResult, viaRpc }) => {
  const seed = (rows: unknown[]) => {
    if (viaRpc) fixture.rpcRows = rows;
    else fixture.data = rows;
  };

  it("a Supabase error resolves null and is cached for minutes only (exactly one cacheLife)", async () => {
    fixture.error = { message: "canceling statement due to statement timeout" };

    await expect(call()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("source-directory");
  });

  it("a thrown query resolves null and is cached for minutes only (exactly one cacheLife)", async () => {
    fixture.throwOnQuery = true;

    await expect(call()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("source-directory");
  });

  it("missing Supabase env resolves null and is cached for minutes only", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    await expect(call()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("logs a failed attempt once through attemptCached ('[label] error: ...')", async () => {
    fixture.error = { message: "connection refused" };

    await call();

    expect(console.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls[0]![0]).toMatch(
      /^\[[a-z-]+\] error: .*connection refused/,
    );
  });

  it("success returns the data and is cached for source-directory, once", async () => {
    seed(okRows);

    await expect(call()).resolves.toEqual(okResult);

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("source-directory");
    expect(cacheLife).not.toHaveBeenCalledWith("minutes");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("an empty successful read returns the empty value (not null) and keeps source-directory", async () => {
    seed([]);

    await expect(call()).resolves.toEqual(emptyResult);

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("source-directory");
  });

  it("tags the entry 'sources' before cacheLife runs (cacheTag precedes cacheLife), on success and failure", async () => {
    seed(okRows);
    await call();
    expect(cacheTag).toHaveBeenCalledWith("sources");
    expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
    );

    vi.mocked(cacheTag).mockClear();
    vi.mocked(cacheLife).mockClear();
    fixture.error = { message: "boom" };
    await call();
    expect(cacheTag).toHaveBeenCalledWith("sources");
    expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
    );
  });
});

describe("getSourceFeedStatuses cache lifetime with the 42703 legacy retry [migration 119]", () => {
  it("42703 then success: rows, exactly two queries, cached for source-directory once", async () => {
    fixture.failNewColumns = true;
    fixture.data = [rawRow()];

    const rows = await getSourceFeedStatuses();

    expect(rows).toHaveLength(1);
    expect(fixture.selects).toHaveLength(2);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("source-directory");
    expect(cacheLife).not.toHaveBeenCalledWith("minutes");
  });

  it("42703 then a second error: null, still exactly two queries (never a loop), cached for minutes once", async () => {
    fixture.failNewColumns = true;
    fixture.retryError = { message: "canceling statement due to statement timeout", code: "57014" };

    await expect(getSourceFeedStatuses()).resolves.toBeNull();

    expect(fixture.selects).toHaveLength(2);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("source-directory");
  });

  it("42703 then a second 42703: null after two queries, cached for minutes (the legacy select is never retried)", async () => {
    fixture.failNewColumns = true;
    fixture.retryError = { message: "column sources.fetch_fail_streak does not exist", code: "42703" };

    await expect(getSourceFeedStatuses()).resolves.toBeNull();

    expect(fixture.selects).toHaveLength(2);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("a non-42703 first error does not retry and is cached for minutes", async () => {
    fixture.error = { message: "canceling statement due to statement timeout" };

    await expect(getSourceFeedStatuses()).resolves.toBeNull();

    expect(fixture.selects).toHaveLength(1);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });
});
