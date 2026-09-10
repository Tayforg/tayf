import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// New coverage — no test file existed for blindspots-query.ts before.
// Harness mirrors search-query.test.ts's shared-fake wiring.
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
      clusters: (state: unknown) => {
        fixture.lastState = state;
        return { data: fixture.data, error: fixture.error };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

// feed-health.ts is owned by a concurrent worker in this pack — mocked here
// so this suite never depends on its real (possibly-Supabase-backed)
// implementation. Default (set in beforeEach) is "health unknown, never
// suppress" so the pre-existing query-shape test below is unaffected.
// `degradedSilentZone` is kept REAL (imported via importOriginal, mirroring
// politics-query.test.ts) — it's pure and has no Supabase dependency, and
// blindspots-query.ts's own logSuppression calls it directly.
const feedHealthMock = vi.hoisted(() => ({
  getZoneFeedHealth: vi.fn(),
  shouldSuppressBlindspot: vi.fn(),
}));

vi.mock("@/lib/clusters/feed-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clusters/feed-health")>();
  return {
    ...actual,
    getZoneFeedHealth: feedHealthMock.getZoneFeedHealth,
    shouldSuppressBlindspot: feedHealthMock.shouldSuppressBlindspot,
  };
});

import { getBlindspots } from "./blindspots-query";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";
import type { BiasCategory } from "@/types";

const ORIGINAL_ENV = { ...process.env };

// ---------------------------------------------------------------------------
// Fixture builders for the feed-health suppression tests below. Each row
// carries 5 distinct-source members of the same bias category so the live
// re-tally (zoneTallyOf) clears BLINDSPOT.minSources (5) and
// BLINDSPOT.dominantShare (0.8) with a clean 5/5 zone.
// ---------------------------------------------------------------------------

function mkMember(
  clusterId: string,
  index: number,
  bias: BiasCategory,
  overrides: { image_url?: string | null; image_allowed?: boolean } = {},
) {
  const sourceId = `${clusterId}-s${index}`;
  return {
    articles: {
      id: `${clusterId}-a${index}`,
      title: `Haber ${clusterId}-${index}`,
      url: `https://example.com/${clusterId}-${index}`,
      image_url: overrides.image_url ?? null,
      published_at: `2026-01-0${index + 1}T00:00:00.000Z`,
      source_id: sourceId,
      category: "politika",
      content_hash: null,
      sources: {
        id: sourceId,
        name: `Kaynak ${sourceId}`,
        bias,
        kind: "outlet",
        image_allowed: overrides.image_allowed,
      },
    },
  };
}

function mkBlindspotClusterRow(
  id: string,
  bias: BiasCategory,
  memberOverrides: Array<{ image_url?: string | null; image_allowed?: boolean }> = [],
) {
  return {
    id,
    title_tr: `Örnek başlık ${id}`,
    title_tr_neutral: null,
    summary_tr: "Özet",
    bias_distribution: {},
    is_blindspot: true,
    blindspot_side: bias,
    article_count: 5,
    first_published: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-05T00:00:00.000Z",
    cluster_articles: Array.from({ length: 5 }, (_, i) =>
      mkMember(id, i, bias, memberOverrides[i] ?? {}),
    ),
  };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.data = [];
  fixture.error = null;
  fixture.lastState = null;
  feedHealthMock.getZoneFeedHealth.mockReset();
  feedHealthMock.shouldSuppressBlindspot.mockReset();
  feedHealthMock.getZoneFeedHealth.mockResolvedValue(null);
  feedHealthMock.shouldSuppressBlindspot.mockReturnValue(false);
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("getBlindspots query shape", () => {
  it("excludes archived clusters and keeps the documented blindspot pre-filters", async () => {
    await getBlindspots();

    const state = fixture.lastState as BuilderState;
    expect(state.table).toBe("clusters");
    // Two boolean-flag predicates: is_blindspot (existing) + is_archived (new).
    expect(state.eq).toHaveLength(2);
    expect(state.eq).toContainEqual({ col: "is_blindspot", val: true });
    expect(state.eq).toContainEqual({ col: "is_archived", val: false });
    expect(state.gte).toEqual([{ col: "article_count", val: 3 }]);
    expect(state.lt[0]?.col).toBe("first_published");
    expect(state.order).toEqual([
      { col: "updated_at", opts: { ascending: false } },
    ]);
    expect(state.limit).toBe(200);

    // BL-13: sources embed must carry both rights flags.
    const selectArg = state.selectArgs[0] as string;
    expect(selectArg).toMatch(/sources\s*\([^)]*\bimage_allowed\b/);
    expect(selectArg).toMatch(/sources\s*\([^)]*\bexcerpt_allowed\b/);
  });
});

describe("getBlindspots BL-13 image_allowed gate", () => {
  it("nulls image_url for a member whose source has image_allowed: false, leaving an allowed member's image untouched", async () => {
    fixture.data = [
      mkBlindspotClusterRow("cluster-gate", "pro_government", [
        {
          image_url: "https://cdn.blocked.example/foto.jpg",
          image_allowed: false,
        },
        {
          image_url: "https://cdn.allowed.example/foto.jpg",
          image_allowed: true,
        },
      ]),
    ];

    const { bundles } = await getBlindspots();

    expect(bundles).toHaveLength(1);
    const byId = Object.fromEntries(
      bundles[0]!.articles.map((a) => [a.id, a]),
    );
    expect(byId["cluster-gate-a0"]?.image_url).toBeNull();
    expect(byId["cluster-gate-a1"]?.image_url).toBe(
      "https://cdn.allowed.example/foto.jpg",
    );
  });
});

describe("getBlindspots feed-health suppression", () => {
  it("fetches health once and drops a cluster whose silent pole shouldSuppressBlindspot flags, logging once", async () => {
    const health = {
      iktidar: { total: 10, healthy: 9, healthyShare: 0.9, degraded: false },
      muhalefet: { total: 10, healthy: 2, healthyShare: 0.2, degraded: true },
      bagimsiz: { total: 5, healthy: 5, healthyShare: 1, degraded: false },
    };
    feedHealthMock.getZoneFeedHealth.mockResolvedValue(health);
    // Suppress the cluster whose dominant zone is "iktidar" (silent pole
    // muhalefet is degraded above); the "muhalefet"-dominant cluster's
    // silent pole (iktidar) is healthy, so it stays.
    feedHealthMock.shouldSuppressBlindspot.mockImplementation(
      (zone: string) => zone === "iktidar",
    );

    fixture.data = [
      mkBlindspotClusterRow("cluster-suppress", "pro_government"),
      mkBlindspotClusterRow("cluster-keep", "opposition"),
    ];

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { bundles } = await getBlindspots();

      expect(bundles.map((b) => b.cluster.id)).toEqual(["cluster-keep"]);
      expect(feedHealthMock.getZoneFeedHealth).toHaveBeenCalledTimes(1);
      expect(feedHealthMock.shouldSuppressBlindspot).toHaveBeenCalledWith(
        "iktidar",
        health,
      );
      expect(feedHealthMock.shouldSuppressBlindspot).toHaveBeenCalledWith(
        "muhalefet",
        health,
      );

      const suppressionLogs = logSpy.mock.calls.filter((args) =>
        String(args[0]).includes("[feed-health] suppressed blindspot"),
      );
      expect(suppressionLogs).toHaveLength(1);
      expect(suppressionLogs[0]?.[0]).toContain(
        "suppressed blindspot for cluster cluster-suppress",
      );
      expect(suppressionLogs[0]?.[0]).toContain("muhalefet");
      expect(suppressionLogs[0]?.[0]).toContain("2/10 feeds healthy");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("names the actually-degraded pole (not a hardcoded 'iktidar') when the dominant zone is bagimsiz", async () => {
    // 5 "center" members -> zoneTallyOf's live re-tally picks "bagimsiz" as
    // the dominant zone. shouldSuppressBlindspot still fires because a pole
    // (muhalefet) is degraded — the suppression log must name THAT pole,
    // not "iktidar" by hardcoded default.
    const health = {
      iktidar: { total: 8, healthy: 8, healthyShare: 1, degraded: false },
      muhalefet: { total: 10, healthy: 2, healthyShare: 0.2, degraded: true },
      bagimsiz: { total: 5, healthy: 5, healthyShare: 1, degraded: false },
    };
    feedHealthMock.getZoneFeedHealth.mockResolvedValue(health);
    feedHealthMock.shouldSuppressBlindspot.mockImplementation(
      (zone: string) => zone === "bagimsiz",
    );

    fixture.data = [mkBlindspotClusterRow("cluster-bagimsiz", "center")];

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { bundles } = await getBlindspots();

      expect(bundles).toEqual([]);
      const suppressionLogs = logSpy.mock.calls.filter((args) =>
        String(args[0]).includes("[feed-health] suppressed blindspot"),
      );
      expect(suppressionLogs).toHaveLength(1);
      expect(suppressionLogs[0]?.[0]).toContain(
        "suppressed blindspot for cluster cluster-bagimsiz",
      );
      expect(suppressionLogs[0]?.[0]).toContain("muhalefet");
      expect(suppressionLogs[0]?.[0]).toContain("2/10 feeds healthy");
      expect(suppressionLogs[0]?.[0]).not.toContain("silent zone iktidar");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("passes every candidate through unaffected when health is null (unknown)", async () => {
    feedHealthMock.getZoneFeedHealth.mockResolvedValue(null);
    // Mirrors the real contract: shouldSuppressBlindspot is false whenever
    // health is null/undefined, regardless of zone.
    feedHealthMock.shouldSuppressBlindspot.mockImplementation(
      (_zone: string, health: unknown) => health != null,
    );

    fixture.data = [
      mkBlindspotClusterRow("cluster-a", "pro_government"),
      mkBlindspotClusterRow("cluster-b", "opposition"),
    ];

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { bundles } = await getBlindspots();

      expect(bundles.map((b) => b.cluster.id).sort()).toEqual([
        "cluster-a",
        "cluster-b",
      ]);
      expect(feedHealthMock.getZoneFeedHealth).toHaveBeenCalledTimes(1);
      const suppressionLogs = logSpy.mock.calls.filter((args) =>
        String(args[0]).includes("[feed-health] suppressed blindspot"),
      );
      expect(suppressionLogs).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  });
});
