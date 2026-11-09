import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Same harness as src/lib/clusters/search-query.test.ts: the shared proxy-based
// Supabase fake (tests/_helpers/supabase-fake.ts), a mocked next/cache, and a
// stubbed getZoneFeedHealth. entity-hub-query.ts resolves ids (plus the total
// match count) via migration 170's `entity_cluster_ids_v3` RPC (precise hubs,
// with the per-hub headline-only flag), falling back on PGRST202 to the
// 4-argument `entity_cluster_ids_v2` of migrations 125/156 and then to migration
// 123's `entity_cluster_ids`, then embeds just those ids with `.in('id', ids)`.
//
// getEntityHubSummary (h94-slowroutes-1) is the light twin the /gundem index and
// /sitemaps/hubs.xml read: the same RPC call, then ONE lean
// `clusters(id, first_published, cluster_articles!inner(article_id))` read for
// those ids, no CLUSTER_EMBED_SELECT and no feed-health read. The fake's
// `clusters` resolver tells the two reads apart by the `!inner` in the select.
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
  // The lean summary read (select string carries `!inner`): its own rows, error and state.
  leanData: [] as unknown[],
  leanError: null as { message: string } | null,
  leanThrows: false,
  leanState: null as unknown,
  leanCalls: 0,
  // entity_cluster_ids_v3 (migration 170): the primary read. The rpc* names are v3's.
  rpcRows: [] as Array<{ id: string; total: unknown }>,
  rpcError: null as { message: string; code?: string } | null,
  rpcThrows: false,
  // Number of leading v3 calls that fail before the rpc recovers.
  rpcFailFirst: 0,
  rpcCalls: [] as unknown[],
  // entity_cluster_ids_v2 (migrations 125/156), the first PGRST202 fallback.
  v2Calls: [] as unknown[],
  v2Rows: [] as Array<{ id: string; total: unknown }>,
  v2Error: null as { message: string; code?: string } | null,
  // The labels getEntityHub hands the resolver (the single-flight / last-good key rides in it).
  resolverLabels: [] as unknown[],
  // entity_cluster_ids (migration 123), the second PGRST202 fallback.
  v1Calls: [] as unknown[],
  v1Rows: [] as Array<{ id: string; total: unknown }>,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state: unknown) => {
        const selectArg = String((state as { selectArgs: unknown[] }).selectArgs[0]);
        if (selectArg.includes("!inner")) {
          fixture.leanState = state;
          fixture.leanCalls += 1;
          if (fixture.leanThrows) throw new Error("lean connection reset");
          return { data: fixture.leanError ? null : fixture.leanData, error: fixture.leanError };
        }
        fixture.lastState = state;
        fixture.embedCalls += 1;
        if (fixture.throwOnQuery) throw new Error("connection reset");
        return { data: fixture.error ? null : fixture.data, error: fixture.error };
      },
    },
    rpc: {
      entity_cluster_ids_v3: (args: unknown) => {
        fixture.rpcCalls.push(args);
        if (fixture.rpcThrows) throw new Error("rpc connection reset");
        if (fixture.rpcFailFirst > 0 && fixture.rpcCalls.length <= fixture.rpcFailFirst) {
          return { data: null, error: { message: "statement timeout" } };
        }
        // PgResult.error is typed { message }; the PostgREST code rides along.
        if (fixture.rpcError) {
          return { data: null, error: fixture.rpcError as { message: string } };
        }
        return { data: fixture.rpcRows, error: null };
      },
      entity_cluster_ids_v2: (args: unknown) => {
        fixture.v2Calls.push(args);
        if (fixture.v2Error) return { data: null, error: fixture.v2Error as { message: string } };
        return { data: fixture.v2Rows, error: null };
      },
      entity_cluster_ids: (args: unknown) => {
        fixture.v1Calls.push(args);
        return { data: fixture.v1Rows, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

// Records the label (and its single-flight / last-good key) of every resolveCachedOrRetry call, then runs the real one.
vi.mock("@/lib/cache-resilience", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-resilience")>();
  return {
    ...actual,
    resolveCachedOrRetry: ((label: unknown, ...rest: unknown[]) => {
      fixture.resolverLabels.push(label);
      return (actual.resolveCachedOrRetry as (...a: unknown[]) => unknown)(label, ...rest);
    }) as typeof actual.resolveCachedOrRetry,
  };
});

import { cacheLife, cacheTag } from "next/cache";
import { __resetCacheResilienceForTests } from "@/lib/cache-resilience";
import { turkishQueryVariants } from "@/lib/clusters/turkish-query";
import { RISING_ENTITIES } from "@/lib/trends/rising-entities";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";
import {
  ENTITY_HUB_LIMIT,
  ENTITY_HUB_MAX_TERMS,
  entityByKey,
  entityHubPatterns,
  entityHubQueries,
} from "./entity-hub";
import { CLUSTER_EMBED_SELECT } from "@/lib/clusters/politics-query";
import { entityHubRobots } from "./entity-hub";
import {
  ENTITY_HUB_SUMMARY_SELECT,
  getEntityHub,
  getEntityHubSummary,
} from "./entity-hub-query";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // getEntityHub is keyed (single-flight, 5 s negative cooldown, last-good): the
  // module-level state would otherwise leak between the sequential failure
  // tests below, which each expect exactly one cached attempt + one live retry.
  __resetCacheResilienceForTests();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.data = [];
  fixture.error = null;
  fixture.throwOnQuery = false;
  fixture.lastState = null;
  fixture.embedCalls = 0;
  fixture.leanData = [];
  fixture.leanError = null;
  fixture.leanThrows = false;
  fixture.leanState = null;
  fixture.leanCalls = 0;
  fixture.rpcRows = [];
  fixture.rpcError = null;
  fixture.rpcThrows = false;
  fixture.rpcFailFirst = 0;
  fixture.rpcCalls = [];
  fixture.v2Calls = [];
  fixture.v2Rows = [];
  fixture.v2Error = null;
  fixture.resolverLabels = [];
  fixture.v1Calls = [];
  fixture.v1Rows = [];
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
  it("calls v3 with the curated queries, the regex patterns, p_limit and p_headline_only false (never p_since)", async () => {
    await getEntityHub("erdogan");

    expect(fixture.rpcCalls).toEqual([
      {
        p_queries: entityHubQueries(entityByKey("erdogan")!),
        p_patterns: entityHubPatterns(entityByKey("erdogan")!),
        p_limit: ENTITY_HUB_LIMIT,
        p_headline_only: false,
      },
    ]);
    expect(fixture.rpcCalls[0]).not.toHaveProperty("p_since");
    expect(fixture.v2Calls).toEqual([]);
    expect(fixture.v1Calls).toEqual([]);
    expect(ENTITY_HUB_LIMIT).toBe(20);
  });

  it("sends p_headline_only true for akp and false for chp, mhp, erdogan, ozgur-ozel, israil, abd, iran and ukrayna", async () => {
    for (const key of ["akp", "chp", "mhp", "erdogan", "ozgur-ozel", "israil", "abd", "iran", "ukrayna"]) {
      fixture.rpcCalls = [];
      await getEntityHub(key);
      expect(fixture.rpcCalls, key).toHaveLength(1);
      expect((fixture.rpcCalls[0] as { p_headline_only: unknown }).p_headline_only, key).toBe(key === "akp");
    }
    // The akp call is otherwise the same shape as every other hub's.
    fixture.rpcCalls = [];
    await getEntityHub("akp");
    expect(fixture.rpcCalls).toEqual([
      {
        p_queries: entityHubQueries(entityByKey("akp")!),
        p_patterns: ["\\mak\\s+parti", "\\makp\\M"],
        p_limit: ENTITY_HUB_LIMIT,
        p_headline_only: true,
      },
    ]);
  });

  it("derives queries and patterns from the entity's forms, not the key", async () => {
    await getEntityHub("iyi-parti");
    const args = fixture.rpcCalls[0] as { p_queries: string[]; p_patterns: string[] };
    // The form first, then its curated inflection ("İYİ Partili"), which widens the prefilter only.
    expect(args.p_queries).toEqual([
      ...turkishQueryVariants("İYİ Parti"),
      ...turkishQueryVariants("İYİ Partili"),
    ]);
    expect(args.p_patterns).toEqual(["\\miyi\\s+parti"]);
  });

  it("sends non-empty p_queries and p_patterns, each at most 12, and a boolean p_headline_only, for all 62 hubs", async () => {
    expect(RISING_ENTITIES).toHaveLength(62);
    for (const e of RISING_ENTITIES) {
      fixture.rpcCalls = [];
      await getEntityHub(e.key);
      expect(fixture.rpcCalls, e.key).toHaveLength(1);
      const args = fixture.rpcCalls[0] as {
        p_queries: string[];
        p_patterns: string[];
        p_headline_only: unknown;
      };
      expect(typeof args.p_headline_only, e.key).toBe("boolean");
      expect(args.p_headline_only, e.key).toBe(e.key === "akp");
      expect(args.p_queries.length, e.key).toBeGreaterThan(0);
      expect(args.p_queries.length, e.key).toBeLessThanOrEqual(ENTITY_HUB_MAX_TERMS);
      expect(args.p_patterns.length, e.key).toBeGreaterThan(0);
      expect(args.p_patterns.length, e.key).toBeLessThanOrEqual(ENTITY_HUB_MAX_TERMS);
      expect(args.p_patterns, e.key).toEqual(entityHubPatterns(e));
    }
  });

  it("searches every curated spelling: akp, zelenski and borsa carry their aliases", async () => {
    await getEntityHub("akp");
    await getEntityHub("zelenski");
    await getEntityHub("borsa");
    const [akp, zelenski, borsa] = fixture.rpcCalls as Array<{
      p_queries: string[];
      p_patterns: string[];
    }>;
    expect(akp!.p_queries).toEqual(expect.arrayContaining(["ak parti", "akp"]));
    expect(akp!.p_patterns).toEqual(["\\mak\\s+parti", "\\makp\\M"]);
    expect(zelenski!.p_queries).toEqual(
      expect.arrayContaining(["zelenski", "zelenskiy", "zelensky", "zelenskyy"]),
    );
    expect(zelenski!.p_patterns).toHaveLength(4);
    expect(borsa!.p_queries).toEqual(
      expect.arrayContaining(["borsa", "bist", "borsada", "borsası"]),
    );
    // 'Borsa İstanbul' and 'BIST' are bare (trusted); the bare 'Borsa' carries the
    // exclude guard that keeps New York, Asia and Binance stories out (h43-entities-2).
    expect(borsa!.p_patterns).toHaveLength(3);
    expect(borsa!.p_patterns[0]).toBe("\\mborsa\\s+istanbul");
    expect(borsa!.p_patterns[1]).toMatch(
      /^\^\(\?!\[\\s\\S\]\*\(\?:\\mnew\\s\+york\|.*\\mkripto\|\\mticaret\\s\+borsa\)\)\[\\s\\S\]\*\\mborsa$/,
    );
    expect(borsa!.p_patterns[2]).toBe("\\mbist");
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
  it("keeps the RPC's (first_published desc) order even when the embed returns rows shuffled", async () => {
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

    expect(result).toEqual({ bundles: [], total: 0, asOfMs: expect.any(Number) });
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

describe("getEntityHub blindspot feed delay (h37-content-1)", () => {
  it("holds back a flagged claim first published 1 h ago and keeps one 30 h old", async () => {
    feedHealth.getZoneFeedHealth.mockResolvedValue(null);
    fixture.rpcRows = [
      { id: "young", total: 2 },
      { id: "old", total: 2 },
    ];
    const flagged = (id: string, ageMs: number) => ({
      ...mkRow({
        id,
        bias_distribution: { pro_government: 9, opposition: 1 },
        members: [
          { id: `${id}-a1`, sourceId: `${id}-s1` },
          { id: `${id}-a2`, sourceId: `${id}-s2` },
        ],
      }),
      is_blindspot: true,
      blindspot_side: "pro_government",
      first_published: new Date(Date.now() - ageMs).toISOString(),
    });
    fixture.data = [flagged("young", 3_600_000), flagged("old", 30 * 3_600_000)];
    const result = await getEntityHub("erdogan");
    const byId = new Map((result?.bundles ?? []).map((b) => [b.cluster.id, b.cluster]));
    expect(byId.get("young")?.is_blindspot).toBe(false);
    expect(byId.get("young")?.blindspot_side).toBeNull();
    expect(byId.get("old")?.is_blindspot).toBe(true);
  });
});

describe("getEntityHub v2 fallback (migration 170 not applied yet)", () => {
  const V3_MISSING = { message: "Could not find the function", code: "PGRST202" };

  it("retries entity_cluster_ids_v2 once on PGRST202 with the old four arguments and builds the bundles from its rows", async () => {
    fixture.rpcError = V3_MISSING;
    fixture.v2Rows = [
      { id: "c2", total: "6" },
      { id: "c1", total: "6" },
    ];
    fixture.data = [one("c1"), one("c2", "s2")];

    const result = await getEntityHub("erdogan");

    expect(fixture.rpcCalls).toHaveLength(1);
    expect(fixture.v2Calls).toEqual([
      {
        p_queries: entityHubQueries(entityByKey("erdogan")!),
        p_patterns: entityHubPatterns(entityByKey("erdogan")!),
        p_limit: ENTITY_HUB_LIMIT,
      },
    ]);
    expect(fixture.v2Calls[0]).not.toHaveProperty("p_headline_only");
    expect(fixture.v2Calls[0]).not.toHaveProperty("p_since");
    expect(fixture.v1Calls).toEqual([]);
    expect(result?.total).toBe(6);
    expect(result?.bundles.map((b) => b.cluster.id)).toEqual(["c2", "c1"]);
    const state = fixture.lastState as BuilderState;
    expect(state.in).toEqual([{ col: "id", vals: ["c2", "c1"] }]);
  });

  it("akp degrades to v2 with the same patterns and no flag (the summary lead counts again until 170 is applied)", async () => {
    fixture.rpcError = V3_MISSING;
    fixture.v2Rows = [{ id: "c1", total: 1 }];
    fixture.data = [one("c1")];
    const result = await getEntityHub("akp");
    expect(fixture.rpcCalls).toEqual([
      expect.objectContaining({ p_headline_only: true }),
    ]);
    expect(fixture.v2Calls).toEqual([
      {
        p_queries: entityHubQueries(entityByKey("akp")!),
        p_patterns: ["\\mak\\s+parti", "\\makp\\M"],
        p_limit: ENTITY_HUB_LIMIT,
      },
    ]);
    expect(result?.bundles.map((b) => b.cluster.id)).toEqual(["c1"]);
  });

  it("a v2 answer of no ids is an empty hub, not an error, and reads nothing else", async () => {
    fixture.rpcError = V3_MISSING;
    fixture.v2Rows = [];
    const result = await getEntityHub("ysk");
    expect(result).toEqual({ bundles: [], total: 0, asOfMs: expect.any(Number) });
    expect(fixture.v1Calls).toEqual([]);
    expect(fixture.embedCalls).toBe(0);
  });

  it("v3 failing with any other error code never calls v2: live retry, then null (2 v3 calls)", async () => {
    fixture.rpcError = { message: "boom", code: "42883" };
    await expect(getEntityHub("akp")).resolves.toBeNull();
    expect(fixture.rpcCalls).toHaveLength(2);
    expect(fixture.v2Calls).toEqual([]);
    expect(fixture.v1Calls).toEqual([]);
  });

  it("a v2 error that is not PGRST202 throws into the retry path: no v1, null after a live retry", async () => {
    fixture.rpcError = V3_MISSING;
    fixture.v2Error = { message: "statement timeout", code: "57014" };
    await expect(getEntityHub("erdogan")).resolves.toBeNull();
    // One cached attempt and one live retry, each v3 then v2.
    expect(fixture.rpcCalls).toHaveLength(2);
    expect(fixture.v2Calls).toHaveLength(2);
    expect(fixture.v1Calls).toEqual([]);
  });
});

describe("getEntityHub v1 fallback (neither 170 nor 125 applied)", () => {
  const MISSING = { message: "Could not find the function", code: "PGRST202" };

  it("falls back to v1 exactly once when v3 and v2 both answer PGRST202, and builds the bundles from the v1 rows", async () => {
    fixture.rpcError = MISSING;
    fixture.v2Error = MISSING;
    fixture.v1Rows = [
      { id: "c2", total: "4" },
      { id: "c1", total: "4" },
    ];
    fixture.data = [one("c1"), one("c2", "s2")];

    const result = await getEntityHub("erdogan");

    expect(fixture.rpcCalls).toHaveLength(1);
    expect(fixture.v2Calls).toHaveLength(1);
    expect(fixture.v1Calls).toEqual([
      { p_variants: turkishQueryVariants("Erdoğan"), p_limit: ENTITY_HUB_LIMIT },
    ]);
    expect(fixture.v1Calls[0]).not.toHaveProperty("p_since");
    expect(result?.total).toBe(4);
    expect(result?.bundles.map((b) => b.cluster.id)).toEqual(["c2", "c1"]);
    const state = fixture.lastState as BuilderState;
    expect(state.in).toEqual([{ col: "id", vals: ["c2", "c1"] }]);
  });

  it("derives the v1 variants from the label, never from the aliases", async () => {
    fixture.rpcError = MISSING;
    fixture.v2Error = MISSING;
    await getEntityHub("akp");
    expect(fixture.v1Calls).toEqual([
      { p_variants: turkishQueryVariants("AK Parti"), p_limit: ENTITY_HUB_LIMIT },
    ]);
  });

  it("an empty v1 fallback result is an empty hub, not an error", async () => {
    fixture.rpcError = MISSING;
    fixture.v2Error = MISSING;
    fixture.v1Rows = [];
    const result = await getEntityHub("ysk");
    expect(result).toEqual({ bundles: [], total: 0, asOfMs: expect.any(Number) });
    expect(fixture.embedCalls).toBe(0);
  });

  it("v3 answering PGRST202 alone never reaches v1 when v2 answers", async () => {
    fixture.rpcError = MISSING;
    fixture.v2Rows = [{ id: "c1", total: 1 }];
    fixture.data = [one("c1")];
    await getEntityHub("erdogan");
    expect(fixture.v1Calls).toEqual([]);
  });

  it("any other error code never calls v1: live retry, then null (2 v3 calls)", async () => {
    fixture.rpcError = { message: "boom", code: "42883" };
    await expect(getEntityHub("erdogan")).resolves.toBeNull();
    expect(fixture.rpcCalls).toHaveLength(2);
    expect(fixture.v1Calls).toEqual([]);
  });

  it("an error without a code never calls v1 either", async () => {
    fixture.rpcError = { message: "db down" };
    await expect(getEntityHub("erdogan")).resolves.toBeNull();
    expect(fixture.rpcCalls).toHaveLength(2);
    expect(fixture.v1Calls).toEqual([]);
  });

  it("a thrown v3 call (no code) never falls back to v2 or v1", async () => {
    fixture.rpcThrows = true;
    await expect(getEntityHub("erdogan")).resolves.toBeNull();
    expect(fixture.v2Calls).toEqual([]);
    expect(fixture.v1Calls).toEqual([]);
  });
});

describe("getEntityHub cache key carries the headline-only flag (h56-entities-2)", () => {
  it("hands the resolver a key of the form clusters-entity:<hub>:<headline|lead>, one per flag value", async () => {
    await getEntityHub("akp");
    await getEntityHub("chp");
    await getEntityHub("erdogan");
    expect(fixture.resolverLabels).toEqual([
      { label: "clusters-entity", key: "clusters-entity:akp:headline" },
      { label: "clusters-entity", key: "clusters-entity:chp:lead" },
      { label: "clusters-entity", key: "clusters-entity:erdogan:lead" },
    ]);
  });

  it("no two hubs share a key, and only akp's carries 'headline'", async () => {
    for (const e of RISING_ENTITIES) await getEntityHub(e.key);
    const keys = fixture.resolverLabels.map((l) => (l as { key: string }).key);
    expect(keys).toHaveLength(RISING_ENTITIES.length);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => k.endsWith(":headline"))).toEqual(["clusters-entity:akp:headline"]);
  });

  it("the flag reaches the 'use cache' function as an argument too, so the Next cache entry is keyed on it", () => {
    const src = readFileSync(resolve(__dirname, "entity-hub-query.ts"), "utf8");
    expect(src).toMatch(/async function cachedEntityHub\(key: string, headlineOnly: boolean\)/);
    expect(src).toContain("() => cachedEntityHub(key, headlineOnly)");
    expect(src).toContain("() => fetchEntityHub(key, headlineOnly)");
    expect(src).toContain("async function fetchEntityHub(key: string, headlineOnly: boolean)");
  });
});

describe("getEntityHub unknown key", () => {
  it("returns null without touching Supabase or the cache", async () => {
    for (const key of ["bilinmeyen", "ERDOGAN", "", "__proto__"]) {
      await expect(getEntityHub(key)).resolves.toBeNull();
    }
    expect(fixture.rpcCalls).toEqual([]);
    expect(fixture.v1Calls).toEqual([]);
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

  it("concurrent callers of one hub share ONE live retry (single-flight per key)", async () => {
    fixture.rpcError = { message: "db down" };

    const results = await Promise.all([getEntityHub("deva"), getEntityHub("deva")]);

    expect(results).toEqual([null, null]);
    // Two cached attempts (one per caller) + ONE shared live retry. Without a
    // key every caller runs its own retry: 4 calls.
    expect(fixture.rpcCalls).toHaveLength(3);
  });

  it("different hubs never share a flight", async () => {
    fixture.rpcError = { message: "db down" };

    await Promise.all([getEntityHub("deva"), getEntityHub("erdogan")]);

    // 2 cached attempts + 2 live retries.
    expect(fixture.rpcCalls).toHaveLength(4);
  });

  it("serves the last good read (under 60 min old) before null when the reader is down", async () => {
    fixture.rpcRows = [{ id: "c1", total: 4 }];
    fixture.data = [one("c1")];
    const good = await getEntityHub("deva");
    expect(good?.total).toBe(4);

    fixture.rpcError = { message: "db down" };
    const stale = await getEntityHub("deva");

    expect(stale?.total).toBe(4);
    expect(stale?.bundles.map((b) => b.cluster.id)).toEqual(["c1"]);
    // A hub never read successfully still resolves to null.
    await expect(getEntityHub("erdogan")).resolves.toBeNull();
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

// ---------------------------------------------------------------------------
// getEntityHubSummary (h94-slowroutes-1). The /gundem index reads only
// `total`; /sitemaps/hubs.xml reads only entityHubRobots(bundles) and the newest
// first_published. Both used to build all 62 full hubs (the entity_cluster_ids_v3
// RPC plus a CLUSTER_EMBED_SELECT of up to 20 clusters each). The summary keeps
// the RPC and replaces the embed by one lean read of the member counts.
// ---------------------------------------------------------------------------

/** A lean-read row, as PostgREST answers `clusters(id, first_published, cluster_articles!inner(article_id))`. */
function leanRow(id: string, firstPublished: unknown, members = 1) {
  return {
    id,
    first_published: firstPublished,
    cluster_articles: Array.from({ length: members }, (_, i) => ({ article_id: `${id}-a${i}` })),
  };
}

/** The ids the RPC answers: `total` repeated on every row, like `count(*) over ()`. */
function rpcIds(ids: string[], total: unknown = ids.length) {
  return ids.map((id) => ({ id, total }));
}

describe("getEntityHubSummary query shape (no embed, no feed health)", () => {
  it("reads ONE lean select of id, first_published and an inner cluster_articles join for exactly the RPC's ids", async () => {
    fixture.rpcRows = rpcIds(["c1", "c2"]);
    fixture.leanData = [leanRow("c1", "2026-11-01T00:00:00.000Z"), leanRow("c2", "2026-11-02T00:00:00.000Z")];

    await getEntityHubSummary("chp");

    expect(fixture.leanCalls).toBe(1);
    const state = fixture.leanState as BuilderState;
    expect(state.table).toBe("clusters");
    expect(state.selectArgs).toEqual(["id, first_published, cluster_articles!inner(article_id)"]);
    expect(ENTITY_HUB_SUMMARY_SELECT).toBe("id, first_published, cluster_articles!inner(article_id)");
    expect(state.in).toEqual([{ col: "id", vals: ["c1", "c2"] }]);
    expect(state.order).toEqual([]);
    expect(state.range).toBeNull();
    expect(state.limit).toBeNull();
  });

  it("makes NO embed call: the CLUSTER_EMBED_SELECT read never runs and the feed-health read is not made", async () => {
    fixture.rpcRows = rpcIds(["c1", "c2", "c3"]);
    fixture.leanData = [leanRow("c1", "2026-11-01T00:00:00.000Z")];

    await getEntityHubSummary("erdogan");

    expect(fixture.embedCalls).toBe(0);
    expect(fixture.lastState).toBeNull();
    expect(feedHealth.getZoneFeedHealth).not.toHaveBeenCalled();
    expect(String((fixture.leanState as BuilderState).selectArgs[0])).not.toContain(
      CLUSTER_EMBED_SELECT.trim().slice(0, 40),
    );
    expect(String((fixture.leanState as BuilderState).selectArgs[0])).not.toContain("articles (");
  });

  it("sends the RPC the same arguments getEntityHub does, for all 62 hubs (akp's p_headline_only included)", async () => {
    for (const e of RISING_ENTITIES) {
      fixture.rpcCalls = [];
      await getEntityHub(e.key);
      const full = fixture.rpcCalls;

      fixture.rpcCalls = [];
      await getEntityHubSummary(e.key);

      expect(fixture.rpcCalls, e.key).toEqual(full);
      expect(fixture.rpcCalls, e.key).toHaveLength(1);
      expect((fixture.rpcCalls[0] as { p_headline_only: unknown }).p_headline_only, e.key).toBe(
        e.key === "akp",
      );
      expect(fixture.rpcCalls[0], e.key).not.toHaveProperty("p_since");
    }
    expect(fixture.v2Calls).toEqual([]);
    expect(fixture.v1Calls).toEqual([]);
  });

  it("falls back to v2 and then v1 on PGRST202 exactly like getEntityHub (same arguments)", async () => {
    const MISSING = { message: "Could not find the function", code: "PGRST202" };
    fixture.rpcError = MISSING;
    fixture.v2Rows = rpcIds(["c1"], "6");
    fixture.leanData = [leanRow("c1", "2026-11-01T00:00:00.000Z")];

    const viaV2 = await getEntityHubSummary("erdogan");

    expect(fixture.rpcCalls).toHaveLength(1);
    expect(fixture.v2Calls).toEqual([
      {
        p_queries: entityHubQueries(entityByKey("erdogan")!),
        p_patterns: entityHubPatterns(entityByKey("erdogan")!),
        p_limit: ENTITY_HUB_LIMIT,
      },
    ]);
    expect(fixture.v1Calls).toEqual([]);
    expect(viaV2?.total).toBe(6);

    fixture.v2Error = MISSING;
    fixture.v1Rows = rpcIds(["c1"], "4");
    fixture.v2Calls = [];
    const viaV1 = await getEntityHubSummary("erdogan");

    expect(fixture.v1Calls).toEqual([
      { p_variants: turkishQueryVariants("Erdoğan"), p_limit: ENTITY_HUB_LIMIT },
    ]);
    expect(viaV1?.total).toBe(4);
    expect(fixture.embedCalls).toBe(0);
  });

  it("any other RPC error never falls back: a live retry, then null", async () => {
    fixture.rpcError = { message: "boom", code: "42883" };

    await expect(getEntityHubSummary("akp")).resolves.toBeNull();

    expect(fixture.rpcCalls).toHaveLength(2);
    expect(fixture.v2Calls).toEqual([]);
    expect(fixture.v1Calls).toEqual([]);
  });
});

describe("getEntityHubSummary result", () => {
  it("returns total, indexableCount, newestFirstPublished and an asOfMs stamp", async () => {
    fixture.rpcRows = rpcIds(["c1", "c2", "c3"], "422");
    fixture.leanData = [
      leanRow("c1", "2026-11-01T08:00:00.000Z"),
      leanRow("c2", "2026-11-05T08:00:00.000Z"),
      leanRow("c3", "2026-11-03T08:00:00.000Z"),
    ];

    const summary = await getEntityHubSummary("erdogan");

    expect(summary).toEqual({
      total: 422,
      indexableCount: 3,
      newestFirstPublished: "2026-11-05T08:00:00.000Z",
      asOfMs: expect.any(Number),
    });
  });

  it("takes the total like getEntityHub: first row, string coerced, never below the id count", async () => {
    fixture.leanData = [leanRow("c1", "2026-11-01T00:00:00.000Z"), leanRow("c2", "2026-11-01T00:00:00.000Z")];

    fixture.rpcRows = rpcIds(["c1", "c2"], "422");
    expect((await getEntityHubSummary("erdogan"))?.total).toBe(422);

    fixture.rpcRows = rpcIds(["c1", "c2"], 7);
    expect((await getEntityHubSummary("erdogan"))?.total).toBe(7);

    fixture.rpcRows = [
      { id: "c1", total: undefined },
      { id: "c2", total: undefined },
    ];
    expect((await getEntityHubSummary("erdogan"))?.total).toBe(2);

    fixture.rpcRows = rpcIds(["c1", "c2"], "çok");
    expect((await getEntityHubSummary("erdogan"))?.total).toBe(2);

    fixture.rpcRows = [
      { id: "c1", total: 0 },
      { id: "c2", total: null },
    ];
    expect((await getEntityHubSummary("erdogan"))?.total).toBe(2);
  });

  it("no ids: zeros and a null lastmod, with no lean read, no embed and no feed-health read", async () => {
    fixture.rpcRows = [];

    const summary = await getEntityHubSummary("ysk");

    expect(summary).toEqual({
      total: 0,
      indexableCount: 0,
      newestFirstPublished: null,
      asOfMs: expect.any(Number),
    });
    expect(fixture.leanCalls).toBe(0);
    expect(fixture.embedCalls).toBe(0);
    expect(feedHealth.getZoneFeedHealth).not.toHaveBeenCalled();
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("counts only clusters that have a member: a memberless row (or an ignored !inner) is not indexable", async () => {
    fixture.rpcRows = rpcIds(["c1", "c2", "c3", "c4"], 9);
    fixture.leanData = [
      leanRow("c1", "2026-11-01T00:00:00.000Z", 2),
      leanRow("c2", "2026-11-09T00:00:00.000Z", 0), // memberless: newest, but not a bundle
      { id: "c3", first_published: "2026-11-08T00:00:00.000Z", cluster_articles: null },
      leanRow("c4", "2026-11-02T00:00:00.000Z", 1),
    ];

    const summary = await getEntityHubSummary("erdogan");

    expect(summary?.total).toBe(9);
    expect(summary?.indexableCount).toBe(2);
    // The lastmod comes from the clusters that would be bundles only.
    expect(summary?.newestFirstPublished).toBe("2026-11-02T00:00:00.000Z");
  });

  it("keeps the RPC total when no cluster has a member (total >= 1, indexableCount 0)", async () => {
    fixture.rpcRows = rpcIds(["c1", "c2"], 5);
    fixture.leanData = [];

    const summary = await getEntityHubSummary("erdogan");

    expect(summary).toMatchObject({ total: 5, indexableCount: 0, newestFirstPublished: null });
  });

  it("newestFirstPublished compares by Date.parse, not as strings, and returns the original string", async () => {
    fixture.rpcRows = rpcIds(["c1", "c2", "c3"]);
    // As text "...:00Z" sorts after "...:00.500Z" ('Z' > '.'), but .500 is later.
    fixture.leanData = [
      leanRow("c1", "2026-10-30T22:00:00Z"),
      leanRow("c2", "2026-10-30T22:00:00.500Z"),
      leanRow("c3", "2026-10-30T21:59:59Z"),
    ];

    expect((await getEntityHubSummary("erdogan"))?.newestFirstPublished).toBe(
      "2026-10-30T22:00:00.500Z",
    );
  });

  it("skips unparseable and non-string timestamps, and is null when none parses", async () => {
    fixture.rpcRows = rpcIds(["c1", "c2", "c3", "c4"]);
    fixture.leanData = [
      leanRow("c1", "not-a-date"),
      leanRow("c2", undefined),
      leanRow("c3", "2026-10-02T00:00:00.000Z"),
      leanRow("c4", null),
    ];
    expect((await getEntityHubSummary("erdogan"))?.newestFirstPublished).toBe(
      "2026-10-02T00:00:00.000Z",
    );

    fixture.leanData = [leanRow("c1", ""), leanRow("c2", "garbage"), leanRow("c3", 12345)];
    expect((await getEntityHubSummary("erdogan"))?.newestFirstPublished).toBeNull();
  });
});

// The sitemap lists a hub exactly when its own page is indexable
// (entityHubRobots over the full read's bundles), and /gundem shows the hub's
// total. The summary must therefore agree with the full read on every figure the
// two consumers use, for one and the same fixture.
describe("getEntityHubSummary parity with the full getEntityHub read", () => {
  const FIRST = [
    "2026-11-08T21:00:00.000Z",
    "2026-11-09T01:30:00.500Z",
    "2026-11-07T10:00:00.000Z",
    "2026-11-09T01:30:00Z",
    "2026-11-02T00:00:00.000Z",
    "2026-11-06T00:00:00.000Z",
  ];

  /** Embed rows for `members[i]` members each (0 = a cluster with no article), c0, c1, ... */
  function embedRows(members: number[]) {
    return members.map((n, i) => ({
      ...mkRow({
        id: `c${i}`,
        members: Array.from({ length: n }, (_, j) => ({ id: `c${i}-a${j}`, sourceId: `s${j}` })),
      }),
      first_published: FIRST[i % FIRST.length]!,
    }));
  }

  /** What PostgREST's `cluster_articles!inner` would answer for the same rows. */
  function leanRowsOf(rows: ReturnType<typeof embedRows>) {
    return rows
      .filter((r) => r.cluster_articles.length > 0)
      .map((r) => ({
        id: r.id,
        first_published: r.first_published,
        cluster_articles: r.cluster_articles.map((ca) => ({ article_id: ca.articles.id })),
      }));
  }

  it.each([
    ["empty hub", []],
    ["one cluster", [2]],
    ["two clusters (thin, noindex)", [1, 3]],
    ["three clusters (the boundary, indexable)", [1, 1, 2]],
    ["two with members and a memberless one (still thin)", [2, 0, 1]],
    ["three with members and two memberless", [1, 0, 2, 0, 1]],
    ["six clusters, all with members", [1, 2, 1, 3, 1, 2]],
    ["only memberless clusters", [0, 0, 0]],
  ])("%s: indexableCount equals the full read's bundles.length, and the robots answer, total and lastmod agree", async (_name, members) => {
    const rows = embedRows(members);
    fixture.rpcRows = rpcIds(rows.map((r) => r.id), 41);
    fixture.data = rows;
    fixture.leanData = leanRowsOf(rows);

    const full = await getEntityHub("erdogan");
    const summary = await getEntityHubSummary("erdogan");

    expect(full).not.toBeNull();
    expect(summary).not.toBeNull();
    expect(summary!.indexableCount).toBe(full!.bundles.length);
    expect(summary!.total).toBe(full!.total);
    // The page's own robots predicate, applied to both, answers the same.
    expect(entityHubRobots({ bundles: Array.from({ length: summary!.indexableCount }) })).toEqual(
      entityHubRobots(full),
    );
    // The lastmod is the newest first_published among the full read's bundles.
    const published = full!.bundles
      .map((b) => b.cluster.first_published)
      .filter((v): v is string => typeof v === "string")
      .sort((a, b) => Date.parse(b) - Date.parse(a));
    expect(summary!.newestFirstPublished).toBe(published[0] ?? null);
  });
});

describe("getEntityHubSummary cache key and lifetime", () => {
  it("hands the resolver clusters-entity-summary:<hub>:<headline|lead> keys, one per hub, only akp 'headline'", async () => {
    for (const e of RISING_ENTITIES) await getEntityHubSummary(e.key);

    const labels = fixture.resolverLabels as Array<{ label: string; key: string }>;
    expect(labels).toHaveLength(RISING_ENTITIES.length);
    expect(labels.every((l) => l.label === "clusters-entity-summary")).toBe(true);
    const keys = labels.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter((k) => k.endsWith(":headline"))).toEqual(["clusters-entity-summary:akp:headline"]);
    expect(keys).toContain("clusters-entity-summary:chp:lead");
    // Never the full hub's key space, so the two caches and last-good maps stay apart.
    expect(keys.some((k) => k.startsWith("clusters-entity:"))).toBe(false);
  });

  it("the flag reaches the 'use cache' function as an argument too, so the Next cache entry is keyed on it", () => {
    const src = readFileSync(resolve(__dirname, "entity-hub-query.ts"), "utf8");
    expect(src).toMatch(/async function cachedEntityHubSummary\(key: string, headlineOnly: boolean\)/);
    expect(src).toContain("() => cachedEntityHubSummary(key, headlineOnly)");
    expect(src).toContain("() => fetchEntityHubSummary(key, headlineOnly)");
  });

  it("is plain 'use cache' (never remote) tagged clusters-entity, with one literal cacheLife per branch", () => {
    const src = readFileSync(resolve(__dirname, "entity-hub-query.ts"), "utf8");
    expect(src).not.toContain("use cache: remote");
    const body = src.slice(src.indexOf("async function cachedEntityHubSummary("));
    const bodyEnd = body.search(/^\}/m);
    const fn = body.slice(0, bodyEnd);
    expect(fn).toContain('"use cache";');
    expect(fn).toContain('cacheTag("clusters-entity");');
    expect(fn).toContain('if (r.ok) cacheLife("cluster-feed");');
    expect(fn).toContain('else cacheLife("minutes");');
    expect(fn).toContain("attemptCached(");
  });

  it("tags clusters-entity first, then keeps the cluster-feed window for a successful read", async () => {
    fixture.rpcRows = rpcIds(["c1"]);
    fixture.leanData = [leanRow("c1", "2026-11-01T00:00:00.000Z")];

    await getEntityHubSummary("erdogan");

    expect(cacheTag).toHaveBeenCalledWith("clusters-entity");
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
    expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
    );
  });

  it("memoises a failed attempt for 'minutes' only, never 'cluster-feed'", async () => {
    fixture.rpcError = { message: "db down" };

    await getEntityHubSummary("erdogan");

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("cluster-feed");
    expect(cacheTag).toHaveBeenCalledWith("clusters-entity");
  });
});

describe("getEntityHubSummary unknown key", () => {
  it("returns null without touching Supabase or the cache", async () => {
    for (const key of ["bilinmeyen", "ERDOGAN", "", "__proto__"]) {
      await expect(getEntityHubSummary(key)).resolves.toBeNull();
    }
    expect(fixture.rpcCalls).toEqual([]);
    expect(fixture.v1Calls).toEqual([]);
    expect(fixture.leanCalls).toBe(0);
    expect(fixture.embedCalls).toBe(0);
    expect(cacheLife).not.toHaveBeenCalled();
    expect(cacheTag).not.toHaveBeenCalled();
  });
});

describe("getEntityHubSummary error handling (never throws)", () => {
  it("retries the RPC live once when it errors or throws, then returns null", async () => {
    fixture.rpcError = { message: "db down" };
    await expect(getEntityHubSummary("erdogan")).resolves.toBeNull();
    // 1 cached attempt + 1 live retry, no more.
    expect(fixture.rpcCalls).toHaveLength(2);
    expect(console.error).toHaveBeenCalled();

    fixture.rpcError = null;
    fixture.rpcCalls = [];
    fixture.rpcThrows = true;
    await expect(getEntityHubSummary("deva")).resolves.toBeNull();
    expect(fixture.rpcCalls).toHaveLength(2);
  });

  it("returns null when the lean read errors or throws, after a live retry", async () => {
    fixture.rpcRows = rpcIds(["c1"]);
    fixture.leanError = { message: "lean down" };
    await expect(getEntityHubSummary("erdogan")).resolves.toBeNull();
    expect(fixture.rpcCalls).toHaveLength(2);
    expect(fixture.leanCalls).toBe(2);

    fixture.leanError = null;
    fixture.leanThrows = true;
    fixture.leanCalls = 0;
    await expect(getEntityHubSummary("deva")).resolves.toBeNull();
    expect(fixture.leanCalls).toBe(2);
    expect(fixture.embedCalls).toBe(0);
  });

  it("concurrent callers of one hub share ONE live retry (single-flight per key)", async () => {
    fixture.rpcError = { message: "db down" };

    const results = await Promise.all([getEntityHubSummary("deva"), getEntityHubSummary("deva")]);

    expect(results).toEqual([null, null]);
    // Two cached attempts + ONE shared live retry.
    expect(fixture.rpcCalls).toHaveLength(3);
  });

  it("serves the last good summary (under 60 min old) before null when the reader is down", async () => {
    fixture.rpcRows = rpcIds(["c1"], 4);
    fixture.leanData = [leanRow("c1", "2026-11-01T00:00:00.000Z")];
    const good = await getEntityHubSummary("deva");
    expect(good?.total).toBe(4);

    fixture.rpcError = { message: "db down" };
    const stale = await getEntityHubSummary("deva");

    expect(stale).toEqual(good);
    // A hub never read successfully still resolves to null.
    await expect(getEntityHubSummary("erdogan")).resolves.toBeNull();
  });

  it("the full hub's last-good value is never served for a summary (separate key space)", async () => {
    fixture.rpcRows = rpcIds(["c1"], 4);
    fixture.data = [one("c1")];
    expect((await getEntityHub("deva"))?.total).toBe(4);

    fixture.rpcError = { message: "db down" };
    await expect(getEntityHubSummary("deva")).resolves.toBeNull();
  });

  it("returns the live retry's result when only the cached attempt failed", async () => {
    fixture.rpcFailFirst = 1;
    fixture.rpcRows = rpcIds(["c1"], "9");
    fixture.leanData = [leanRow("c1", "2026-11-01T00:00:00.000Z")];

    const summary = await getEntityHubSummary("erdogan");

    expect(fixture.rpcCalls).toHaveLength(2);
    expect(summary).toMatchObject({ total: 9, indexableCount: 1 });
  });
});
