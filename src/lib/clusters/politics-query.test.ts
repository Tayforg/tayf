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

// Pack C (feed-health-gated blindspots): fetchPoliticsClusters() now calls
// getZoneFeedHealth() once per build. That function does its own Supabase
// round-trip against the `sources` table — mocking it here (instead of
// wiring a second table into the hand-rolled `makeFakeClient` above) keeps
// every pre-existing test's "exactly one clusters query" assertion true,
// and keeps this file's health-suppression tests independent of
// feed-health.ts's own query shape (covered by feed-health.test.ts).
// `shouldSuppressBlindspot` is kept REAL (imported via importOriginal) so
// these are still integration tests of the suppression wiring, not just of
// the mock.
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

import { getPoliticsClusters } from "./politics-query";
import type { ZoneFeedHealth } from "./feed-health";

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
  /** Migration 071 — omit for "column absent" (pre-071 row, pass-through). */
  blindspot_recall_veto?: boolean | null;
  first_published?: string;
  updated_at?: string;
  members: Array<{
    id: string;
    title?: string;
    sourceId: string;
    sourceName?: string;
    bias?: string;
    kind?: string | null;
    category?: string;
    content_hash?: string | null;
    published_at?: string;
    image_url?: string | null;
    /** BL-13 rights gate — omit for "flag absent, treated as allowed". */
    image_allowed?: boolean;
    /** Migration 089 ("ADMIT") — omit for "never admitted". */
    politics_admitted_at?: string | null;
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
    ...(opts.blindspot_recall_veto !== undefined
      ? { blindspot_recall_veto: opts.blindspot_recall_veto }
      : {}),
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
        politics_admitted_at: m.politics_admitted_at ?? null,
        sources: {
          id: m.sourceId,
          name: m.sourceName ?? `Source ${m.sourceId}`,
          bias: m.bias ?? "center",
          logo_url: null,
          kind: m.kind,
          image_allowed: m.image_allowed,
        },
      },
    })),
  };
}

beforeEach(() => {
  callLog = [];
  response = { data: [], error: null };
  feedHealth.getZoneFeedHealth.mockReset();
  feedHealth.getZoneFeedHealth.mockResolvedValue(null);
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
    // sources embed must carry kind (voting vs non-voting source).
    expect(selectArg).toMatch(/sources\s*\([^)]*\bkind\b/);
    // BL-13: sources embed must carry both rights flags.
    expect(selectArg).toMatch(/sources\s*\([^)]*\bimage_allowed\b/);
    expect(selectArg).toMatch(/sources\s*\([^)]*\bexcerpt_allowed\b/);
    // H2 neutral-headline column.
    expect(selectArg).toMatch(/\btitle_tr_neutral\b/);
    // Migration 089 ("ADMIT"): the 60%-politics gate must see the stamp.
    expect(selectArg).toMatch(/\bpolitics_admitted_at\b/);

    // ≥2 members, newest clusters first, capped at 200 (CANDIDATE_LIMIT).
    const gte = steps.find((s) => s.method === "gte");
    expect(gte!.args).toEqual(["article_count", 2]);
    // Archived clusters (migration 037) never reach the home feed / RSS.
    expect(steps.filter((s) => s.method === "eq").map((s) => s.args)).toEqual(
      [["is_archived", false]]
    );
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
// Migration 089 ("ADMIT"): politics-admitted members count toward the 60%
// gate exactly like a politika/son_dakika category member.
// ---------------------------------------------------------------------------

describe("politics-admission gate (migration 089)", () => {
  it("2 politika + 2 admitted (non-politika) members pass the 60% gate", async () => {
    response = {
      data: [
        mkCluster({
          id: "c-admitted-pass",
          members: [
            { id: "a1", sourceId: "s1", category: "politika" },
            { id: "a2", sourceId: "s2", category: "politika" },
            { id: "a3", sourceId: "s3", category: "ekonomi", politics_admitted_at: iso(0) },
            { id: "a4", sourceId: "s4", category: "ekonomi", politics_admitted_at: iso(0) },
          ],
        }),
      ],
      error: null,
    };
    const { bundles } = await getPoliticsClusters();
    expect(bundles).toHaveLength(1);
  });

  it("2 + 2 non-admitted (unstamped) members fail the 60% gate", async () => {
    response = {
      data: [
        mkCluster({
          id: "c-unstamped-fail",
          members: [
            { id: "a1", sourceId: "s1", category: "politika" },
            { id: "a2", sourceId: "s2", category: "politika" },
            { id: "a3", sourceId: "s3", category: "ekonomi", politics_admitted_at: null },
            { id: "a4", sourceId: "s4", category: "ekonomi", politics_admitted_at: null },
          ],
        }),
      ],
      error: null,
    };
    const { bundles } = await getPoliticsClusters();
    expect(bundles).toHaveLength(0);
  });

  it("1 politika + 2 admitted members passes (3/3 = 100% >= 60%)", async () => {
    response = {
      data: [
        mkCluster({
          id: "c-1plus2",
          members: [
            { id: "a1", sourceId: "s1", category: "politika" },
            { id: "a2", sourceId: "s2", category: "ekonomi", politics_admitted_at: iso(0) },
            { id: "a3", sourceId: "s3", category: "ekonomi", politics_admitted_at: iso(0) },
          ],
        }),
      ],
      error: null,
    };
    const { bundles } = await getPoliticsClusters();
    expect(bundles).toHaveLength(1);
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
// BL-13 — per-source rights gate on the hero/card image candidate list
// ---------------------------------------------------------------------------

describe("BL-13 image_allowed gate", () => {
  it("nulls image_url for a member whose source has image_allowed: false, leaving other members untouched", async () => {
    response = {
      data: [
        mkCluster({
          id: "c1",
          members: [
            {
              id: "a-blocked",
              sourceId: "s-blocked",
              image_url: "https://cdn.blocked.example/foto.jpg",
              image_allowed: false,
              published_at: iso(5 * 60 * 1000),
            },
            {
              id: "a-allowed",
              sourceId: "s-allowed",
              image_url: "https://cdn.allowed.example/foto.jpg",
              image_allowed: true,
              published_at: iso(10 * 60 * 1000),
            },
          ],
        }),
      ],
      error: null,
    };
    const { bundles } = await getPoliticsClusters();
    const byId = Object.fromEntries(bundles[0].articles.map((a) => [a.id, a]));
    // Blocked source's image never surfaces as a candidate.
    expect(byId["a-blocked"].image_url).toBeNull();
    // The allowed source's image is untouched.
    expect(byId["a-allowed"].image_url).toBe(
      "https://cdn.allowed.example/foto.jpg",
    );
  });

  it("leaves image_url untouched when image_allowed is absent (legacy fixture, treated as allowed)", async () => {
    response = {
      data: [
        mkCluster({
          id: "c1",
          members: [
            {
              id: "a-legacy",
              sourceId: "s-legacy",
              image_url: "https://cdn.legacy.example/foto.jpg",
              // image_allowed intentionally omitted.
            },
          ],
        }),
      ],
      error: null,
    };
    const { bundles } = await getPoliticsClusters();
    expect(bundles[0].articles[0].image_url).toBe(
      "https://cdn.legacy.example/foto.jpg",
    );
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
// Zone-diversity ranking is source-kind aware (R1 diversity bonus)
// ---------------------------------------------------------------------------

describe("zone-diversity ranking (source-kind aware)", () => {
  it("an aggregator's bias must not fabricate a zone for the R1 diversity bonus", async () => {
    // Cluster A (listed first): 3 pro_government outlets + 1 "center"
    // member whose kind is "aggregator" — that member never votes, so it
    // must not count toward zone diversity either. Real zones = 1
    // (iktidar only).
    const clusterA = mkCluster({
      id: "cluster-a",
      members: [
        { id: "a1", sourceId: "sa1", bias: "pro_government" },
        { id: "a2", sourceId: "sa2", bias: "pro_government" },
        { id: "a3", sourceId: "sa3", bias: "pro_government" },
        { id: "a4", sourceId: "sa4", bias: "center", kind: "aggregator" },
      ],
    });
    // Cluster B: 3 pro_government outlets + 1 opposition outlet (votes).
    // Real zones = 2 (iktidar + muhalefet).
    const clusterB = mkCluster({
      id: "cluster-b",
      members: [
        { id: "b1", sourceId: "sb1", bias: "pro_government" },
        { id: "b2", sourceId: "sb2", bias: "pro_government" },
        { id: "b3", sourceId: "sb3", bias: "pro_government" },
        { id: "b4", sourceId: "sb4", bias: "opposition" },
      ],
    });
    response = { data: [clusterA, clusterB], error: null };

    const { bundles } = await getPoliticsClusters();
    // B has real zone-diversity 2 vs A's 1 (the aggregator doesn't count),
    // so B must outrank A. Without the fix both would score zones=2, tie
    // on every other term, and A's input position would win the stable
    // sort instead.
    expect(bundles[0].cluster.id).toBe("cluster-b");
    expect(bundles[1].cluster.id).toBe("cluster-a");
  });
});

// ---------------------------------------------------------------------------
// Pack C — feed-health-gated blindspot suppression (read-path only)
// ---------------------------------------------------------------------------

describe("feed-health gated blindspot suppression", () => {
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

  it("withdraws is_blindspot/blindspot_side and logs once when the silent pole zone is degraded", async () => {
    feedHealth.getZoneFeedHealth.mockResolvedValue(mkHealth({ muhalefet: true }));
    response = {
      data: [
        mkCluster({
          id: "suppressed",
          is_blindspot: true,
          blindspot_side: "pro_government",
          bias_distribution: { pro_government: 9, opposition: 1 },
          members: [
            { id: "a1", sourceId: "s1", category: "politika" },
            { id: "a2", sourceId: "s2", category: "politika" },
          ],
        }),
      ],
      error: null,
    };
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const { bundles } = await getPoliticsClusters();
    expect(bundles).toHaveLength(1);
    expect(bundles[0].cluster.is_blindspot).toBe(false);
    expect(bundles[0].cluster.blindspot_side).toBeNull();
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]?.[0]).toBe(
      "[feed-health] suppressed blindspot for cluster suppressed (silent zone muhalefet: 2/10 feeds healthy)",
    );
    infoSpy.mockRestore();
  });

  it("leaves is_blindspot/blindspot_side untouched when feed health is unknown (null passthrough)", async () => {
    feedHealth.getZoneFeedHealth.mockResolvedValue(null);
    response = {
      data: [
        mkCluster({
          id: "unaffected-unknown-health",
          is_blindspot: true,
          blindspot_side: "pro_government",
          bias_distribution: { pro_government: 9, opposition: 1 },
          members: [
            { id: "a1", sourceId: "s1", category: "politika" },
            { id: "a2", sourceId: "s2", category: "politika" },
          ],
        }),
      ],
      error: null,
    };
    const { bundles } = await getPoliticsClusters();
    expect(bundles[0].cluster.is_blindspot).toBe(true);
    expect(bundles[0].cluster.blindspot_side).toBe("pro_government");
  });

  it("leaves is_blindspot/blindspot_side untouched when the silent pole zone is healthy (regression)", async () => {
    feedHealth.getZoneFeedHealth.mockResolvedValue(mkHealth({}));
    response = {
      data: [
        mkCluster({
          id: "unaffected-healthy-silent-side",
          is_blindspot: true,
          blindspot_side: "pro_government",
          bias_distribution: { pro_government: 9, opposition: 1 },
          members: [
            { id: "a1", sourceId: "s1", category: "politika" },
            { id: "a2", sourceId: "s2", category: "politika" },
          ],
        }),
      ],
      error: null,
    };
    const { bundles } = await getPoliticsClusters();
    expect(bundles[0].cluster.is_blindspot).toBe(true);
    expect(bundles[0].cluster.blindspot_side).toBe("pro_government");
  });

  it("never suppresses a cluster that isn't already a blindspot", async () => {
    feedHealth.getZoneFeedHealth.mockResolvedValue(mkHealth({ muhalefet: true }));
    response = {
      data: [
        mkCluster({
          id: "not-a-blindspot",
          is_blindspot: false,
          blindspot_side: null,
          bias_distribution: { pro_government: 9, opposition: 1 },
          members: [
            { id: "a1", sourceId: "s1", category: "politika" },
            { id: "a2", sourceId: "s2", category: "politika" },
          ],
        }),
      ],
      error: null,
    };
    const { bundles } = await getPoliticsClusters();
    expect(bundles[0].cluster.is_blindspot).toBe(false);
    expect(bundles[0].cluster.blindspot_side).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Migration 071 — blindspot recall veto (read-path only)
// ---------------------------------------------------------------------------

describe("blindspot recall veto", () => {
  const healthyAll: ZoneFeedHealth = {
    iktidar: { total: 10, healthy: 10, healthyShare: 1, degraded: false },
    bagimsiz: { total: 10, healthy: 10, healthyShare: 1, degraded: false },
    muhalefet: { total: 10, healthy: 10, healthyShare: 1, degraded: false },
  };

  function vetoRow(id: string, veto: boolean | null | undefined) {
    return mkCluster({
      id,
      is_blindspot: true,
      blindspot_side: "pro_government",
      bias_distribution: { pro_government: 9, opposition: 1 },
      ...(veto !== undefined ? { blindspot_recall_veto: veto } : {}),
      members: [
        { id: `${id}-a1`, sourceId: `${id}-s1`, category: "politika" },
        { id: `${id}-a2`, sourceId: `${id}-s2`, category: "politika" },
      ],
    });
  }

  it("selects blindspot_recall_veto on the cluster (CLUSTER_EMBED_SELECT)", async () => {
    await getPoliticsClusters();
    const select = callLog[0]!.steps.find((s) => s.method === "select");
    expect(String(select!.args[0])).toMatch(/\bblindspot_recall_veto\b/);
  });

  it("withdraws the claim on its own — health would NOT suppress — and logs the veto", async () => {
    feedHealth.getZoneFeedHealth.mockResolvedValue(healthyAll);
    response = { data: [vetoRow("vetoed", true)], error: null };
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const { bundles } = await getPoliticsClusters();
    expect(bundles).toHaveLength(1);
    expect(bundles[0].cluster.is_blindspot).toBe(false);
    expect(bundles[0].cluster.blindspot_side).toBeNull();
    const lines = infoSpy.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain("[recall-veto] withdrew blindspot for cluster vetoed");
    expect(lines.some((l) => l.startsWith("[feed-health]"))).toBe(false);
    infoSpy.mockRestore();
  });

  it("vetoes before the feed-health gate (no feed-health log even when the silent zone is degraded)", async () => {
    feedHealth.getZoneFeedHealth.mockResolvedValue({
      ...healthyAll,
      muhalefet: { total: 10, healthy: 2, healthyShare: 0.2, degraded: true },
    });
    response = { data: [vetoRow("vetoed-first", true)], error: null };
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const { bundles } = await getPoliticsClusters();
    expect(bundles[0].cluster.is_blindspot).toBe(false);
    const lines = infoSpy.mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual(["[recall-veto] withdrew blindspot for cluster vetoed-first"]);
    infoSpy.mockRestore();
  });

  it.each([
    ["false", false],
    ["null", null],
    ["absent (pre-071 row)", undefined],
  ])("keeps the blindspot when the veto is %s", async (_label, veto) => {
    feedHealth.getZoneFeedHealth.mockResolvedValue(healthyAll);
    response = { data: [vetoRow("kept", veto)], error: null };
    const { bundles } = await getPoliticsClusters();
    expect(bundles[0].cluster.is_blindspot).toBe(true);
    expect(bundles[0].cluster.blindspot_side).toBe("pro_government");
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("getPoliticsClusters error handling", () => {
  it("rejects when the cache attempt AND the live retry both fail (cron/RSS/home callers rely on the throw)", async () => {
    // The `"use cache"` layer never throws (attemptCached), but the public
    // entry must: the digest/social crons must not send from empty data,
    // rss.xml must 500 rather than serve an empty 200 feed, and the home
    // page's try/catch must reach <FeedUnavailable/>.
    vi.spyOn(console, "error").mockImplementation(() => {});
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

// ---------------------------------------------------------------------------
// E2: fetchPoliticsClusters runs getZoneFeedHealth() and the clusters select
// IN PARALLEL, not serially awaited one after another.
// ---------------------------------------------------------------------------

describe("getPoliticsClusters parallel health + select (E2)", () => {
  it("issues the clusters query before the deferred health promise resolves", async () => {
    response = { data: [], error: null };
    let resolveHealth!: (v: unknown) => void;
    const deferred = new Promise((resolve) => {
      resolveHealth = resolve;
    });
    feedHealth.getZoneFeedHealth.mockReturnValue(deferred);

    const pending = getPoliticsClusters();

    // Flush microtasks so any synchronous work before the first real
    // `await` inside fetchPoliticsClusters has had a chance to run.
    await Promise.resolve();
    await Promise.resolve();

    // The clusters query must already have been issued even though the
    // health promise is still pending — a serial `await
    // getZoneFeedHealth()` before the select would leave callLog empty
    // here.
    expect(callLog).toHaveLength(1);

    resolveHealth(null);
    await pending;
  });
});
