import { createElement, type DependencyList, type EffectCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// h55-personal-3: the home "N yeni haber" pill stamps the last visit only on a
// render that actually showed the feed. HomeFeed is called directly (the same
// pattern as page.test.tsx) and the stamp prop of the NewSinceLastVisit element
// is read off the returned tree. The effect that writes localStorage needs a
// browser; the prop is what decides whether it writes.
//
// h112-follows-1: the same props then drive the REAL component, with react's
// useEffect run synchronously and a stub localStorage, to pin what the stamp
// effect writes: the stamp plus the seen record (ids + minimum first_published
// of exactly the rendered clusters).

const effectMode = vi.hoisted(() => ({ run: false }));
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return {
    ...actual,
    // renderToString never runs effects: when asked, run the body at once.
    useEffect: (fn: EffectCallback, deps?: DependencyList): void => {
      if (effectMode.run) fn();
      else actual.useEffect(fn, deps);
    },
  };
});

const getPoliticsClusters = vi.fn();
// Only the read is faked: the page's pure helpers (splitHomeFeed, knownBreakingIds; h170-roadmap-2) stay real.
vi.mock("@/lib/clusters/politics-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clusters/politics-query")>();
  return { ...actual, getPoliticsClusters: () => getPoliticsClusters() };
});

const searchClusters = vi.fn();
vi.mock("@/lib/clusters/search-query", () => ({
  searchClusters: (q: string) => searchClusters(q),
}));

// HomeFeed starts the "Yükselen konular" rail's read beside the feed read (loadRisingRail). Faked, so no
// test here reaches the database: an empty answer is a rail that renders nothing.
vi.mock("@/lib/trends/rising-query", () => ({
  getRisingEntities: () => Promise.resolve(null),
}));

import { HomeFeed } from "./page";
import { NewSinceLastVisit } from "@/components/home/new-since-last-visit";
import type { PoliticsClustersResult } from "@/lib/clusters/politics-query";

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

function bundle(id: string, at = "2026-10-31T10:00:00.000Z") {
  return {
    cluster: { id, title_tr: `Haber ${id}`, first_published: at, updated_at: at },
    articles: [],
    sources: [],
    isWireRedistribution: false,
    effectiveArticleCount: 2,
  };
}

function feedOf(n: number) {
  return {
    bundles: Array.from({ length: n }, (_, i) => bundle(`b${i + 1}`)),
    breakingBundles: [],
  } as unknown as PoliticsClustersResult;
}

/** A feed with distinct times, so the floor is observable: breaking strip + ranked rows. */
function datedFeed() {
  return {
    breakingBundles: [bundle("BR-1", "2026-10-31T11:30:00.000Z")],
    bundles: [
      bundle("R-1", "2026-10-31T10:00:00.000Z"),
      bundle("R-2", "2026-10-31T06:15:00.000Z"),
      bundle("R-3", "2026-10-31T08:00:00.000Z"),
    ],
  } as unknown as PoliticsClustersResult;
}

/** The single NewSinceLastVisit mount of one HomeFeed render. */
async function pill(searchParams: { q?: string | string[]; page?: string | string[] }) {
  const tree = await HomeFeed({ searchParams: Promise.resolve(searchParams) });
  const mounts = collectElements(tree).filter((el) => el.type === NewSinceLastVisit);
  expect(mounts).toHaveLength(1);
  return mounts[0]!.props as {
    stamp: boolean;
    items: { id: string; firstPublished: string }[];
    listed: { id: string; firstPublished: string }[];
  };
}

afterEach(() => {
  effectMode.run = false;
  vi.unstubAllGlobals();
});

beforeEach(() => {
  getPoliticsClusters.mockReset();
  searchClusters.mockReset();
  searchClusters.mockResolvedValue({ ok: true, bundles: [] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("HomeFeed -> NewSinceLastVisit stamp", () => {
  it("stamps on the plain home feed", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(3));
    const props = await pill({});
    expect(props.stamp).toBe(true);
    expect(props.items).toHaveLength(3);
    expect(props.listed).toHaveLength(3);
  });

  it("stamps on an explicit ?page=1 and on a blank ?q=", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(3));
    expect((await pill({ page: "1" })).stamp).toBe(true);
    expect((await pill({ q: "   " })).stamp).toBe(true);
  });

  it("does not stamp the FeedUnavailable shell (the reader saw no stories)", async () => {
    getPoliticsClusters.mockRejectedValue(new Error("db down"));
    const props = await pill({});
    expect(props.stamp).toBe(false);
    expect(props.items).toEqual([]);
    expect(props.listed).toEqual([]);
  });

  it("does not stamp a /?q= search view", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(3));
    expect((await pill({ q: "seçim" })).stamp).toBe(false);
    // The first value of a repeated ?q= decides, like the rest of the page.
    expect((await pill({ q: ["seçim", "ekonomi"] })).stamp).toBe(false);
  });

  it("does not stamp the unavailable shell of a search either", async () => {
    getPoliticsClusters.mockRejectedValue(new Error("db down"));
    expect((await pill({ q: "seçim" })).stamp).toBe(false);
  });

  it("does not stamp ?page=2", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(31));
    expect((await pill({ page: "2" })).stamp).toBe(false);
  });

  it("judges the CLAMPED page: ?page=99 on a one-page feed is page 1 and stamps", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(3));
    expect((await pill({ page: "99" })).stamp).toBe(true);
  });

  it("?page=99 on a three-page feed clamps to page 3 and does not stamp", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(31));
    expect((await pill({ page: "99" })).stamp).toBe(false);
  });

  it("a search on page 2 does not stamp", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(31));
    expect((await pill({ q: "haber", page: "2" })).stamp).toBe(false);
  });
});

describe("HomeFeed -> NewSinceLastVisit items (h112-follows-1)", () => {
  it("passes the id and first_published of the breaking strip and the page rows", async () => {
    getPoliticsClusters.mockResolvedValue(datedFeed());
    const props = await pill({});
    expect(props.items).toEqual([
      { id: "BR-1", firstPublished: "2026-10-31T11:30:00.000Z" },
      { id: "R-1", firstPublished: "2026-10-31T10:00:00.000Z" },
      { id: "R-2", firstPublished: "2026-10-31T06:15:00.000Z" },
      { id: "R-3", firstPublished: "2026-10-31T08:00:00.000Z" },
    ]);
  });

  it("passes only the rows of this page (the last page of 31 rows at 15 per page holds row 31)", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(31));
    const props = await pill({ page: "3" });
    expect(props.items).toEqual([{ id: "b31", firstPublished: "2026-10-31T10:00:00.000Z" }]);
  });
});

describe("HomeFeed -> NewSinceLastVisit listed (h113 correctness-1)", () => {
  it("lists the breaking strip plus EVERY ranked row, whatever page was asked for", async () => {
    getPoliticsClusters.mockResolvedValue(datedFeed());
    const props = await pill({});
    expect(props.listed).toEqual([
      { id: "BR-1", firstPublished: "2026-10-31T11:30:00.000Z" },
      { id: "R-1", firstPublished: "2026-10-31T10:00:00.000Z" },
      { id: "R-2", firstPublished: "2026-10-31T06:15:00.000Z" },
      { id: "R-3", firstPublished: "2026-10-31T08:00:00.000Z" },
    ]);
  });

  it("page 1 of a 31-row feed shows 15 rows but lists all 31 (page 2 is disjoint from page 1)", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(31));
    const props = await pill({});
    expect(props.items).toHaveLength(15);
    expect(props.listed.map((i) => i.id)).toEqual(Array.from({ length: 31 }, (_, i) => `b${i + 1}`));
  });

  it("the breaking strip is listed once: a cluster that is breaking AND ranked is deduped like the page", async () => {
    getPoliticsClusters.mockResolvedValue({
      breakingBundles: [bundle("DUP", "2026-10-31T11:30:00.000Z")],
      bundles: [bundle("DUP", "2026-10-31T11:30:00.000Z"), bundle("R-1", "2026-10-31T10:00:00.000Z")],
    } as unknown as PoliticsClustersResult);
    const props = await pill({});
    expect(props.listed.map((i) => i.id)).toEqual(["DUP", "R-1"]);
  });

  it("listed is the same whether or not the reader asked for page 1 explicitly", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(31));
    expect((await pill({ page: "1" })).listed).toEqual((await pill({})).listed);
  });
});

describe("the stamp effect writes the seen record (h112-follows-1)", () => {
  /** Mounts the real component with a stub localStorage; returns every write. */
  async function mount(props: {
    stamp: boolean;
    items: { id: string; firstPublished: string }[];
    listed: { id: string; firstPublished: string }[];
  }) {
    const writes: [string, string][] = [];
    const removed: string[] = [];
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => null,
        setItem: (k: string, v: string) => void writes.push([k, v]),
        removeItem: (k: string) => void removed.push(k),
      },
    });
    effectMode.run = true;
    const { renderToString } = await import("react-dom/server");
    renderToString(createElement(NewSinceLastVisit, props));
    return { writes, removed };
  }

  it("stamp=true: the stamp, then the record with the rendered ids (lower-cased) and their minimum first_published", async () => {
    getPoliticsClusters.mockResolvedValue(datedFeed());
    const props = await pill({});
    const { writes } = await mount(props);

    expect(writes.map(([k]) => k)).toEqual(["tayf:last-visit", "tayf:last-visit-seen"]);
    expect(writes[0]![1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const record = JSON.parse(writes[1]![1]) as { v: number; ids: string[]; floor: string };
    expect(record.v).toBe(1);
    expect([...record.ids].sort()).toEqual(["br-1", "r-1", "r-2", "r-3"]);
    expect(record.floor).toBe("2026-10-31T06:15:00.000Z");
  });

  it("stamp=true on page 1 of a 31-row feed: the record holds all 31 listed ids, not the 15 on screen (h113 correctness-1)", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(31));
    const props = await pill({});
    const { writes } = await mount(props);
    const record = JSON.parse(writes[1]![1]) as { ids: string[] };
    expect(record.ids).toHaveLength(31);
    expect(record.ids).toContain("b31");
  });

  it("stamp=false (search, ?page=N, outage shell): writes nothing and removes nothing", async () => {
    getPoliticsClusters.mockResolvedValue(datedFeed());
    const props = await pill({ q: "seçim" });
    expect(props.stamp).toBe(false);
    const { writes, removed } = await mount(props);
    expect(writes).toEqual([]);
    expect(removed).toEqual([]);

    getPoliticsClusters.mockRejectedValue(new Error("db down"));
    const shell = await pill({});
    const again = await mount(shell);
    expect(again.writes).toEqual([]);
    expect(again.removed).toEqual([]);
  });

  it("stamp=true with an empty feed stamps and drops any older record (the stamp rule applies next time)", async () => {
    getPoliticsClusters.mockResolvedValue({ bundles: [], breakingBundles: [] } as unknown as PoliticsClustersResult);
    const props = await pill({});
    expect(props.stamp).toBe(true);
    const { writes, removed } = await mount(props);
    expect(writes.map(([k]) => k)).toEqual(["tayf:last-visit"]);
    expect(removed).toEqual(["tayf:last-visit-seen"]);
  });
});
