import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// P-07 (/hafta). Mirrors src/lib/quality/snapshots.test.ts: the shared
// chainable Supabase fake (tests/_helpers/supabase-fake.ts) plus a mocked
// next/cache so the "use cache" directive's cacheLife/cacheTag calls don't
// throw outside a real Next.js request scope.
//
// The two fetchers are pinned against the fake's recorded builder state
// (table / select string / eq / gte / lte / order / range) because the
// weekly page's honesty depends on the exact window: a dropped `.gte()` on
// first_published silently turns "the trailing 7 days" into "all time".
//
// The cluster window is PAGED (PostgREST cuts every response at 1,000 rows
// whatever `.limit()` asks for), so the clusters handler below behaves like
// PostgREST: it slices the fixture by the request's `.range(from, to)`.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  clusters: [] as unknown[],
  clustersError: null as { message: string } | null,
  /** When set, only requests whose range starts at or after this row fail. */
  clustersErrorFromRow: null as number | null,
  clustersThrows: false,
  history: [] as unknown[],
  historyError: null as { message: string } | null,
  clusterState: null as unknown,
  /** Every clusters request, in order (one entry per page). */
  clusterStates: [] as unknown[],
  historyState: null as unknown,
  /** The options object each `createClient(url, key, opts)` call received. */
  clientOpts: [] as unknown[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state) => {
        fixture.clusterState = state;
        fixture.clusterStates.push(state);
        if (fixture.clustersThrows) throw new Error("boom");
        const range = (state as { range: { from: number; to: number } | null }).range;
        if (
          fixture.clustersError &&
          (fixture.clustersErrorFromRow === null || (range?.from ?? 0) >= fixture.clustersErrorFromRow)
        ) {
          return { data: null, error: fixture.clustersError };
        }
        // Like PostgREST: rows from..to inclusive of the ordered table.
        const data = range ? fixture.clusters.slice(range.from, range.to + 1) : fixture.clusters;
        return { data, error: null };
      },
      source_zone_history: (state) => {
        fixture.historyState = state;
        if (fixture.historyError) return { data: null, error: fixture.historyError };
        return { data: fixture.history, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, opts?: unknown) => {
    fixture.clientOpts.push(opts);
    return supabaseFake.client;
  },
}));

/** A capped client is built with a custom `global.fetch`; a plain one is not. */
function isCappedClientOpts(opts: unknown): boolean {
  const g = (opts as { global?: { fetch?: unknown } } | undefined)?.global;
  return typeof g?.fetch === "function";
}

import { cacheLife, cacheTag } from "next/cache";
import {
  WEEKLY_CLUSTER_LIMIT,
  WEEK_MS,
  getWeeklyClusters,
  getWeeklyLabelChanges,
  summariseWeek,
  type WeeklyClusterRow,
} from "./weekly-query";
import { zonePercents } from "@/lib/bias/zone-summary";
import type { ZoneFeedHealth, ZoneHealth } from "@/lib/clusters/feed-health";
import type { BiasCategory, BiasDistribution, MediaDnaZone } from "@/types";
import { POSTGREST_MAX_ROWS } from "@/lib/db/paging";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.clusters = [];
  fixture.clustersError = null;
  fixture.clustersErrorFromRow = null;
  fixture.clustersThrows = false;
  fixture.history = [];
  fixture.historyError = null;
  fixture.clusterState = null;
  fixture.clusterStates = [];
  fixture.historyState = null;
  fixture.clientOpts = [];
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

// --- fixtures --------------------------------------------------------------

const ZERO_DISTRIBUTION: BiasDistribution = {
  pro_government: 0,
  gov_leaning: 0,
  state_media: 0,
  islamist_conservative: 0,
  center: 0,
  international: 0,
  pro_kurdish: 0,
  opposition_leaning: 0,
  opposition: 0,
  nationalist: 0,
};

/** Only the three unambiguous poles are used, one per zone:
 *  pro_government -> iktidar, center -> bagimsiz, opposition -> muhalefet. */
function dist(partial: Partial<Record<BiasCategory, number>>): BiasDistribution {
  return { ...ZERO_DISTRIBUTION, ...partial };
}

function row(overrides: Partial<WeeklyClusterRow> = {}): WeeklyClusterRow {
  return {
    id: "c1",
    title_tr: "Ham başlık",
    title_tr_neutral: "Nötr başlık",
    bias_distribution: dist({ pro_government: 1, center: 1 }),
    is_blindspot: false,
    blindspot_side: null,
    article_count: 2,
    first_published: "2026-09-18T09:00:00.000Z",
    ...overrides,
  };
}

/**
 * A week of `n` clusters in the order the query returns them (article_count
 * desc, then id asc). Each row's bias_distribution is derived from its index so
 * the three zone sums differ between "the first 1,000 rows" and "every row".
 */
function orderedWindow(n: number): WeeklyClusterRow[] {
  return Array.from({ length: n }, (_, i) =>
    row({
      id: `c${String(i).padStart(5, "0")}`,
      article_count: 20 - Math.floor(i / 120),
      bias_distribution: dist({
        pro_government: (i % 5) + 1,
        center: i % 3,
        opposition: i % 4,
      }),
    }),
  );
}

/** Independent of summariseWeek: pro_government -> iktidar, center -> bagimsiz, opposition -> muhalefet. */
function directZoneSum(rows: WeeklyClusterRow[]): Record<MediaDnaZone, number> {
  const sum: Record<MediaDnaZone, number> = { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
  for (const r of rows) {
    sum.iktidar += r.bias_distribution?.pro_government ?? 0;
    sum.bagimsiz += r.bias_distribution?.center ?? 0;
    sum.muhalefet += r.bias_distribution?.opposition ?? 0;
  }
  return sum;
}

function zoneHealth(overrides: Partial<ZoneHealth> = {}): ZoneHealth {
  return {
    total: 10,
    fetchOk: 9,
    fetchOkShare: 0.9,
    delivering: 8,
    deliveringShare: 0.8,
    healthy: 8,
    healthyShare: 0.8,
    degraded: false,
    ...overrides,
  };
}

function health(overrides: Partial<Record<MediaDnaZone, ZoneHealth>> = {}): ZoneFeedHealth {
  return {
    iktidar: zoneHealth({ delivering: 24, total: 36 }),
    bagimsiz: zoneHealth({ delivering: 33, total: 57 }),
    muhalefet: zoneHealth({ delivering: 15, total: 20 }),
    ...overrides,
  };
}

const DEGRADED_MUHALEFET = health({
  muhalefet: zoneHealth({ delivering: 2, total: 20, deliveringShare: 0.1, degraded: true }),
});

// --- getWeeklyClusters -----------------------------------------------------

describe("getWeeklyClusters", () => {
  it("pins the clusters query: table, select columns, filters, deterministic order and first range", async () => {
    await getWeeklyClusters();

    const state = fixture.clusterState as BuilderState;
    expect(state.table).toBe("clusters");

    const select = String(state.selectArgs[0]);
    expect(select).toBe(
      "id, title_tr, title_tr_neutral, bias_distribution, is_blindspot, blindspot_side, blindspot_recall_veto, article_count, first_published",
    );

    expect(state.eq).toContainEqual({ col: "is_archived", val: false });
    expect(state.gte).toContainEqual({ col: "article_count", val: 2 });
    // Deterministic and unique per row, so a page boundary never skips or
    // repeats a cluster inside a tier of equal article_count.
    expect(state.order).toEqual([
      { col: "article_count", opts: { ascending: false } },
      { col: "id", opts: { ascending: true } },
    ]);
    expect(state.range).toEqual({ from: 0, to: 999 });
    // `.limit()` would be clamped to 1,000 by PostgREST; paging replaces it.
    expect(state.limit).toBeNull();
  });

  it("allows up to five pages of 1,000 (WEEKLY_CLUSTER_LIMIT = 5,000)", () => {
    expect(WEEKLY_CLUSTER_LIMIT).toBe(5000);
    expect(WEEKLY_CLUSTER_LIMIT / POSTGREST_MAX_ROWS).toBe(5);
  });

  it("bounds first_published to the trailing 7 days (window, not all time)", async () => {
    const before = Date.now();
    await getWeeklyClusters();
    const after = Date.now();

    const state = fixture.clusterState as BuilderState;
    const from = state.gte.find((g) => g.col === "first_published");
    const to = state.lte.find((l) => l.col === "first_published");

    expect(from).toBeDefined();
    expect(to).toBeDefined();

    const fromMs = Date.parse(String(from!.val));
    const toMs = Date.parse(String(to!.val));

    expect(fromMs).toBeGreaterThanOrEqual(before - WEEK_MS);
    expect(fromMs).toBeLessThanOrEqual(after - WEEK_MS);
    expect(toMs).toBeGreaterThanOrEqual(before);
    expect(toMs).toBeLessThanOrEqual(after);
    expect(toMs - fromMs).toBe(WEEK_MS);
  });

  it("returns the rows Supabase gave it, not truncated", async () => {
    fixture.clusters = [row({ id: "a" }), row({ id: "b" })];

    const read = await getWeeklyClusters();

    expect(read?.rows).toHaveLength(2);
    expect(read?.rows[0]?.id).toBe("a");
    expect(read?.truncated).toBe(false);
    expect(fixture.clusterStates).toHaveLength(1);
  });

  it("returns an empty read (not null) when the window has no clusters", async () => {
    fixture.clusters = [];

    await expect(getWeeklyClusters()).resolves.toEqual({ rows: [], truncated: false });
  });

  it("reads every cluster of a 1,991-row week in two pages, in a deterministic order (the 1,000-row PostgREST cap no longer hides rows 1001-1991)", async () => {
    fixture.clusters = orderedWindow(1991);

    const read = await getWeeklyClusters();

    expect(read).not.toBeNull();
    expect(read!.rows).toHaveLength(1991);
    expect(read!.truncated).toBe(false);
    // Row identity and order survive the page boundary: nothing skipped, nothing repeated.
    expect(read!.rows.map((r) => r.id)).toEqual((fixture.clusters as WeeklyClusterRow[]).map((r) => r.id));

    const states = fixture.clusterStates as BuilderState[];
    expect(states.map((s) => s.range)).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
    ]);
    for (const s of states) {
      expect(s.order).toEqual([
        { col: "article_count", opts: { ascending: false } },
        { col: "id", opts: { ascending: true } },
      ]);
    }
    // One window for every page: a second clock read could drift the bounds.
    const bounds = (s: BuilderState) => ({
      from: s.gte.find((g) => g.col === "first_published")?.val,
      to: s.lte.find((l) => l.col === "first_published")?.val,
    });
    expect(bounds(states[1]!)).toEqual(bounds(states[0]!));
    // And one reader client for the whole paged read.
    expect(fixture.clientOpts).toHaveLength(1);
  });

  it("ACCEPTANCE: the zone totals over the paged read equal the full sum, not the top-1,000 sum", async () => {
    const window = orderedWindow(1991);
    fixture.clusters = window;

    const read = await getWeeklyClusters();
    const zoneCounts = summariseWeek(read!.rows, null).zoneCounts;

    expect(zoneCounts).toEqual(directZoneSum(window));
    expect(zoneCounts).not.toEqual(directZoneSum(window.slice(0, 1000)));
  });

  it("is truncated only when the paged read hit its own ceiling: five full pages, exactly five requests", async () => {
    fixture.clusters = orderedWindow(WEEKLY_CLUSTER_LIMIT);

    const read = await getWeeklyClusters();

    expect(read?.truncated).toBe(true);
    expect(read?.rows).toHaveLength(WEEKLY_CLUSTER_LIMIT);
    expect(fixture.clusterStates).toHaveLength(5);
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);
  });

  it("is not truncated one row short of the ceiling (4,999 rows end on a short fifth page)", async () => {
    fixture.clusters = orderedWindow(WEEKLY_CLUSTER_LIMIT - 1);

    const read = await getWeeklyClusters();

    expect(read?.truncated).toBe(false);
    expect(read?.rows).toHaveLength(WEEKLY_CLUSTER_LIMIT - 1);
    expect(fixture.clusterStates).toHaveLength(5);
  });

  it("returns null when Supabase errors, never throws", async () => {
    fixture.clustersError = { message: "relation missing" };

    await expect(getWeeklyClusters()).resolves.toBeNull();
  });

  it("returns null when the query throws, never throws", async () => {
    fixture.clustersThrows = true;

    await expect(getWeeklyClusters()).resolves.toBeNull();
  });
});

// --- read profile + cache lifetime (cold-read resilience) ------------------

const TIMEOUT_MESSAGE = "AbortError: Supabase request exceeded 4000 ms";

describe("weekly readers: capped client", () => {
  it("getWeeklyClusters builds only capped reader clients", async () => {
    await getWeeklyClusters();
    expect(fixture.clientOpts.length).toBeGreaterThanOrEqual(1);
    expect(fixture.clientOpts.every(isCappedClientOpts)).toBe(true);
  });

  it("getWeeklyLabelChanges builds only capped reader clients", async () => {
    await getWeeklyLabelChanges();
    expect(fixture.clientOpts.length).toBeGreaterThanOrEqual(1);
    expect(fixture.clientOpts.every(isCappedClientOpts)).toBe(true);
  });
});

describe("weekly readers: a failure is cached for minutes only", () => {
  it("getWeeklyClusters: success is cluster-feed, exactly once, tagged before the fetch", async () => {
    fixture.clusters = [row({ id: "a" })];

    await getWeeklyClusters();

    expect(cacheTag).toHaveBeenCalledWith("clusters-politics");
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
    expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
    );
  });

  it("getWeeklyClusters: an empty week is a successful answer (cluster-feed)", async () => {
    fixture.clusters = [];
    await expect(getWeeklyClusters()).resolves.toEqual({ rows: [], truncated: false });
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("getWeeklyClusters: a multi-page read still calls cacheLife('cluster-feed') exactly once", async () => {
    fixture.clusters = orderedWindow(1991);

    await getWeeklyClusters();

    expect(fixture.clusterStates).toHaveLength(2);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("getWeeklyClusters: an error on page 2 discards page 1, resolves null and calls cacheLife('minutes') exactly once", async () => {
    fixture.clusters = orderedWindow(1991);
    fixture.clustersError = { message: TIMEOUT_MESSAGE };
    fixture.clustersErrorFromRow = POSTGREST_MAX_ROWS;

    // No partial week: a half-read total would be a wrong number shown as the right one.
    await expect(getWeeklyClusters()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("cluster-feed");
    // The cached attempt reached page 2; the uncached live retry did too.
    expect((fixture.clusterStates as BuilderState[]).map((s) => s.range?.from)).toEqual([0, 1000, 0, 1000]);
  });

  it("getWeeklyClusters: a timeout resolves null and calls cacheLife('minutes') exactly once", async () => {
    fixture.clustersError = { message: TIMEOUT_MESSAGE };

    await expect(getWeeklyClusters()).resolves.toBeNull();

    // cached attempt (cacheLife) + live retry (uncached, no cacheLife)
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("cluster-feed");
  });

  it("getWeeklyLabelChanges: success is source-directory, exactly once", async () => {
    fixture.history = [];

    await expect(getWeeklyLabelChanges()).resolves.toEqual([]);

    expect(cacheTag).toHaveBeenCalledWith("sources");
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("source-directory");
  });

  it("getWeeklyLabelChanges: a timeout resolves null and calls cacheLife('minutes') exactly once", async () => {
    fixture.historyError = { message: TIMEOUT_MESSAGE };

    await expect(getWeeklyLabelChanges()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("source-directory");
  });
});

// --- getWeeklyLabelChanges -------------------------------------------------

describe("getWeeklyLabelChanges", () => {
  it("pins the source_zone_history query: table, select, window, order and limit", async () => {
    const before = Date.now();
    await getWeeklyLabelChanges();
    const after = Date.now();

    const state = fixture.historyState as BuilderState;
    expect(state.table).toBe("source_zone_history");
    // `!inner` + the source.active filter keep the read inside migration
    // 055's public policy, server-side and *before* the row limit.
    expect(String(state.selectArgs[0])).toBe(
      "source_slug, old_bias, new_bias, reason, changed_at, source:sources!inner ( name, active )",
    );
    expect(state.eq).toContainEqual({ col: "source.active", val: true });
    expect(state.order).toContainEqual({
      col: "changed_at",
      opts: { ascending: false },
    });
    expect(state.limit).toBe(50);

    const from = state.gte.find((g) => g.col === "changed_at");
    const to = state.lte.find((l) => l.col === "changed_at");
    expect(from).toBeDefined();
    expect(to).toBeDefined();
    const fromMs = Date.parse(String(from!.val));
    const toMs = Date.parse(String(to!.val));
    expect(fromMs).toBeGreaterThanOrEqual(before - WEEK_MS);
    expect(fromMs).toBeLessThanOrEqual(after - WEEK_MS);
    expect(toMs).toBeGreaterThanOrEqual(before);
    expect(toMs).toBeLessThanOrEqual(after);
    expect(toMs - fromMs).toBe(WEEK_MS);
  });

  it("maps a row whose source embed is an object", async () => {
    fixture.history = [
      {
        source_slug: "ornek",
        old_bias: "center",
        new_bias: "opposition",
        reason: "Sahiplik değişti",
        changed_at: "2026-09-17T10:00:00.000Z",
        source: { name: "Örnek Gazete", active: true },
      },
    ];

    const changes = await getWeeklyLabelChanges();

    expect(changes).toEqual([
      {
        slug: "ornek",
        name: "Örnek Gazete",
        oldBias: "center",
        newBias: "opposition",
        reason: "Sahiplik değişti",
        changedAt: "2026-09-17T10:00:00.000Z",
      },
    ]);
  });

  it("maps a row whose source embed is a one-element array", async () => {
    fixture.history = [
      {
        source_slug: "dizi",
        old_bias: null,
        new_bias: "pro_government",
        reason: null,
        changed_at: "2026-09-16T10:00:00.000Z",
        source: [{ name: "Dizi Haber", active: true }],
      },
    ];

    const changes = await getWeeklyLabelChanges();

    expect(changes).toHaveLength(1);
    expect(changes?.[0]?.name).toBe("Dizi Haber");
    expect(changes?.[0]?.oldBias).toBeNull();
    expect(changes?.[0]?.newBias).toBe("pro_government");
    expect(changes?.[0]?.reason).toBeNull();
  });

  it("drops a row whose source embed is missing (orphan = archival only)", async () => {
    // migration 055: a history row whose source_id was nulled by the
    // ON DELETE SET NULL is excluded from the public read policy, so it
    // must not be republished under the deleted outlet's slug.
    fixture.history = [
      {
        source_slug: "gizli-kaynak",
        old_bias: "center",
        new_bias: "opposition_leaning",
        reason: null,
        changed_at: "2026-09-15T10:00:00.000Z",
      },
    ];

    await expect(getWeeklyLabelChanges()).resolves.toEqual([]);
  });

  it("drops rows whose embedded source is inactive", async () => {
    fixture.history = [
      {
        source_slug: "kapali",
        old_bias: "center",
        new_bias: "opposition",
        reason: null,
        changed_at: "2026-09-17T10:00:00.000Z",
        source: { name: "Kapalı Gazete", active: false },
      },
      {
        source_slug: "acik",
        old_bias: "center",
        new_bias: "opposition",
        reason: null,
        changed_at: "2026-09-17T09:00:00.000Z",
        source: [{ name: "Açık Gazete", active: false }],
      },
      {
        source_slug: "yayinda",
        old_bias: "center",
        new_bias: "opposition",
        reason: null,
        changed_at: "2026-09-17T08:00:00.000Z",
        source: { name: "Yayında", active: true },
      },
    ];

    const changes = await getWeeklyLabelChanges();

    expect(changes?.map((c) => c.slug)).toEqual(["yayinda"]);
  });

  it("returns null when Supabase errors, never throws", async () => {
    fixture.historyError = { message: "permission denied" };

    await expect(getWeeklyLabelChanges()).resolves.toBeNull();
  });
});

// --- summariseWeek ---------------------------------------------------------

describe("summariseWeek — zone counts", () => {
  it("sums zoneCountsOf across every row", () => {
    const summary = summariseWeek(
      [
        row({ id: "a", bias_distribution: dist({ pro_government: 3, center: 1 }) }),
        row({ id: "b", bias_distribution: dist({ opposition: 2, center: 2 }) }),
      ],
      null,
    );

    expect(summary.zoneCounts).toEqual({ iktidar: 3, bagimsiz: 3, muhalefet: 2 });
  });

  it("treats a missing bias_distribution as no zones covered instead of throwing", () => {
    const malformed = row({ id: "broken" });
    // The column is nullable in the DB and this module casts PostgREST
    // output rather than validating it.
    (malformed as { bias_distribution: unknown }).bias_distribution = null;

    const summary = summariseWeek([malformed, row({ id: "ok" })], null);

    expect(summary.zoneCounts).toEqual({ iktidar: 1, bagimsiz: 1, muhalefet: 0 });
    expect(summary.topClusters.map((c) => c.id)).toEqual(["ok"]);
  });

  it("is all zeros for no rows and yields empty lists", () => {
    const summary = summariseWeek([], null);

    expect(summary.zoneCounts).toEqual({ iktidar: 0, bagimsiz: 0, muhalefet: 0 });
    expect(summary.topClusters).toEqual([]);
    expect(summary.blindspots).toEqual([]);
  });
});

describe("summariseWeek — topClusters", () => {
  it("keeps only clusters with at least two zones covered", () => {
    const summary = summariseWeek(
      [
        row({ id: "wide", bias_distribution: dist({ pro_government: 2, opposition: 2 }), article_count: 4 }),
        row({ id: "narrow", bias_distribution: dist({ pro_government: 9 }), article_count: 9 }),
      ],
      null,
    );

    expect(summary.topClusters.map((c) => c.id)).toEqual(["wide"]);
    expect(summary.topClusters[0]?.zonesCovered).toBe(2);
    expect(summary.topClusters[0]?.zoneCounts).toEqual({
      iktidar: 2,
      bagimsiz: 0,
      muhalefet: 2,
    });
  });

  it("collapses two clusters that are the same story under a cosmetically different title (browser-qa-15) into one topClusters row", () => {
    const rows = [
      row({
        id: "dup-a",
        title_tr_neutral: null,
        title_tr: "Mansur Yavaş CHP'den istifa etti",
        article_count: 29,
        bias_distribution: dist({ pro_government: 2, opposition: 2 }),
      }),
      row({
        id: "dup-b",
        title_tr_neutral: null,
        title_tr: "MANSUR YAVAŞ CHP’DEN İSTİFA ETTİ!",
        article_count: 26,
        bias_distribution: dist({ pro_government: 2, opposition: 2 }),
      }),
      row({
        id: "other",
        title_tr_neutral: null,
        title_tr: "Deprem yönetmeliği",
        article_count: 10,
        bias_distribution: dist({ pro_government: 2, opposition: 2 }),
      }),
    ];

    const summary = summariseWeek(rows, null);

    expect(summary.topClusters.map((c) => c.id)).toEqual(["dup-a", "other"]);
    expect(summary.topClusters.map((c) => c.articleCount)).toEqual([29, 10]);
  });

  it("still fills to WEEKLY_LIST_SIZE from the remaining rows after de-duplication", () => {
    const rows = [
      row({ id: "dup-a", title_tr_neutral: null, title_tr: "Aynı haber", article_count: 20, bias_distribution: dist({ pro_government: 2, opposition: 2 }) }),
      row({ id: "dup-b", title_tr_neutral: null, title_tr: "aynı  haber!", article_count: 18, bias_distribution: dist({ pro_government: 2, opposition: 2 }) }),
      ...["c1", "c2", "c3", "c4", "c5"].map((id, i) =>
        row({
          id,
          title_tr_neutral: null,
          title_tr: `Haber ${id}`,
          article_count: 10 - i,
          bias_distribution: dist({ pro_government: 2, opposition: 2 }),
        }),
      ),
    ];

    const summary = summariseWeek(rows, null);

    expect(summary.topClusters).toHaveLength(5);
    expect(summary.topClusters.map((c) => c.id)).toEqual([
      "dup-a",
      "c1",
      "c2",
      "c3",
      "c4",
    ]);
  });

  it("orders by article_count desc and caps at five", () => {
    const rows = [3, 9, 5, 1, 7, 6].map((n, i) =>
      row({
        id: `c${i}`,
        title_tr_neutral: null,
        title_tr: `Haber ${i}`,
        article_count: n,
        bias_distribution: dist({ pro_government: n, opposition: 1 }),
      }),
    );

    const summary = summariseWeek(rows, null);

    expect(summary.topClusters).toHaveLength(5);
    expect(summary.topClusters.map((c) => c.articleCount)).toEqual([9, 7, 6, 5, 3]);
  });

  it("prefers title_tr_neutral and falls back to title_tr", () => {
    const summary = summariseWeek(
      [
        row({ id: "n", title_tr_neutral: "Nötr", title_tr: "Ham" }),
        row({ id: "r", title_tr_neutral: null, title_tr: "Sadece ham" }),
      ],
      null,
    );

    expect(summary.topClusters.map((c) => c.title)).toEqual(["Nötr", "Sadece ham"]);
  });
});

describe("summariseWeek — blindspots", () => {
  it("derives the side from blindspot_side via zoneOf", () => {
    const summary = summariseWeek(
      [
        row({
          id: "bs",
          is_blindspot: true,
          blindspot_side: "opposition",
          bias_distribution: dist({ opposition: 5 }),
          article_count: 5,
        }),
      ],
      null,
    );

    expect(summary.blindspots).toEqual([
      { id: "bs", title: "Nötr başlık", articleCount: 5, side: "muhalefet", share: 1, sharePct: 100 },
    ]);
  });

  describe("share of the stored side (the 'Sadece' claim must be earned)", () => {
    function blindspotOf(distribution: BiasDistribution | null, side: BiasCategory | null, articleCount = 20) {
      const r = row({
        id: "bs",
        is_blindspot: true,
        blindspot_side: side,
        bias_distribution: distribution,
        article_count: articleCount,
      });
      return summariseWeek([r], null).blindspots[0];
    }

    it("15 iktidar / 1 bağımsız / 1 muhalefet: share 15/17 and the bar's own 88", () => {
      const b = blindspotOf(dist({ pro_government: 15, center: 1, opposition: 1 }), "pro_government");

      expect(b?.side).toBe("iktidar");
      expect(b?.share).toBeCloseTo(15 / 17, 10);
      expect(b?.sharePct).toBe(88);
    });

    it("every article on the stored side: share exactly 1 and 100", () => {
      const b = blindspotOf(dist({ pro_government: 6 }), "pro_government", 6);

      expect(b?.share).toBe(1);
      expect(b?.sharePct).toBe(100);
    });

    it("counts every category of the stored side's zone, against the zone total", () => {
      // gov_leaning + pro_government are both iktidar; center + opposition_leaning are the other two zones.
      const b = blindspotOf(
        dist({ gov_leaning: 7, pro_government: 8, center: 1, opposition_leaning: 1 }),
        "pro_government",
        20,
      );

      expect(b?.share).toBeCloseTo(15 / 17, 10);
      expect(b?.sharePct).toBe(88);
    });

    it("clamps a share below 1 that rounds to 100 down to 99, so only a true 100% reads 'Sadece'", () => {
      const b = blindspotOf(dist({ pro_government: 199, center: 1 }), "pro_government", 200);

      expect(b?.share).toBeCloseTo(0.995, 10);
      expect(b?.share).toBeLessThan(1);
      expect(b?.sharePct).toBe(99);
    });

    it("uses the same largest-remainder rounding as the bar (never an independent Math.round)", () => {
      // 7 : 1 is 87.5% / 12.5%. Independent Math.round prints 88 + 13 = 101; the bar prints 88 + 12.
      // The minor side discriminates: the row must say what the bar says (12), not 13.
      const counts = { iktidar: 7, bagimsiz: 1, muhalefet: 0 };
      const b = blindspotOf(dist({ pro_government: 7, center: 1 }), "center", 8);

      expect(b?.side).toBe("bagimsiz");
      expect(b?.sharePct).toBe(zonePercents(counts).bagimsiz);
      expect(b?.sharePct).toBe(12);
    });

    it("a stored side with no zone evidence at all has no share (null, null) but is still listed", () => {
      const b = blindspotOf(null, "pro_government", 3);

      expect(b).toMatchObject({ side: "iktidar", share: null, sharePct: null });
    });

    it("a side inferred from the distribution has a real share", () => {
      const b = blindspotOf(dist({ opposition: 6, center: 1 }), null, 7);

      expect(b?.side).toBe("muhalefet");
      expect(b?.share).toBeCloseTo(6 / 7, 10);
      expect(b?.sharePct).toBe(86);
    });
  });

  it("falls back to the zone with the largest count when blindspot_side is null", () => {
    const summary = summariseWeek(
      [
        row({
          id: "bs",
          is_blindspot: true,
          blindspot_side: null,
          bias_distribution: dist({ opposition: 6, center: 1 }),
          article_count: 7,
        }),
      ],
      null,
    );

    expect(summary.blindspots[0]?.side).toBe("muhalefet");
  });

  it("skips a flagged row with no side and no distribution instead of claiming iktidar", () => {
    const malformed = row({
      id: "no-evidence",
      is_blindspot: true,
      blindspot_side: null,
      article_count: 3,
    });
    (malformed as { bias_distribution: unknown }).bias_distribution = null;

    const summary = summariseWeek([malformed], null);

    expect(summary.blindspots).toEqual([]);
  });

  it("ignores rows that are not flagged as blindspots", () => {
    const summary = summariseWeek([row({ id: "plain", is_blindspot: false })], null);

    expect(summary.blindspots).toEqual([]);
  });

  it("drops blindspots suppressed by degraded feed health, keeps the rest", () => {
    const rows = [
      row({
        id: "iktidar-side",
        is_blindspot: true,
        blindspot_side: "pro_government",
        bias_distribution: dist({ pro_government: 6 }),
        article_count: 6,
      }),
      row({
        id: "muhalefet-side",
        is_blindspot: true,
        blindspot_side: "opposition",
        bias_distribution: dist({ opposition: 4 }),
        article_count: 4,
      }),
    ];

    // muhalefet degraded => an iktidar-side blindspot claim ("muhalefet
    // chose not to cover") is unverifiable and must be suppressed; the
    // muhalefet-side claim is still checkable against a healthy iktidar.
    const summary = summariseWeek(rows, DEGRADED_MUHALEFET);

    expect(summary.blindspots.map((b) => b.id)).toEqual(["muhalefet-side"]);
  });

  it("collapses two blindspot rows for the same story (browser-qa-15) into one", () => {
    const rows = [
      row({
        id: "dup-a",
        title_tr_neutral: null,
        title_tr: "İhale iptal edildi",
        is_blindspot: true,
        blindspot_side: "opposition",
        bias_distribution: dist({ opposition: 5 }),
        article_count: 9,
      }),
      row({
        id: "dup-b",
        title_tr_neutral: null,
        title_tr: "İhale İptal Edildi!",
        is_blindspot: true,
        blindspot_side: "opposition",
        bias_distribution: dist({ opposition: 5 }),
        article_count: 6,
      }),
    ];

    const summary = summariseWeek(rows, null);

    expect(summary.blindspots.map((b) => b.id)).toEqual(["dup-a"]);
  });

  it("suppresses nothing when health is null (fail open)", () => {
    const rows = [
      row({
        id: "iktidar-side",
        is_blindspot: true,
        blindspot_side: "pro_government",
        bias_distribution: dist({ pro_government: 6 }),
        article_count: 6,
      }),
    ];

    expect(summariseWeek(rows, null).blindspots).toHaveLength(1);
    expect(summariseWeek(rows, health()).blindspots).toHaveLength(1);
  });

  it("excludes a recall-vetoed blindspot (migration 071) but still counts it in topClusters", () => {
    const rows = [
      row({
        id: "vetoed",
        is_blindspot: true,
        blindspot_side: "pro_government",
        blindspot_recall_veto: true,
        // Two zones so the row qualifies for topClusters too.
        bias_distribution: dist({ pro_government: 5, center: 1 }),
        article_count: 6,
      }),
      row({
        id: "kept",
        is_blindspot: true,
        blindspot_side: "opposition",
        blindspot_recall_veto: false,
        bias_distribution: dist({ opposition: 4 }),
        article_count: 4,
      }),
    ];

    const summary = summariseWeek(rows, null);

    expect(summary.blindspots.map((b) => b.id)).toEqual(["kept"]);
    expect(summary.topClusters.map((c) => c.id)).toEqual(["vetoed"]);
  });

  it("treats a null/absent recall veto as pass-through", () => {
    const rows = [
      row({
        id: "null-veto",
        title_tr_neutral: null,
        title_tr: "Null veto haberi",
        is_blindspot: true,
        blindspot_side: "opposition",
        blindspot_recall_veto: null,
        bias_distribution: dist({ opposition: 5 }),
        article_count: 5,
      }),
      row({
        id: "absent-veto",
        title_tr_neutral: null,
        title_tr: "Absent veto haberi",
        is_blindspot: true,
        blindspot_side: "opposition",
        bias_distribution: dist({ opposition: 3 }),
        article_count: 3,
      }),
    ];

    expect(summariseWeek(rows, null).blindspots.map((b) => b.id)).toEqual([
      "null-veto",
      "absent-veto",
    ]);
  });

  it("orders blindspots by article_count desc and caps at five", () => {
    const rows = [2, 8, 4, 1, 9, 6, 3].map((n, i) =>
      row({
        id: `b${i}`,
        title_tr_neutral: null,
        title_tr: `Kör nokta haberi ${i}`,
        is_blindspot: true,
        blindspot_side: "opposition",
        bias_distribution: dist({ opposition: n }),
        article_count: n,
      }),
    );

    const summary = summariseWeek(rows, null);

    expect(summary.blindspots).toHaveLength(5);
    expect(summary.blindspots.map((b) => b.articleCount)).toEqual([9, 8, 6, 4, 3]);
  });
});
