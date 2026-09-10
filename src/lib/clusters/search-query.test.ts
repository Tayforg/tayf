import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Uses the shared proxy-based Supabase fake (tests/_helpers/supabase-fake.ts)
// per tests/api/corrections.test.ts convention, extended in this pass with
// `textSearch` support (it didn't record that predicate before).
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

// Feed-health-gated blindspot suppression (Pack C) — mirrors
// politics-query.test.ts's mock exactly: getZoneFeedHealth() is
// stubbed (its own Supabase round-trip against `sources` is covered by
// feed-health.test.ts) while shouldSuppressBlindspot/degradedSilentZone
// stay REAL via importOriginal, so these are integration tests of the
// suppression wiring inside buildClusterBundle, not just of the mock.
const feedHealth = vi.hoisted(() => ({
  getZoneFeedHealth: vi.fn(async () => null as unknown),
}));

vi.mock("./feed-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./feed-health")>();
  return {
    ...actual,
    getZoneFeedHealth: feedHealth.getZoneFeedHealth,
  };
});

// Mutable fixture the `clusters` table resolver reads on every query, plus
// the last builder state it saw — lets tests assert on the exact
// select/textSearch/filter/order/limit chain without a bespoke fake.
const fixture = vi.hoisted(() => ({
  data: [] as unknown[],
  error: null as { message: string } | null,
  throwOnQuery: false,
  lastState: null as unknown,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state: unknown) => {
        fixture.lastState = state;
        if (fixture.throwOnQuery) throw new Error("connection reset");
        return { data: fixture.error ? null : fixture.data, error: fixture.error };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import { searchClusters } from "./search-query";
import type { ZoneFeedHealth } from "./feed-health";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.data = [];
  fixture.error = null;
  fixture.throwOnQuery = false;
  fixture.lastState = null;
  feedHealth.getZoneFeedHealth.mockReset();
  feedHealth.getZoneFeedHealth.mockResolvedValue(null);
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

// ---------------------------------------------------------------------------
// Fixtures — same embedded row shape as politics-query.test.ts's mkCluster.
// ---------------------------------------------------------------------------

function mkRow(opts: {
  id: string;
  title_tr?: string;
  title_tr_neutral?: string | null;
  category?: string;
  bias_distribution?: unknown;
  is_blindspot?: boolean;
  blindspot_side?: unknown;
  members: Array<{ id: string; sourceId: string; content_hash?: string | null }>;
}) {
  return {
    id: opts.id,
    title_tr: opts.title_tr ?? `Cluster ${opts.id}`,
    title_tr_neutral: opts.title_tr_neutral ?? null,
    summary_tr: "summary",
    bias_distribution: opts.bias_distribution ?? {},
    is_blindspot: opts.is_blindspot ?? false,
    blindspot_side: opts.blindspot_side ?? null,
    article_count: opts.members.length,
    first_published: "2026-04-18T10:00:00.000Z",
    updated_at: "2026-04-18T11:00:00.000Z",
    cluster_articles: opts.members.map((m) => ({
      articles: {
        id: m.id,
        title: `Article ${m.id}`,
        url: `https://example.com/${m.id}`,
        image_url: null,
        published_at: "2026-04-18T10:30:00.000Z",
        source_id: m.sourceId,
        category: opts.category ?? "spor", // non-politika on purpose (see below)
        content_hash: m.content_hash === undefined ? `h-${m.id}` : m.content_hash,
        sources: {
          id: m.sourceId,
          name: `Source ${m.sourceId}`,
          bias: "center",
          logo_url: null,
          kind: null,
        },
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// Query shape
// ---------------------------------------------------------------------------

describe("searchClusters query shape", () => {
  it("issues a single clusters query with textSearch + the documented filters/order/limit", async () => {
    await searchClusters("İmamoğlu");

    const state = fixture.lastState as BuilderState;
    expect(state.table).toBe("clusters");

    const selectArg = state.selectArgs[0] as string;
    expect(selectArg).toMatch(/cluster_articles\s*\(/);
    expect(selectArg).toMatch(/articles\s*\(/);
    expect(selectArg).toMatch(/sources\s*\(/);

    expect(state.textSearch).toEqual([
      { col: "search_tsv", query: "İmamoğlu", opts: { config: "turkish", type: "websearch" } },
    ]);
    expect(state.gte).toEqual([{ col: "article_count", val: 2 }]);
    expect(state.eq).toEqual([{ col: "is_archived", val: false }]);
    expect(state.order).toEqual([
      { col: "article_count", opts: { ascending: false } },
      { col: "updated_at", opts: { ascending: false } },
    ]);
    expect(state.limit).toBe(12);
  });

  it("trims the query before sending it to textSearch", async () => {
    await searchClusters("  seçim  ");
    const state = fixture.lastState as BuilderState;
    expect(state.textSearch[0]?.query).toBe("seçim");
  });
});

// ---------------------------------------------------------------------------
// Short-query guard
// ---------------------------------------------------------------------------

describe("short query guard", () => {
  it("returns [] without querying Supabase for a 0-character query", async () => {
    const result = await searchClusters("");
    expect(result).toEqual([]);
    expect(fixture.lastState).toBeNull();
  });

  it("returns [] without querying Supabase for a 1-character (post-trim) query", async () => {
    const result = await searchClusters("  a  ");
    expect(result).toEqual([]);
    expect(fixture.lastState).toBeNull();
  });

  it("queries once the trimmed length reaches 2 characters", async () => {
    fixture.data = [];
    const result = await searchClusters(" ab ");
    expect(result).toEqual([]);
    expect(fixture.lastState).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Error handling — never throws.
// ---------------------------------------------------------------------------

describe("searchClusters error handling", () => {
  it("returns [] (does not throw) when the query errors", async () => {
    fixture.error = { message: "db down" };
    await expect(searchClusters("merhaba")).resolves.toEqual([]);
  });

  it("returns [] (does not throw) when the query itself throws", async () => {
    fixture.throwOnQuery = true;
    await expect(searchClusters("merhaba")).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Row -> bundle assembly (reuses politics-query's buildClusterBundle)
// ---------------------------------------------------------------------------

describe("row assembly", () => {
  it("builds a ClusterBundle per row, deduping same-source members", async () => {
    fixture.data = [
      mkRow({
        id: "c1",
        title_tr: "original",
        title_tr_neutral: "neutral version",
        members: [
          { id: "a1", sourceId: "s1" },
          { id: "a2", sourceId: "s1" }, // duplicate source
          { id: "a3", sourceId: "s2" },
        ],
      }),
    ];
    const result = await searchClusters("deprem");
    expect(result).toHaveLength(1);
    const b = result[0]!;
    expect(b.cluster.id).toBe("c1");
    // H2 neutral-headline coalesce reused from politics-query.
    expect(b.cluster.title_tr).toBe("neutral version");
    // Same-source dedupe: s1 contributes once.
    expect(b.articles).toHaveLength(2);
    expect(b.sources.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  });

  it("does NOT apply the politics-majority category gate (unlike getPoliticsClusters)", async () => {
    // All members are "spor" (sports) — politics-query would drop this
    // cluster entirely. Full-text search has no such gate: it's an
    // archive fallback across all clusters, not a politics feed.
    fixture.data = [
      mkRow({
        id: "sports-cluster",
        category: "spor",
        members: [
          { id: "a1", sourceId: "s1" },
          { id: "a2", sourceId: "s2" },
        ],
      }),
    ];
    const result = await searchClusters("galatasaray");
    expect(result).toHaveLength(1);
    expect(result[0]?.cluster.id).toBe("sports-cluster");
  });

  it("drops a row whose every embedded article join is null", async () => {
    fixture.data = [
      {
        id: "empty",
        title_tr: "Empty",
        title_tr_neutral: null,
        summary_tr: "",
        bias_distribution: {},
        is_blindspot: false,
        blindspot_side: null,
        article_count: 1,
        first_published: "2026-04-18T10:00:00.000Z",
        updated_at: "2026-04-18T10:00:00.000Z",
        cluster_articles: [{ articles: null }],
      },
    ];
    const result = await searchClusters("boş");
    expect(result).toEqual([]);
  });

  it("returns [] when the query matches no rows", async () => {
    fixture.data = [];
    const result = await searchClusters("hiçbirşey");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Feed-health-gated blindspot suppression (Pack C) — search results thread
// the same `health` the home feed uses through buildClusterBundle, mirrored
// from politics-query.test.ts's "feed-health gated blindspot suppression"
// cases so a suppressed cluster never disagrees between the home feed and
// a search result.
// ---------------------------------------------------------------------------

describe("feed-health gated blindspot suppression (search results)", () => {
  function mkHealth(overrides: {
    iktidar?: boolean;
    bagimsiz?: boolean;
    muhalefet?: boolean;
  }): ZoneFeedHealth {
    const healthy = { total: 10, healthy: 10, healthyShare: 1, degraded: false };
    const degraded = { total: 10, healthy: 2, healthyShare: 0.2, degraded: true };
    return {
      iktidar: overrides.iktidar ? degraded : healthy,
      bagimsiz: overrides.bagimsiz ? degraded : healthy,
      muhalefet: overrides.muhalefet ? degraded : healthy,
    };
  }

  it("withdraws is_blindspot/blindspot_side when the silent pole zone is degraded", async () => {
    feedHealth.getZoneFeedHealth.mockResolvedValue(mkHealth({ muhalefet: true }));
    fixture.data = [
      mkRow({
        id: "suppressed",
        is_blindspot: true,
        blindspot_side: "pro_government",
        bias_distribution: { pro_government: 9, opposition: 1 },
        members: [
          { id: "a1", sourceId: "s1" },
          { id: "a2", sourceId: "s2" },
        ],
      }),
    ];
    const result = await searchClusters("deprem");
    expect(result).toHaveLength(1);
    expect(result[0]?.cluster.is_blindspot).toBe(false);
    expect(result[0]?.cluster.blindspot_side).toBeNull();
  });

  it("leaves is_blindspot/blindspot_side untouched when feed health is unknown (null passthrough)", async () => {
    feedHealth.getZoneFeedHealth.mockResolvedValue(null);
    fixture.data = [
      mkRow({
        id: "unaffected-unknown-health",
        is_blindspot: true,
        blindspot_side: "pro_government",
        bias_distribution: { pro_government: 9, opposition: 1 },
        members: [
          { id: "a1", sourceId: "s1" },
          { id: "a2", sourceId: "s2" },
        ],
      }),
    ];
    const result = await searchClusters("deprem");
    expect(result).toHaveLength(1);
    expect(result[0]?.cluster.is_blindspot).toBe(true);
    expect(result[0]?.cluster.blindspot_side).toBe("pro_government");
  });
});
