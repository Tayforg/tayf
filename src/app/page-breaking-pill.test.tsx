import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// h170-roadmap-2: HomeFeed mounts the "N yeni son dakika haberi · Yenile" pill
// (NewBreakingPill) only where the reader is looking at page 1 of the plain feed:
// the same rule as the last-visit stamp (shouldStampLastVisit). HomeFeed is called
// directly (the pattern of page-last-visit.test.tsx) and the pill's element is read
// off the returned tree; what the client component does with its props is covered
// in src/components/home/new-breaking-pill.test.tsx.
//
// The pill is told the ids of EVERY story this render lists (the strip and the whole
// ranked set, at most 36), with no clock and no age filter, and nothing else: ids
// only, so the props stay small. A render-clock filter was a bug: the 2 h window is
// applied once, when the "use cache" entry is filled (up to 300 s before the render),
// so the strip can still hold a story that is over 2 h old by the render clock, and
// the head (read from the same entry) lists it too. knownIds must therefore change
// only when the entry does, never because the render clock moved.
// ---------------------------------------------------------------------------

const getPoliticsClusters = vi.fn();
vi.mock("@/lib/clusters/politics-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clusters/politics-query")>();
  return {
    ...actual,
    getPoliticsClusters: () => getPoliticsClusters(),
  };
});

const searchClusters = vi.fn();
vi.mock("@/lib/clusters/search-query", () => ({
  searchClusters: (...args: unknown[]) => searchClusters(...args),
}));

vi.mock("@/lib/search/search-intent-query", () => ({
  loadSearchIntent: () => Promise.resolve(null),
}));

// HomeFeed starts the "Yükselen konular" rail's read beside the feed read (loadRisingRail). Faked, so no
// test here reaches the database: an empty answer is a rail that renders nothing.
vi.mock("@/lib/trends/rising-query", () => ({
  getRisingEntities: () => Promise.resolve(null),
}));

// Pin the request clock (movable, so a test can render the same feed later). Every other export of
// @/lib/time stays real.
const NOW = Date.UTC(2026, 10, 13, 9, 0, 0);
let clockMs = NOW;
vi.mock("@/lib/time", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/time")>();
  return { ...actual, currentTimeMs: () => clockMs };
});

import { HomeFeed } from "./page";
import { NewBreakingPill } from "@/components/home/new-breaking-pill";
import { NewSinceLastVisit } from "@/components/home/new-since-last-visit";
import { splitHomeFeed, type PoliticsClustersResult } from "@/lib/clusters/politics-query";
import { shouldStampLastVisit } from "@/lib/last-visit";
import { pageSignature, refreshOutcome } from "@/lib/clusters/timeline-head";

type Elementish = { type?: unknown; props?: Record<string, unknown> };

function collectElements(node: unknown, out: Elementish[] = []): Elementish[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as Elementish;
    if (el.type !== undefined) out.push(el);
    if (el.props?.children !== undefined) collectElements(el.props.children, out);
  }
  return out;
}

function bundle(id: string, minutesAgo: number) {
  const at = new Date(NOW - minutesAgo * 60_000).toISOString();
  return {
    cluster: { id, title_tr: `Haber ${id}`, first_published: at, updated_at: at },
    articles: [],
    sources: [],
    isWireRedistribution: false,
    effectiveArticleCount: 2,
  };
}

/** `strip` breaking stories (3, 8, 13 ... minutes old) and `ranked` ranked ones (3 h old and older). */
function feedOf(strip: number, ranked: number) {
  return {
    breakingBundles: Array.from({ length: strip }, (_, i) => bundle(`s${i + 1}`, 3 + i * 5)),
    bundles: Array.from({ length: ranked }, (_, i) => bundle(`r${i + 1}`, 180 + i)),
  } as unknown as PoliticsClustersResult;
}

type Params = { q?: string | string[]; page?: string | string[]; arsiv?: string | string[] };

async function mounts(searchParams: Params) {
  const tree = await HomeFeed({ searchParams: Promise.resolve(searchParams) });
  return collectElements(tree).filter((el) => el.type === NewBreakingPill);
}

beforeEach(() => {
  clockMs = NOW;
  getPoliticsClusters.mockReset();
  searchClusters.mockReset();
  searchClusters.mockResolvedValue({ ok: true, bundles: [] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HomeFeed -> NewBreakingPill mounting", () => {
  it("mounts once on the plain home feed", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(2, 5));
    expect(await mounts({})).toHaveLength(1);
  });

  it("mounts on an explicit ?page=1, on a blank ?q= and on ?page=99 of a one-page feed (that is page 1)", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(2, 5));
    expect(await mounts({ page: "1" })).toHaveLength(1);
    expect(await mounts({ q: "   " })).toHaveLength(1);
    expect(await mounts({ page: "99" })).toHaveLength(1);
  });

  it("mounts on an empty plain feed too (a first story arriving later is worth the pill)", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(0, 0));
    const found = await mounts({});
    expect(found).toHaveLength(1);
    expect(found[0]!.props?.knownIds).toEqual([]);
  });

  it("does not mount on ?page=2, nor on ?page=99 when that clamps to a later page", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(2, 31));
    expect(await mounts({ page: "2" })).toHaveLength(0);
    expect(await mounts({ page: "99" })).toHaveLength(0);
  });

  it("does not mount on a /?q= search, a repeated ?q= or a search on page 2", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(2, 31));
    expect(await mounts({ q: "seçim" })).toHaveLength(0);
    expect(await mounts({ q: ["seçim", "ekonomi"] })).toHaveLength(0);
    expect(await mounts({ q: "haber", page: "2" })).toHaveLength(0);
  });

  it("does not mount on a later page of a search archive (?arsiv=N)", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(2, 5));
    expect(await mounts({ q: "haber", arsiv: "2" })).toHaveLength(0);
    // ?arsiv= without a query is ignored: that is the plain feed.
    expect(await mounts({ arsiv: "2" })).toHaveLength(1);
  });

  it("does not mount in the outage shell", async () => {
    getPoliticsClusters.mockRejectedValue(new Error("db down"));
    expect(await mounts({})).toHaveLength(0);
    expect(await mounts({ q: "seçim" })).toHaveLength(0);
  });

  it("agrees with shouldStampLastVisit for every case above (one rule for both pills)", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(2, 31));
    const cases: Array<[Params, { page: number; q: string | undefined }]> = [
      [{}, { page: 1, q: undefined }],
      [{ page: "2" }, { page: 2, q: undefined }],
      [{ q: "seçim" }, { page: 1, q: "seçim" }],
      [{ q: "   " }, { page: 1, q: undefined }],
    ];
    for (const [params, rule] of cases) {
      const stamps = shouldStampLastVisit({ ...rule, feedOk: true });
      expect((await mounts(params)).length === 1, JSON.stringify(params)).toBe(stamps);
    }
  });
});

describe("HomeFeed -> NewBreakingPill knownIds", () => {
  it("is every listed id (strip + whole ranked set), ids only", async () => {
    // Strip: s1 (3 min), s2 (8 min). Ranked: r1.. are 3 h old and older: listed, so known, whatever their age.
    getPoliticsClusters.mockResolvedValue(feedOf(2, 5));
    const [pill] = await mounts({});
    expect(pill!.props).toEqual({ knownIds: ["s1", "s2", "r1", "r2", "r3", "r4", "r5"] });
  });

  it("includes a ranked story inside the window and one outside it alike", async () => {
    const feed = feedOf(1, 0);
    // A 90-minute-old story that scored into the ranked list but is not in the strip (one outlet only, say).
    (feed.bundles as unknown[]).push(bundle("ranked-fresh", 90), bundle("ranked-old", 130));
    getPoliticsClusters.mockResolvedValue(feed);
    const [pill] = await mounts({});
    expect(pill!.props?.knownIds).toEqual(["s1", "ranked-fresh", "ranked-old"]);
  });

  it("includes a strip story first published NOW - 2 h - 60 s (a stale entry can hold one)", async () => {
    // The entry was filled up to 300 s before this render with the story 2 h - 1 min old; by the render
    // clock it is 2 h + 60 s old. The head, read from the same entry, still lists it, so the page must know it.
    const feed = feedOf(1, 0);
    const staleStrip = bundle("stale-strip", 121);
    expect(NOW - Date.parse(staleStrip.cluster.first_published)).toBe(2 * 60 * 60_000 + 60_000);
    (feed.breakingBundles as unknown[]).push(staleStrip);
    getPoliticsClusters.mockResolvedValue(feed);
    const [pill] = await mounts({});
    expect(pill!.props?.knownIds).toEqual(["s1", "stale-strip"]);
  });

  it("does not depend on the render clock: the same feed rendered 10 minutes later gives the same knownIds, so a refresh from an unchanged entry is a retry, not 'changed'", async () => {
    // r-edge is 115 min old at the first render and 125 min old at the second: it crosses the 2 h mark
    // between the two renders while the cache entry stays the same.
    const feed = feedOf(1, 0);
    (feed.bundles as unknown[]).push(bundle("r-edge", 115), bundle("r-old", 300));
    getPoliticsClusters.mockResolvedValue(feed);

    clockMs = NOW;
    const [first] = await mounts({});
    clockMs = NOW + 10 * 60_000;
    const [second] = await mounts({});

    const a = first!.props?.knownIds as string[];
    const b = second!.props?.knownIds as string[];
    expect(b).toEqual(a);
    expect(a).toContain("r-edge");
    expect(refreshOutcome(pageSignature(null, a), pageSignature(null, b), 0)).toBe("retry");
  });

  it("lists a story that is in both the strip and the ranked list once", async () => {
    const feed = feedOf(2, 0);
    (feed.bundles as unknown[]).push(feed.breakingBundles[0]);
    getPoliticsClusters.mockResolvedValue(feed);
    const [pill] = await mounts({});
    expect(pill!.props?.knownIds).toEqual(["s1", "s2"]);
  });

  it("covers the whole ranked set, not only page 1's rows", async () => {
    const feed = feedOf(0, 0);
    // 31 ranked stories, all inside the window: 3 pages of 15, and every one of them is known.
    (feed.bundles as unknown[]).push(...Array.from({ length: 31 }, (_, i) => bundle(`f${i + 1}`, 5 + i)));
    getPoliticsClusters.mockResolvedValue(feed);
    const [pill] = await mounts({});
    expect(pill!.props?.knownIds).toHaveLength(31);
  });

  it("holds only strings", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(3, 3));
    const [pill] = await mounts({});
    const known = pill!.props?.knownIds as unknown[];
    expect(known.every((id) => typeof id === "string")).toBe(true);
  });
});

describe("HomeFeed -> the strip and the head can never drift", () => {
  it("the stories the pill treats as known are a subset of what splitHomeFeed lists", async () => {
    const feed = feedOf(3, 4);
    getPoliticsClusters.mockResolvedValue(feed);
    const [pill] = await mounts({});
    const { filteredBreaking, ranked } = splitHomeFeed(feed);
    const listed = new Set([...filteredBreaking, ...ranked].map((b) => b.cluster.id));
    for (const id of pill!.props?.knownIds as string[]) expect(listed.has(id)).toBe(true);
  });
});

describe("HomeFeed -> the pill never changes the layout of the feed", () => {
  it("is never the last child of the feed section (the section's space-y gap is on every child but the last)", async () => {
    for (const feed of [feedOf(2, 5), feedOf(0, 0)]) {
      getPoliticsClusters.mockResolvedValue(feed);
      const tree = (await HomeFeed({ searchParams: Promise.resolve({}) })) as {
        props: { children: unknown[] };
      };
      const children = tree.props.children;
      const at = children.findIndex(
        (c) => c !== null && typeof c === "object" && (c as Elementish).type === NewBreakingPill,
      );
      expect(at).toBeGreaterThanOrEqual(0);
      expect(children.slice(at + 1).some(Boolean)).toBe(true);
    }
  });

  it("hands the pill no layout props: ids only, nothing that could size or place it", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(2, 5));
    const [pill] = await mounts({});
    expect(Object.keys(pill!.props ?? {})).toEqual(["knownIds"]);
  });
});

describe("HomeFeed -> the since-last-visit pill is untouched", () => {
  it("still mounts once beside the new pill with the same stamp rule", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(2, 5));
    const tree = await HomeFeed({ searchParams: Promise.resolve({}) });
    const all = collectElements(tree);
    const visit = all.filter((el) => el.type === NewSinceLastVisit);
    expect(visit).toHaveLength(1);
    expect(visit[0]!.props?.stamp).toBe(true);
    // The new pill sits after it in the tree: nothing above the first card moves.
    const order = all.map((el) => el.type);
    expect(order.indexOf(NewBreakingPill)).toBeGreaterThan(order.indexOf(NewSinceLastVisit));
  });
});
