import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// P-07 (/hafta). Mirrors src/lib/quality/snapshots.test.ts: the shared
// chainable Supabase fake (tests/_helpers/supabase-fake.ts) plus a mocked
// next/cache so the "use cache" directive's cacheLife/cacheTag calls don't
// throw outside a real Next.js request scope.
//
// The two fetchers are pinned against the fake's recorded builder state
// (table / select string / eq / gte / lte / order / limit) because the
// weekly page's honesty depends on the exact window: a dropped `.gte()` on
// first_published silently turns "the trailing 7 days" into "all time".
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  clusters: [] as unknown[],
  clustersError: null as { message: string } | null,
  clustersThrows: false,
  history: [] as unknown[],
  historyError: null as { message: string } | null,
  clusterState: null as unknown,
  historyState: null as unknown,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state) => {
        fixture.clusterState = state;
        if (fixture.clustersThrows) throw new Error("boom");
        if (fixture.clustersError) return { data: null, error: fixture.clustersError };
        return { data: fixture.clusters, error: null };
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
  createClient: () => supabaseFake.client,
}));

import {
  WEEK_MS,
  getWeeklyClusters,
  getWeeklyLabelChanges,
  summariseWeek,
  type WeeklyClusterRow,
} from "./weekly-query";
import type { ZoneFeedHealth, ZoneHealth } from "@/lib/clusters/feed-health";
import type { BiasCategory, BiasDistribution, MediaDnaZone } from "@/types";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.clusters = [];
  fixture.clustersError = null;
  fixture.clustersThrows = false;
  fixture.history = [];
  fixture.historyError = null;
  fixture.clusterState = null;
  fixture.historyState = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
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
  it("pins the clusters query: table, select columns, filters, order and limit", async () => {
    await getWeeklyClusters();

    const state = fixture.clusterState as BuilderState;
    expect(state.table).toBe("clusters");

    const select = String(state.selectArgs[0]);
    expect(select).toBe(
      "id, title_tr, title_tr_neutral, bias_distribution, is_blindspot, blindspot_side, article_count, first_published",
    );

    expect(state.eq).toContainEqual({ col: "is_archived", val: false });
    expect(state.gte).toContainEqual({ col: "article_count", val: 2 });
    expect(state.order).toContainEqual({
      col: "article_count",
      opts: { ascending: false },
    });
    expect(state.limit).toBe(2000);
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

  it("returns the rows Supabase gave it", async () => {
    fixture.clusters = [row({ id: "a" }), row({ id: "b" })];

    const rows = await getWeeklyClusters();

    expect(rows).toHaveLength(2);
    expect(rows?.[0]?.id).toBe("a");
  });

  it("returns [] (not null) when the window has no clusters", async () => {
    fixture.clusters = [];

    await expect(getWeeklyClusters()).resolves.toEqual([]);
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

  it("orders by article_count desc and caps at five", () => {
    const rows = [3, 9, 5, 1, 7, 6].map((n, i) =>
      row({
        id: `c${i}`,
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
      { id: "bs", title: "Nötr başlık", articleCount: 5, side: "muhalefet" },
    ]);
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

  it("orders blindspots by article_count desc and caps at five", () => {
    const rows = [2, 8, 4, 1, 9, 6, 3].map((n, i) =>
      row({
        id: `b${i}`,
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
