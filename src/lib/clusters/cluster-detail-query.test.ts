import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
//
// next/cache: the module under test is wrapped in `"use cache"` with
//   cacheLife/cacheTag side-effects. In Vitest (no Next.js SWC transform)
//   the directive is a no-op string literal; we only need the two helpers
//   to exist so the import doesn't blow up.
//
// @/lib/supabase/server: the whole point. We replace createServerClient
//   with a factory that returns a fake client built by `makeFakeClient`
//   (see below). Each test sets the canned responses before calling the
//   fetcher so we can verify (a) that the builder issued the right
//   queries against the right tables/columns/filters, and (b) that the
//   builder reshapes those rows correctly.

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

// Record of every (from, chain-call) pair the builder emits, so each test
// can assert the expected PostgREST query shape.
type CallLog = Array<{
  table: string;
  steps: Array<{ method: string; args: unknown[] }>;
}>;

interface FakeResult {
  data: unknown;
  error: { message: string } | null;
}

// Response lookup keyed by table name. maybeSingle responses go in a
// separate slot because the fetcher uses both terminal kinds.
interface ResponseMap {
  [table: string]: {
    maybeSingle?: FakeResult;
    returns?: FakeResult;
  };
}

let callLog: CallLog = [];
let responses: ResponseMap = {};

function makeFakeClient() {
  return {
    from(table: string) {
      const steps: Array<{ method: string; args: unknown[] }> = [];
      callLog.push({ table, steps });

      // Builder object. Every intermediate method (.select, .eq, .order)
      // just records the call and returns `this`. The terminal methods
      // (.maybeSingle, .returns) resolve with the canned response for
      // the table.
      const builder: Record<string, unknown> = {};
      const chainable = ["select", "eq", "order", "gte", "limit"];
      for (const name of chainable) {
        builder[name] = (...args: unknown[]) => {
          steps.push({ method: name, args });
          return builder;
        };
      }

      builder.maybeSingle = async (...args: unknown[]) => {
        steps.push({ method: "maybeSingle", args });
        const r = responses[table]?.maybeSingle;
        return r ?? { data: null, error: null };
      };

      // `.returns<T>()` is itself chainable — the fetcher calls it AFTER
      // the final .eq/.order — so in the real SDK it returns the
      // terminal Promise. We support both: it's `await`-able AND
      // chainable. PromiseLike `.then` makes `await` work.
      builder.returns = (...args: unknown[]) => {
        steps.push({ method: "returns", args });
        const r = responses[table]?.returns ?? { data: [], error: null };
        // Return a thenable so `await builder.....returns<T>()` works.
        return {
          then: (onFulfilled: (v: FakeResult) => unknown) =>
            Promise.resolve(r).then(onFulfilled),
        };
      };

      return builder;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(() => makeFakeClient()),
}));

// Import AFTER mocks are declared.
import { getClusterDetail } from "./cluster-detail-query";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkClusterRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cluster-1",
    title_tr: "Original başlık",
    title_tr_neutral: null,
    summary_tr: "Kısa özet",
    article_count: 5,
    bias_distribution: {
      pro_government: 2,
      opposition: 3,
    },
    is_blindspot: false,
    blindspot_side: null,
    first_published: "2026-04-17T08:00:00Z",
    updated_at: "2026-04-17T12:00:00Z",
    ...overrides,
  };
}

function mkSource(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Source ${id}`,
    slug: `src-${id}`,
    url: `https://${id}.example`,
    rss_url: `https://${id}.example/rss`,
    bias: "center",
    logo_url: null,
    active: true,
    ...overrides,
  };
}

function mkEmbeddedMember(
  articleId: string,
  sourceId: string,
  publishedAt: string,
  overrides: { article?: Record<string, unknown>; source?: Record<string, unknown> } = {}
) {
  return {
    article: {
      id: articleId,
      title: `Article ${articleId}`,
      url: `https://example.com/${articleId}`,
      published_at: publishedAt,
      image_url: null,
      content_hash: null,
      source: mkSource(sourceId, overrides.source ?? {}),
      ...(overrides.article ?? {}),
    },
  };
}

beforeEach(() => {
  callLog = [];
  responses = {};
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getClusterDetail query shape", () => {
  it("queries clusters, cluster_articles, and sources with the documented filters", async () => {
    responses.clusters = { maybeSingle: { data: mkClusterRow(), error: null } };
    responses.cluster_articles = {
      returns: {
        data: [
          mkEmbeddedMember("a1", "s1", "2026-04-17T10:00:00Z"),
          mkEmbeddedMember("a2", "s2", "2026-04-17T09:00:00Z"),
        ],
        error: null,
      },
    };
    responses.sources = {
      returns: {
        data: [
          mkSource("s1"),
          mkSource("s2", { name: "Other" }),
          mkSource("s3"),
        ],
        error: null,
      },
    };

    await getClusterDetail("cluster-1");

    // clusters query: select → eq("id", …) → maybeSingle
    const clustersCall = callLog.find((c) => c.table === "clusters");
    expect(clustersCall).toBeTruthy();
    const clusterSelect = clustersCall!.steps.find((s) => s.method === "select");
    expect(clusterSelect).toBeTruthy();
    // Column list must include the neutral-headline column and the
    // blindspot pair — these are load-bearing for the page render.
    const selectArg = clusterSelect!.args[0] as string;
    expect(selectArg).toMatch(/\btitle_tr_neutral\b/);
    expect(selectArg).toMatch(/\bis_blindspot\b/);
    expect(selectArg).toMatch(/\bblindspot_side\b/);
    expect(selectArg).toMatch(/\bbias_distribution\b/);
    const clusterEq = clustersCall!.steps.find((s) => s.method === "eq");
    expect(clusterEq!.args).toEqual(["id", "cluster-1"]);
    expect(
      clustersCall!.steps.some((s) => s.method === "maybeSingle")
    ).toBe(true);

    // cluster_articles query: embedded select + eq("cluster_id", …).
    const membersCall = callLog.find((c) => c.table === "cluster_articles");
    expect(membersCall).toBeTruthy();
    const embedded = membersCall!.steps.find((s) => s.method === "select")!
      .args[0] as string;
    expect(embedded).toMatch(/article:articles/);
    expect(embedded).toMatch(/source:sources/);
    expect(embedded).toMatch(/\bcontent_hash\b/);
    const membersEq = membersCall!.steps.find((s) => s.method === "eq");
    expect(membersEq!.args).toEqual(["cluster_id", "cluster-1"]);

    // sources query: active=true, ordered by name.
    const sourcesCall = callLog.find((c) => c.table === "sources");
    expect(sourcesCall).toBeTruthy();
    const activeEq = sourcesCall!.steps.find((s) => s.method === "eq");
    expect(activeEq!.args).toEqual(["active", true]);
    const orderStep = sourcesCall!.steps.find((s) => s.method === "order");
    expect(orderStep!.args).toEqual(["name"]);
  });
});

describe("getClusterDetail row shaping", () => {
  it("returns a structured detail with deduped members sorted newest-first", async () => {
    responses.clusters = { maybeSingle: { data: mkClusterRow(), error: null } };
    responses.cluster_articles = {
      returns: {
        data: [
          // Same source s1 appears twice — dedupe should keep the earliest
          // published (11:00) and drop the later (12:00).
          mkEmbeddedMember("a-late-s1", "s1", "2026-04-17T12:00:00Z"),
          mkEmbeddedMember("a-early-s1", "s1", "2026-04-17T11:00:00Z"),
          mkEmbeddedMember("a-s2", "s2", "2026-04-17T13:00:00Z"),
        ],
        error: null,
      },
    };
    responses.sources = { returns: { data: [mkSource("s1")], error: null } };

    const result = await getClusterDetail("cluster-1");
    expect(result).not.toBeNull();

    // Two distinct sources survive dedupe.
    expect(result!.members).toHaveLength(2);

    // Newest-first: s2 (13:00) before s1 (11:00, the earlier article kept).
    expect(result!.members[0].source.id).toBe("s2");
    expect(result!.members[0].article.id).toBe("a-s2");
    expect(result!.members[1].source.id).toBe("s1");
    expect(result!.members[1].article.id).toBe("a-early-s1");

    // article_count reflects the POST-dedupe truth, not the DB column.
    expect(result!.cluster.article_count).toBe(2);
    // But everything else comes from the cluster row.
    expect(result!.cluster.id).toBe("cluster-1");
    expect(result!.cluster.summary_tr).toBe("Kısa özet");
    expect(result!.cluster.is_blindspot).toBe(false);

    // allSources is passed through.
    expect(result!.allSources).toHaveLength(1);
    expect(result!.allSources[0].id).toBe("s1");
  });

  it("prefers the neutral headline when non-empty and falls back to title_tr otherwise", async () => {
    responses.cluster_articles = { returns: { data: [], error: null } };
    responses.sources = { returns: { data: [], error: null } };

    // 1. neutral present and non-empty → wins
    responses.clusters = {
      maybeSingle: {
        data: mkClusterRow({
          title_tr: "orig",
          title_tr_neutral: "neutral version",
        }),
        error: null,
      },
    };
    let result = await getClusterDetail("cluster-1");
    expect(result!.cluster.title_tr).toBe("neutral version");

    // 2. neutral present but whitespace-only → falls back
    callLog = [];
    responses.clusters = {
      maybeSingle: {
        data: mkClusterRow({ title_tr: "orig", title_tr_neutral: "   " }),
        error: null,
      },
    };
    result = await getClusterDetail("cluster-1");
    expect(result!.cluster.title_tr).toBe("orig");

    // 3. neutral null → falls back
    callLog = [];
    responses.clusters = {
      maybeSingle: {
        data: mkClusterRow({ title_tr: "orig", title_tr_neutral: null }),
        error: null,
      },
    };
    result = await getClusterDetail("cluster-1");
    expect(result!.cluster.title_tr).toBe("orig");
  });

  it("normalizes malformed bias_distribution blobs to the empty shape", async () => {
    // bias_distribution may come back as string / number / wrong keys.
    // normalizeDistribution should return the canonical all-zero shape
    // with only valid numeric entries copied through.
    responses.clusters = {
      maybeSingle: {
        data: mkClusterRow({
          bias_distribution: {
            pro_government: 3,
            not_a_real_key: 99, // ignored
            opposition: "not a number", // ignored
            center: Number.NaN, // ignored (not finite)
          },
        }),
        error: null,
      },
    };
    responses.cluster_articles = { returns: { data: [], error: null } };
    responses.sources = { returns: { data: [], error: null } };

    const result = await getClusterDetail("cluster-1");
    const dist = result!.cluster.bias_distribution;

    // Real numeric entry preserved.
    expect(dist.pro_government).toBe(3);
    // Invalid entries zeroed.
    expect(dist.opposition).toBe(0);
    expect(dist.center).toBe(0);
    // All ten keys present.
    expect(Object.keys(dist).sort()).toEqual(
      [
        "center",
        "gov_leaning",
        "international",
        "islamist_conservative",
        "nationalist",
        "opposition",
        "opposition_leaning",
        "pro_government",
        "pro_kurdish",
        "state_media",
      ].sort()
    );
  });

  it("returns the empty distribution when bias_distribution is null/undefined", async () => {
    responses.clusters = {
      maybeSingle: {
        data: mkClusterRow({ bias_distribution: null }),
        error: null,
      },
    };
    responses.cluster_articles = { returns: { data: [], error: null } };
    responses.sources = { returns: { data: [], error: null } };

    const result = await getClusterDetail("cluster-1");
    expect(result!.cluster.bias_distribution.pro_government).toBe(0);
    expect(result!.cluster.bias_distribution.opposition).toBe(0);
  });

  it("drops member rows with null embedded article or null source (dangling FK)", async () => {
    responses.clusters = { maybeSingle: { data: mkClusterRow(), error: null } };
    responses.cluster_articles = {
      returns: {
        data: [
          { article: null }, // dangling FK: no article
          {
            article: {
              id: "a-no-source",
              title: "t",
              url: "u",
              published_at: "2026-04-17T10:00:00Z",
              image_url: null,
              source: null, // dangling FK: no source
            },
          },
          mkEmbeddedMember("a-ok", "s-ok", "2026-04-17T10:00:00Z"),
        ],
        error: null,
      },
    };
    responses.sources = { returns: { data: [], error: null } };

    const result = await getClusterDetail("cluster-1");
    expect(result!.members).toHaveLength(1);
    expect(result!.members[0].source.id).toBe("s-ok");
  });
});

describe("getClusterDetail error handling", () => {
  // NOTE: "cluster row errors → null" was the old contract; errors now
  // throw (see the cache-poisoning tests below). Only a genuine
  // maybeSingle miss maps to null/notFound.

  it("returns null when the cluster is not found (maybeSingle → null)", async () => {
    responses.clusters = { maybeSingle: { data: null, error: null } };
    responses.cluster_articles = { returns: { data: [], error: null } };
    responses.sources = { returns: { data: [], error: null } };
    const result = await getClusterDetail("does-not-exist");
    expect(result).toBeNull();
  });

  it("throws when the cluster query errors — a transient failure must not cache as a 404", async () => {
    // Returning null here makes the page call notFound(), and `"use cache"`
    // would pin that null for the detail TTL — i.e. a real cluster serves
    // a cached 404 for minutes after a single Supabase blip. Throwing keeps
    // the bad result out of the cache.
    responses.clusters = {
      maybeSingle: { data: null, error: { message: "cluster boom" } },
    };
    responses.cluster_articles = { returns: { data: [], error: null } };
    responses.sources = { returns: { data: [], error: null } };

    await expect(getClusterDetail("cluster-1")).rejects.toThrow(
      /cluster boom/,
    );
  });

  it("throws when the members query errors — a memberless detail must not be cached", async () => {
    responses.clusters = { maybeSingle: { data: mkClusterRow(), error: null } };
    responses.cluster_articles = {
      returns: { data: null, error: { message: "members boom" } },
    };
    responses.sources = { returns: { data: [], error: null } };

    await expect(getClusterDetail("cluster-1")).rejects.toThrow(
      /members boom/,
    );
  });

  it("still renders when only the supplemental sources query errored", async () => {
    // The 144-source directory is supplemental (MediaDna dimming) — a
    // failure there degrades gracefully to an empty list rather than
    // taking down the whole detail page.
    responses.clusters = { maybeSingle: { data: mkClusterRow(), error: null } };
    responses.cluster_articles = { returns: { data: [], error: null } };
    responses.sources = {
      returns: { data: null, error: { message: "sources boom" } },
    };

    const result = await getClusterDetail("cluster-1");
    expect(result).not.toBeNull();
    expect(result!.allSources).toEqual([]);
    expect(result!.cluster.id).toBe("cluster-1");
  });

  it("gracefully handles empty member + source results", async () => {
    responses.clusters = { maybeSingle: { data: mkClusterRow(), error: null } };
    responses.cluster_articles = { returns: { data: [], error: null } };
    responses.sources = { returns: { data: [], error: null } };

    const result = await getClusterDetail("cluster-1");
    expect(result!.members).toEqual([]);
    expect(result!.allSources).toEqual([]);
    expect(result!.cluster.article_count).toBe(0); // post-dedupe count
  });
});

describe("getClusterDetail wire signal", () => {
  it("flags wire redistribution when 5 members collapse to 2 distinct hashes", async () => {
    responses.clusters = { maybeSingle: { data: mkClusterRow(), error: null } };
    responses.cluster_articles = {
      returns: {
        data: [
          mkEmbeddedMember("a1", "s1", "2026-04-17T10:00:00Z", {
            article: { content_hash: "hash-a" },
          }),
          mkEmbeddedMember("a2", "s2", "2026-04-17T09:00:00Z", {
            article: { content_hash: "hash-a" },
          }),
          mkEmbeddedMember("a3", "s3", "2026-04-17T08:00:00Z", {
            article: { content_hash: "hash-a" },
          }),
          mkEmbeddedMember("a4", "s4", "2026-04-17T07:00:00Z", {
            article: { content_hash: "hash-b" },
          }),
          mkEmbeddedMember("a5", "s5", "2026-04-17T06:00:00Z", {
            article: { content_hash: "hash-b" },
          }),
        ],
        error: null,
      },
    };
    responses.sources = { returns: { data: [], error: null } };

    const result = await getClusterDetail("cluster-1");
    expect(result!.wire.isWireRedistribution).toBe(true);
    expect(result!.wire.effectiveArticleCount).toBe(2);
    expect(result!.wire.memberCount).toBe(5);
  });

  it("does not flag wire redistribution when 5 members have 5 distinct hashes", async () => {
    responses.clusters = { maybeSingle: { data: mkClusterRow(), error: null } };
    responses.cluster_articles = {
      returns: {
        data: [
          mkEmbeddedMember("a1", "s1", "2026-04-17T10:00:00Z", {
            article: { content_hash: "hash-1" },
          }),
          mkEmbeddedMember("a2", "s2", "2026-04-17T09:00:00Z", {
            article: { content_hash: "hash-2" },
          }),
          mkEmbeddedMember("a3", "s3", "2026-04-17T08:00:00Z", {
            article: { content_hash: "hash-3" },
          }),
          mkEmbeddedMember("a4", "s4", "2026-04-17T07:00:00Z", {
            article: { content_hash: "hash-4" },
          }),
          mkEmbeddedMember("a5", "s5", "2026-04-17T06:00:00Z", {
            article: { content_hash: "hash-5" },
          }),
        ],
        error: null,
      },
    };
    responses.sources = { returns: { data: [], error: null } };

    const result = await getClusterDetail("cluster-1");
    expect(result!.wire.isWireRedistribution).toBe(false);
    expect(result!.wire.effectiveArticleCount).toBe(5);
    expect(result!.wire.memberCount).toBe(5);
  });

  it("never collapses null content_hash members into a wire signal", async () => {
    responses.clusters = { maybeSingle: { data: mkClusterRow(), error: null } };
    responses.cluster_articles = {
      returns: {
        data: [
          mkEmbeddedMember("a1", "s1", "2026-04-17T10:00:00Z", {
            article: { content_hash: null },
          }),
          mkEmbeddedMember("a2", "s2", "2026-04-17T09:00:00Z", {
            article: { content_hash: null },
          }),
          mkEmbeddedMember("a3", "s3", "2026-04-17T08:00:00Z", {
            article: { content_hash: null },
          }),
          mkEmbeddedMember("a4", "s4", "2026-04-17T07:00:00Z", {
            article: { content_hash: null },
          }),
          mkEmbeddedMember("a5", "s5", "2026-04-17T06:00:00Z", {
            article: { content_hash: null },
          }),
        ],
        error: null,
      },
    };
    responses.sources = { returns: { data: [], error: null } };

    const result = await getClusterDetail("cluster-1");
    expect(result!.wire.isWireRedistribution).toBe(false);
    expect(result!.wire.effectiveArticleCount).toBe(5);
  });

  it("never flags wire when fewer than 3 members share the same hash", async () => {
    responses.clusters = { maybeSingle: { data: mkClusterRow(), error: null } };
    responses.cluster_articles = {
      returns: {
        data: [
          mkEmbeddedMember("a1", "s1", "2026-04-17T10:00:00Z", {
            article: { content_hash: "hash-a" },
          }),
          mkEmbeddedMember("a2", "s2", "2026-04-17T09:00:00Z", {
            article: { content_hash: "hash-a" },
          }),
        ],
        error: null,
      },
    };
    responses.sources = { returns: { data: [], error: null } };

    const result = await getClusterDetail("cluster-1");
    expect(result!.wire.isWireRedistribution).toBe(false);
    expect(result!.wire.effectiveArticleCount).toBe(2);
    expect(result!.wire.memberCount).toBe(2);
  });

  it("computes the wire signal over per-source-deduped members, not raw rows", async () => {
    // 4 raw rows, but 3 of them share source s1 (same-source dedupe keeps
    // only the earliest). Raw: 2 unique hashes / 4 rows = 0.5 → would read
    // as wire if computed before dedupe. After dedupe: 2 members (s1, s2),
    // below the 3-member wire floor, so it must NOT be flagged.
    responses.clusters = { maybeSingle: { data: mkClusterRow(), error: null } };
    responses.cluster_articles = {
      returns: {
        data: [
          mkEmbeddedMember("a1", "s1", "2026-04-17T10:00:00Z", {
            article: { content_hash: "hash-a" },
          }),
          mkEmbeddedMember("a2", "s1", "2026-04-17T09:00:00Z", {
            article: { content_hash: "hash-a" },
          }),
          mkEmbeddedMember("a3", "s1", "2026-04-17T08:00:00Z", {
            article: { content_hash: "hash-a" },
          }),
          mkEmbeddedMember("a4", "s2", "2026-04-17T07:00:00Z", {
            article: { content_hash: "hash-b" },
          }),
        ],
        error: null,
      },
    };
    responses.sources = { returns: { data: [], error: null } };

    const result = await getClusterDetail("cluster-1");
    expect(result!.cluster.article_count).toBe(2);
    expect(result!.wire.memberCount).toBe(2);
    expect(result!.wire.effectiveArticleCount).toBe(2);
    expect(result!.wire.isWireRedistribution).toBe(false);
  });
});
