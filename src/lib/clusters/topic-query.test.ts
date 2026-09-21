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
// resolver distinguishes the embedded list query (selectArgs[0] is the
// long CLUSTER_EMBED_SELECT string) from a head/exact count query
// (selectArgs[0] === "id") so one fixture object serves both
// getTopicClusters and getTopicCounts.
const fixture = vi.hoisted(() => ({
  clusters: [] as unknown[],
  clustersError: null as { message: string } | null,
  clustersThrows: false,
  clusterState: null as unknown,
  countStates: [] as unknown[],
  countsBySlug: {} as Record<string, number>,
  countError: null as { message: string } | null,
  // A successful PostgREST response (error: null) can still carry a null
  // count when the total isn't in Content-Range — simulated per-slug so
  // C1-COUNTS-NULL-ZERO's fix (treat null count like the error branch,
  // never `?? 0`) has a regression case.
  countNullSlug: null as string | null,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state) => {
        const isCountQuery = state.selectArgs[0] === "id";
        if (isCountQuery) {
          fixture.countStates.push(state);
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
        fixture.clusterState = state;
        if (fixture.clustersThrows) throw new Error("boom");
        if (fixture.clustersError) return { data: null, error: fixture.clustersError };
        return { data: fixture.clusters, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import { cacheLife, cacheTag } from "next/cache";
import {
  clampTopicPage,
  getTopicClusters,
  getTopicCounts,
  isTopicSlug,
  buildTopicCollectionPage,
  topicMetadata,
  TOPIC_SLUGS,
  TOPIC_LABELS_TR,
  TOPIC_PAGE_SIZE,
  TOPIC_MAX_PAGE,
  TOPIC_WINDOW_MS,
  TOPIC_NOTE_PREFIX,
  TOPIC_NOTE_LINK_LABEL,
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
  fixture.countStates = [];
  fixture.countsBySlug = {};
  fixture.countError = null;
  fixture.countNullSlug = null;
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
}) {
  const memberCount = opts.memberCount ?? 1;
  return {
    id: opts.id,
    title_tr: opts.title_tr ?? `Cluster ${opts.id}`,
    title_tr_neutral: null,
    summary_tr: "summary",
    bias_distribution: {},
    is_blindspot: false,
    blindspot_side: null,
    article_count: memberCount,
    first_published: "2026-09-18T10:00:00.000Z",
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
  it("filters on topic7 = slug, is_archived = false and the trailing 7-day updated_at window, newest first", async () => {
    const before = Date.now();
    await getTopicClusters("dunya", 1);
    const after = Date.now();

    const state = fixture.clusterState as BuilderState;
    expect(state.table).toBe("clusters");
    expect(String(state.selectArgs[0])).toBe(CLUSTER_EMBED_SELECT);
    expect(state.eq).toContainEqual({ col: "is_archived", val: false });
    expect(state.eq).toContainEqual({ col: "topic7", val: "dunya" });
    expect(state.order).toContainEqual({
      col: "updated_at",
      opts: { ascending: false },
    });
    // Tiebreaker on the uuid primary key: without it, OFFSET pagination over
    // rows sharing an updated_at timestamp is not a total order.
    expect(state.order).toContainEqual({
      col: "id",
      opts: { ascending: false },
    });

    const from = state.gte.find((g) => g.col === "updated_at");
    expect(from).toBeDefined();
    const fromMs = Date.parse(String(from!.val));
    expect(fromMs).toBeGreaterThanOrEqual(before - TOPIC_WINDOW_MS);
    expect(fromMs).toBeLessThanOrEqual(after - TOPIC_WINDOW_MS);

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

describe("TOPIC_NOTE_PREFIX / TOPIC_NOTE_LINK_LABEL", () => {
  it("TOPIC_NOTE_PREFIX names Jev and states the 0,8 threshold, and the note links to /metodoloji", () => {
    expect(TOPIC_NOTE_PREFIX).toContain("Jev");
    expect(TOPIC_NOTE_PREFIX).toContain("0,8");
    expect(TOPIC_NOTE_LINK_LABEL).toBe("yöntem");
  });
});

// --- topicMetadata --------------------------------------------------------

describe("topicMetadata", () => {
  it("sets the Turkish title and the /konu/<slug> canonical, and omits openGraph images and the robots key", () => {
    const meta = topicMetadata("dunya");

    expect(meta.title).toBe("Dünya haberleri");
    expect(meta.alternates).toEqual({ canonical: "/konu/dunya" });
    expect(meta.robots).toBeUndefined();
    expect((meta as { openGraph?: unknown }).openGraph).toBeUndefined();
    expect((meta as { twitter?: unknown }).twitter).toBeUndefined();
    expect(typeof meta.description).toBe("string");
    expect(String(meta.description)).toContain("0,8");
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
});
