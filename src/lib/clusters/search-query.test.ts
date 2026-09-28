import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Uses the shared proxy-based Supabase fake (tests/_helpers/supabase-fake.ts).
// search-query.ts now resolves ids via the 083 migration's
// `search_cluster_ids` RPC, then fetches the embed with `.in('id', ids)` —
// no `textSearch` call anywhere in this file any more.
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

// Mutable fixture the `clusters` table resolver reads on every embed query,
// plus the last builder state it saw, and a separate mutable fixture for
// the `search_cluster_ids` RPC.
const fixture = vi.hoisted(() => ({
  data: [] as unknown[],
  error: null as { message: string } | null,
  throwOnQuery: false,
  lastState: null as unknown,
  rpcIds: [] as string[],
  rpcError: null as { message: string } | null,
  rpcThrows: false,
  rpcCalls: [] as unknown[],
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
    rpc: {
      search_cluster_ids: (args: unknown) => {
        fixture.rpcCalls.push(args);
        if (fixture.rpcThrows) throw new Error("rpc connection reset");
        if (fixture.rpcError) return { data: null, error: fixture.rpcError };
        return {
          data: fixture.rpcIds.map((id) => ({ id })),
          error: null,
        };
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
  fixture.rpcIds = [];
  fixture.rpcError = null;
  fixture.rpcThrows = false;
  fixture.rpcCalls = [];
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
  it("calls the RPC with the Turkish-aware variants and p_limit", async () => {
    fixture.rpcIds = [];
    await searchClusters("IŞIK");

    expect(fixture.rpcCalls).toEqual([
      { p_variants: ["ışık", "işik", "işık"], p_limit: 12 },
    ]);
  });

  it("uses .in('id', ids) for the embed, with no textSearch anywhere", async () => {
    fixture.rpcIds = ["c1"];
    fixture.data = [mkRow({ id: "c1", members: [{ id: "a1", sourceId: "s1" }] })];

    await searchClusters("deprem");

    const state = fixture.lastState as BuilderState;
    expect(state.table).toBe("clusters");
    expect(state.textSearch).toEqual([]);
    expect(state.in).toEqual([{ col: "id", vals: ["c1"] }]);
  });

  it("trims and caps the query before building variants", async () => {
    fixture.rpcIds = [];
    await searchClusters("  seçim  ");
    expect(fixture.rpcCalls[0]).toEqual({ p_variants: ["seçim"], p_limit: 12 });
  });
});

// ---------------------------------------------------------------------------
// Short-query guard
// ---------------------------------------------------------------------------

describe("short query guard", () => {
  it("returns { ok: true, bundles: [] } without any Supabase call for a 0-character query", async () => {
    const result = await searchClusters("");
    expect(result).toEqual({ ok: true, bundles: [] });
    expect(fixture.rpcCalls).toEqual([]);
    expect(fixture.lastState).toBeNull();
  });

  it("returns { ok: true, bundles: [] } for a 1-character (post-trim) query", async () => {
    const result = await searchClusters("  a  ");
    expect(result).toEqual({ ok: true, bundles: [] });
    expect(fixture.rpcCalls).toEqual([]);
  });

  it("calls the RPC once the trimmed length reaches 2 characters", async () => {
    fixture.rpcIds = [];
    const result = await searchClusters(" ab ");
    expect(result).toEqual({ ok: true, bundles: [] });
    expect(fixture.rpcCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Error handling — never throws, always { ok: false } on failure.
// ---------------------------------------------------------------------------

describe("searchClusters error handling", () => {
  it("returns { ok: false } when the rpc errors", async () => {
    fixture.rpcError = { message: "db down" };
    await expect(searchClusters("merhaba")).resolves.toEqual({ ok: false });
  });

  it("returns { ok: false } when the rpc itself throws", async () => {
    fixture.rpcThrows = true;
    await expect(searchClusters("merhaba")).resolves.toEqual({ ok: false });
  });

  it("returns { ok: false } when the embed select errors", async () => {
    fixture.rpcIds = ["c1"];
    fixture.error = { message: "embed down" };
    await expect(searchClusters("merhaba")).resolves.toEqual({ ok: false });
  });

  it("returns { ok: true, bundles: [] } when the rpc result is empty, with no clusters query", async () => {
    fixture.rpcIds = [];
    const result = await searchClusters("hiçbirşey");
    expect(result).toEqual({ ok: true, bundles: [] });
    expect(fixture.lastState).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Row -> bundle assembly (reuses politics-query's buildClusterBundle)
// ---------------------------------------------------------------------------

describe("row assembly", () => {
  it("builds a ClusterBundle per row, deduping same-source members", async () => {
    fixture.rpcIds = ["c1"];
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
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundles).toHaveLength(1);
    const b = result.bundles[0]!;
    expect(b.cluster.id).toBe("c1");
    // H2 neutral-headline coalesce reused from politics-query.
    expect(b.cluster.title_tr).toBe("neutral version");
    // Same-source dedupe: s1 contributes once.
    expect(b.articles).toHaveLength(2);
    expect(b.sources.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  });

  it("follows the RPC's id order even when the embed returns rows shuffled", async () => {
    fixture.rpcIds = ["c2", "c1", "c3"];
    fixture.data = [
      mkRow({ id: "c1", members: [{ id: "a1", sourceId: "s1" }] }),
      mkRow({ id: "c3", members: [{ id: "a3", sourceId: "s3" }] }),
      mkRow({ id: "c2", members: [{ id: "a2", sourceId: "s2" }] }),
    ];
    const result = await searchClusters("deprem");
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundles.map((b) => b.cluster.id)).toEqual(["c2", "c1", "c3"]);
  });

  it("does NOT apply the politics-majority category gate (unlike getPoliticsClusters)", async () => {
    fixture.rpcIds = ["sports-cluster"];
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
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundles).toHaveLength(1);
    expect(result.bundles[0]?.cluster.id).toBe("sports-cluster");
  });

  it("drops a row whose every embedded article join is null", async () => {
    fixture.rpcIds = ["empty"];
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
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Feed-health-gated blindspot suppression (Pack C) — search results thread
// the same `health` the home feed uses through buildClusterBundle.
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
    fixture.rpcIds = ["suppressed"];
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
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundles).toHaveLength(1);
    expect(result.bundles[0]?.cluster.is_blindspot).toBe(false);
    expect(result.bundles[0]?.cluster.blindspot_side).toBeNull();
  });

  it("leaves is_blindspot/blindspot_side untouched when feed health is unknown (null passthrough)", async () => {
    feedHealth.getZoneFeedHealth.mockResolvedValue(null);
    fixture.rpcIds = ["unaffected-unknown-health"];
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
    if (!result.ok) throw new Error("expected ok");
    expect(result.bundles).toHaveLength(1);
    expect(result.bundles[0]?.cluster.is_blindspot).toBe(true);
    expect(result.bundles[0]?.cluster.blindspot_side).toBe("pro_government");
  });
});
