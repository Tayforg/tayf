import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks (see cluster-detail-query.test.ts for rationale)
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

interface FakeResult {
  data: unknown;
  error: { message: string } | null;
}

type Step = { method: string; args: unknown[] };
type CallEntry = { table: string; steps: Step[] };

let callLog: CallEntry[] = [];
let response: FakeResult = { data: [], error: null };

function makeFakeClient() {
  return {
    from(table: string) {
      const steps: Step[] = [];
      callLog.push({ table, steps });
      const builder: Record<string, unknown> = {};
      for (const name of ["select", "eq", "order", "gte", "limit"]) {
        builder[name] = (...args: unknown[]) => {
          steps.push({ method: name, args });
          return builder;
        };
      }
      builder.returns = (...args: unknown[]) => {
        steps.push({ method: "returns", args });
        return {
          then: (fn: (v: FakeResult) => unknown) =>
            Promise.resolve(response).then(fn),
        };
      };
      return builder;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(() => makeFakeClient()),
}));

import { getPoliticsClusters } from "./politics-query";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Fix a clock so time-decay and velocity are deterministic.
const NOW_MS = new Date("2026-04-18T12:00:00Z").getTime();

function iso(msOffset: number): string {
  return new Date(NOW_MS - msOffset).toISOString();
}

interface MkClusterOpts {
  id: string;
  title_tr?: string;
  title_tr_neutral?: string | null;
  summary_tr?: string;
  article_count?: number;
  bias_distribution?: unknown;
  is_blindspot?: boolean;
  blindspot_side?: unknown;
  first_published?: string;
  updated_at?: string;
  members: Array<{
    id: string;
    title?: string;
    sourceId: string;
    sourceName?: string;
    bias?: string;
    category?: string;
    content_hash?: string | null;
    published_at?: string;
    image_url?: string | null;
  }>;
}

function mkCluster(opts: MkClusterOpts) {
  return {
    id: opts.id,
    title_tr: opts.title_tr ?? `Cluster ${opts.id}`,
    title_tr_neutral: opts.title_tr_neutral ?? null,
    summary_tr: opts.summary_tr ?? "summary",
    bias_distribution: opts.bias_distribution ?? {},
    is_blindspot: opts.is_blindspot ?? false,
    blindspot_side: opts.blindspot_side ?? null,
    article_count: opts.article_count ?? opts.members.length,
    first_published: opts.first_published ?? iso(10 * 60 * 1000),
    updated_at: opts.updated_at ?? iso(5 * 60 * 1000),
    cluster_articles: opts.members.map((m) => ({
      articles: {
        id: m.id,
        title: m.title ?? `Article ${m.id}`,
        url: `https://example.com/${m.id}`,
        image_url: m.image_url ?? null,
        published_at: m.published_at ?? iso(10 * 60 * 1000),
        source_id: m.sourceId,
        category: m.category ?? "politika",
        content_hash: m.content_hash === undefined ? `h-${m.id}` : m.content_hash,
        sources: {
          id: m.sourceId,
          name: m.sourceName ?? `Source ${m.sourceId}`,
          bias: m.bias ?? "center",
          logo_url: null,
        },
      },
    })),
  };
}

beforeEach(() => {
  callLog = [];
  response = { data: [], error: null };
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_MS));
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Query shape
// ---------------------------------------------------------------------------

describe("getPoliticsClusters query shape", () => {
  it("issues a single clusters query with the documented filters and limits", async () => {
    response = { data: [], error: null };
    await getPoliticsClusters();

    expect(callLog).toHaveLength(1);
    const { table, steps } = callLog[0];
    expect(table).toBe("clusters");

    const select = steps.find((s) => s.method === "select");
    expect(select).toBeTruthy();
    const selectArg = select!.args[0] as string;
    // Verify the embedded nested shape is what PostgREST gets.
    expect(selectArg).toMatch(/cluster_articles\s*\(/);
    expect(selectArg).toMatch(/articles\s*\(/);
    expect(selectArg).toMatch(/sources\s*\(/);
    // Verify the R2 wire-collapse needs content_hash (and the builder
    // still selects it even though it's not rendered directly).
    expect(selectArg).toMatch(/\bcontent_hash\b/);
    // H2 neutral-headline column.
    expect(selectArg).toMatch(/\btitle_tr_neutral\b/);

    // ≥2 members, newest clusters first, capped at 200 (CANDIDATE_LIMIT).
    const gte = steps.find((s) => s.method === "gte");
    expect(gte!.args).toEqual(["article_count", 2]);
    const order = steps.find((s) => s.method === "order");
    expect(order!.args).toEqual([
      "updated_at",
      { ascending: false },
    ]);
    const limit = steps.find((s) => s.method === "limit");
    expect(limit!.args).toEqual([200]);
  });
});

// ---------------------------------------------------------------------------
// Politics majority filter
// ---------------------------------------------------------------------------

describe("politics majority filter", () => {
  it("keeps clusters with ≥60% politika/son_dakika members", async () => {
    response = {
      data: [
        mkCluster({
          id: "c-politics",
          members: [
            { id: "a1", sourceId: "s1", category: "politika" },
            { id: "a2", sourceId: "s2", category: "politika" },
            { id: "a3", sourceId: "s3", category: "son_dakika" },
            { id: "a4", sourceId: "s4", category: "ekonomi" },
          ],
        }),
      ],
      error: null,
    };
    const { bundles, prefilterCount } = await getPoliticsClusters();
    expect(prefilterCount).toBe(1);
    expect(bundles).toHaveLength(1);
    expect(bundles[0].cluster.id).toBe("c-politics");
  });

  it("drops clusters with <60% politika/son_dakika members", async () => {
    response = {
      data: [
        mkCluster({
          id: "c-sports",
          members: [
            { id: "a1", sourceId: "s1", category: "spor" },
            { id: "a2", sourceId: "s2", category: "spor" },
            { id: "a3", sourceId: "s3", category: "politika" },
          ],
        }),
      ],
      error: null,
    };
    const { bundles, prefilterCount } = await getPoliticsClusters();
    expect(prefilterCount).toBe(1);
    expect(bundles).toHaveLength(0);
  });

  it("drops clusters where every member has a null embedded article", async () => {
    const bad = {
      id: "c-empty",
      title_tr: "Empty",
      title_tr_neutral: null,
      summary_tr: "",
      bias_distribution: {},
      is_blindspot: false,
      blindspot_side: null,
      article_count: 2,
      first_published: iso(0),
      updated_at: iso(0),
      cluster_articles: [{ articles: null }, { articles: null }],
    };
    response = { data: [bad], error: null };
    const { bundles } = await getPoliticsClusters();
    expect(bundles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Same-source dedupe
// ---------------------------------------------------------------------------

describe("same-source dedupe + newest-first ordering", () => {
  it("collapses duplicate (cluster, source) pairs and keeps the earliest article", async () => {
    response = {
      data: [
        mkCluster({
          id: "c1",
          members: [
            // s1 appears twice — earliest (t=20m ago) must win.
            {
              id: "a-late",
              sourceId: "s1",
              published_at: iso(10 * 60 * 1000), // 10m ago
            },
            {
              id: "a-early",
              sourceId: "s1",
              published_at: iso(20 * 60 * 1000), // 20m ago
            },
            {
              id: "a-s2",
              sourceId: "s2",
              published_at: iso(5 * 60 * 1000), // 5m ago
            },
          ],
        }),
      ],
      error: null,
    };
    const { bundles } = await getPoliticsClusters();
    const b = bundles[0];
    // Two distinct sources survive dedupe.
    expect(b.articles).toHaveLength(2);
    // Newest first: s2 (5m) before s1's earliest article (20m).
    expect(b.articles[0].id).toBe("a-s2");
    expect(b.articles[1].id).toBe("a-early");
    // article_count reflects the post-dedupe truth.
    expect(b.cluster.article_count).toBe(2);
    // Sources list matches.
    expect(b.sources.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  });
});

// ---------------------------------------------------------------------------
// H2 neutral-headline coalesce
// ---------------------------------------------------------------------------

describe("neutral headline coalesce", () => {
  it("prefers the neutral title when non-empty; falls back otherwise", async () => {
    response = {
      data: [
        mkCluster({
          id: "neutral-wins",
          title_tr: "original",
          title_tr_neutral: "neutral version",
          members: [
            { id: "a1", sourceId: "s1", category: "politika" },
            { id: "a2", sourceId: "s2", category: "politika" },
          ],
        }),
        mkCluster({
          id: "neutral-blank",
          title_tr: "original-2",
          title_tr_neutral: "   ",
          members: [
            { id: "b1", sourceId: "s1", category: "politika" },
            { id: "b2", sourceId: "s2", category: "politika" },
          ],
        }),
      ],
      error: null,
    };
    const { bundles } = await getPoliticsClusters();
    const byId = Object.fromEntries(bundles.map((b) => [b.cluster.id, b]));
    expect(byId["neutral-wins"].cluster.title_tr).toBe("neutral version");
    expect(byId["neutral-blank"].cluster.title_tr).toBe("original-2");
  });
});

// ---------------------------------------------------------------------------
// R2 wire-collapse detection
// ---------------------------------------------------------------------------

describe("wire-collapse detection", () => {
  it("marks a cluster with ≤50% unique content_hash as wire redistribution", async () => {
    response = {
      data: [
        mkCluster({
          id: "wire",
          members: [
            // 4 members, 3 share the same hash → 2 unique / 4 = 0.5 → wire.
            { id: "w1", sourceId: "s1", content_hash: "AA" },
            { id: "w2", sourceId: "s2", content_hash: "AA" },
            { id: "w3", sourceId: "s3", content_hash: "AA" },
            { id: "w4", sourceId: "s4", content_hash: "BB" },
          ],
        }),
      ],
      error: null,
    };
    const { bundles } = await getPoliticsClusters();
    const b = bundles[0];
    expect(b.isWireRedistribution).toBe(true);
    expect(b.effectiveArticleCount).toBe(2); // distinct hashes
    // Pins the card's "N kopya" (which reads article_count, not
    // wire.memberCount) to the actual post-dedupe member count.
    expect(b.cluster.article_count).toBe(4);
  });

  it("does NOT mark a cluster with <3 members as wire", async () => {
    response = {
      data: [
        mkCluster({
          id: "small",
          members: [
            { id: "m1", sourceId: "s1", content_hash: "AA" },
            { id: "m2", sourceId: "s2", content_hash: "AA" },
          ],
        }),
      ],
      error: null,
    };
    const { bundles } = await getPoliticsClusters();
    expect(bundles[0].isWireRedistribution).toBe(false);
  });

  it("treats null content_hash as unique per-article (legacy safety)", async () => {
    response = {
      data: [
        mkCluster({
          id: "legacy",
          members: [
            { id: "l1", sourceId: "s1", content_hash: null },
            { id: "l2", sourceId: "s2", content_hash: null },
            { id: "l3", sourceId: "s3", content_hash: null },
            { id: "l4", sourceId: "s4", content_hash: null },
          ],
        }),
      ],
      error: null,
    };
    const { bundles } = await getPoliticsClusters();
    // All nulls become distinct pseudo-hashes → 4 unique / 4 members = 1.0
    expect(bundles[0].isWireRedistribution).toBe(false);
    expect(bundles[0].effectiveArticleCount).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// R3 source-fairness cap
// ---------------------------------------------------------------------------

describe("source-fairness cap", () => {
  it("caps a dominant source at 10% of the cluster and flags it", async () => {
    // 10 members total, 7 from haberler, 3 from others. Cap = ceil(10*.1)=1,
    // so only 1 haberler counts; effective count = 1 + 1 + 1 + 1 = 4.
    // haberler exceeds the cap so it's in cappedSources.
    response = {
      data: [
        mkCluster({
          id: "dom",
          members: [
            { id: "h1", sourceId: "haberler", sourceName: "Haberler" },
            { id: "h2", sourceId: "haberler", sourceName: "Haberler" },
            { id: "h3", sourceId: "haberler", sourceName: "Haberler" },
            { id: "h4", sourceId: "haberler", sourceName: "Haberler" },
            { id: "h5", sourceId: "haberler", sourceName: "Haberler" },
            { id: "h6", sourceId: "haberler", sourceName: "Haberler" },
            { id: "h7", sourceId: "haberler", sourceName: "Haberler" },
            { id: "b1", sourceId: "bbc", sourceName: "BBC" },
            { id: "br1", sourceId: "birgun", sourceName: "BirGün" },
            { id: "cn1", sourceId: "cnn", sourceName: "CNN" },
          ],
        }),
      ],
      error: null,
    };
    const { bundles } = await getPoliticsClusters();
    const b = bundles[0];
    expect(b.cappedSources).toEqual(["haberler"]);
    // cap = ceil(10 * 0.1) = 1; one haberler + 1 bbc + 1 birgun + 1 cnn = 4
    expect(b.effectiveSourceCount).toBe(4);
  });

  it("leaves cappedSources empty when no source exceeds the cap", async () => {
    response = {
      data: [
        mkCluster({
          id: "fair",
          members: [
            { id: "a1", sourceId: "s1" },
            { id: "a2", sourceId: "s2" },
            { id: "a3", sourceId: "s3" },
            { id: "a4", sourceId: "s4" },
            { id: "a5", sourceId: "s5" },
          ],
        }),
      ],
      error: null,
    };
    const { bundles } = await getPoliticsClusters();
    expect(bundles[0].cappedSources).toEqual([]);
    // All sources have 1 article, cap = ceil(5*.1)=1, so effective = 5.
    expect(bundles[0].effectiveSourceCount).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// R6 "Son Dakika" breaking strip
// ---------------------------------------------------------------------------

describe("breaking strip", () => {
  it("emits clusters within 2h of first_published, sorted newest-first, capped at 6", async () => {
    response = {
      data: [
        // 10-minute-old cluster (breaking)
        mkCluster({
          id: "fresh",
          first_published: iso(10 * 60 * 1000),
          members: [
            { id: "f1", sourceId: "s1", category: "politika" },
            { id: "f2", sourceId: "s2", category: "politika" },
          ],
        }),
        // 1-hour-old cluster (still breaking)
        mkCluster({
          id: "hourold",
          first_published: iso(60 * 60 * 1000),
          members: [
            { id: "h1", sourceId: "s1", category: "politika" },
            { id: "h2", sourceId: "s2", category: "politika" },
          ],
        }),
        // 3-hour-old cluster (outside window)
        mkCluster({
          id: "stale",
          first_published: iso(3 * 60 * 60 * 1000),
          members: [
            { id: "st1", sourceId: "s1", category: "politika" },
            { id: "st2", sourceId: "s2", category: "politika" },
          ],
        }),
      ],
      error: null,
    };
    const { breakingBundles } = await getPoliticsClusters();
    expect(breakingBundles).toHaveLength(2);
    // Newest first.
    expect(breakingBundles[0].cluster.id).toBe("fresh");
    expect(breakingBundles[1].cluster.id).toBe("hourold");
  });

  it("respects the BREAKING_LIMIT of 6", async () => {
    // Build 8 fresh clusters all within the breaking window.
    const clusters = Array.from({ length: 8 }, (_, i) =>
      mkCluster({
        id: `fresh-${i}`,
        // Offsets 1..8 minutes old, so ordering is deterministic.
        first_published: iso((i + 1) * 60 * 1000),
        members: [
          { id: `a-${i}-1`, sourceId: "s1", category: "politika" },
          { id: `a-${i}-2`, sourceId: "s2", category: "politika" },
        ],
      })
    );
    response = { data: clusters, error: null };

    const { breakingBundles } = await getPoliticsClusters();
    expect(breakingBundles).toHaveLength(6);
    // Newest 6 survive; the two oldest (7m, 8m) are dropped.
    expect(breakingBundles[0].cluster.id).toBe("fresh-0"); // 1m old
    expect(breakingBundles[5].cluster.id).toBe("fresh-5"); // 6m old
  });
});

// ---------------------------------------------------------------------------
// R1/R4 importance ranking
// ---------------------------------------------------------------------------

describe("importance ranking", () => {
  it("sorts bundles by score descending and caps at DISPLAY_LIMIT (30)", async () => {
    // 35 clusters. Give each a different article_count so scores are
    // strictly decreasing with the ID index. Use a 24h-old first_published
    // to neutralize the velocity bonus (no recent articles).
    const clusters = Array.from({ length: 35 }, (_, i) => {
      const count = 35 - i; // c0 has 35 articles, c34 has 1
      const members = Array.from({ length: count }, (_, j) => ({
        id: `a-${i}-${j}`,
        sourceId: `s-${i}-${j}`,
        category: "politika" as const,
        published_at: iso(24 * 60 * 60 * 1000), // old, so no velocity
      }));
      return mkCluster({
        id: `c-${i}`,
        first_published: iso(24 * 60 * 60 * 1000),
        members,
      });
    });
    response = { data: clusters, error: null };

    const { bundles, prefilterCount } = await getPoliticsClusters();
    expect(prefilterCount).toBe(35);
    // DISPLAY_LIMIT = 30.
    expect(bundles).toHaveLength(30);
    // Top-ranked is the one with the most articles.
    expect(bundles[0].cluster.id).toBe("c-0");
    // Last in the top-30 is c-29; c-30..c-34 are dropped.
    expect(bundles[29].cluster.id).toBe("c-29");
    const includedIds = new Set(bundles.map((b) => b.cluster.id));
    expect(includedIds.has("c-34")).toBe(false);
  });

  it("rewards velocity: a fresh 5-source cluster beats an older 5-source cluster", async () => {
    // Two clusters, same size. One's articles landed ~30 minutes ago
    // (velocity = 1); the other's all landed 22 hours ago (velocity ≈ 0
    // and heavy time decay).
    const fresh = mkCluster({
      id: "fresh",
      first_published: iso(30 * 60 * 1000),
      members: Array.from({ length: 5 }, (_, i) => ({
        id: `f-${i}`,
        sourceId: `sf-${i}`,
        category: "politika" as const,
        published_at: iso(30 * 60 * 1000),
      })),
    });
    const old = mkCluster({
      id: "old",
      first_published: iso(22 * 60 * 60 * 1000),
      members: Array.from({ length: 5 }, (_, i) => ({
        id: `o-${i}`,
        sourceId: `so-${i}`,
        category: "politika" as const,
        published_at: iso(22 * 60 * 60 * 1000),
      })),
    });
    // Use a first_published JUST OUTSIDE the breaking window for `fresh`
    // so it still lands in `bundles` (otherwise the breaking strip would
    // be relevant but the ranked list still includes breaking clusters).
    // With 30 minutes we're inside the breaking window — but the R1
    // ranked list runs over all candidates anyway, so it's fine.
    response = { data: [old, fresh], error: null };

    const { bundles } = await getPoliticsClusters();
    expect(bundles).toHaveLength(2);
    expect(bundles[0].cluster.id).toBe("fresh");
    expect(bundles[1].cluster.id).toBe("old");
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("getPoliticsClusters error handling", () => {
  it("throws when the query errors — an empty feed must never be cached as truth", async () => {
    // The caller is wrapped in `"use cache"`: a thrown error prevents the
    // bad value from entering the cache (Next serves the last good entry),
    // whereas returning {bundles: []} would pin an empty homepage for the
    // full revalidate window after a single Supabase blip.
    response = { data: null, error: { message: "db down" } };
    await expect(getPoliticsClusters()).rejects.toThrow(/db down/);
  });

  it("returns an empty result when the query returns no rows", async () => {
    response = { data: [], error: null };
    const result = await getPoliticsClusters();
    expect(result).toEqual({
      bundles: [],
      breakingBundles: [],
      prefilterCount: 0,
    });
  });
});
