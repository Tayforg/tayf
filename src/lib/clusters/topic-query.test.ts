import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Pack C (/konu) — topic-hub read layer. Modelled line for line on
// src/lib/weekly/weekly-query.test.ts: the shared chainable Supabase fake
// (tests/_helpers/supabase-fake.ts) plus a mocked next/cache so the
// "use cache" directive's cacheLife/cacheTag calls don't throw outside a
// real Next.js request scope. feed-health is mocked the way
// search-query.test.ts mocks it (getZoneFeedHealth stubbed via
// importOriginal, shouldSuppressBlindspot/degradedSilentZone stay real).
//
// The fetchers are pinned against the fake's recorded builder state
// (table / select string / eq / gte / order / range) because the hub's
// honesty depends on the exact window: a dropped .gte() on updated_at
// silently turns "son 7 gün" into "all time", and a dropped
// .eq("is_archived", false) republishes soft-deleted stories.
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

// Mutable fixture the `clusters` table resolver reads on every query. The
// resolver tells THREE reads apart so one fixture object serves both
// getTopicClusters and getTopicCounts (h94-slowroutes-1, two-step read):
//   * a head/exact count query (selectArgs[1].head === true): the counts and the
//     last-page lookup;
//   * the ids-first query (selectArgs[0] === "id", no head option): step 1 of
//     getTopicClusters, which carries the filters, both orders and the range;
//   * the embed query (any other select, the long CLUSTER_EMBED_SELECT string):
//     step 2, which carries only `.in("id", ids)`.
// `fixture.clusters` is the "database": the ids step answers with its ids (in
// the recorded order when applyRecordedOrder is on), the embed step answers with
// the rows whose id was asked for.
const fixture = vi.hoisted(() => ({
  clusters: [] as unknown[],
  /** Error of the ids step (step 1). */
  clustersError: null as { message: string; code?: string } | null,
  /** Throw from the ids step (step 1). */
  clustersThrows: false,
  /** The ids step's builder state (filters, orders, range). */
  clusterState: null as unknown,
  /** Every ids-step state, in call order. */
  idStates: [] as unknown[],
  /** Every embed-step state, in call order. */
  embedStates: [] as unknown[],
  /** Error of the embed step (step 2). */
  embedError: null as { message: string; code?: string } | null,
  /** Throw from the embed step (step 2). */
  embedThrows: false,
  /** Hand the embed rows back reversed, as `.in()` gives no order guarantee. */
  embedReverse: false,
  countStates: [] as unknown[],
  countsBySlug: {} as Record<string, number>,
  countError: null as { message: string } | null,
  // A successful PostgREST response (error: null) can still carry a null
  // count when the total isn't in Content-Range — simulated per-slug so
  // C1-COUNTS-NULL-ZERO's fix (treat null count like the error branch,
  // never `?? 0`) has a regression case.
  countNullSlug: null as string | null,
  /** Make the head/exact count read throw (the last-page lookup's catch path). */
  countThrows: false,
  /** The options object each `createClient(url, key, opts)` call received. */
  clientOpts: [] as unknown[],
  /** Make the list read behave like PostgREST: sort the fixture rows by the
   *  `.order()` calls the code actually recorded (string compare, which is
   *  exact for ISO timestamps and uuids). Off by default: most tests only
   *  need the recorded builder state. */
  applyRecordedOrder: false,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state) => {
        const isCountQuery =
          (state.selectArgs[1] as { head?: boolean } | undefined)?.head === true;
        if (isCountQuery) {
          fixture.countStates.push(state);
          if (fixture.countThrows) throw new Error("count boom");
          if (fixture.countError) {
            return { data: null, error: fixture.countError, count: null };
          }
          const slugEq = state.eq.find((e) => e.col === "topic7");
          const slug = slugEq ? String(slugEq.val) : "";
          if (slug === fixture.countNullSlug) {
            return { data: null, error: null, count: null };
          }
          return { data: null, error: null, count: fixture.countsBySlug[slug] ?? 0 };
        }

        const rows = fixture.clusters as Array<Record<string, unknown>>;

        if (String(state.selectArgs[0]) === "id") {
          // Step 1: ids only.
          fixture.clusterState = state;
          fixture.idStates.push(state);
          if (fixture.clustersThrows) throw new Error("boom");
          if (fixture.clustersError) return { data: null, error: fixture.clustersError };
          let ordered = rows;
          if (fixture.applyRecordedOrder) {
            const keys = state.order.map((o) => ({
              col: o.col,
              sign: (o.opts as { ascending?: boolean } | undefined)?.ascending === false ? -1 : 1,
            }));
            ordered = [...rows].sort((a, b) => {
              for (const { col, sign } of keys) {
                const x = String(a[col]);
                const y = String(b[col]);
                if (x !== y) return x < y ? -sign : sign;
              }
              return 0;
            });
          }
          return { data: ordered.map((r) => ({ id: r.id })), error: null };
        }

        // Step 2: the embed, restricted to the ids it was asked for.
        fixture.embedStates.push(state);
        if (fixture.embedThrows) throw new Error("embed boom");
        if (fixture.embedError) return { data: null, error: fixture.embedError };
        const wanted = new Set(
          (state.in.find((i) => i.col === "id")?.vals ?? []).map(String),
        );
        const embedded = rows.filter((r) => wanted.has(String(r.id)));
        return { data: fixture.embedReverse ? [...embedded].reverse() : embedded, error: null };
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
  clampTopicPage,
  getTopicClusters,
  getTopicCounts,
  isTopicSlug,
  buildTopicCollectionPage,
  topicDescription,
  topicMetadata,
  topicNounLowerTr,
  topicNounTr,
  topicSubtitleTr,
  TOPIC_SLUGS,
  TOPIC_LABELS_TR,
  TOPIC_PAGE_SIZE,
  TOPIC_MAX_PAGE,
  TOPIC_WINDOW_MS,
  TOPIC_NOTE_PREFIX,
  TOPIC_NOTE_LINK_LABEL,
  TOPIC_INDEX_SCOPE_NOTE,
} from "./topic-query";
import { CLUSTER_EMBED_SELECT, type ClusterBundle } from "./politics-query";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";
import { NEWS_CATEGORIES } from "@/types";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.clusters = [];
  fixture.clustersError = null;
  fixture.clustersThrows = false;
  fixture.clusterState = null;
  fixture.idStates = [];
  fixture.embedStates = [];
  fixture.embedError = null;
  fixture.embedThrows = false;
  fixture.embedReverse = false;
  fixture.countStates = [];
  fixture.countsBySlug = {};
  fixture.countError = null;
  fixture.countNullSlug = null;
  fixture.countThrows = false;
  fixture.clientOpts = [];
  fixture.applyRecordedOrder = false;
  feedHealth.getZoneFeedHealth.mockReset();
  feedHealth.getZoneFeedHealth.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

// --- fixtures ---------------------------------------------------------------

function mkRow(opts: {
  id: string;
  title_tr?: string;
  updated_at?: string;
  memberCount?: number;
  first_published?: string;
  is_blindspot?: boolean;
}) {
  const memberCount = opts.memberCount ?? 1;
  return {
    id: opts.id,
    title_tr: opts.title_tr ?? `Cluster ${opts.id}`,
    title_tr_neutral: null,
    summary_tr: "summary",
    bias_distribution: {},
    is_blindspot: opts.is_blindspot ?? false,
    blindspot_side: opts.is_blindspot ? "pro_government" : null,
    article_count: memberCount,
    first_published: opts.first_published ?? "2026-09-18T10:00:00.000Z",
    updated_at: opts.updated_at ?? "2026-09-18T11:00:00.000Z",
    cluster_articles: Array.from({ length: memberCount }, (_, i) => ({
      articles: {
        id: `${opts.id}-a${i}`,
        title: `Article ${opts.id}-${i}`,
        url: `https://example.com/${opts.id}-${i}`,
        image_url: null,
        published_at: "2026-09-18T10:30:00.000Z",
        source_id: `src-${opts.id}-${i}`,
        category: "dunya",
        content_hash: `h-${opts.id}-${i}`,
        sources: {
          id: `src-${opts.id}-${i}`,
          name: `Source ${opts.id}-${i}`,
          bias: "center",
          logo_url: null,
          kind: null,
        },
      },
    })),
  };
}

// --- getTopicClusters --------------------------------------------------------

describe("getTopicClusters", () => {
  it("filters on topic7 = slug, is_archived = false and the trailing 7-day updated_at window, newest story first", async () => {
    const before = Date.now();
    await getTopicClusters("dunya", 1);
    const after = Date.now();

    // Step 1 of the two-step read (h94-slowroutes-1): the filtered, ordered,
    // ranged read selects the id only; the embed is step 2 (see the describe
    // below), so the embed aggregates never run for the whole 7-day window.
    const state = fixture.clusterState as BuilderState;
    expect(state.table).toBe("clusters");
    expect(state.selectArgs).toEqual(["id"]);
    expect(state.eq).toContainEqual({ col: "is_archived", val: false });
    expect(state.eq).toContainEqual({ col: "topic7", val: "dunya" });
    // h44-time-2: ordered by the age each card prints (first_published), then
    // the uuid primary key as the tiebreaker. Without a unique second key,
    // OFFSET pagination over rows sharing a first_published is not a total
    // order. updated_at is deliberately NOT an ordering key any more: it only
    // windows the read (the .gte below), exactly like entity-hub-query.ts.
    expect(state.order).toEqual([
      { col: "first_published", opts: { ascending: false } },
      { col: "id", opts: { ascending: false } },
    ]);

    const from = state.gte.find((g) => g.col === "updated_at");
    expect(from).toBeDefined();
    const fromMs = Date.parse(String(from!.val));
    expect(fromMs).toBeGreaterThanOrEqual(before - TOPIC_WINDOW_MS);
    expect(fromMs).toBeLessThanOrEqual(after - TOPIC_WINDOW_MS);
    // The site's own cluster definition (article_count >= 2): a hub must not
    // list single-article "clusters" that /clusters and the home feed hide.
    expect(state.gte).toContainEqual({ col: "article_count", val: 2 });

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
    expect(cacheTag).toHaveBeenCalledWith("clusters-politics");
  });

  it("requests TOPIC_PAGE_SIZE + 1 rows via .range() and reports hasMore only when the extra row came back", async () => {
    fixture.clusters = Array.from({ length: TOPIC_PAGE_SIZE + 1 }, (_, i) =>
      mkRow({ id: `c${i}` }),
    );

    const withExtra = await getTopicClusters("dunya", 1);
    const stateWithExtra = fixture.clusterState as BuilderState;
    expect(stateWithExtra.range).toEqual({ from: 0, to: TOPIC_PAGE_SIZE });
    expect(withExtra?.hasMore).toBe(true);
    expect(withExtra?.bundles).toHaveLength(TOPIC_PAGE_SIZE);

    fixture.clusters = Array.from({ length: TOPIC_PAGE_SIZE }, (_, i) =>
      mkRow({ id: `d${i}` }),
    );
    const exact = await getTopicClusters("dunya", 1);
    expect(exact?.hasMore).toBe(false);
    expect(exact?.bundles).toHaveLength(TOPIC_PAGE_SIZE);
  });

  it("pages with ?sayfa=: page 2 starts at offset TOPIC_PAGE_SIZE and the page is clamped to 1..TOPIC_MAX_PAGE", async () => {
    await getTopicClusters("dunya", 2);
    let state = fixture.clusterState as BuilderState;
    expect(state.range).toEqual({
      from: TOPIC_PAGE_SIZE,
      to: TOPIC_PAGE_SIZE * 2,
    });

    await getTopicClusters("dunya", 0);
    state = fixture.clusterState as BuilderState;
    expect(state.range).toEqual({ from: 0, to: TOPIC_PAGE_SIZE });

    await getTopicClusters("dunya", 999);
    state = fixture.clusterState as BuilderState;
    const expectedFrom = (TOPIC_MAX_PAGE - 1) * TOPIC_PAGE_SIZE;
    expect(state.range).toEqual({
      from: expectedFrom,
      to: expectedFrom + TOPIC_PAGE_SIZE,
    });
  });

  it("returns null on a Supabase error instead of caching an empty hub as truth", async () => {
    fixture.clustersError = { message: "relation missing" };

    await expect(getTopicClusters("dunya", 1)).resolves.toBeNull();
  });

  it("returns null when the query throws, and never rethrows into the prerender", async () => {
    fixture.clustersThrows = true;

    await expect(getTopicClusters("dunya", 1)).resolves.toBeNull();
  });

  it("returns { bundles: [] } — not null — when the window legitimately matched nothing", async () => {
    fixture.clusters = [];

    const result = await getTopicClusters("dunya", 1);
    expect(result).not.toBeNull();
    expect(result?.bundles).toEqual([]);
    expect(result?.hasMore).toBe(false);
  });
});

// --- ids first, then the embed (h94-slowroutes-1) ----------------------------
//
// The window index is (topic7, updated_at), so ONE select carrying the
// cluster -> cluster_articles -> articles -> sources embed ran its aggregates for
// every window row (313 for dunya, about 16,000 buffers) before the top-30 sort.
// The read is now two steps, the shape getEntityHub, politics-query's digest and
// /blindspots already use: step 1 selects `id` with the filters, both orders and
// the range; step 2 embeds just those ids with `.in('id', ids)` and the result is
// put back into step 1's order in JS, because `.in()` gives no order.

describe("getTopicClusters: ids first, then the embed (h94-slowroutes-1)", () => {
  const pad = (i: number) => String(i).padStart(2, "0");
  /** `n` ids c00, c01, ... in the order the database would answer step 1. */
  const idList = (n: number) => Array.from({ length: n }, (_, i) => `c${pad(i)}`);
  const seed = (n: number) => {
    fixture.clusters = idList(n).map((id) => mkRow({ id }));
  };
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("step 1 selects the id only (never the embed), with the page's filters, both orders and the PAGE_SIZE + 1 range", async () => {
    seed(3);

    await getTopicClusters("dunya", 2);

    expect(fixture.idStates).toHaveLength(1);
    const ids = fixture.idStates[0] as BuilderState;
    expect(ids.table).toBe("clusters");
    expect(ids.selectArgs).toEqual(["id"]);
    expect(String(ids.selectArgs[0])).not.toContain("cluster_articles");
    expect(ids.eq).toEqual([
      { col: "is_archived", val: false },
      { col: "topic7", val: "dunya" },
    ]);
    expect(ids.gte).toContainEqual({ col: "article_count", val: 2 });
    expect(ids.gte.filter((g) => g.col === "updated_at")).toHaveLength(1);
    expect(ids.order).toEqual([
      { col: "first_published", opts: { ascending: false } },
      { col: "id", opts: { ascending: false } },
    ]);
    expect(ids.range).toEqual({ from: TOPIC_PAGE_SIZE, to: TOPIC_PAGE_SIZE * 2 });
    expect(ids.in).toEqual([]);
  });

  it("(a) step 2 is CLUSTER_EMBED_SELECT with .in('id', ids) and no order, range or limit", async () => {
    seed(5);

    await getTopicClusters("dunya", 1);

    expect(fixture.embedStates).toHaveLength(1);
    const embed = fixture.embedStates[0] as BuilderState;
    expect(embed.table).toBe("clusters");
    expect(String(embed.selectArgs[0])).toBe(CLUSTER_EMBED_SELECT);
    expect(embed.in).toEqual([{ col: "id", vals: idList(5) }]);
    expect(embed.order).toEqual([]);
    expect(embed.range).toBeNull();
    expect(embed.limit).toBeNull();
  });

  it("issues exactly two cluster reads for a page that has rows: one ids read, one embed", async () => {
    seed(4);

    await getTopicClusters("dunya", 1);

    expect(fixture.idStates).toHaveLength(1);
    expect(fixture.embedStates).toHaveLength(1);
    expect(fixture.countStates).toHaveLength(0);
  });

  it("(b) the output order is step 1's order even when the embed returns the rows shuffled", async () => {
    // Fixture order a, b, c, d. Step 1 (first_published desc, id desc) answers
    // d, a, c, b: a and d share a first_published, the id tiebreaker puts d first.
    fixture.clusters = [
      mkRow({ id: "a", first_published: "2026-11-05T10:00:00.000Z" }),
      mkRow({ id: "b", first_published: "2026-11-02T09:00:00.000Z" }),
      mkRow({ id: "c", first_published: "2026-11-05T08:00:00.000Z" }),
      mkRow({ id: "d", first_published: "2026-11-05T10:00:00.000Z" }),
    ];
    fixture.applyRecordedOrder = true;
    fixture.embedReverse = true; // the embed answers d, c, b, a

    const result = await getTopicClusters("dunya", 1);

    expect((fixture.embedStates[0] as BuilderState).in).toEqual([
      { col: "id", vals: ["d", "a", "c", "b"] },
    ]);
    expect(result?.bundles.map((b) => b.cluster.id)).toEqual(["d", "a", "c", "b"]);
  });

  it("(b) a full page of shuffled embed rows still comes back in step 1's order", async () => {
    seed(TOPIC_PAGE_SIZE);
    fixture.embedReverse = true;

    const result = await getTopicClusters("dunya", 1);

    expect(result?.bundles.map((b) => b.cluster.id)).toEqual(idList(TOPIC_PAGE_SIZE));
  });

  it("(c) the PAGE_SIZE + 1st id still sets hasMore, but is neither embedded nor listed", async () => {
    seed(TOPIC_PAGE_SIZE + 1);

    const result = await getTopicClusters("dunya", 1);

    const extra = `c${pad(TOPIC_PAGE_SIZE)}`;
    expect(result?.hasMore).toBe(true);
    expect(result?.bundles).toHaveLength(TOPIC_PAGE_SIZE);
    expect(result?.bundles.map((b) => b.cluster.id)).not.toContain(extra);
    // Step 2 embeds the page's TOPIC_PAGE_SIZE ids, not the lookahead one.
    const embedded = (fixture.embedStates[0] as BuilderState).in[0]!.vals;
    expect(embedded).toEqual(idList(TOPIC_PAGE_SIZE));
    expect(embedded).not.toContain(extra);
  });

  it("(c) exactly PAGE_SIZE ids is a full last page: hasMore false, all of them embedded", async () => {
    seed(TOPIC_PAGE_SIZE);

    const result = await getTopicClusters("dunya", 1);

    expect(result?.hasMore).toBe(false);
    expect(result?.bundles).toHaveLength(TOPIC_PAGE_SIZE);
    expect((fixture.embedStates[0] as BuilderState).in[0]!.vals).toHaveLength(TOPIC_PAGE_SIZE);
  });

  it("still skips an id whose embed row has no member article, and one the embed no longer returns", async () => {
    fixture.clusters = [
      mkRow({ id: "c00" }),
      mkRow({ id: "c01", memberCount: 0 }),
      mkRow({ id: "c02" }),
    ];

    const result = await getTopicClusters("dunya", 1);

    expect(result?.bundles.map((b) => b.cluster.id)).toEqual(["c00", "c02"]);
    expect(result?.hasMore).toBe(false);
  });

  it("(d) zero ids on page 1 is an empty page with no embed call and no lastPage key", async () => {
    fixture.clusters = [];

    const result = await getTopicClusters("dunya", 1);

    expect(result).toEqual({ bundles: [], hasMore: false, page: 1 });
    expect(result).not.toHaveProperty("lastPage");
    expect(fixture.idStates).toHaveLength(1);
    expect(fixture.embedStates).toHaveLength(0);
    expect(fixture.countStates).toHaveLength(0);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("(d) zero ids past page 1 still resolves lastPage and still makes no embed call", async () => {
    fixture.clusters = [];
    fixture.countsBySlug = { dunya: 61 };

    const result = await getTopicClusters("dunya", 3);

    expect(result).toEqual({ bundles: [], hasMore: false, page: 3, lastPage: 3 });
    expect(fixture.embedStates).toHaveLength(0);
    expect(fixture.countStates).toHaveLength(1);
  });

  it("(e) an error in step 1 gives the logged null and never reaches the embed", async () => {
    fixture.clustersError = { message: "ids timeout", code: "57014" };

    await expect(getTopicClusters("dunya", 1)).resolves.toBeNull();

    expect(fixture.embedStates).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(
      "[konu] clusters unavailable:",
      expect.objectContaining({ message: "ids timeout", code: "57014" }),
    );
  });

  it("(e) an error in step 2 gives the same logged null", async () => {
    seed(3);
    fixture.embedError = { message: "embed timeout", code: "57014" };

    await expect(getTopicClusters("dunya", 1)).resolves.toBeNull();

    expect(fixture.embedStates.length).toBeGreaterThanOrEqual(1);
    expect(console.error).toHaveBeenCalledWith(
      "[konu] clusters unavailable:",
      expect.objectContaining({ message: "embed timeout", code: "57014" }),
    );
  });

  it("(e) a throw in step 1 or in step 2 gives the logged null, never a rejection", async () => {
    seed(3);
    fixture.clustersThrows = true;
    await expect(getTopicClusters("dunya", 1)).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledWith("[konu] clusters unavailable: boom");

    fixture.clustersThrows = false;
    fixture.embedThrows = true;
    await expect(getTopicClusters("dunya", 1)).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledWith("[konu] clusters unavailable: embed boom");
  });

  it("(e) a failure in either step is cached for 'minutes' only, exactly once per cached call", async () => {
    seed(3);
    fixture.embedError = { message: "embed timeout" };

    await getTopicClusters("dunya", 1);

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("starts the feed-health read together with step 1, not before it", async () => {
    seed(2);
    let release!: (value: unknown) => void;
    feedHealth.getZoneFeedHealth.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const pending = getTopicClusters("dunya", 1);
    await tick();

    // The health read has not settled, yet the ids query is already out.
    expect(feedHealth.getZoneFeedHealth).toHaveBeenCalledTimes(1);
    expect(fixture.idStates).toHaveLength(1);

    release(null);
    const result = await pending;
    expect(result?.bundles.map((b) => b.cluster.id)).toEqual(["c00", "c01"]);
  });

  it("a rejected feed-health read still gives the logged null", async () => {
    seed(2);
    feedHealth.getZoneFeedHealth.mockRejectedValue(new Error("health down"));

    await expect(getTopicClusters("dunya", 1)).resolves.toBeNull();

    expect(console.error).toHaveBeenCalledWith("[konu] clusters unavailable: health down");
  });

  it("threads the feed health through to the bundles (a degraded pole zone withdraws the blindspot)", async () => {
    const healthy = { total: 10, healthy: 10, healthyShare: 1, degraded: false };
    const degraded = { total: 10, healthy: 2, healthyShare: 0.2, degraded: true };
    feedHealth.getZoneFeedHealth.mockResolvedValue({
      iktidar: healthy,
      bagimsiz: healthy,
      muhalefet: degraded,
    });
    fixture.clusters = [
      {
        ...mkRow({ id: "c00", memberCount: 2, is_blindspot: true }),
        bias_distribution: { pro_government: 9, opposition: 1 },
      },
    ];

    const result = await getTopicClusters("dunya", 1);

    expect(result?.bundles[0]?.cluster.is_blindspot).toBe(false);
    expect(result?.bundles[0]?.cluster.blindspot_side).toBeNull();
  });
});

// --- order: the age a card prints is the order it sits in (h44-time-2) --------
//
// The window stays on updated_at (hub counts and page sizes do not change), but
// the order follows first_published, because that is the age every card prints.
// Ordering by updated_at put a story first published 3 days ago, refreshed this
// hour, above one first published 13 hours ago, so the printed ages read
// '13 saat önce', '1 gün önce', '3 Kasım 2026', '1 gün önce', ... entity-hub-
// query.ts:41-44 fixed the same defect for /gundem hubs the same way.

describe("getTopicClusters: order follows first_published (h44-time-2)", () => {
  // updated_at order (b, c, a, d) is NOT first_published order (d, a, c, b),
  // and a/d share a first_published, so the id tiebreaker is exercised too.
  const rows = () => [
    mkRow({
      id: "b",
      first_published: "2026-11-02T09:00:00.000Z",
      updated_at: "2026-11-05T20:00:00.000Z",
    }),
    mkRow({
      id: "c",
      first_published: "2026-11-05T08:00:00.000Z",
      updated_at: "2026-11-05T19:00:00.000Z",
    }),
    mkRow({
      id: "a",
      first_published: "2026-11-05T10:00:00.000Z",
      updated_at: "2026-11-05T10:30:00.000Z",
    }),
    mkRow({
      id: "d",
      first_published: "2026-11-05T10:00:00.000Z",
      updated_at: "2026-11-05T10:10:00.000Z",
    }),
  ];

  it("keeps the window on updated_at and adds no first_published filter, so hub counts and page sizes are unchanged", async () => {
    await getTopicClusters("dunya", 1);

    const state = fixture.clusterState as BuilderState;
    expect(state.gte.filter((g) => g.col === "updated_at")).toHaveLength(1);
    expect(state.gte.some((g) => g.col === "first_published")).toBe(false);
    expect(state.gte).toContainEqual({ col: "article_count", val: 2 });
    expect(state.range).toEqual({ from: 0, to: TOPIC_PAGE_SIZE });
  });

  it("sends first_published desc first and id desc second, on every page", async () => {
    for (const page of [1, 2, TOPIC_MAX_PAGE]) {
      await getTopicClusters("dunya", page);
      expect((fixture.clusterState as BuilderState).order).toEqual([
        { col: "first_published", opts: { ascending: false } },
        { col: "id", opts: { ascending: false } },
      ]);
    }
  });

  it("returns the bundles monotone non-increasing in cluster.first_published once the database applies that order", async () => {
    fixture.clusters = rows();
    fixture.applyRecordedOrder = true;

    const result = await getTopicClusters("dunya", 1);

    const published = (result?.bundles ?? []).map((b) =>
      Date.parse(b.cluster.first_published),
    );
    expect(published).toHaveLength(4);
    for (let i = 1; i < published.length; i++) {
      expect(published[i]!).toBeLessThanOrEqual(published[i - 1]!);
    }
    // The tied pair (a, d) is broken by id desc, and the freshly refreshed old
    // story (b) sits last instead of first.
    expect(result?.bundles.map((b) => b.cluster.id)).toEqual(["d", "a", "c", "b"]);
  });

  it("the fixture's updated_at-desc order differs from its first_published-desc order, so the monotone test above can fail", () => {
    const byUpdated = [...rows()]
      .sort((x, y) => Date.parse(y.updated_at) - Date.parse(x.updated_at))
      .map((r) => r.id);
    const byPublished = [...rows()]
      .sort(
        (x, y) =>
          Date.parse(y.first_published) - Date.parse(x.first_published) ||
          (x.id < y.id ? 1 : -1),
      )
      .map((r) => r.id);
    expect(byUpdated).toEqual(["b", "c", "a", "d"]);
    expect(byPublished).toEqual(["d", "a", "c", "b"]);
  });

  it("does not reorder rows it was given: the database order is the page order", async () => {
    fixture.clusters = rows();

    const result = await getTopicClusters("dunya", 1);

    expect(result?.bundles.map((b) => b.cluster.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("the last-page count read stays lean: no ordering key of any kind", async () => {
    fixture.countsBySlug = { dunya: 61 };

    await getTopicClusters("dunya", 3);

    expect((fixture.countStates[0] as BuilderState).order).toEqual([]);
  });
});

// --- past-the-end last page ----------------------------------------------------
//
// /konu/<slug>?sayfa=N past the last page used to render an empty state whose
// only pager link went to N-1 (also empty). The fetcher now answers "where does
// the list end?" with ONE lean head/exact count, but only when it is needed:
// zero rows on a page > 1. A page that has rows, and page 1, never pay for it.

describe("getTopicClusters: blindspot feed delay (h37-content-1)", () => {
  it("holds back a flagged claim first published 1 h ago and keeps an older one", async () => {
    fixture.clusters = [
      mkRow({
        id: "young",
        is_blindspot: true,
        first_published: new Date(Date.now() - 3_600_000).toISOString(),
      }),
      mkRow({ id: "old", is_blindspot: true }),
    ];
    const page = await getTopicClusters("dunya", 1);
    const byId = new Map((page?.bundles ?? []).map((b) => [b.cluster.id, b.cluster]));
    expect(byId.get("young")?.is_blindspot).toBe(false);
    expect(byId.get("young")?.blindspot_side).toBeNull();
    expect(byId.get("old")?.is_blindspot).toBe(true);
    expect(byId.get("old")?.blindspot_side).toBe("pro_government");
  });
});

describe("getTopicClusters: lastPage on a page past the end", () => {
  it("page 3 with 0 rows issues exactly one extra head/exact count read with the same four filters as the list read", async () => {
    fixture.countsBySlug = { dunya: 61 };

    const result = await getTopicClusters("dunya", 3);

    expect(fixture.countStates).toHaveLength(1);
    const count = fixture.countStates[0] as BuilderState;
    const list = fixture.clusterState as BuilderState;
    expect(count.table).toBe("clusters");
    expect(count.selectArgs).toEqual(["id", { count: "exact", head: true }]);
    // Same filter chain, value for value (including the one shared updated_at
    // instant): a drift here would make lastPage disagree with the list.
    expect(count.eq).toEqual([
      { col: "is_archived", val: false },
      { col: "topic7", val: "dunya" },
    ]);
    expect(count.eq).toEqual(list.eq);
    expect(count.gte).toEqual(list.gte);
    expect(count.gte).toHaveLength(2);
    expect(count.gte).toContainEqual({ col: "article_count", val: 2 });
    expect(count.gte.some((g) => g.col === "updated_at")).toBe(true);
    // A lean count: no ordering, no row window.
    expect(count.order).toEqual([]);
    expect(count.range).toBeNull();

    expect(result).toEqual({ bundles: [], hasMore: false, page: 3, lastPage: 3 });
  });

  it.each([
    [61, 3],
    [60, 2],
    [30, 1],
    [1, 1],
    [0, 1],
    [10_000, TOPIC_MAX_PAGE],
  ])("count %i gives lastPage %i (ceil(count / page size), floored at 1, capped at TOPIC_MAX_PAGE)", async (count, expected) => {
    fixture.countsBySlug = { dunya: count };

    const result = await getTopicClusters("dunya", 3);

    expect(result?.lastPage).toBe(expected);
  });

  it("a clamped ?sayfa=999 (page 20) with 0 rows also resolves lastPage", async () => {
    fixture.countsBySlug = { dunya: 10_000 };

    const result = await getTopicClusters("dunya", 999);

    expect(fixture.countStates).toHaveLength(1);
    expect(result).toMatchObject({ page: TOPIC_MAX_PAGE, lastPage: TOPIC_MAX_PAGE });

    fixture.countStates = [];
    fixture.countsBySlug = { dunya: 61 };
    const small = await getTopicClusters("dunya", 999);
    expect(small).toMatchObject({ page: TOPIC_MAX_PAGE, lastPage: 3 });
  });

  it("a count error gives lastPage null, logs it, and keeps the result non-null and cached for cluster-feed", async () => {
    fixture.countError = { message: "canceling statement due to statement timeout" };

    const result = await getTopicClusters("dunya", 3);

    expect(result).not.toBeNull();
    expect(result).toMatchObject({ bundles: [], hasMore: false, page: 3, lastPage: null });
    expect(console.error).toHaveBeenCalledWith(
      "[konu] last page unavailable:",
      expect.anything(),
    );
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("a null count (no total in Content-Range) gives lastPage null, not a guessed page", async () => {
    fixture.countNullSlug = "dunya";

    const result = await getTopicClusters("dunya", 3);

    expect(result).not.toBeNull();
    expect(result?.lastPage).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      "[konu] last page unavailable:",
      expect.anything(),
    );
  });

  it("a thrown count read gives lastPage null and never turns the result null", async () => {
    fixture.countThrows = true;

    const result = await getTopicClusters("dunya", 3);

    expect(result).not.toBeNull();
    expect(result).toMatchObject({ bundles: [], page: 3, lastPage: null });
    expect(console.error).toHaveBeenCalledWith(
      "[konu] last page unavailable:",
      expect.anything(),
    );
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("page 1 with 0 rows reads no count and carries no lastPage key", async () => {
    fixture.countsBySlug = { dunya: 61 };

    const result = await getTopicClusters("dunya", 1);

    expect(fixture.countStates).toHaveLength(0);
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("lastPage");
  });

  it("page 2 that has rows reads no count and carries no lastPage key", async () => {
    fixture.clusters = [mkRow({ id: "c1" }), mkRow({ id: "c2" })];
    fixture.countsBySlug = { dunya: 61 };

    const result = await getTopicClusters("dunya", 2);

    expect(fixture.countStates).toHaveLength(0);
    expect(result?.bundles).toHaveLength(2);
    expect(result).not.toHaveProperty("lastPage");
  });

  it("a failed list read returns null and never reaches the count", async () => {
    fixture.clustersError = { message: "relation missing" };

    await expect(getTopicClusters("dunya", 3)).resolves.toBeNull();
    expect(fixture.countStates).toHaveLength(0);
  });
});

// --- getTopicCounts ----------------------------------------------------------

describe("getTopicCounts", () => {
  it("returns one 7-day count per hub slug and null if any count query errors", async () => {
    fixture.countsBySlug = {
      dunya: 5,
      ekonomi: 3,
      spor: 0,
      yasam: 12,
      teknoloji: 1,
      genel: 7,
    };

    const counts = await getTopicCounts();
    expect(counts).toEqual({
      dunya: 5,
      ekonomi: 3,
      spor: 0,
      yasam: 12,
      teknoloji: 1,
      genel: 7,
    });
    expect(fixture.countStates).toHaveLength(TOPIC_SLUGS.length);
    for (const state of fixture.countStates as BuilderState[]) {
      expect(state.eq).toContainEqual({ col: "is_archived", val: false });
      expect(state.gte.some((g) => g.col === "updated_at")).toBe(true);
      // Same definition as the list: the index page's "N küme" must equal
      // what the hub then renders.
      expect(state.gte).toContainEqual({ col: "article_count", val: 2 });
    }

    fixture.countError = { message: "timeout" };
    await expect(getTopicCounts()).resolves.toBeNull();
  });

  it("returns null when a count query succeeds with a null count, rather than rendering a zero it did not read (C1-COUNTS-NULL-ZERO)", async () => {
    fixture.countsBySlug = {
      dunya: 5,
      ekonomi: 3,
      spor: 0,
      yasam: 12,
      teknoloji: 1,
      genel: 7,
    };
    fixture.countNullSlug = "spor";

    await expect(getTopicCounts()).resolves.toBeNull();
  });
});

// --- read profile + cache lifetime (cold-read resilience) --------------------

const TIMEOUT_MESSAGE = "AbortError: Supabase request exceeded 4000 ms";

describe("topic hub read profile", () => {
  it("getTopicClusters builds only capped reader clients", async () => {
    await getTopicClusters("dunya", 1);
    expect(fixture.clientOpts.length).toBeGreaterThanOrEqual(1);
    expect(fixture.clientOpts.every(isCappedClientOpts)).toBe(true);
  });

  it("getTopicCounts builds only capped reader clients", async () => {
    await getTopicCounts();
    expect(fixture.clientOpts.length).toBeGreaterThanOrEqual(1);
    expect(fixture.clientOpts.every(isCappedClientOpts)).toBe(true);
  });
});

describe("topic hub cache lifetime: a failure is cached for minutes only", () => {
  it("getTopicClusters: a timeout resolves null and calls cacheLife('minutes') exactly once", async () => {
    fixture.clustersError = { message: TIMEOUT_MESSAGE };

    await expect(getTopicClusters("dunya", 1)).resolves.toBeNull();

    // cached attempt (cacheLife) + live retry (uncached, no cacheLife)
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("cluster-feed");
  });

  it("getTopicClusters: a thrown query also lands on 'minutes'", async () => {
    fixture.clustersThrows = true;

    await expect(getTopicClusters("dunya", 1)).resolves.toBeNull();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("getTopicClusters: an empty-but-read window is a success: cluster-feed, once", async () => {
    fixture.clusters = [];

    const result = await getTopicClusters("dunya", 1);
    expect(result).not.toBeNull();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("getTopicClusters: tags the entry before the fetch", async () => {
    await getTopicClusters("dunya", 1);
    expect(cacheTag).toHaveBeenCalledWith("clusters-politics");
    expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
    );
  });

  it("getTopicCounts: a timeout resolves null and calls cacheLife('minutes') exactly once", async () => {
    fixture.countError = { message: TIMEOUT_MESSAGE };

    await expect(getTopicCounts()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("cluster-feed");
  });

  it("getTopicCounts: a null count (nothing counted) is a failure, not a cached zero", async () => {
    fixture.countNullSlug = "spor";

    await expect(getTopicCounts()).resolves.toBeNull();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("getTopicCounts: success is cached for cluster-feed, once", async () => {
    fixture.countsBySlug = { dunya: 1 };

    const counts = await getTopicCounts();
    expect(counts).not.toBeNull();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
    expect(cacheTag).toHaveBeenCalledWith("clusters-politics");
  });
});

// --- clampTopicPage -----------------------------------------------------------

describe("clampTopicPage", () => {
  it("clamps to 1..TOPIC_MAX_PAGE and treats non-finite/zero/negative input as page 1", () => {
    expect(clampTopicPage(1)).toBe(1);
    expect(clampTopicPage(0)).toBe(1);
    expect(clampTopicPage(-5)).toBe(1);
    expect(clampTopicPage(Number.NaN)).toBe(1);
    expect(clampTopicPage(99999)).toBe(TOPIC_MAX_PAGE);
  });
});

// --- isTopicSlug --------------------------------------------------------------

describe("isTopicSlug", () => {
  it("accepts the six hub slugs and rejects politika, unknown strings, empty input and path traversal", () => {
    for (const slug of TOPIC_SLUGS) {
      expect(isTopicSlug(slug)).toBe(true);
    }
    expect(isTopicSlug("politika")).toBe(false);
    expect(isTopicSlug("saglik")).toBe(false);
    expect(isTopicSlug("")).toBe(false);
    expect(isTopicSlug("../admin")).toBe(false);
  });
});

// --- the shared topic noun phrase (h46-copy-1) -------------------------------
//
// One helper decides how a hub label is put into prose, so no surface prints
// the ungrammatical "Genel haberleri" and a mid-sentence label is lower-case.

describe("topicNounTr / topicNounLowerTr", () => {
  it("noun labels form the '<Label> haberleri' compound with a capitalised head", () => {
    expect(topicNounTr("dunya")).toBe("Dünya haberleri");
    expect(topicNounTr("spor")).toBe("Spor haberleri");
    expect(topicNounTr("ekonomi")).toBe("Ekonomi haberleri");
    expect(topicNounTr("yasam")).toBe("Yaşam haberleri");
    expect(topicNounTr("teknoloji")).toBe("Teknoloji haberleri");
  });

  it("'genel' is an adjective, so its phrase is 'Genel haberler', never 'Genel haberleri'", () => {
    expect(topicNounTr("genel")).toBe("Genel haberler");
  });

  it("the lower-case form (for mid-sentence use) lowercases with the Turkish locale", () => {
    expect(topicNounLowerTr("dunya")).toBe("dünya haberleri");
    expect(topicNounLowerTr("yasam")).toBe("yaşam haberleri");
    expect(topicNounLowerTr("genel")).toBe("genel haberler");
  });

  it.each(TOPIC_SLUGS)("'%s': the lower-case form is the capitalised form lowercased, and only genel drops the possessive", (slug) => {
    expect(topicNounLowerTr(slug)).toBe(topicNounTr(slug).toLocaleLowerCase("tr-TR"));
    expect(topicNounTr(slug).startsWith(TOPIC_LABELS_TR[slug])).toBe(true);
    expect(topicNounTr(slug).endsWith(" haberleri")).toBe(slug !== "genel");
    expect(topicNounTr(slug)).not.toContain("Genel haberleri");
  });
});

describe("topicSubtitleTr", () => {
  it("a noun label reads 'Son 7 günde <label> konusunda kümelenen haberler.' with the label in lower case", () => {
    expect(topicSubtitleTr("dunya")).toBe("Son 7 günde dünya konusunda kümelenen haberler.");
    expect(topicSubtitleTr("yasam")).toBe("Son 7 günde yaşam konusunda kümelenen haberler.");
  });

  it("'genel' is not a subject area, so it reads 'genel gündemde' instead of 'genel konusunda'", () => {
    expect(topicSubtitleTr("genel")).toBe("Son 7 günde genel gündemde kümelenen haberler.");
  });

  it.each(TOPIC_SLUGS)("'%s': ends with a full stop and never capitalises the label mid-sentence", (slug) => {
    const subtitle = topicSubtitleTr(slug);
    expect(subtitle.startsWith("Son 7 günde ")).toBe(true);
    expect(subtitle.endsWith("kümelenen haberler.")).toBe(true);
    expect(subtitle).not.toContain(TOPIC_LABELS_TR[slug]);
  });
});

describe("the genel hub never prints 'Genel haberleri'", () => {
  it("page 1: <title> and JSON-LD name are 'Genel haberler'", () => {
    expect(topicMetadata("genel").title).toBe("Genel haberler");
    expect(topicMetadata("genel").openGraph?.title).toBe("Genel haberler — Tayf");
    expect(buildTopicCollectionPage({ slug: "genel", bundles: [] }).name).toBe("Genel haberler");
  });

  it("page 2: 'Genel haberler — Sayfa 2' in both the <title> and the JSON-LD name", () => {
    expect(topicMetadata("genel", 2).title).toBe("Genel haberler — Sayfa 2");
    expect(buildTopicCollectionPage({ slug: "genel", bundles: [], page: 2 }).name).toBe(
      "Genel haberler — Sayfa 2",
    );
  });

  it("the meta description uses the same lower-case phrase as the helper", () => {
    expect(topicDescription("genel")).toContain(`kesişen ${topicNounLowerTr("genel")},`);
    expect(topicDescription("dunya")).toContain(`kesişen ${topicNounLowerTr("dunya")},`);
  });
});

// --- static exports -----------------------------------------------------------

describe("TOPIC_LABELS_TR / TOPIC_SLUGS", () => {
  it("TOPIC_LABELS_TR covers every TOPIC_SLUGS entry with its Turkish name and TOPIC_SLUGS excludes politika", () => {
    for (const slug of TOPIC_SLUGS) {
      expect(typeof TOPIC_LABELS_TR[slug]).toBe("string");
      expect(TOPIC_LABELS_TR[slug].length).toBeGreaterThan(0);
    }
    expect(TOPIC_SLUGS).not.toContain("politika");
    expect(TOPIC_SLUGS).toEqual([
      "dunya",
      "ekonomi",
      "spor",
      "yasam",
      "teknoloji",
      "genel",
    ]);
  });

  // C1-LABEL-DUPLICATION: TOPIC_LABELS_TR hand-duplicates six labels that
  // already exist as the single source of truth in NEWS_CATEGORIES
  // (src/types/index.ts), which also drives the article-category UI. This
  // pins the two together so a rename in one fails here instead of leaving
  // /konu silently showing a stale word in the hero, <title>, meta
  // description and CollectionPage JSON-LD name.
  it("TOPIC_LABELS_TR matches NEWS_CATEGORIES for every hub slug", () => {
    for (const slug of TOPIC_SLUGS) {
      expect(TOPIC_LABELS_TR[slug]).toBe(NEWS_CATEGORIES[slug].label);
    }
  });
});

describe("TOPIC_INDEX_SCOPE_NOTE (the sentence under the /konu index counts)", () => {
  it("is the exact scope sentence: only politics-gated stories are clustered, hubs are their topic split", () => {
    expect(TOPIC_INDEX_SCOPE_NOTE).toBe(
      "Tayf yalnızca siyasi gündeme giren haberleri kümeler; konu sayfaları bu haberlerin konu dağılımıdır.",
    );
  });

  it("carries no classifier jargon (that lives in TOPIC_NOTE_PREFIX)", () => {
    expect(TOPIC_INDEX_SCOPE_NOTE).not.toMatch(/jev|eşik|0,8/i);
  });
});

describe("TOPIC_NOTE_PREFIX / TOPIC_NOTE_LINK_LABEL", () => {
  it("TOPIC_NOTE_PREFIX names Jev and states the 0,8 threshold, and the note links to /metodoloji", () => {
    expect(TOPIC_NOTE_PREFIX).toContain("Jev");
    expect(TOPIC_NOTE_PREFIX).toContain("0,8");
    expect(TOPIC_NOTE_LINK_LABEL).toBe("yöntem");
  });
});

// --- topicMetadata --------------------------------------------------------

type OgImage = { url: string | URL };

function firstImageUrl(images: unknown): string | undefined {
  const list = Array.isArray(images) ? (images as OgImage[]) : [];
  const first = list[0];
  return first === undefined ? undefined : String(first.url);
}

describe("topicMetadata", () => {
  it("keeps the Turkish title, the description, and no robots key (the root layout's index,follow inherits)", () => {
    const meta = topicMetadata("dunya");

    expect(meta.title).toBe("Dünya haberleri");
    expect(meta.robots).toBeUndefined();
    expect(meta.description).toBe(
      "Siyasi gündemle kesişen dünya haberleri, son 7 gün: iktidar, bağımsız ve muhalefet medyasının her olaya ne kadar yer verdiğini görün.",
    );
  });

  describe.each(TOPIC_SLUGS)("share metadata for %s", (slug) => {
    const label = TOPIC_LABELS_TR[slug];

    // The hub's meta/og/twitter description is reader-facing search-result
    // copy. The classifier's name and threshold stay in the on-page note
    // (TOPIC_NOTE_PREFIX), never here.
    it("description names the topic in lowercase Turkish, fits a snippet, and carries no classifier jargon", () => {
      const description = String(topicMetadata(slug).description);
      expect(description.length).toBeLessThanOrEqual(155);
      expect(description).toContain(label.toLocaleLowerCase("tr-TR"));
      expect(description).not.toMatch(/jev/i);
      expect(description).not.toContain("eşik");
      expect(description).not.toContain("0,8");
      expect(description).not.toContain("etiket");
    });

    it("description, og:description and twitter:description are one and the same string", () => {
      const meta = topicMetadata(slug);
      expect(typeof meta.description).toBe("string");
      expect(meta.openGraph?.description).toBe(meta.description);
      expect(meta.twitter?.description).toBe(meta.description);
    });

    it("description equals topicDescription(slug)", () => {
      expect(topicMetadata(slug).description).toBe(topicDescription(slug));
    });

    it("canonical equals og:url equals /konu/<slug>", () => {
      const meta = topicMetadata(slug);
      expect(meta.alternates?.canonical).toBe(`/konu/${slug}`);
      expect(meta.openGraph?.url).toBe(`/konu/${slug}`);
    });

    it("og:title carries the brand suffix, og:description equals the meta description", () => {
      const meta = topicMetadata(slug);
      expect(meta.title).toBe(topicNounTr(slug));
      expect(meta.openGraph?.title).toBe(`${topicNounTr(slug)} — Tayf`);
      expect(meta.openGraph?.description).toBe(meta.description);
    });

    it("names the root share card explicitly (a page-level openGraph replaces the parent wholesale)", () => {
      const meta = topicMetadata(slug);
      expect(firstImageUrl(meta.openGraph?.images)).toBe("/opengraph-image");
      expect(firstImageUrl(meta.twitter?.images)).toBe("/twitter-image");
    });

    it("sets twitter title and description to the same brand-suffixed copy", () => {
      const meta = topicMetadata(slug);
      expect(meta.twitter?.title).toBe(`${topicNounTr(slug)} — Tayf`);
      expect(meta.twitter?.description).toBe(meta.description);
    });

    it("leaves robots undefined", () => {
      expect(topicMetadata(slug).robots).toBeUndefined();
    });
  });

  it("the six hub descriptions are pairwise distinct (no duplicate meta descriptions across hubs)", () => {
    const descriptions = TOPIC_SLUGS.map((slug) => String(topicMetadata(slug).description));
    expect(new Set(descriptions).size).toBe(6);
  });

  it("a paged hub keeps page 1's description (og and twitter included)", () => {
    const first = topicMetadata("spor");
    const paged = topicMetadata("spor", 3);
    expect(paged.description).toBe(first.description);
    expect(paged.openGraph?.description).toBe(first.description);
    expect(paged.twitter?.description).toBe(first.description);
  });

  it("topicDescription fills the template with the lowercase label (tr-TR)", () => {
    expect(topicDescription("yasam")).toBe(
      "Siyasi gündemle kesişen yaşam haberleri, son 7 gün: iktidar, bağımsız ve muhalefet medyasının her olaya ne kadar yer verdiğini görün.",
    );
  });

  // h44-topics-3: Tayf clusters only articles that pass the politics gate, so a
  // hub holds the politics-adjacent stories of its topic, not "the week's spor
  // news". The old copy ("Son 7 günün teknoloji haberleri, olaylara göre
  // gruplanmış") promised the second; this one says the first.
  it("topicDescription('teknoloji') is the politics-scoped copy, not a promise of a full topic feed", () => {
    expect(topicDescription("teknoloji")).toBe(
      "Siyasi gündemle kesişen teknoloji haberleri, son 7 gün: iktidar, bağımsız ve muhalefet medyasının her olaya ne kadar yer verdiğini görün.",
    );
    expect(topicDescription("spor")).toMatch(/^Siyasi gündemle kesişen spor haberleri/);
    expect(topicDescription("spor")).not.toContain("olaylara göre gruplanmış");
  });

  // 'Genel' is an adjective, not a noun: "genel haberleri" (a possessive
  // compound with no possessor) is not Turkish, so the genel hub reads
  // "genel haberler". The noun labels keep the "<label> haberleri" compound.
  it("topicDescription('genel') uses the plain 'genel haberler' noun phrase, not the ungrammatical 'genel haberleri'", () => {
    expect(topicDescription("genel")).toBe(
      "Siyasi gündemle kesişen genel haberler, son 7 gün: iktidar, bağımsız ve muhalefet medyasının her olaya ne kadar yer verdiğini görün.",
    );
    expect(topicDescription("genel")).not.toContain("genel haberleri");
  });

  it.each(TOPIC_SLUGS)("topicDescription('%s') fits a 155-character snippet", (slug) => {
    expect(topicDescription(slug).length).toBeLessThanOrEqual(155);
  });

  it("no hub description is longer than 155 characters (measured max 137)", () => {
    const longest = Math.max(...TOPIC_SLUGS.map((slug) => topicDescription(slug).length));
    expect(longest).toBeLessThanOrEqual(155);
  });

  it("page 1 and an omitted page carry no query string", () => {
    for (const meta of [topicMetadata("spor"), topicMetadata("spor", 1)]) {
      expect(meta.alternates?.canonical).toBe("/konu/spor");
      expect(meta.openGraph?.url).toBe("/konu/spor");
    }
  });

  it("page N > 1 is self-canonical: canonical and og:url both carry ?sayfa=N", () => {
    const meta = topicMetadata("spor", 3);
    expect(meta.alternates?.canonical).toBe("/konu/spor?sayfa=3");
    expect(meta.openGraph?.url).toBe("/konu/spor?sayfa=3");
  });

  it("a page > 1 keeps the rest of the share metadata (image, twitter) intact and names the page in the og title", () => {
    const meta = topicMetadata("spor", 2);
    expect(meta.openGraph?.title).toBe("Spor haberleri — Sayfa 2 — Tayf");
    expect(firstImageUrl(meta.openGraph?.images)).toBe("/opengraph-image");
    expect(firstImageUrl(meta.twitter?.images)).toBe("/twitter-image");
    expect(meta.robots).toBeUndefined();
  });

  // h21: pages 2+ shared page 1's title, so a results page listed the same
  // headline for every ?sayfa=N of a hub. The page number is part of the title
  // (and of the og:/twitter: titles, which add the brand suffix themselves).
  describe("paged titles", () => {
    it("page 3 carries 'Sayfa 3' in the title, og:title and twitter:title", () => {
      const meta = topicMetadata("spor", 3);
      expect(meta.title).toBe("Spor haberleri — Sayfa 3");
      expect(meta.openGraph?.title).toBe("Spor haberleri — Sayfa 3 — Tayf");
      expect(meta.twitter?.title).toBe("Spor haberleri — Sayfa 3 — Tayf");
    });

    it("page 2 is 'Sayfa 2'", () => {
      expect(topicMetadata("spor", 2).title).toBe("Spor haberleri — Sayfa 2");
    });

    it("page 1, an omitted page and an out-of-range page clamped to 1 keep page 1's title exactly", () => {
      for (const meta of [
        topicMetadata("spor"),
        topicMetadata("spor", 1),
        topicMetadata("spor", 0),
        topicMetadata("spor", -4),
        topicMetadata("spor", Number.NaN),
      ]) {
        expect(meta.title).toBe("Spor haberleri");
        expect(meta.openGraph?.title).toBe("Spor haberleri — Tayf");
        expect(meta.twitter?.title).toBe("Spor haberleri — Tayf");
        expect(meta.alternates?.canonical).toBe("/konu/spor");
        expect(meta.openGraph?.url).toBe("/konu/spor");
      }
    });

    it("the title names the clamped page, so a hand-built huge page never mints a number past the cap", () => {
      const meta = topicMetadata("spor", 9999);
      expect(meta.title).toBe(`Spor haberleri — Sayfa ${TOPIC_MAX_PAGE}`);
      expect(meta.alternates?.canonical).toBe(`/konu/spor?sayfa=${TOPIC_MAX_PAGE}`);
    });

    it("canonical and og:url still use ?sayfa=N, and the description is page 1's", () => {
      const first = topicMetadata("spor");
      const meta = topicMetadata("spor", 3);
      expect(meta.alternates?.canonical).toBe("/konu/spor?sayfa=3");
      expect(meta.openGraph?.url).toBe("/konu/spor?sayfa=3");
      expect(meta.description).toBe(first.description);
    });

    it("every hub gets a distinct title on each of its pages", () => {
      const titles = TOPIC_SLUGS.flatMap((slug) =>
        [1, 2, 3].map((page) => String(topicMetadata(slug, page).title)),
      );
      expect(new Set(titles).size).toBe(TOPIC_SLUGS.length * 3);
    });
  });
});

// --- buildTopicCollectionPage -----------------------------------------------

describe("buildTopicCollectionPage", () => {
  it("emits a CollectionPage whose ItemList carries absolute /cluster/<id> URLs in render order", () => {
    const bundles = [
      { cluster: { id: "c1", title_tr: "Birinci" } },
      { cluster: { id: "c2", title_tr: "İkinci" } },
    ] as unknown as ClusterBundle[];

    const jsonLd = buildTopicCollectionPage({ slug: "dunya", bundles });

    expect(jsonLd["@context"]).toBe("https://schema.org");
    expect(jsonLd["@type"]).toBe("CollectionPage");
    expect(jsonLd.url).toContain("/konu/dunya");
    expect((jsonLd.isPartOf as Record<string, unknown>)["@type"]).toBe(
      "WebSite",
    );

    const mainEntity = jsonLd.mainEntity as Record<string, unknown>;
    expect(mainEntity["@type"]).toBe("ItemList");
    expect(mainEntity.numberOfItems).toBe(2);
    const items = mainEntity.itemListElement as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      "@type": "ListItem",
      position: 1,
      name: "Birinci",
    });
    expect(String(items[0]!.url)).toContain("/cluster/c1");
    expect(items[1]).toMatchObject({
      "@type": "ListItem",
      position: 2,
      name: "İkinci",
    });
    expect(String(items[1]!.url)).toContain("/cluster/c2");
  });

  // Page 1 is the byte-for-byte output captured from HEAD before the page
  // argument existed (origin pinned, because siteUrl() reads the environment):
  // the paged JSON-LD must not move it.
  it("page 1 (page omitted or 1) is byte-identical to the pre-paging output", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://tayf.test");
    try {
      const bundles = [
        { cluster: { id: "c1", title_tr: "Birinci" } },
        { cluster: { id: "c2", title_tr: "İkinci" } },
      ] as unknown as ClusterBundle[];
      const SNAPSHOT =
        '{"@context":"https://schema.org","@type":"CollectionPage","name":"Dünya haberleri","url":"https://tayf.test/konu/dunya","isPartOf":{"@type":"WebSite","name":"Tayf","url":"https://tayf.test"},"mainEntity":{"@type":"ItemList","numberOfItems":2,"itemListElement":[{"@type":"ListItem","position":1,"name":"Birinci","url":"https://tayf.test/cluster/c1"},{"@type":"ListItem","position":2,"name":"İkinci","url":"https://tayf.test/cluster/c2"}]}}';

      expect(JSON.stringify(buildTopicCollectionPage({ slug: "dunya", bundles }))).toBe(SNAPSHOT);
      expect(JSON.stringify(buildTopicCollectionPage({ slug: "dunya", bundles, page: 1 }))).toBe(SNAPSHOT);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  describe("a paged hub (?sayfa=N) describes its own page", () => {
    const bundles = [
      { cluster: { id: "c31", title_tr: "Otuz birinci" } },
      { cluster: { id: "c32", title_tr: "Otuz ikinci" } },
    ] as unknown as ClusterBundle[];

    it("page 2: the url carries ?sayfa=2", () => {
      const jsonLd = buildTopicCollectionPage({ slug: "dunya", bundles, page: 2 });
      expect(String(jsonLd.url).endsWith("/konu/dunya?sayfa=2")).toBe(true);
    });

    it("page 2: the name is the page <title> (Dünya haberleri — Sayfa 2)", () => {
      const jsonLd = buildTopicCollectionPage({ slug: "dunya", bundles, page: 2 });
      expect(jsonLd.name).toBe("Dünya haberleri — Sayfa 2");
      const title = topicMetadata("dunya", 2).title;
      expect(String(title)).toBe(String(jsonLd.name));
    });

    it("page 2: positions continue after the previous page (TOPIC_PAGE_SIZE + 1, + 2, ...)", () => {
      const jsonLd = buildTopicCollectionPage({ slug: "dunya", bundles, page: 2 });
      const items = (jsonLd.mainEntity as Record<string, unknown>).itemListElement as Array<Record<string, unknown>>;
      expect(items.map((i) => i.position)).toEqual([TOPIC_PAGE_SIZE + 1, TOPIC_PAGE_SIZE + 2]);
      expect(String(items[0]!.url)).toContain("/cluster/c31");
    });

    it("page 3 starts at 2 * TOPIC_PAGE_SIZE + 1 and numberOfItems stays the length of this page", () => {
      const jsonLd = buildTopicCollectionPage({ slug: "spor", bundles, page: 3 });
      const mainEntity = jsonLd.mainEntity as Record<string, unknown>;
      const items = mainEntity.itemListElement as Array<Record<string, unknown>>;
      expect(items[0]!.position).toBe(2 * TOPIC_PAGE_SIZE + 1);
      expect(mainEntity.numberOfItems).toBe(2);
      expect(String(jsonLd.url).endsWith("/konu/spor?sayfa=3")).toBe(true);
      expect(jsonLd.name).toBe("Spor haberleri — Sayfa 3");
    });

    it("clamps the page like the rest of the hub: a nonsense page reads as page 1, a huge one as TOPIC_MAX_PAGE", () => {
      const first = buildTopicCollectionPage({ slug: "dunya", bundles, page: 0 });
      expect(String(first.url).endsWith("/konu/dunya")).toBe(true);
      expect(first.name).toBe("Dünya haberleri");

      const last = buildTopicCollectionPage({ slug: "dunya", bundles, page: 999 });
      expect(String(last.url).endsWith(`/konu/dunya?sayfa=${TOPIC_MAX_PAGE}`)).toBe(true);
      const items = (last.mainEntity as Record<string, unknown>).itemListElement as Array<Record<string, unknown>>;
      expect(items[0]!.position).toBe((TOPIC_MAX_PAGE - 1) * TOPIC_PAGE_SIZE + 1);
    });
  });
});
