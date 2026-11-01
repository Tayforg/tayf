import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Same harness as src/lib/clusters/search-query.test.ts: the shared proxy-based
// Supabase fake (tests/_helpers/supabase-fake.ts), a mocked next/cache, and a
// stubbed getZoneFeedHealth. entity-hub-query.ts resolves ids (plus the total
// match count) via migration 123's `entity_cluster_ids` RPC, then embeds just
// those ids with `.in('id', ids)`.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const feedHealth = vi.hoisted(() => ({
  getZoneFeedHealth: vi.fn(async () => null as unknown),
}));

vi.mock("@/lib/clusters/feed-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clusters/feed-health")>();
  return {
    ...actual,
    getZoneFeedHealth: feedHealth.getZoneFeedHealth,
  };
});

const fixture = vi.hoisted(() => ({
  data: [] as unknown[],
  error: null as { message: string } | null,
  throwOnQuery: false,
  lastState: null as unknown,
  embedCalls: 0,
  rpcRows: [] as Array<{ id: string; total: unknown }>,
  rpcError: null as { message: string } | null,
  rpcThrows: false,
  // Number of leading rpc calls that fail before the rpc recovers.
  rpcFailFirst: 0,
  rpcCalls: [] as unknown[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state: unknown) => {
        fixture.lastState = state;
        fixture.embedCalls += 1;
        if (fixture.throwOnQuery) throw new Error("connection reset");
        return { data: fixture.error ? null : fixture.data, error: fixture.error };
      },
    },
    rpc: {
      entity_cluster_ids: (args: unknown) => {
        fixture.rpcCalls.push(args);
        if (fixture.rpcThrows) throw new Error("rpc connection reset");
        if (fixture.rpcFailFirst > 0 && fixture.rpcCalls.length <= fixture.rpcFailFirst) {
          return { data: null, error: { message: "statement timeout" } };
        }
        if (fixture.rpcError) return { data: null, error: fixture.rpcError };
        return { data: fixture.rpcRows, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import { cacheLife, cacheTag } from "next/cache";
import { turkishQueryVariants } from "@/lib/clusters/turkish-query";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";
import { ENTITY_HUB_LIMIT } from "./entity-hub";
import { getEntityHub } from "./entity-hub-query";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.data = [];
  fixture.error = null;
  fixture.throwOnQuery = false;
  fixture.lastState = null;
  fixture.embedCalls = 0;
  fixture.rpcRows = [];
  fixture.rpcError = null;
  fixture.rpcThrows = false;
  fixture.rpcFailFirst = 0;
  fixture.rpcCalls = [];
  feedHealth.getZoneFeedHealth.mockReset();
  feedHealth.getZoneFeedHealth.mockResolvedValue(null);
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

// Same embedded row shape as search-query.test.ts's mkRow.
function mkRow(opts: {
  id: string;
  title_tr?: string;
  bias_distribution?: unknown;
  members: Array<{ id: string; sourceId: string }>;
}) {
  return {
    id: opts.id,
    title_tr: opts.title_tr ?? `Cluster ${opts.id}`,
    title_tr_neutral: null,
    summary_tr: "summary",
    bias_distribution: opts.bias_distribution ?? {},
    is_blindspot: false,
    blindspot_side: null,
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
        category: "politika",
        content_hash: `h-${m.id}`,
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

const one = (id: string, sourceId = "s1") =>
  mkRow({ id, members: [{ id: `a-${id}`, sourceId }] });

describe("getEntityHub query shape", () => {
  it("calls the RPC with the Turkish-aware variants and p_limit only (never p_since)", async () => {
    await getEntityHub("erdogan");

    expect(fixture.rpcCalls).toEqual([
      { p_variants: turkishQueryVariants("Erdoğan"), p_limit: ENTITY_HUB_LIMIT },
    ]);
    expect(fixture.rpcCalls[0]).not.toHaveProperty("p_since");
    expect(ENTITY_HUB_LIMIT).toBe(20);
  });

  it("derives the variants from the entity label, not the key", async () => {
    await getEntityHub("iyi-parti");
    const args = fixture.rpcCalls[0] as { p_variants: string[] };
    expect(args.p_variants).toEqual(turkishQueryVariants("İYİ Parti"));
    expect(args.p_variants.length).toBeGreaterThan(0);
  });

  it("embeds exactly the returned ids with .in('id', ids)", async () => {
    fixture.rpcRows = [
      { id: "c1", total: 2 },
      { id: "c2", total: 2 },
    ];
    fixture.data = [one("c1"), one("c2", "s2")];

    await getEntityHub("chp");

    const state = fixture.lastState as BuilderState;
    expect(state.table).toBe("clusters");
    expect(state.in).toEqual([{ col: "id", vals: ["c1", "c2"] }]);
    expect(state.textSearch).toEqual([]);
  });
});

describe("getEntityHub result", () => {
  it("keeps the RPC's (newest-first) order even when the embed returns rows shuffled", async () => {
    fixture.rpcRows = [
      { id: "c2", total: 3 },
      { id: "c1", total: 3 },
      { id: "c3", total: 3 },
    ];
    fixture.data = [one("c1"), one("c3", "s3"), one("c2", "s2")];

    const result = await getEntityHub("erdogan");
    expect(result?.bundles.map((b) => b.cluster.id)).toEqual(["c2", "c1", "c3"]);
  });

  it("takes the total from the first row and coerces a string '422' to 422", async () => {
    fixture.rpcRows = [
      { id: "c1", total: "422" },
      { id: "c2", total: "422" },
    ];
    fixture.data = [one("c1"), one("c2", "s2")];

    const result = await getEntityHub("erdogan");
    expect(result?.total).toBe(422);
    expect(typeof result?.total).toBe("number");
    expect(result?.bundles).toHaveLength(2);
  });

  it("keeps a numeric total as is", async () => {
    fixture.rpcRows = [{ id: "c1", total: 7 }];
    fixture.data = [one("c1")];
    expect((await getEntityHub("erdogan"))?.total).toBe(7);
  });

  it("falls back to the number of ids when the total is missing or not a number", async () => {
    fixture.rpcRows = [
      { id: "c1", total: undefined },
      { id: "c2", total: undefined },
    ];
    fixture.data = [one("c1"), one("c2", "s2")];
    expect((await getEntityHub("erdogan"))?.total).toBe(2);

    fixture.rpcRows = [{ id: "c1", total: "çok" }];
    fixture.data = [one("c1")];
    expect((await getEntityHub("erdogan"))?.total).toBe(1);
  });

  it("never reports a total below the number of ids actually returned", async () => {
    fixture.rpcRows = [
      { id: "c1", total: 0 },
      { id: "c2", total: null },
    ];
    fixture.data = [one("c1"), one("c2", "s2")];
    expect((await getEntityHub("erdogan"))?.total).toBe(2);
  });

  it("returns { bundles: [], total: 0 } and makes NO embed call when the RPC returns no ids", async () => {
    fixture.rpcRows = [];

    const result = await getEntityHub("ysk");

    expect(result).toEqual({ bundles: [], total: 0 });
    expect(fixture.embedCalls).toBe(0);
    expect(fixture.lastState).toBeNull();
    expect(feedHealth.getZoneFeedHealth).not.toHaveBeenCalled();
  });

  it("builds ClusterBundles through the shared builder (same-source dedupe)", async () => {
    fixture.rpcRows = [{ id: "c1", total: 1 }];
    fixture.data = [
      mkRow({
        id: "c1",
        members: [
          { id: "a1", sourceId: "s1" },
          { id: "a2", sourceId: "s1" },
          { id: "a3", sourceId: "s2" },
        ],
      }),
    ];
    const result = await getEntityHub("erdogan");
    expect(result?.bundles).toHaveLength(1);
    const b = result!.bundles[0]!;
    expect(b.articles).toHaveLength(2);
    expect(b.sources.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  });

  it("drops a row whose every article join is null but keeps the RPC total", async () => {
    fixture.rpcRows = [
      { id: "empty", total: 5 },
      { id: "c1", total: 5 },
    ];
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
      one("c1"),
    ];
    const result = await getEntityHub("erdogan");
    expect(result?.bundles.map((b) => b.cluster.id)).toEqual(["c1"]);
    expect(result?.total).toBe(5);
  });

  it("does not apply the politics-majority gate (a sports story under a person still lists)", async () => {
    fixture.rpcRows = [{ id: "c1", total: 1 }];
    const row = one("c1");
    row.cluster_articles[0]!.articles.category = "spor";
    fixture.data = [row];
    expect((await getEntityHub("erdogan"))?.bundles).toHaveLength(1);
  });

  it("threads the feed health through buildClusterBundle (blindspot withdrawn for a degraded pole zone)", async () => {
    const healthy = { total: 10, healthy: 10, healthyShare: 1, degraded: false };
    const degraded = { total: 10, healthy: 2, healthyShare: 0.2, degraded: true };
    feedHealth.getZoneFeedHealth.mockResolvedValue({
      iktidar: healthy,
      bagimsiz: healthy,
      muhalefet: degraded,
    });
    fixture.rpcRows = [{ id: "c1", total: 1 }];
    fixture.data = [
      {
        ...mkRow({
          id: "c1",
          bias_distribution: { pro_government: 9, opposition: 1 },
          members: [
            { id: "a1", sourceId: "s1" },
            { id: "a2", sourceId: "s2" },
          ],
        }),
        is_blindspot: true,
        blindspot_side: "pro_government",
      },
    ];
    const result = await getEntityHub("erdogan");
    expect(result?.bundles[0]?.cluster.is_blindspot).toBe(false);
    expect(result?.bundles[0]?.cluster.blindspot_side).toBeNull();
  });
});

describe("getEntityHub unknown key", () => {
  it("returns null without touching Supabase or the cache", async () => {
    for (const key of ["bilinmeyen", "ERDOGAN", "", "__proto__"]) {
      await expect(getEntityHub(key)).resolves.toBeNull();
    }
    expect(fixture.rpcCalls).toEqual([]);
    expect(fixture.embedCalls).toBe(0);
    expect(cacheLife).not.toHaveBeenCalled();
    expect(cacheTag).not.toHaveBeenCalled();
  });
});

describe("getEntityHub error handling (never throws)", () => {
  it("retries the RPC live once when it errors, then returns null", async () => {
    fixture.rpcError = { message: "db down" };

    await expect(getEntityHub("erdogan")).resolves.toBeNull();

    // 1 cached attempt + 1 live retry, no more.
    expect(fixture.rpcCalls).toHaveLength(2);
    expect(console.error).toHaveBeenCalled();
  });

  it("retries when the RPC throws, then returns null", async () => {
    fixture.rpcThrows = true;
    await expect(getEntityHub("erdogan")).resolves.toBeNull();
    expect(fixture.rpcCalls).toHaveLength(2);
  });

  it("returns null when the embed select errors, after a live retry", async () => {
    fixture.rpcRows = [{ id: "c1", total: 1 }];
    fixture.error = { message: "embed down" };

    await expect(getEntityHub("erdogan")).resolves.toBeNull();

    expect(fixture.rpcCalls).toHaveLength(2);
    expect(fixture.embedCalls).toBe(2);
  });

  it("returns the live retry's result when only the cached attempt failed", async () => {
    fixture.rpcFailFirst = 1;
    fixture.rpcRows = [{ id: "c1", total: "9" }];
    fixture.data = [one("c1")];

    const result = await getEntityHub("erdogan");

    expect(fixture.rpcCalls).toHaveLength(2);
    expect(result?.total).toBe(9);
    expect(result?.bundles.map((b) => b.cluster.id)).toEqual(["c1"]);
  });
});

describe("getEntityHub cache lifetime", () => {
  it("tags clusters-entity first, then keeps the cluster-feed window for a successful read", async () => {
    fixture.rpcRows = [{ id: "c1", total: 1 }];
    fixture.data = [one("c1")];

    await getEntityHub("erdogan");

    expect(cacheTag).toHaveBeenCalledWith("clusters-entity");
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
    expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
    );
  });

  it("keeps cluster-feed for an empty (but successful) read", async () => {
    fixture.rpcRows = [];
    await getEntityHub("ysk");
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("memoises a failed attempt for 'minutes' only, never 'cluster-feed'", async () => {
    fixture.rpcError = { message: "db down" };
    await getEntityHub("erdogan");

    // One cached invocation (the live retry bypasses the cache boundary).
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("cluster-feed");
    expect(cacheTag).toHaveBeenCalledWith("clusters-entity");
  });
});
