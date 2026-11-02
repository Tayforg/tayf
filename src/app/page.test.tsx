import { Suspense } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// seo-error-states A.2: "/" must NEVER emit <meta name="robots"
// content="noindex">, not even in the FeedUnavailable retry state. That state
// is a transient cold-read timeout and "/" is the most-crawled URL; a noindex
// seen during a blip would drop the homepage from the index (see page.tsx).
//
// NOTE: these assertions walk the React element tree. They pin WHICH states
// carry the tag, not WHERE it lands in the final document: HomeFeed streams
// behind <Suspense>, so the tag is emitted in <body>, not <head> (see the
// placement caveat in page.tsx).
//
// `HomeFeed` is the streamed, data-dependent body of the page (the same
// pattern as BlindspotsFeed in blindspots/page.tsx): it is exported so this
// suite can call it directly instead of needing a Suspense-aware renderer.
// ---------------------------------------------------------------------------

const getPoliticsClusters = vi.fn();
vi.mock("@/lib/clusters/politics-query", () => ({
  getPoliticsClusters: () => getPoliticsClusters(),
}));

const searchClusters = vi.fn();
vi.mock("@/lib/clusters/search-query", () => ({
  searchClusters: (q: string) => searchClusters(q),
}));

// composeSearchView passes through to the real implementation unless a test
// installs `viewOverride` (used to pin how the page renders `archiveCapped`
// without depending on how search-view derives it).
let viewOverride: ((args: unknown) => unknown) | null = null;
vi.mock("@/lib/clusters/search-view", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/clusters/search-view")>();
  return {
    ...actual,
    composeSearchView: (args: Parameters<typeof actual.composeSearchView>[0]) =>
      viewOverride ? viewOverride(args) : actual.composeSearchView(args),
  };
});

// Pin the request clock so the day-bucket headings are deterministic. Every
// other export of @/lib/time stays real. `null` = the real clock.
let nowOverrideMs: number | null = null;
vi.mock("@/lib/time", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/time")>();
  return {
    ...actual,
    currentTimeMs: () => nowOverrideMs ?? actual.currentTimeMs(),
  };
});

import HomePage, { HomeFeed, generateMetadata } from "./page";
import { FocusFeedOnPageChange } from "@/components/home/focus-feed-on-page-change";
import type { PoliticsClustersResult } from "@/lib/clusters/politics-query";

type Elementish = { type?: unknown; props?: Record<string, unknown> };

/** Collects every element in the tree (props.children walked recursively). */
function collectElements(node: unknown, out: Elementish[] = []): Elementish[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as Elementish;
    if (el.type !== undefined) out.push(el);
    if (el.props?.children !== undefined) {
      collectElements(el.props.children, out);
    }
  }
  return out;
}

function hasNoindexMeta(tree: unknown): boolean {
  return collectElements(tree).some(
    (el) =>
      el.type === "meta" &&
      el.props?.name === "robots" &&
      el.props?.content === "noindex",
  );
}

/** Concatenated text of a node (strings and numbers only, children walked). */
function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object") {
    return textOf((node as Elementish).props?.children);
  }
  return "";
}

/** Ids of every ClusterCard element in the tree, in render order. */
function clusterCardIds(tree: unknown): string[] {
  return collectElements(tree)
    .filter((el) => el.props?.cluster !== undefined)
    .map((el) => (el.props?.cluster as { id: string }).id);
}

function bundle(id: string, title_tr: string) {
  const at = "2026-10-31T10:00:00.000Z";
  return {
    cluster: { id, title_tr, first_published: at, updated_at: at },
    articles: [],
    sources: [],
    isWireRedistribution: false,
    effectiveArticleCount: 2,
  };
}

function feedOf(...bundles: ReturnType<typeof bundle>[]) {
  return { bundles, breakingBundles: [] } as unknown as PoliticsClustersResult;
}

beforeEach(() => {
  getPoliticsClusters.mockReset();
  searchClusters.mockReset();
  viewOverride = null;
  nowOverrideMs = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("HomeFeed — never emits noindex", () => {
  it("does not emit noindex when the politics feed fails to load", async () => {
    getPoliticsClusters.mockRejectedValue(new Error("db down"));

    const tree = (await HomeFeed({
      searchParams: Promise.resolve({}),
    })) as Elementish;

    expect(hasNoindexMeta(tree)).toBe(false);
    // Still the retry state: SearchStatus (the live region, empty without a
    // q) + NewSinceLastVisit + FeedUnavailable.
    expect(tree.props?.children as Elementish[]).toHaveLength(3);
  });

  it("does not emit noindex when the feed loads but is empty", async () => {
    getPoliticsClusters.mockResolvedValue({
      bundles: [],
      breakingBundles: [],
    } as unknown as PoliticsClustersResult);

    const tree = await HomeFeed({ searchParams: Promise.resolve({}) });

    expect(hasNoindexMeta(tree)).toBe(false);
  });

  it("does not emit noindex on a search page when the feed is healthy", async () => {
    getPoliticsClusters.mockResolvedValue({
      bundles: [],
      breakingBundles: [],
    } as unknown as PoliticsClustersResult);
    searchClusters.mockResolvedValue({ ok: false });

    const tree = await HomeFeed({
      searchParams: Promise.resolve({ q: "seçim" }),
    });

    expect(hasNoindexMeta(tree)).toBe(false);
  });
});

describe("HomeFeed — repeated ?q= (array searchParams)", () => {
  it("renders the first q instead of throwing on /?q=seçim&q=erdoğan", async () => {
    getPoliticsClusters.mockResolvedValue({
      bundles: [],
      breakingBundles: [],
    } as unknown as PoliticsClustersResult);
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });

    await expect(
      HomeFeed({ searchParams: Promise.resolve({ q: ["seçim", "erdoğan"] }) }),
    ).resolves.toBeTruthy();

    expect(searchClusters).toHaveBeenCalledTimes(1);
    expect(searchClusters).toHaveBeenCalledWith("seçim");
  });

  it("treats an empty q array like no search", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(bundle("a", "AK Parti")));

    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: [] }) });

    expect(searchClusters).not.toHaveBeenCalled();
    expect(clusterCardIds(tree)).toEqual(["a"]);
  });

  it("does not crash on an array page", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(bundle("a", "AK Parti")));

    const tree = await HomeFeed({
      searchParams: Promise.resolve({ page: ["2", "3"] }),
    });

    expect(clusterCardIds(tree)).toEqual(["a"]);
  });
});

describe("HomeFeed — in-feed matcher", () => {
  const feed = () =>
    feedOf(
      bundle("ak", "AK Parti açıklama yaptı"),
      bundle("bas", "Başbakan dakikaya kadar bekledi"),
    );

  it("matches at word starts only: ak finds AK Parti, not Başbakan or dakikaya", async () => {
    getPoliticsClusters.mockResolvedValue(feed());
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });

    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: "ak" }) });

    expect(clusterCardIds(tree)).toEqual(["ak"]);
  });

  it("matches order-free, quoted and apostrophe-suffixed queries", async () => {
    getPoliticsClusters.mockResolvedValue(
      feedOf(
        bundle("c1", "Cumhurbaşkanı Erdoğan açıkladı"),
        bundle("c2", "İstanbul'da yağış"),
        bundle("c3", "Spor haberleri"),
      ),
    );
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });

    for (const [q, ids] of [
      ["Erdoğan Cumhurbaşkanı", ["c1"]],
      ['"Cumhurbaşkanı Erdoğan"', ["c1"]],
      ["Erdoğan'ın", ["c1"]],
      ["ISTANBUL", ["c2"]],
    ] as const) {
      const tree = await HomeFeed({ searchParams: Promise.resolve({ q }) });
      expect(clusterCardIds(tree), q).toEqual(ids);
    }
  });

  it("shows no in-feed card for a query that only consists of operators", async () => {
    getPoliticsClusters.mockResolvedValue(feed());
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });

    const tree = await HomeFeed({
      searchParams: Promise.resolve({ q: "-ak" }),
    });

    expect(clusterCardIds(tree)).toEqual([]);
  });
});

describe("HomeFeed — archive heading", () => {
  const archiveView = (archiveCapped: boolean) => () => ({
    archive: [bundle("x1", "Arşiv bir"), bundle("x2", "Arşiv iki")],
    archiveUnavailable: false,
    emptySearch: false,
    archiveCapped,
    archiveTotal: 2,
    archiveCappedTotal: archiveCapped,
  });

  async function headings(capped: boolean): Promise<string[]> {
    getPoliticsClusters.mockResolvedValue(feedOf());
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });
    viewOverride = archiveView(capped);
    const tree = await HomeFeed({
      searchParams: Promise.resolve({ q: "arşiv" }),
    });
    return collectElements(tree)
      .filter((el) => el.type === "h2")
      .map((el) => textOf(el.props?.children));
  }

  it("reads 'Arşivden: N sonuç' when the archive was not capped", async () => {
    expect(await headings(false)).toContain("Arşivden: 2 sonuç");
  });

  it("reads 'Arşivden: en ilgili N sonuç' when the RPC hit its cap", async () => {
    const h = await headings(true);
    expect(h).toContain("Arşivden: en ilgili 2 sonuç");
    expect(h).not.toContain("Arşivden: 2 sonuç");
  });
});

describe("HomeFeed — result count is the same on every page of one search", () => {
  // 16 in-feed matches span two pages (HOME_PAGE_SIZE 15); the archive RPC
  // returned a full page (24 rows, two of them also in the feed), so 22 rows
  // are archive-only. Total = 16 + 22 = 38, on page 1 and on page 2.
  const inFeed = Array.from({ length: 16 }, (_, i) =>
    bundle(`f${i + 1}`, `Deprem haberi ${i + 1}`),
  );
  const archiveOnly = Array.from({ length: 22 }, (_, i) =>
    bundle(`x${i + 1}`, `Arşiv kaydı ${i + 1}`),
  );

  function statusText(tree: unknown): string {
    const el = collectElements(tree).find(
      (e) =>
        typeof e.type === "function" &&
        (e.type as { name?: string }).name === "SearchStatus",
    );
    return String(el?.props?.text);
  }

  async function renderPage(page: string) {
    getPoliticsClusters.mockResolvedValue(feedOf(...inFeed));
    searchClusters.mockResolvedValue({
      ok: true,
      bundles: [inFeed[0], inFeed[1], ...archiveOnly],
      capped: true,
    });
    return HomeFeed({
      searchParams: Promise.resolve({ q: "deprem", page }),
    });
  }

  it("page 1 lists 15 feed cards plus the archive and reports 38 results", async () => {
    const tree = await renderPage("1");
    expect(clusterCardIds(tree)).toHaveLength(15 + 22);
    expect(textOf(tree)).toContain("“deprem” için 38 sonuç");
    expect(statusText(tree)).toBe(
      "“deprem” için en ilgili 38 sonuç gösteriliyor.",
    );
  });

  it("page 2 shows the last feed card, no archive rows, and the same 38 results", async () => {
    const tree = await renderPage("2");
    expect(clusterCardIds(tree)).toEqual(["f16"]);
    expect(textOf(tree)).toContain("“deprem” için 38 sonuç");
    expect(statusText(tree)).toBe(
      "“deprem” için en ilgili 38 sonuç gösteriliyor.",
    );
  });

  it("a page past the end is clamped and still reports the same total", async () => {
    const tree = await renderPage("99");
    expect(textOf(tree)).toContain("“deprem” için 38 sonuç");
    expect(statusText(tree)).toBe(
      "“deprem” için en ilgili 38 sonuç gösteriliyor.",
    );
  });
});

describe("HomeFeed — day-bucket headings follow the Istanbul calendar day", () => {
  const bundleAt = (id: string, firstPublished: string) => {
    const b = bundle(id, `Haber ${id}`);
    b.cluster.first_published = firstPublished;
    b.cluster.updated_at = firstPublished;
    return b;
  };

  async function bucketHeadings(): Promise<string[]> {
    const tree = await HomeFeed({ searchParams: Promise.resolve({}) });
    return collectElements(tree)
      .filter((el) => el.type === "h2")
      .map((el) => textOf(el.props?.children));
  }

  it("shows 'Dün' for last night's story just after midnight (02.11 00:05 TRT)", async () => {
    // 21:05Z is 00:05 on 02.11 in Istanbul. The 20:30Z story (23:30 on 01.11)
    // used to sit under 'Bugün' because it is less than 24 h old.
    nowOverrideMs = Date.parse("2026-11-01T21:05:00Z");
    getPoliticsClusters.mockResolvedValue(
      feedOf(
        bundleAt("t", "2026-11-01T21:02:00.000Z"),
        bundleAt("y", "2026-11-01T20:30:00.000Z"),
        bundleAt("w", "2026-10-30T10:00:00.000Z"),
        bundleAt("o", "2026-10-01T10:00:00.000Z"),
      ),
    );

    const headings = await bucketHeadings();

    expect(headings).toEqual(["Bugün", "Dün", "Son 7 gün", "Daha eski"]);
    expect(headings).not.toContain("Bu hafta");
  });

  it("keeps the cards in feed order across the buckets", async () => {
    nowOverrideMs = Date.parse("2026-11-01T21:05:00Z");
    getPoliticsClusters.mockResolvedValue(
      feedOf(
        bundleAt("t", "2026-11-01T21:02:00.000Z"),
        bundleAt("y", "2026-11-01T20:30:00.000Z"),
        bundleAt("w", "2026-10-30T10:00:00.000Z"),
      ),
    );

    const tree = await HomeFeed({ searchParams: Promise.resolve({}) });

    expect(clusterCardIds(tree)).toEqual(["t", "y", "w"]);
  });

  it("omits a bucket that has no story", async () => {
    nowOverrideMs = Date.parse("2026-11-01T12:00:00Z");
    getPoliticsClusters.mockResolvedValue(
      feedOf(bundleAt("t", "2026-11-01T10:00:00.000Z")),
    );

    expect(await bucketHeadings()).toEqual(["Bugün"]);
  });
});

// ---------------------------------------------------------------------------
// h17-a11y-4: the home pager. /?page=N gets its own title (Next's route
// announcer reads a title change), the current-page indicator is announced as
// the current page, and after a client-side page change focus moves to the
// feed container instead of falling to <body>.
// ---------------------------------------------------------------------------

/** n distinct bundles; 31 ranked bundles = 3 pages of 15. */
function manyBundles(n: number) {
  return Array.from({ length: n }, (_, i) =>
    bundle(`b${i + 1}`, `Haber ${i + 1}`),
  );
}

const RSS_TYPES = {
  "application/rss+xml": [{ url: "/rss.xml", title: "Tayf — Haberler RSS" }],
};

describe("generateMetadata — /?page=N titles", () => {
  const meta = (sp: { q?: string | string[]; page?: string | string[] }) =>
    generateMetadata({ searchParams: Promise.resolve(sp) });

  beforeEach(() => {
    getPoliticsClusters.mockResolvedValue(feedOf(...manyBundles(31)));
  });

  it("gives page 2 of 3 its own absolute title next to the self-canonical", async () => {
    expect(await meta({ page: "2" })).toEqual({
      title: { absolute: "Haberler — sayfa 2 / 3 — Tayf" },
      alternates: { canonical: "/?page=2", types: RSS_TYPES },
    });
  });

  it("clamps a page past the end in both the title and the canonical", async () => {
    expect(await meta({ page: "9" })).toEqual({
      title: { absolute: "Haberler — sayfa 3 / 3 — Tayf" },
      alternates: { canonical: "/?page=3", types: RSS_TYPES },
    });
  });

  it("reads the first value of a repeated ?page=", async () => {
    expect(await meta({ page: ["2", "3"] })).toEqual({
      title: { absolute: "Haberler — sayfa 2 / 3 — Tayf" },
      alternates: { canonical: "/?page=2", types: RSS_TYPES },
    });
  });

  it("inherits everything on page 1 and without a page", async () => {
    expect(await meta({})).toEqual({});
    expect(await meta({ page: "1" })).toEqual({});
    expect(await meta({ page: "0" })).toEqual({});
    expect(getPoliticsClusters).not.toHaveBeenCalled();
  });

  it("keeps a title without the total (and no canonical) when the feed fails", async () => {
    getPoliticsClusters.mockRejectedValue(new Error("db down"));
    const result = await meta({ page: "2" });
    expect(result).toEqual({ title: { absolute: "Haberler — sayfa 2 — Tayf" } });
    expect(result.alternates).toBeUndefined();
  });

  it("inherits everything when the clamped page is 1", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(...manyBundles(10)));
    expect(await meta({ page: "2" })).toEqual({});
  });

  it("keeps today's search result for a q, with or without a page", async () => {
    const searchResult = {
      title: { absolute: "“seçim” araması — Tayf" },
      robots: { index: false, follow: true },
    };
    expect(await meta({ q: "seçim" })).toEqual(searchResult);
    expect(await meta({ q: "seçim", page: "2" })).toEqual(searchResult);
    expect(getPoliticsClusters).not.toHaveBeenCalled();
  });
});

describe("HomeFeed — page 2 of 3", () => {
  async function pageTwoTree() {
    getPoliticsClusters.mockResolvedValue(feedOf(...manyBundles(31)));
    return (await HomeFeed({
      searchParams: Promise.resolve({ page: "2" }),
    })) as Elementish;
  }

  function paginationTree(tree: unknown): Elementish {
    const el = collectElements(tree).find(
      (e) =>
        typeof e.type === "function" &&
        (e.type as { name?: string }).name === "Pagination",
    );
    expect(el, "a Pagination element").toBeDefined();
    return (el!.type as (props: unknown) => Elementish)(el!.props);
  }

  it("announces the indicator as the current page, with a spoken 'Sayfa ' prefix", async () => {
    const nav = paginationTree(await pageTwoTree());
    const current = collectElements(nav).filter(
      (el) => el.props?.["aria-current"] === "page",
    );
    expect(current).toHaveLength(1);
    const indicator = current[0]!;
    expect(textOf(indicator)).toBe("Sayfa 2 / 3");
    const hidden = collectElements(indicator).filter(
      (el) => el.type === "span" && el.props?.className === "sr-only",
    );
    expect(hidden).toHaveLength(1);
    expect(textOf(hidden[0])).toBe("Sayfa ");
  });

  it("still links to the previous and next page", async () => {
    const nav = paginationTree(await pageTwoTree());
    const links = collectElements(nav)
      .filter((el) => typeof el.props?.href === "string")
      .map((el) => [textOf(el), el.props?.href]);
    expect(links).toEqual([
      ["Önceki", "/"],
      ["Sonraki", "/?page=3"],
    ]);
  });

  it("mounts FocusFeedOnPageChange for the feed container, after the two status nodes", async () => {
    const tree = await pageTwoTree();
    const focusEls = collectElements(tree).filter(
      (el) => el.type === FocusFeedOnPageChange,
    );
    expect(focusEls).toHaveLength(1);
    expect(focusEls[0]!.props).toEqual({
      page: 2,
      query: "",
      targetId: "haber-akisi",
    });
    const names = (tree.props?.children as Elementish[])
      .filter((c) => c && typeof c === "object" && typeof c.type === "function")
      .map((c) => (c.type as { name?: string }).name);
    expect(names.slice(0, 3)).toEqual([
      "SearchStatus",
      "NewSinceLastVisit",
      "FocusFeedOnPageChange",
    ]);
  });

  it("passes the clamped page and the search query to the island", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(...manyBundles(31)));
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });
    const tree = await HomeFeed({
      searchParams: Promise.resolve({ q: "haber", page: "99" }),
    });
    const focusEl = collectElements(tree).find(
      (el) => el.type === FocusFeedOnPageChange,
    );
    expect(focusEl?.props).toEqual({
      page: 3,
      query: "haber",
      targetId: "haber-akisi",
    });
  });
});

describe("HomePage — the feed container", () => {
  it("stays a plain, non-async Server Component", () => {
    expect(HomePage.constructor.name).toBe("Function");
  });

  it("wraps the feed Suspense in a focusable, labelled #haber-akisi section", () => {
    const tree = HomePage({ searchParams: Promise.resolve({}) });
    const sections = collectElements(tree).filter(
      (el) => el.type === "section" && el.props?.id === "haber-akisi",
    );
    expect(sections).toHaveLength(1);
    const section = sections[0]!;
    expect(section.props?.tabIndex).toBe(-1);
    expect(section.props?.["aria-label"]).toBe("Haber akışı");
    expect(String(section.props?.className)).toContain("focus:outline-none");
    const inner = section.props?.children as Elementish;
    expect(inner.type).toBe(Suspense);
    expect((inner.props?.children as Elementish).type).toBe(HomeFeed);
  });

  it("keeps the search bar outside the focus target", () => {
    const tree = HomePage({ searchParams: Promise.resolve({}) });
    const section = collectElements(tree).find(
      (el) => el.type === "section" && el.props?.id === "haber-akisi",
    )!;
    const inside = collectElements(section).map((el) => el.type);
    expect(inside).not.toContain("input");
    expect(
      collectElements(section).some(
        (el) =>
          typeof el.type === "function" &&
          (el.type as { name?: string }).name === "SearchBar",
      ),
    ).toBe(false);
  });
});
