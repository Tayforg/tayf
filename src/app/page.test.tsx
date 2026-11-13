import { Fragment, Suspense, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
// Only the read is faked: the page's pure helpers (splitHomeFeed, knownBreakingIds; h170-roadmap-2) stay real.
vi.mock("@/lib/clusters/politics-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clusters/politics-query")>();
  return { ...actual, getPoliticsClusters: () => getPoliticsClusters() };
});

// Every argument is forwarded, so a call for page 1 (`searchClusters(q)`) and for a later archive page
// (`searchClusters(q, 2)`, h170-roadmap-1) are told apart exactly as the page makes them.
const searchClusters = vi.fn();
vi.mock("@/lib/clusters/search-query", () => ({
  searchClusters: (...args: unknown[]) => searchClusters(...args),
}));

// h153: the home search's one link row (a BIST code or an outlet name). The
// lookup is mocked: its rules are pinned in src/lib/search/search-intent*.test.ts.
const loadSearchIntent = vi.fn();
vi.mock("@/lib/search/search-intent-query", () => ({
  loadSearchIntent: (q: string) => loadSearchIntent(q),
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

// h170-roadmap-3: the "Yükselen konular" rail reads the same cached entry /trends reads. HomeFeed starts
// that read beside the feed read (loadRisingRail) and never awaits it (the rail is its own Suspense
// boundary), so the read is a spy a test can leave pending or reject.
const getRisingEntities = vi.fn();
vi.mock("@/lib/trends/rising-query", () => ({
  getRisingEntities: () => getRisingEntities(),
}));

// h170-roadmap-3: dailyTeaserSlot passes through to the real implementation unless a test installs
// `teaserOverride`, to show the rail renders whether or not the teaser does.
let teaserOverride: ((input: unknown) => unknown) | null = null;
vi.mock("@/lib/game/daily-teaser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/game/daily-teaser")>();
  return {
    ...actual,
    dailyTeaserSlot: (input: Parameters<typeof actual.dailyTeaserSlot>[0]) =>
      teaserOverride ? teaserOverride(input) : actual.dailyTeaserSlot(input),
  };
});

import HomePage, { HomeFeed, generateMetadata } from "./page";
import { ClearSearchLink } from "@/components/home/clear-search-link";
import { FocusFeedOnPageChange } from "@/components/home/focus-feed-on-page-change";
import { FollowButton } from "@/components/follow/follow-button";
import { HomeLcpPreload } from "@/components/home/home-lcp-preload";
import { RisingRail } from "@/components/home/rising-rail";
import { homeFirstCard } from "@/lib/home/first-card";
import type { PoliticsClustersResult } from "@/lib/clusters/politics-query";
import { resultCountPhrase } from "@/lib/search/search-status";

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

/** Display name of a function component element, or undefined for a DOM tag. */
function typeName(el: Elementish): string | undefined {
  return typeof el.type === "function"
    ? (el.type as { name?: string }).name
    : undefined;
}

/**
 * Like collectElements, but also renders the named PURE function components
 * (no hooks, no async) inline, so what they output is part of the walk.
 */
function collectRendered(
  node: unknown,
  expand: ReadonlySet<string>,
  out: Elementish[] = [],
): Elementish[] {
  if (Array.isArray(node)) {
    for (const child of node) collectRendered(child, expand, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as Elementish;
    if (el.type === undefined) return out;
    out.push(el);
    const name = typeName(el);
    if (name !== undefined && expand.has(name)) {
      collectRendered((el.type as (p: unknown) => unknown)(el.props), expand, out);
    } else if (el.props?.children !== undefined) {
      collectRendered(el.props.children, expand, out);
    }
  }
  return out;
}

// SearchEcho (the quoted query) and EmptySearch (the card) are pure, so the
// reader-visible text can be read without a renderer. SearchStatus is left
// alone on purpose: it is the sr-only live region, read through its `text`.
const VISIBLE_VIEWS = new Set(["SearchEcho", "EmptySearch"]);

/** Text a sighted reader gets: textOf, with SearchEcho and EmptySearch rendered. */
function visibleText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(visibleText).join("");
  if (node && typeof node === "object") {
    const el = node as Elementish;
    const name = typeName(el);
    if (name !== undefined && VISIBLE_VIEWS.has(name)) {
      return visibleText((el.type as (p: unknown) => unknown)(el.props));
    }
    return visibleText(el.props?.children);
  }
  return "";
}

/**
 * The "Aramayı temizle" links the empty card offers. The link is a client
 * component with hooks (ClearSearchLink owns its label), so it is found as an
 * element rather than read as text.
 */
function clearSearchLinks(tree: unknown): Elementish[] {
  return collectRendered(tree, new Set(["EmptySearch"])).filter((e) => e.type === ClearSearchLink);
}

/** The live region's text (SearchStatus's `text` prop). */
function liveRegionText(tree: unknown): string {
  const el = collectElements(tree).find((e) => typeName(e) === "SearchStatus");
  return String(el?.props?.text);
}

/** Longest run of one repeated character (character scan, no regex). */
function longestRun(text: string, ch: string): number {
  let best = 0;
  let run = 0;
  for (const c of text) {
    run = c === ch ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
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
  // mockReset wipes the resolved value, so the default is set AFTER it.
  loadSearchIntent.mockReset();
  loadSearchIntent.mockResolvedValue(null);
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
    expect(visibleText(tree)).toContain("“deprem” için en ilgili 38 sonuç");
    expect(statusText(tree)).toBe(
      "“deprem” için en ilgili 38 sonuç gösteriliyor.",
    );
  });

  it("page 2 shows the last feed card, no archive rows, and the same 38 results", async () => {
    const tree = await renderPage("2");
    expect(clusterCardIds(tree)).toEqual(["f16"]);
    expect(visibleText(tree)).toContain("“deprem” için en ilgili 38 sonuç");
    expect(statusText(tree)).toBe(
      "“deprem” için en ilgili 38 sonuç gösteriliyor.",
    );
  });

  it("a page past the end is clamped and still reports the same total", async () => {
    const tree = await renderPage("99");
    expect(visibleText(tree)).toContain("“deprem” için en ilgili 38 sonuç");
    expect(statusText(tree)).toBe(
      "“deprem” için en ilgili 38 sonuç gösteriliyor.",
    );
  });
});

// ---------------------------------------------------------------------------
// h50-search-3: the visible result line used to print the 24-row cap as the
// total ('“istanbul” için 24 sonuç') while the live region and the archive
// heading on the same page said 'en ilgili'. Both lines are built from
// resultCountPhrase now.
// ---------------------------------------------------------------------------

describe("HomeFeed: the visible result line says 'en ilgili' when the archive is capped (h50-search-3)", () => {
  const inFeed = bundle("f1", "Deprem haberi");
  const archiveOnly = (n: number) =>
    Array.from({ length: n }, (_, i) => bundle(`x${i + 1}`, `Arşiv kaydı ${i + 1}`));

  /** One in-feed match for "deprem" plus `archiveRows` archive-only rows. */
  async function render(
    archiveRows: number,
    capped: boolean,
    q = "deprem",
  ) {
    getPoliticsClusters.mockResolvedValue(feedOf(inFeed));
    searchClusters.mockResolvedValue({
      ok: true,
      bundles: [inFeed, ...archiveOnly(archiveRows)],
      capped,
    });
    return HomeFeed({ searchParams: Promise.resolve({ q }) });
  }

  it("capped: the echo paragraph reads '“q” için en ilgili N sonuç'", async () => {
    const tree = await render(23, true);
    expect(visibleText(tree)).toContain("“deprem” için en ilgili 24 sonuç");
    expect(visibleText(tree)).not.toMatch(/için 24 sonuç/);
  });

  it("uncapped: the echo paragraph reads '“q” için N sonuç'", async () => {
    const tree = await render(1, false);
    expect(visibleText(tree)).toContain("“deprem” için 2 sonuç");
    expect(visibleText(tree)).not.toContain("en ilgili");
    expect(liveRegionText(tree)).toBe("“deprem” için 2 sonuç bulundu.");
  });

  it("the visible line and the live region carry the same phrase (one helper)", async () => {
    for (const capped of [true, false]) {
      const tree = await render(23, capped);
      const phrase = resultCountPhrase(24, capped);
      expect(visibleText(tree), String(capped)).toContain(`“deprem” için ${phrase}`);
      expect(liveRegionText(tree), String(capped)).toContain(`“deprem” için ${phrase}`);
    }
    expect(liveRegionText(await render(23, true))).toBe(
      "“deprem” için en ilgili 24 sonuç gösteriliyor.",
    );
  });

  it("formats a capped count with Turkish thousands grouping", async () => {
    const tree = await render(1233, true);
    expect(visibleText(tree)).toContain("“deprem” için en ilgili 1.234 sonuç");
  });

  it("an archive that returned nothing new is not 'capped', even when the RPC filled its page", async () => {
    // Every archive row is already in the feed: nothing archive-only is left.
    getPoliticsClusters.mockResolvedValue(feedOf(inFeed));
    searchClusters.mockResolvedValue({ ok: true, bundles: [inFeed], capped: true });
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: "deprem" }) });
    expect(visibleText(tree)).toContain("“deprem” için 1 sonuç");
    expect(visibleText(tree)).not.toContain("en ilgili");
  });

  it("page 2 of a capped search reads the same phrase", async () => {
    const feed = Array.from({ length: 16 }, (_, i) => bundle(`g${i + 1}`, `Deprem haberi ${i + 1}`));
    getPoliticsClusters.mockResolvedValue(feedOf(...feed));
    searchClusters.mockResolvedValue({ ok: true, bundles: [feed[0]!, ...archiveOnly(23)], capped: true });
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: "deprem", page: "2" }) });
    expect(visibleText(tree)).toContain("“deprem” için en ilgili 39 sonuç");
  });

  it("keeps the term-cap note after a capped phrase", async () => {
    const six = "Erdoğan Erdoğan Erdoğan Erdoğan Erdoğan Erdoğan";
    getPoliticsClusters.mockResolvedValue(feedOf(bundle("e", "Erdoğan konuştu")));
    searchClusters.mockResolvedValue({
      ok: true,
      bundles: [bundle("e", "Erdoğan konuştu"), ...archiveOnly(23)],
      capped: true,
    });
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: `${six} zebra` }) });

    expect(visibleText(tree)).toContain(
      `“${six}” için en ilgili 24 sonuç. Arama ilk 6 kelimeyle yapıldı.`,
    );
    expect(liveRegionText(tree)).toBe(
      `“${six}” için en ilgili 24 sonuç gösteriliyor. Arama ilk 6 kelimeyle yapıldı.`,
    );
  });

  it("keeps the term-cap note after an uncapped phrase", async () => {
    const six = "Erdoğan Erdoğan Erdoğan Erdoğan Erdoğan Erdoğan";
    getPoliticsClusters.mockResolvedValue(feedOf(bundle("e", "Erdoğan konuştu")));
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: `${six} zebra` }) });

    expect(visibleText(tree)).toContain(`“${six}” için 1 sonuç. Arama ilk 6 kelimeyle yapıldı.`);
  });

  it("keeps the length-cap note after a capped phrase", async () => {
    const q = `${"a".repeat(23)} ${"b".repeat(23)} ${"c".repeat(22)}`;
    getPoliticsClusters.mockResolvedValue(feedOf());
    searchClusters.mockResolvedValue({ ok: true, bundles: archiveOnly(24), capped: true });
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q }) });

    expect(visibleText(tree)).toContain(
      "için en ilgili 24 sonuç. Arama sorgunun ilk 64 karakterine sığan kelimelerle yapıldı.",
    );
  });

  it("an archive-unavailable result never says 'en ilgili' (visible line or live region)", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(inFeed));
    searchClusters.mockResolvedValue({ ok: false });
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: "deprem" }) });

    expect(visibleText(tree)).toContain("“deprem” için 1 sonuç");
    expect(visibleText(tree)).not.toContain("en ilgili");
    expect(liveRegionText(tree)).not.toContain("en ilgili");
    expect(liveRegionText(tree)).toBe(
      "“deprem” için 1 sonuç bulundu; arşiv araması şu an yanıt vermiyor.",
    );
  });

  it("an unavailable archive wins even if a view claims both (the guard is on the page, not only in the view)", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(inFeed));
    searchClusters.mockResolvedValue({ ok: false });
    viewOverride = () => ({
      archive: [],
      archiveUnavailable: true,
      emptySearch: false,
      archiveCapped: true,
      archiveTotal: 23,
      archiveCappedTotal: true,
    });
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: "deprem" }) });

    expect(visibleText(tree)).toContain("“deprem” için 24 sonuç");
    expect(visibleText(tree)).not.toContain("en ilgili");
  });

  it("no results: says '0 sonuç' without 'en ilgili'", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(bundle("b", "Başbakan açıkladı")));
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: "deprem" }) });

    expect(visibleText(tree)).toContain("“deprem” için 0 sonuç");
    expect(visibleText(tree)).not.toContain("en ilgili");
  });
});

// ---------------------------------------------------------------------------
// h23-a11y-4: the search echo. A pasted 170-character URL used to overflow the
// page at 390 px (WCAG 1.4.10), and a 1-character query said 'için sonuç yok'
// and announced 'sonuç bulunamadı' although no search ran (searchClusters
// needs two characters).
// ---------------------------------------------------------------------------

describe("HomeFeed: a one-character query (no search ran)", () => {
  beforeEach(() => {
    getPoliticsClusters.mockResolvedValue(feedOf(bundle("ak", "AK Parti")));
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });
  });

  it("does not call searchClusters", async () => {
    await HomeFeed({ searchParams: Promise.resolve({ q: "a" }) });
    expect(searchClusters).not.toHaveBeenCalled();
  });

  it("asks for more characters instead of claiming 'no results'", async () => {
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: "a" }) });
    const text = visibleText(tree);
    expect(text).toContain("En az 2 karakter yazın.");
    expect(text).toContain("Aramak için biraz daha yazın");
    expect(text).not.toContain("için sonuç yok");
    expect(text).not.toContain("sonuç bulunamadı");
    expect(text).not.toContain("Hiç haber bulunamadı");
    expect(text).not.toContain("Farklı bir kelime deneyin");
    // The reader has to type more, so the way out is still offered.
    const links = clearSearchLinks(tree);
    expect(links).toHaveLength(1);
    expect(links[0]?.props?.targetId).toBe("haber-akisi");
  });

  it("announces the same hint in the live region, not 'sonuç bulunamadı'", async () => {
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: "a" }) });
    expect(liveRegionText(tree)).toBe("En az 2 karakter yazın.");
  });

  it("shows no result-count line and no follow button for it", async () => {
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: "a" }) });
    expect(visibleText(tree)).not.toMatch(/için \d+ sonuç/);
    expect(visibleText(tree)).not.toContain("“a”");
    expect(collectElements(tree).some((e) => e.type === FollowButton)).toBe(false);
  });

  it("treats a padded or control-character one-character query the same way", async () => {
    for (const q of ["  a  ", "\u0001a", "ş"]) {
      searchClusters.mockClear();
      const tree = await HomeFeed({ searchParams: Promise.resolve({ q }) });
      expect(searchClusters, JSON.stringify(q)).not.toHaveBeenCalled();
      expect(liveRegionText(tree), JSON.stringify(q)).toBe("En az 2 karakter yazın.");
      expect(visibleText(tree), JSON.stringify(q)).not.toContain("için sonuç yok");
    }
  });

  it("keeps the hint when the feed itself failed to load", async () => {
    getPoliticsClusters.mockRejectedValue(new Error("db down"));
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: "a" }) });
    expect(liveRegionText(tree)).toBe("En az 2 karakter yazın.");
  });

  it("still hands the query to FocusFeedOnPageChange (focus handoff unchanged)", async () => {
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: "a" }) });
    const focusEl = collectElements(tree).find((e) => e.type === FocusFeedOnPageChange);
    expect(focusEl?.props?.query).toBe("a");
  });
});

// h30-abuse-1: a query that is only punctuation canonicalises to '' (its cache
// key and RPC input would be empty), so it is "too short" like a lone letter:
// no search runs and the page asks for more characters.
describe("HomeFeed: a punctuation-only query (no search ran)", () => {
  beforeEach(() => {
    getPoliticsClusters.mockResolvedValue(feedOf(bundle("ak", "AK Parti")));
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });
  });

  it("q='!!' does not call searchClusters and renders the too-short state", async () => {
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: "!!" }) });
    expect(searchClusters).not.toHaveBeenCalled();
    const text = visibleText(tree);
    expect(text).toContain("Aramak için biraz daha yazın");
    expect(text).toContain("En az 2 karakter yazın.");
    expect(text).not.toContain("için sonuç yok");
    expect(text).not.toContain("Hiç haber bulunamadı");
    expect(clearSearchLinks(tree)).toHaveLength(1);
    expect(liveRegionText(tree)).toBe("En az 2 karakter yazın.");
    expect(collectElements(tree).some((e) => e.type === FollowButton)).toBe(false);
  });

  it.each(["?!", "...", "\u201c\u201d", "a!", "\u{1F600}\u{1F600}"])(
    "q=%j is too short as well",
    async (q) => {
      const tree = await HomeFeed({ searchParams: Promise.resolve({ q }) });
      expect(searchClusters).not.toHaveBeenCalled();
      expect(liveRegionText(tree)).toBe("En az 2 karakter yazın.");
      expect(visibleText(tree)).toContain("Aramak için biraz daha yazın");
    },
  );

  it("keeps the too-short hint when the feed itself failed to load", async () => {
    getPoliticsClusters.mockRejectedValue(new Error("db down"));
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: "!!" }) });
    expect(searchClusters).not.toHaveBeenCalled();
    expect(liveRegionText(tree)).toBe("En az 2 karakter yazın.");
  });
});

describe("HomeFeed: the raw query is echoed and searched, only the key is canonical", () => {
  it("q='ERDOĞAN!' calls searchClusters once with the raw text and echoes it", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(bundle("b", "Başbakan açıkladı")));
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });

    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: "ERDOĞAN!" }) });

    expect(searchClusters).toHaveBeenCalledTimes(1);
    expect(searchClusters).toHaveBeenCalledWith("ERDOĞAN!");
    const text = visibleText(tree);
    expect(text).toContain("\u201cERDOĞAN!\u201d için 0 sonuç");
    expect(text).not.toContain("En az 2 karakter");
    expect(liveRegionText(tree)).toBe("\u201cERDOĞAN!\u201d için sonuç bulunamadı.");
  });
});

describe("HomeFeed: a two-character query behaves as before", () => {
  it("searches, counts and says 'için sonuç yok' when nothing matches", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(bundle("b", "Başbakan açıkladı")));
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });

    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: "ak" }) });

    expect(searchClusters).toHaveBeenCalledTimes(1);
    expect(searchClusters).toHaveBeenCalledWith("ak");
    const text = visibleText(tree);
    expect(text).toContain("“ak” için 0 sonuç");
    expect(text).toContain("“ak” için sonuç yok. Farklı bir kelime deneyin.");
    expect(text).toContain("Hiç haber bulunamadı");
    expect(text).not.toContain("En az 2 karakter");
    expect(liveRegionText(tree)).toBe("“ak” için sonuç bulunamadı.");
    expect(collectElements(tree).some((e) => e.type === FollowButton)).toBe(true);
  });

  it("counts an in-feed match", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(bundle("ak", "AK Parti açıkladı")));
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });

    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: "ak" }) });

    expect(clusterCardIds(tree)).toEqual(["ak"]);
    expect(visibleText(tree)).toContain("“ak” için 1 sonuç");
    expect(visibleText(tree)).not.toContain("için sonuç yok");
  });

  it("still searches 'a b' (three characters once normalised)", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf());
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });
    await HomeFeed({ searchParams: Promise.resolve({ q: "a b" }) });
    expect(searchClusters).toHaveBeenCalledWith("a b");
  });
});

describe("HomeFeed: a 300 character query does not overflow", () => {
  const long = "a".repeat(300);

  async function longTree() {
    getPoliticsClusters.mockResolvedValue(feedOf(bundle("b", "Başbakan açıkladı")));
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });
    return HomeFeed({ searchParams: Promise.resolve({ q: long }) });
  }

  it("echoes at most 60 code points of the query anywhere in the visible text", async () => {
    const tree = await longTree();
    const text = visibleText(tree);
    expect(text).toContain("için sonuç yok");
    expect(longestRun(text, "a")).toBeLessThanOrEqual(60);
    expect(text).not.toContain("a".repeat(61));
    expect(text).toContain(`“${"a".repeat(59)}…”`);
  });

  it("echoes it through SearchEcho in BOTH the count line and the empty card", async () => {
    const tree = await longTree();
    const echoes = collectRendered(tree, new Set(["EmptySearch"])).filter(
      (e) => typeName(e) === "SearchEcho",
    );
    expect(echoes).toHaveLength(2);
    for (const echo of echoes) {
      const markup = renderToStaticMarkup(
        createElement(echo.type as never, echo.props as never),
      );
      expect(markup).toContain("break-words");
      expect(markup).toContain("[overflow-wrap:anywhere]");
      expect(longestRun(markup, "a")).toBe(59);
    }
  });

  it("lets the count line and the empty card paragraphs shrink and wrap", async () => {
    const tree = await longTree();
    const paragraphs = collectRendered(tree, new Set(["EmptySearch"])).filter(
      (e) => e.type === "p",
    );
    const holdingEcho = paragraphs.filter((p) =>
      collectRendered(p.props?.children, new Set()).some(
        (e) => typeName(e) === "SearchEcho",
      ),
    );
    expect(holdingEcho).toHaveLength(2);
    for (const p of holdingEcho) {
      const cls = String(p.props?.className);
      expect(cls).toContain("min-w-0");
      expect(cls).toContain("break-words");
    }
    // The empty card's paragraph can also never outgrow its column.
    const emptyP = holdingEcho.find((p) =>
      String(p.props?.className).includes("leading-relaxed"),
    );
    expect(emptyP, "the empty card paragraph").toBeDefined();
    expect(String(emptyP?.props?.className)).toContain("max-w-full");
  });

  it("keeps the live region and the title at 60 code points (plus the h42-search-2 note: this query is cut at 64 characters)", async () => {
    const tree = await longTree();
    expect(liveRegionText(tree)).toBe(
      `“${"a".repeat(59)}…” için sonuç bulunamadı. Arama sorgunun ilk 64 karakteriyle yapıldı.`,
    );
    expect(await generateMetadata({ searchParams: Promise.resolve({ q: long }) })).toEqual({
      title: { absolute: `“${"a".repeat(59)}…” araması — Tayf` },
      robots: { index: false, follow: true },
    });
  });
});

describe("HomeFeed: AKP and AK Parti are one search (h42-search-1)", () => {
  const feed = () =>
    feedOf(
      bundle("grup", "AK Parti Grup Başkanı Abdullah Güler açıkladı"),
      bundle("akp", "AKP'den açıklama"),
      bundle("chp", "CHP Genel Başkanı Özel konuştu"),
    );

  it.each(["AKP", "AK Parti", "ak parti", "AK PARTİ", "akp'nin"])(
    "%s lists both spellings in the feed, in feed order, and not CHP",
    async (q) => {
      getPoliticsClusters.mockResolvedValue(feed());
      searchClusters.mockResolvedValue({ ok: true, bundles: [] });

      const tree = await HomeFeed({ searchParams: Promise.resolve({ q }) });

      expect(clusterCardIds(tree), q).toEqual(["grup", "akp"]);
      expect(visibleText(tree)).toContain("için 2 sonuç");
    },
  );

  it("hands the archive the raw query, so the cache key and the follow target are unchanged", async () => {
    getPoliticsClusters.mockResolvedValue(feed());
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });

    await HomeFeed({ searchParams: Promise.resolve({ q: "AKP" }) });

    expect(searchClusters).toHaveBeenCalledTimes(1);
    expect(searchClusters).toHaveBeenCalledWith("AKP");
  });

  it("keeps a quoted 'AK Parti' exact, like the archive does (no AKP card)", async () => {
    getPoliticsClusters.mockResolvedValue(feed());
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });

    const tree = await HomeFeed({
      searchParams: Promise.resolve({ q: '"AK Parti"' }),
    });

    expect(clusterCardIds(tree)).toEqual(["grup"]);
  });

  it("'ak' is a whole word: AK Parti, not Akşener or Başbakan (h116-search-3)", async () => {
    getPoliticsClusters.mockResolvedValue(
      feedOf(
        bundle("grup", "AK Parti Grup Başkanı açıkladı"),
        bundle("aks", "Akşener açıklama yaptı"),
        bundle("bas", "Başbakan dakikaya kadar bekledi"),
      ),
    );
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });

    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: "ak" }) });

    expect(clusterCardIds(tree)).toEqual(["grup"]);
  });
});

describe("HomeFeed: a query past the search cap says so (h42-search-2)", () => {
  const six = "Erdoğan Erdoğan Erdoğan Erdoğan Erdoğan Erdoğan";
  const seven = `${six} zebra`;
  const TERM_NOTE = "Arama ilk 6 kelimeyle yapıldı.";
  // h144-search-3: the length cut drops whole words, so the note names "the words that fit". The one
  // exception is a single word longer than the bound (h145 review TS-5): a fragment of it is searched.
  const LENGTH_NOTE = "Arama sorgunun ilk 64 karakterine sığan kelimelerle yapıldı.";
  const FRAGMENT_NOTE = "Arama sorgunun ilk 64 karakteriyle yapıldı.";

  function givenFeed() {
    getPoliticsClusters.mockResolvedValue(
      feedOf(bundle("e", "Erdoğan konuştu"), bundle("b", "Başbakan açıkladı")),
    );
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });
  }

  it("a 7-word query echoes its first 6 words and the note, not the 7th word", async () => {
    givenFeed();
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: seven }) });

    const text = visibleText(tree);
    expect(text).toContain(`“${six}” için 1 sonuç`);
    expect(text).toContain(TERM_NOTE);
    expect(text).not.toContain("zebra");
  });

  it("puts the note in the one live region as well", async () => {
    givenFeed();
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: seven }) });

    expect(liveRegionText(tree)).toBe(`“${six}” için 1 sonuç bulundu. ${TERM_NOTE}`);
  });

  it("still hands the archive the raw query (the cache key is built from it)", async () => {
    givenFeed();
    await HomeFeed({ searchParams: Promise.resolve({ q: seven }) });

    expect(searchClusters).toHaveBeenCalledTimes(1);
    expect(searchClusters).toHaveBeenCalledWith(seven);
  });

  it("filters the feed with the same words as the archive: the 7-word query equals its first 6", async () => {
    givenFeed();
    const longTree = await HomeFeed({ searchParams: Promise.resolve({ q: seven }) });
    givenFeed();
    const shortTree = await HomeFeed({ searchParams: Promise.resolve({ q: six }) });

    expect(clusterCardIds(longTree)).toEqual(["e"]);
    expect(clusterCardIds(longTree)).toEqual(clusterCardIds(shortTree));
  });

  it("a different 7th word does not change the feed either (it used to empty it)", async () => {
    givenFeed();
    const tree = await HomeFeed({
      searchParams: Promise.resolve({ q: `${six} konuştu zebra` }),
    });
    // 8 words: the 7th and 8th are beyond the cap, so the feed is the 6-word one.
    expect(clusterCardIds(tree)).toEqual(["e"]);
  });

  it("says nothing extra for a 6-word query", async () => {
    givenFeed();
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: six }) });

    const text = visibleText(tree);
    expect(text).toContain(`“${six}” için 1 sonuç`);
    expect(text).not.toContain("Arama ilk");
    expect(text).not.toContain("Arama sorgunun");
    expect(liveRegionText(tree)).toBe(`“${six}” için 1 sonuç bulundu.`);
  });

  it("says nothing extra for a 3-word query", async () => {
    givenFeed();
    const tree = await HomeFeed({
      searchParams: Promise.resolve({ q: "Erdoğan konuştu bugün" }),
    });

    const text = visibleText(tree);
    expect(text).toContain("“Erdoğan konuştu bugün” için");
    expect(text).not.toContain("Arama ilk");
    expect(text).not.toContain("Arama sorgunun");
    expect(liveRegionText(tree)).not.toContain("Arama ");
  });

  it("names the character cap when a 3-word query is longer than 64 characters", async () => {
    givenFeed();
    const q = `${"a".repeat(23)} ${"b".repeat(23)} ${"c".repeat(22)}`;
    expect(q).toHaveLength(70);
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q }) });

    expect(visibleText(tree)).toContain(LENGTH_NOTE);
    expect(visibleText(tree)).not.toContain(TERM_NOTE);
    expect(liveRegionText(tree)).toContain(LENGTH_NOTE);
  });

  it("a single word longer than 64 characters keeps the fragment wording: no whole word was dropped", async () => {
    givenFeed();
    const q = "a".repeat(300);
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q }) });

    expect(visibleText(tree)).toContain(FRAGMENT_NOTE);
    expect(visibleText(tree)).not.toContain("kelimelerle yapıldı");
    expect(liveRegionText(tree)).toContain(FRAGMENT_NOTE);
    expect(liveRegionText(tree)).not.toContain("kelimelerle yapıldı");
  });

  it("a long first word followed by more words is still a fragment of that word", async () => {
    givenFeed();
    const q = `${"a".repeat(70)} bb`;
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q }) });

    expect(visibleText(tree)).toContain(FRAGMENT_NOTE);
    expect(visibleText(tree)).not.toContain("kelimelerle yapıldı");
  });

  it("a first word kept whole (40 + 40 letters) uses the whole-words wording", async () => {
    givenFeed();
    const q = `${"a".repeat(40)} ${"b".repeat(40)}`;
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q }) });

    expect(visibleText(tree)).toContain(LENGTH_NOTE);
    expect(visibleText(tree)).not.toContain(FRAGMENT_NOTE);
  });

  it("keeps the empty-search card to the 6 searched words, and the count line carries the note once", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf(bundle("b", "Başbakan açıkladı")));
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: seven }) });

    const text = visibleText(tree);
    expect(text).toContain(`“${six}” için 0 sonuç. ${TERM_NOTE}`);
    expect(text).toContain(`“${six}” için sonuç yok. Farklı bir kelime deneyin.`);
    expect(text.split(TERM_NOTE)).toHaveLength(2);
    expect(text).not.toContain("zebra");
    expect(liveRegionText(tree)).toBe(`“${six}” için sonuç bulunamadı. ${TERM_NOTE}`);
  });

  it("escapes markup in the echoed words (the note adds no HTML)", async () => {
    givenFeed();
    const tree = await HomeFeed({
      searchParams: Promise.resolve({ q: "<b>x</b> a1 b2 c3 d4 e5 f6" }),
    });

    expect(collectElements(tree).some((e) => e.type === "b")).toBe(false);
    expect(visibleText(tree)).toContain(TERM_NOTE);
    const echoes = collectRendered(tree, new Set(["EmptySearch"])).filter(
      (e) => typeName(e) === "SearchEcho",
    );
    for (const echo of echoes) {
      const markup = renderToStaticMarkup(
        createElement(echo.type as never, echo.props as never),
      );
      expect(markup).not.toContain("<b>");
      expect(markup).toContain("&lt;b&gt;x&lt;/b&gt;");
    }
  });

  it("does not add the note to a query that is too short to search", async () => {
    getPoliticsClusters.mockResolvedValue(feedOf());
    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: "!" }) });

    expect(searchClusters).not.toHaveBeenCalled();
    expect(visibleText(tree)).not.toContain("Arama ilk");
    expect(liveRegionText(tree)).toBe("En az 2 karakter yazın.");
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

// ---------------------------------------------------------------------------
// h160-1: the first card's banner is preloaded from the prerendered shell
// (HomeLcpPreload), which picks that card with homeFirstCard and no clock. The
// shell's pick must be the card HomeFeed really renders first.
// ---------------------------------------------------------------------------

describe("HomePage — the LCP preload boundary (h160-1)", () => {
  it("returns a fragment: the preload boundary first, then the page container", () => {
    const tree = HomePage({ searchParams: Promise.resolve({}) }) as unknown as Elementish;
    expect(tree.type).toBe(Fragment);
    const [boundary, container] = tree.props?.children as Elementish[];
    expect(boundary?.type).toBe(Suspense);
    expect(boundary?.props?.fallback).toBeNull();
    expect((boundary?.props?.children as Elementish).type).toBe(HomeLcpPreload);
    expect(container?.type).toBe("div");
    expect(String(container?.props?.className)).toContain("container");
  });

  it("gives HomeLcpPreload no props, so it cannot depend on the request", () => {
    const tree = HomePage({ searchParams: Promise.resolve({ q: "x", page: "2" }) }) as unknown as Elementish;
    const [boundary] = tree.props?.children as Elementish[];
    const preloadEl = boundary?.props?.children as Elementish;
    expect(Object.keys(preloadEl.props ?? {})).toEqual([]);
  });
});

describe("homeFirstCard names the card HomeFeed renders first (h160-1)", () => {
  const NOW = Date.parse("2026-11-12T10:00:00Z");

  function at(id: string, iso: string) {
    return {
      cluster: { id, title_tr: `Haber ${id}`, first_published: iso, updated_at: iso },
      articles: [],
      sources: [],
      isWireRedistribution: false,
      effectiveArticleCount: 2,
    };
  }
  function full(bundles: ReturnType<typeof at>[], breakingBundles: ReturnType<typeof at>[] = []) {
    return { bundles, breakingBundles, prefilterCount: bundles.length } as unknown as PoliticsClustersResult;
  }

  async function firstRenderedId(result: PoliticsClustersResult): Promise<string | undefined> {
    getPoliticsClusters.mockResolvedValue(result);
    nowOverrideMs = NOW;
    const tree = await HomeFeed({ searchParams: Promise.resolve({}) });
    return clusterCardIds(tree)[0];
  }

  const FEEDS: Array<[string, PoliticsClustersResult]> = [
    ["a Son Dakika strip", full([at("r0", "2026-11-12T08:00:00Z")], [at("b0", "2026-11-12T09:30:00Z"), at("b1", "2026-11-12T09:40:00Z")])],
    ["a strip card that is also ranked", full([at("same", "2026-11-12T09:30:00Z"), at("r1", "2026-11-12T09:00:00Z")], [at("same", "2026-11-12T09:30:00Z")])],
    ["ranked[0] from yesterday, ranked[1] from today", full([at("r0", "2026-11-11T15:00:00Z"), at("r1", "2026-11-12T08:00:00Z"), at("r2", "2026-11-12T07:00:00Z")])],
    ["only yesterday's stories", full([at("r0", "2026-11-11T09:00:00Z"), at("r1", "2026-11-11T18:00:00Z"), at("r2", "2026-11-10T18:00:00Z")])],
    ["Istanbul midnight between ranked[0] and ranked[1]", full([at("r0", "2026-11-11T20:59:00Z"), at("r1", "2026-11-11T21:01:00Z")])],
    ["a 16th ranked story that is the newest", full([...Array.from({ length: 15 }, (_, i) => at(`r${i}`, "2026-11-11T12:00:00Z")), at("r15", "2026-11-12T09:00:00Z")])],
    ["no stories at all", full([])],
  ];

  it.each(FEEDS)("%s", async (_name, result) => {
    const rendered = await firstRenderedId(result);
    const picked = homeFirstCard(result);
    expect(picked?.cluster.id).toBe(rendered);
  });
});

// ---------------------------------------------------------------------------
// h153: "/?q=THYAO" or "/?q=Hürriyet" used to land on the archive and say
// 'Hiç haber bulunamadı' although /ekonomi/THYAO and /source/hurriyet exist.
// When the query is a traded BIST code or an active outlet's name, ONE link row
// sits under the "için N sonuç" line and above the first story. Nothing else
// on the page changes: the results, the counts, the live region and the follow
// button are the same as without the row, and there is no redirect.
// ---------------------------------------------------------------------------

describe("HomeFeed — search intent row (h153)", () => {
  const TICKER = { kind: "ticker", ticker: "THYAO" } as const;
  const SOURCE = { kind: "source", slug: "hurriyet", name: "Hürriyet" } as const;
  const EXPAND = new Set(["SearchIntentRow"]);

  /** The links of the intent row: the only elements with an /ekonomi/ or /source/ href. */
  function intentLinks(tree: unknown): Elementish[] {
    return collectRendered(tree, EXPAND).filter((el) => {
      const href = el.props?.href;
      return typeof href === "string" && (href.startsWith("/ekonomi/") || href.startsWith("/source/"));
    });
  }

  function intentRowText(tree: unknown): string {
    const row = collectElements(tree).find((e) => typeName(e) === "SearchIntentRow");
    if (!row) return "";
    return textOf((row.type as (p: unknown) => unknown)(row.props));
  }

  async function render(q: string | undefined, intent: unknown = null) {
    loadSearchIntent.mockResolvedValue(intent);
    getPoliticsClusters.mockResolvedValue(
      feedOf(bundle("t1", "THYAO hisseleri yükseldi"), bundle("t2", "THYAO için hedef fiyat")),
    );
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });
    return (await HomeFeed({
      searchParams: Promise.resolve(q === undefined ? {} : { q }),
    })) as Elementish;
  }

  it("renders the ticker link between the result count and the first story, and leaves the stories unchanged", async () => {
    const without = await render("thyao", null);
    const withRow = await render("thyao", TICKER);

    const links = intentLinks(withRow);
    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(link.props?.href).toBe("/ekonomi/THYAO");
    expect(textOf(link)).toBe("THYAO hisse sayfası");
    expect(link.props?.prefetch).toBe(false);
    expect(intentRowText(withRow)).toContain("Borsa İstanbul kodu:");

    // One walk, so the positions are comparable (every walk expands the row into fresh objects).
    const order = collectRendered(withRow, EXPAND);
    const linkAt = order.findIndex((e) => e.props?.href === "/ekonomi/THYAO");
    const countAt = order.findIndex((e) => typeName(e) === "SearchEcho");
    const firstCardAt = order.findIndex((e) => e.props?.cluster !== undefined);
    expect(countAt).toBeGreaterThan(-1);
    expect(firstCardAt).toBeGreaterThan(-1);
    expect(linkAt).toBeGreaterThan(countAt);
    expect(linkAt).toBeLessThan(firstCardAt);

    // Not one thing about the results moved.
    expect(clusterCardIds(withRow)).toEqual(["t1", "t2"]);
    expect(clusterCardIds(withRow)).toEqual(clusterCardIds(without));
    expect(liveRegionText(withRow)).toBe(liveRegionText(without));
    expect(visibleText(withRow)).toContain("“thyao” için 2 sonuç");
    expect(collectElements(withRow).some((e) => e.type === FollowButton)).toBe(true);
    expect(loadSearchIntent).toHaveBeenCalledWith("thyao");
    expect(intentLinks(without)).toHaveLength(0);
  });

  it("renders the source link", async () => {
    const tree = await render("hürriyet", SOURCE);

    const links = intentLinks(tree);
    expect(links).toHaveLength(1);
    expect(links[0]?.props?.href).toBe("/source/hurriyet");
    expect(textOf(links[0])).toBe("Hürriyet kaynak sayfası");
    expect(links[0]?.props?.prefetch).toBe(false);
    expect(intentRowText(tree)).toContain("Haber kaynağı:");
  });

  it("keeps the same number of top-level children with and without the row (no layout shift)", async () => {
    const without = await render("thyao", null);
    const withRow = await render("thyao", TICKER);
    const count = (t: Elementish) => (t.props?.children as unknown[]).length;
    expect(count(withRow)).toBe(count(without));
  });

  it("uses the chip class of EntityHubChips: a fixed height, no opacity on the text colour", async () => {
    const tree = await render("thyao", TICKER);
    const cls = String(intentLinks(tree)[0]?.props?.className);
    expect(cls).toContain("inline-flex items-center min-h-6 max-sm:min-h-11 rounded-full border border-border/60");
    expect(cls).toContain("text-foreground");
    expect(cls).not.toContain("text-foreground/");
    const row = collectRendered(tree, EXPAND).find((e) => e.type === "p" && String(e.props?.className).includes("flex-wrap"));
    expect(String(row?.props?.className)).toContain("text-muted-foreground");
    expect(String(row?.props?.className)).not.toContain("text-muted-foreground/");
  });

  it("is a hookless server component that adds no client element", async () => {
    const tree = await render("thyao", TICKER);
    const row = collectElements(tree).find((e) => typeName(e) === "SearchIntentRow");
    expect(row).toBeDefined();
    // Callable as a plain function: a component with a hook would throw outside a render.
    expect(() => (row!.type as (p: unknown) => unknown)(row!.props)).not.toThrow();
  });

  it("escapes an outlet name that carries markup", async () => {
    // The page's own row, rendered for real: React escapes the name, nothing is HTML.
    const tree = await render("hürriyet", { kind: "source", slug: "hurriyet", name: "<b>Hürriyet</b>" });
    const row = collectElements(tree).find((e) => typeName(e) === "SearchIntentRow");
    const markup = renderToStaticMarkup(createElement(row!.type as never, row!.props as never));
    expect(markup).toContain("&lt;b&gt;Hürriyet&lt;/b&gt; kaynak sayfası");
    expect(markup).not.toContain("<b>");
    expect(markup).toContain('href="/source/hurriyet"');
  });

  it("renders no row when the lookup found nothing", async () => {
    const tree = await render("thyao", null);
    expect(intentLinks(tree)).toHaveLength(0);
    expect(intentRowText(tree)).toBe("");
    expect(visibleText(tree)).not.toContain("hisse sayfası");
    expect(visibleText(tree)).not.toContain("kaynak sayfası");
  });

  it("copes with a lookup that resolves undefined (an unset mock) instead of rendering a broken row", async () => {
    const tree = await render("thyao", undefined);
    expect(collectElements(tree).some((e) => typeName(e) === "SearchIntentRow")).toBe(false);
  });

  it("asks for the lookup with the first value of a repeated ?q=", async () => {
    loadSearchIntent.mockResolvedValue(TICKER);
    getPoliticsClusters.mockResolvedValue(feedOf());
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });
    await HomeFeed({ searchParams: Promise.resolve({ q: ["thyao", "kchol"] }) });
    expect(loadSearchIntent).toHaveBeenCalledTimes(1);
    expect(loadSearchIntent).toHaveBeenCalledWith("thyao");
  });

  it("no lookup without a search or for a too-short one", async () => {
    for (const q of [undefined, "a", "!!", "  ", ""]) {
      loadSearchIntent.mockClear();
      // The mock WOULD answer with a link: the page must not even ask.
      const tree = await render(q, TICKER);
      expect(loadSearchIntent, JSON.stringify(q)).not.toHaveBeenCalled();
      expect(intentLinks(tree), JSON.stringify(q)).toHaveLength(0);
      expect(collectElements(tree).some((e) => typeName(e) === "SearchIntentRow"), JSON.stringify(q)).toBe(false);
    }
  });

  it("the plain home page carries neither link and does no extra read", async () => {
    const tree = await render(undefined, SOURCE);
    expect(loadSearchIntent).not.toHaveBeenCalled();
    expect(visibleText(tree)).not.toContain("hisse sayfası");
    expect(visibleText(tree)).not.toContain("kaynak sayfası");
    expect(clusterCardIds(tree)).toEqual(["t1", "t2"]);
  });

  it("keeps the link when the archive fails and nothing matched", async () => {
    loadSearchIntent.mockResolvedValue(TICKER);
    getPoliticsClusters.mockResolvedValue(feedOf());
    searchClusters.mockResolvedValue({ ok: false });

    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: "thyao" }) });

    expect(intentLinks(tree)).toHaveLength(1);
    expect(collectRendered(tree, EXPAND).some((e) => typeName(e) === "SearchUnavailable")).toBe(true);
  });

  it("keeps the link next to the empty-search card when the search simply found nothing", async () => {
    loadSearchIntent.mockResolvedValue(TICKER);
    getPoliticsClusters.mockResolvedValue(feedOf(bundle("b", "Başbakan açıkladı")));
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });

    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: "thyao" }) });

    expect(intentLinks(tree)).toHaveLength(1);
    expect(visibleText(tree)).toContain("Hiç haber bulunamadı");
    expect(visibleText(tree)).toContain("“thyao” için 0 sonuç");
  });

  it("leaves the FeedUnavailable state alone: no row, still three children", async () => {
    loadSearchIntent.mockResolvedValue(TICKER);
    getPoliticsClusters.mockRejectedValue(new Error("db down"));

    const tree = (await HomeFeed({ searchParams: Promise.resolve({ q: "thyao" }) })) as Elementish;

    expect(tree.props?.children as Elementish[]).toHaveLength(3);
    expect(intentLinks(tree)).toHaveLength(0);
  });

  it("runs the lookup in parallel with the feed and the archive (none waits for another)", async () => {
    // A latch that opens only once all three have STARTED: a sequential page would wait on it forever.
    let started = 0;
    let open!: () => void;
    const latch = new Promise<void>((resolve) => {
      open = resolve;
    });
    const arrive = async () => {
      started += 1;
      if (started === 3) open();
      await latch;
    };
    getPoliticsClusters.mockImplementation(async () => {
      await arrive();
      return feedOf();
    });
    searchClusters.mockImplementation(async () => {
      await arrive();
      return { ok: true, bundles: [] };
    });
    loadSearchIntent.mockImplementation(async () => {
      await arrive();
      return TICKER;
    });

    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: "thyao" }) });

    expect(started).toBe(3);
    expect(intentLinks(tree)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// h170-roadmap-1: the archive search can be paged to its 96 best matches (?arsiv=N, 4 pages of 24).
// Page 1 stays what it was; a pager follows the archive list when the TYPED call filled its page, and
// a later page is the archive rows of that page only (no in-feed sections).
// ---------------------------------------------------------------------------

describe("HomeFeed — archive pages (?arsiv=N, h170-roadmap-1)", () => {
  const inFeed = [bundle("f1", "Enflasyon rakamları açıklandı"), bundle("f2", "Enflasyon beklentisi düştü")];
  const archiveRows = (n: number, prefix = "x") =>
    Array.from({ length: n }, (_, i) => bundle(`${prefix}${i + 1}`, `Arşiv haberi ${prefix}${i + 1}`));

  async function render(
    sp: { q?: string | string[]; page?: string | string[]; arsiv?: string | string[] },
    search: unknown,
    feed = feedOf(...inFeed),
  ) {
    getPoliticsClusters.mockResolvedValue(feed);
    searchClusters.mockResolvedValue(search);
    return (await HomeFeed({ searchParams: Promise.resolve(sp) })) as Elementish;
  }

  /** The element ArchivePager renders (a pure function component), or null when the page has none. */
  function pager(tree: unknown): Elementish | null {
    const el = collectElements(tree).find((e) => typeName(e) === "ArchivePager");
    return el ? (el.type as (props: unknown) => Elementish)(el.props) : null;
  }

  const linksOf = (node: unknown) =>
    collectElements(node)
      .filter((el) => typeof el.props?.href === "string")
      .map((el) => [textOf(el), el.props?.href]);

  const full = (n = 24) => ({ ok: true as const, bundles: archiveRows(n), capped: true, typedFull: true as const });

  describe("the pager on page 1", () => {
    it("appears when the typed call filled the page: 'Sonraki sonuçlar →' to arsiv=2, the page as '1. sayfa', no previous link", async () => {
      const tree = await render({ q: "enflasyon" }, full());
      const nav = pager(tree);
      expect(nav).not.toBeNull();
      expect(linksOf(nav)).toEqual([["Sonraki sonuçlar →", "/?q=enflasyon&arsiv=2"]]);
      const current = collectElements(nav).filter((el) => el.props?.["aria-current"] === "page");
      expect(current).toHaveLength(1);
      expect(textOf(current[0])).toContain("1. sayfa");
      const navEl = collectElements(nav).find((el) => el.type === "nav");
      expect(navEl?.props?.["aria-label"]).toBe("Arama sonuç sayfaları");
    });

    it("sits after the archive list: the last section before it is the archive, and nothing follows it", async () => {
      const tree = await render({ q: "enflasyon" }, full());
      const names = collectElements(tree).map((el) => (el.type === "section" ? "section" : typeName(el) ?? ""));
      const last = names.lastIndexOf("ArchivePager");
      expect(last).toBeGreaterThan(names.lastIndexOf("section"));
    });

    it("is absent when the sibling or locative call filled the page (capped, but not by the typed call)", async () => {
      const tree = await render({ q: "enflasyon" }, { ok: true, bundles: archiveRows(24), capped: true });
      expect(pager(tree)).toBeNull();
    });

    it("is absent for fewer than 24 hits", async () => {
      const tree = await render({ q: "enflasyon" }, { ok: true, bundles: archiveRows(23), capped: false });
      expect(pager(tree)).toBeNull();
    });

    it("is absent on in-feed page 2 of a search (the archive list shows on page 1 of the feed only)", async () => {
      const tree = await render({ q: "enflasyon", page: "2" }, full(), feedOf(...manyBundles(31).map((b, i) => bundle(b.cluster.id, `Enflasyon haberi ${i}`))));
      expect(pager(tree)).toBeNull();
    });

    it("is absent when the archive failed", async () => {
      expect(pager(await render({ q: "enflasyon" }, { ok: false }))).toBeNull();
    });

    it("still shows when every archive row is already in the feed (page 2 can hold rows the list does not)", async () => {
      const search = { ok: true, bundles: inFeed, capped: true, typedFull: true };
      const tree = await render({ q: "enflasyon" }, search);
      expect(pager(tree)).not.toBeNull();
    });

    it("uses Pagination's link classes (44 px targets on phones)", async () => {
      const withPager = pager(await render({ q: "enflasyon" }, full()));
      const archiveLink = collectElements(withPager).find((el) => typeof el.props?.href === "string");
      const feedTree = await render({}, undefined, feedOf(...manyBundles(31)));
      const paginationEl = collectElements(feedTree).find((e) => typeName(e) === "Pagination")!;
      const pagination = (paginationEl.type as (p: unknown) => Elementish)(paginationEl.props);
      const feedLink = collectElements(pagination).find((el) => typeof el.props?.href === "string");
      expect(archiveLink?.props?.className).toBe(feedLink?.props?.className);
      expect(String(archiveLink?.props?.className)).toContain("min-h-[44px]");
    });

    it("leaves everything else of page 1 as it was: the same cards, headings, lines and status with and without typedFull", async () => {
      const a = await render({ q: "enflasyon" }, { ok: true, bundles: archiveRows(24), capped: true, typedFull: true });
      const b = await render({ q: "enflasyon" }, { ok: true, bundles: archiveRows(24), capped: true });
      expect(clusterCardIds(a)).toEqual(clusterCardIds(b));
      expect(visibleText(a)).toBe(visibleText(b));
      expect(liveRegionText(a)).toBe(liveRegionText(b));
      expect(liveRegionText(a)).toBe("“enflasyon” için en ilgili 26 sonuç gösteriliyor.");
      expect(searchClusters).toHaveBeenLastCalledWith("enflasyon");
    });

    it("calls the search with the query only, as before (page 1 never passes a page)", async () => {
      await render({ q: "enflasyon", arsiv: "1" }, full());
      expect(searchClusters).toHaveBeenCalledTimes(1);
      expect(searchClusters).toHaveBeenCalledWith("enflasyon");
    });
  });

  describe("page 2", () => {
    const page2 = () => render({ q: "enflasyon", arsiv: "2" }, { ok: true, bundles: [...archiveRows(22, "y"), inFeed[0]!, inFeed[1]!], capped: true });

    it("asks the search for page 2", async () => {
      await page2();
      expect(searchClusters).toHaveBeenCalledTimes(1);
      expect(searchClusters).toHaveBeenCalledWith("enflasyon", 2);
    });

    it("lists the page's archive rows and no in-feed section: no Son Dakika, no day buckets, no in-feed cards, no Pagination", async () => {
      const tree = await page2();
      const ids = clusterCardIds(tree);
      expect(ids).toEqual(archiveRows(22, "y").map((b) => b.cluster.id));
      expect(ids).not.toContain("f1");
      expect(ids).not.toContain("f2");
      const names = collectElements(tree).map((e) => typeName(e));
      expect(names).not.toContain("Pagination");
      const headings = collectElements(tree).filter((el) => el.type === "h2").map((el) => textOf(el));
      expect(headings).toEqual(["Arşivden: en ilgili sonuçlar (2. sayfa)"]);
    });

    it("links back with 'Önceki sonuçlar' (to the first page, no arsiv) and on with 'Sonraki sonuçlar'", async () => {
      const nav = pager(await page2());
      expect(linksOf(nav)).toEqual([
        ["← Önceki sonuçlar", "/?q=enflasyon"],
        ["Sonraki sonuçlar →", "/?q=enflasyon&arsiv=3"],
      ]);
      const current = collectElements(nav).filter((el) => el.props?.["aria-current"] === "page");
      expect(current.map((el) => textOf(el))).toEqual(["2. sayfa"]);
    });

    it("says which page it shows in the live region and in the visible line, with no count", async () => {
      const tree = await page2();
      expect(liveRegionText(tree)).toBe("“enflasyon” için en ilgili sonuçların 2. sayfası gösteriliyor.");
      expect(visibleText(tree)).toContain("“enflasyon” için en ilgili sonuçların 2. sayfası");
      expect(visibleText(tree)).not.toContain("sonuç gösteriliyor");
    });

    it("keeps the follow button and the search echo of the query", async () => {
      const tree = await page2();
      const follow = collectElements(tree).find((el) => el.type === FollowButton);
      expect(follow?.props).toMatchObject({ kind: "q", value: "enflasyon" });
    });

    it("hands the island the archive page so a pager change moves focus to the feed", async () => {
      const tree = await page2();
      const focus = collectElements(tree).find((el) => el.type === FocusFeedOnPageChange);
      expect(focus?.props).toEqual({ page: 1, query: "enflasyon", targetId: "haber-akisi", archivePage: 2 });
    });

    it("the last-visit pill counts nothing the reader did not see (no in-feed rows on this page)", async () => {
      const tree = await page2();
      const pill = collectElements(tree).find((el) => typeName(el) === "NewSinceLastVisit");
      expect(pill?.props?.items).toEqual([]);
      expect(pill?.props?.stamp).toBe(false);
    });
  });

  describe("the arrows are decorative (react-3)", () => {
    /** A node's text without the subtrees marked aria-hidden="true": what a screen reader puts in the link's name. */
    function accessibleText(node: unknown): string {
      if (typeof node === "string" || typeof node === "number") return String(node);
      if (Array.isArray(node)) return node.map(accessibleText).join("");
      if (node && typeof node === "object") {
        const el = node as Elementish;
        if (el.props?.["aria-hidden"] === "true") return "";
        return accessibleText(el.props?.children);
      }
      return "";
    }

    const pagerLinks = (nav: Elementish | null) =>
      collectElements(nav).filter((el) => typeof el.props?.href === "string");

    it("the link names are exactly 'Önceki sonuçlar' and 'Sonraki sonuçlar': each glyph sits in its own aria-hidden span", async () => {
      const nav = pager(await render({ q: "enflasyon", arsiv: "2" }, full()));
      const [prev, next] = pagerLinks(nav);
      expect(accessibleText(prev).trim()).toBe("Önceki sonuçlar");
      expect(accessibleText(next).trim()).toBe("Sonraki sonuçlar");
      const hidden = (link: Elementish | undefined) =>
        collectElements(link).filter((el) => el.type === "span" && el.props?.["aria-hidden"] === "true");
      expect(hidden(prev).map(textOf)).toEqual(["← "]);
      expect(hidden(next).map(textOf)).toEqual([" →"]);
      // The visible text is unchanged: the glyph and the words, in the same order.
      expect(textOf(prev)).toBe("← Önceki sonuçlar");
      expect(textOf(next)).toBe("Sonraki sonuçlar →");
    });

    it("holds on the first page (next only) and the last page (previous only)", async () => {
      const first = pagerLinks(pager(await render({ q: "enflasyon" }, full())));
      expect(first.map((l) => accessibleText(l).trim())).toEqual(["Sonraki sonuçlar"]);
      const last = pagerLinks(
        pager(await render({ q: "enflasyon", arsiv: "4" }, { ok: true, bundles: archiveRows(24), capped: true })),
      );
      expect(last.map((l) => accessibleText(l).trim())).toEqual(["Önceki sonuçlar"]);
    });

    it("no arrow glyph is left outside an aria-hidden span", async () => {
      const nav = pager(await render({ q: "enflasyon", arsiv: "2" }, full()));
      for (const link of pagerLinks(nav)) expect(accessibleText(link)).not.toMatch(/[←→]/);
    });
  });

  describe("page 3", () => {
    it("links to page 2 and page 4", async () => {
      const tree = await render({ q: "enflasyon", arsiv: "3" }, full());
      expect(searchClusters).toHaveBeenCalledWith("enflasyon", 3);
      expect(linksOf(pager(tree))).toEqual([
        ["← Önceki sonuçlar", "/?q=enflasyon&arsiv=2"],
        ["Sonraki sonuçlar →", "/?q=enflasyon&arsiv=4"],
      ]);
    });
  });

  describe("page 4, the last", () => {
    it("when full, prints the end line and no next link", async () => {
      const tree = await render({ q: "enflasyon", arsiv: "4" }, { ok: true, bundles: archiveRows(24), capped: true });
      const nav = pager(tree);
      expect(linksOf(nav)).toEqual([["← Önceki sonuçlar", "/?q=enflasyon&arsiv=3"]]);
      expect(textOf(nav)).toContain("En ilgili 96 sonuç gösterildi; daha fazlası için aramayı daraltın.");
      expect(textOf(nav)).not.toContain("Sonraki sonuçlar");
      expect(textOf(nav)).toContain("4. sayfa");
    });

    it("when not full, there is no end line (the ranking ended on its own) and still no next link", async () => {
      const tree = await render({ q: "enflasyon", arsiv: "4" }, { ok: true, bundles: archiveRows(10), capped: false });
      const nav = pager(tree);
      expect(textOf(nav)).not.toContain("En ilgili 96 sonuç");
      expect(textOf(nav)).not.toContain("Sonraki sonuçlar");
      expect(linksOf(nav)).toEqual([["← Önceki sonuçlar", "/?q=enflasyon&arsiv=3"]]);
    });

    it("a page past the last is page 4", async () => {
      const tree = await render({ q: "enflasyon", arsiv: "9" }, { ok: true, bundles: archiveRows(24), capped: true });
      expect(searchClusters).toHaveBeenCalledWith("enflasyon", 4);
      expect(textOf(pager(tree))).toContain("En ilgili 96 sonuç gösterildi");
      expect(liveRegionText(tree)).toBe("“enflasyon” için en ilgili sonuçların 4. sayfası gösteriliyor.");
    });
  });

  describe("which parameter wins, and when arsiv counts", () => {
    it("?page=2&arsiv=2: arsiv wins (archive page 2, no in-feed section, no page in any link)", async () => {
      const feed = feedOf(...Array.from({ length: 31 }, (_, i) => bundle(`f${i + 1}`, `Enflasyon haberi ${i + 1}`)));
      const tree = await render({ q: "enflasyon", page: "2", arsiv: "2" }, { ok: true, bundles: archiveRows(24), capped: true }, feed);
      expect(searchClusters).toHaveBeenCalledWith("enflasyon", 2);
      expect(clusterCardIds(tree)).toEqual(archiveRows(24).map((b) => b.cluster.id));
      for (const [, href] of linksOf(pager(tree))) expect(String(href)).not.toContain("page=");
      expect(collectElements(tree).map((e) => typeName(e))).not.toContain("Pagination");
    });

    it("arsiv without q is ignored: no search, the plain page", async () => {
      const plain = await render({}, undefined, feedOf(...inFeed));
      searchClusters.mockClear();
      const withArsiv = await render({ arsiv: "2" }, undefined, feedOf(...inFeed));
      expect(searchClusters).not.toHaveBeenCalled();
      expect(clusterCardIds(withArsiv)).toEqual(clusterCardIds(plain));
      expect(visibleText(withArsiv)).toBe(visibleText(plain));
      expect(liveRegionText(withArsiv)).toBe("");
      expect(pager(withArsiv)).toBeNull();
      const focus = collectElements(withArsiv).find((el) => el.type === FocusFeedOnPageChange);
      expect(focus?.props).toEqual({ page: 1, query: "", targetId: "haber-akisi" });
    });

    it("arsiv with a blank or too-short q is ignored too", async () => {
      for (const q of ["", "   ", "a", "!!"]) {
        searchClusters.mockClear();
        const tree = await render({ q, arsiv: "3" }, { ok: true, bundles: [] });
        expect(searchClusters, JSON.stringify(q)).not.toHaveBeenCalledWith(expect.anything(), 3);
        expect(pager(tree), JSON.stringify(q)).toBeNull();
        const focus = collectElements(tree).find((el) => el.type === FocusFeedOnPageChange);
        expect(focus?.props).not.toHaveProperty("archivePage");
      }
    });

    it("plain '/' renders identically, with or without the new parameter", async () => {
      const a = await render({}, undefined, feedOf(...manyBundles(31)));
      const b = await render({ arsiv: "1" }, undefined, feedOf(...manyBundles(31)));
      expect(clusterCardIds(b)).toEqual(clusterCardIds(a));
      expect(visibleText(b)).toBe(visibleText(a));
      expect(collectElements(b).length).toBe(collectElements(a).length);
      expect(searchClusters).not.toHaveBeenCalled();
    });

    it("a value that is not a page reads as page 1: no pager link, the plain search call", async () => {
      for (const arsiv of ["abc", "0", "-1", "", "1", "2.5"] as const) {
        searchClusters.mockClear();
        const tree = await render({ q: "enflasyon", arsiv }, { ok: true, bundles: archiveRows(5), capped: false });
        expect(searchClusters, arsiv).toHaveBeenCalledWith("enflasyon");
        expect(pager(tree), arsiv).toBeNull();
        expect(clusterCardIds(tree), arsiv).toContain("f1");
      }
    });

    it("a repeated ?arsiv= is page 1, as is a repeated ?q= that reads its first value", async () => {
      searchClusters.mockClear();
      await render({ q: "enflasyon", arsiv: ["2", "3"] }, { ok: true, bundles: [] });
      expect(searchClusters).toHaveBeenCalledWith("enflasyon");
    });
  });

  describe("an unavailable page (migration 211 not applied)", () => {
    const unavailable = () => render({ q: "enflasyon", arsiv: "2" }, { ok: false, unavailablePage: true });

    it("prints 'Bu sayfa şu an gösterilemiyor.' with a link to page 1, and no list, no pager, no retry card", async () => {
      const tree = await unavailable();
      const el = collectElements(tree).find((e) => typeName(e) === "ArchivePageUnavailable");
      expect(el, "the unavailable-page block").toBeDefined();
      const block = (el!.type as (props: unknown) => Elementish)(el!.props);
      expect(textOf(block)).toContain("Bu sayfa şu an gösterilemiyor.");
      expect(linksOf(block)).toEqual([["İlk sayfaya dön", "/?q=enflasyon"]]);
      expect(clusterCardIds(tree)).toEqual([]);
      expect(pager(tree)).toBeNull();
      expect(collectRendered(tree, new Set(["EmptySearch"])).some((e) => typeName(e) === "SearchUnavailable")).toBe(false);
    });

    it("says so in the live region", async () => {
      expect(liveRegionText(await unavailable())).toBe("Bu sayfa şu an gösterilemiyor.");
    });

    it("is not announced as an empty search", async () => {
      expect(visibleText(await unavailable())).not.toContain("Hiç haber bulunamadı");
    });

    it("a plain failure on a later page is the retry card, not the page message", async () => {
      const tree = await render({ q: "enflasyon", arsiv: "2" }, { ok: false });
      expect(collectRendered(tree, new Set(["EmptySearch"])).some((e) => typeName(e) === "SearchUnavailable")).toBe(true);
      expect(visibleText(tree)).not.toContain("Bu sayfa şu an gösterilemiyor.");
    });
  });

  describe("an empty later page", () => {
    it("says there is nothing on this page and leads back, never 'Hiç haber bulunamadı'", async () => {
      const tree = await render({ q: "enflasyon", arsiv: "2" }, { ok: true, bundles: [], capped: false });
      expect(visibleText(tree)).not.toContain("Hiç haber bulunamadı");
      expect(visibleText(tree)).toContain("Bu sayfada sonuç yok.");
      expect(linksOf(pager(tree))).toEqual([["← Önceki sonuçlar", "/?q=enflasyon"]]);
    });
  });

  describe("the hrefs", () => {
    it("are built with URLSearchParams: the query is encoded, arsiv is omitted on page 1", async () => {
      const q = "asgari ücret & zam";
      const tree = await render({ q, arsiv: "3" }, full());
      const links = linksOf(pager(tree));
      const params = (href: unknown) => new URLSearchParams(String(href).slice(2));
      expect(params(links[0]![1]).get("q")).toBe(q);
      expect(params(links[0]![1]).get("arsiv")).toBe("2");
      expect(params(links[1]![1]).get("arsiv")).toBe("4");
      const first = await render({ q, arsiv: "2" }, full());
      const back = linksOf(pager(first))[0]![1];
      expect(params(back).has("arsiv")).toBe(false);
      expect(params(back).get("q")).toBe(q);
      expect(String(back)).toBe(`/?${new URLSearchParams({ q }).toString()}`);
    });

    it("never carry a markup-looking query unescaped (it is a href value, not HTML)", async () => {
      const tree = await render({ q: '"><script>x</script>', arsiv: "2" }, full());
      const links = linksOf(pager(tree));
      expect(links.length).toBeGreaterThan(0);
      for (const [, href] of links) {
        expect(String(href).startsWith("/?q=")).toBe(true);
        expect(String(href)).not.toContain("<");
        expect(String(href)).not.toContain('"');
      }
    });
  });
});

describe("generateMetadata — archive pages (?arsiv=N, h170-roadmap-1)", () => {
  const meta = (sp: { q?: string | string[]; page?: string | string[]; arsiv?: string | string[] }) =>
    generateMetadata({ searchParams: Promise.resolve(sp) });
  const noindex = { index: false, follow: true };

  it("titles page 2 and later with the page, and stays noindex,follow", async () => {
    expect(await meta({ q: "enflasyon", arsiv: "2" })).toEqual({
      title: { absolute: "“enflasyon” araması — 2. sayfa — Tayf" },
      robots: noindex,
    });
    expect(await meta({ q: "enflasyon", arsiv: "4" })).toEqual({
      title: { absolute: "“enflasyon” araması — 4. sayfa — Tayf" },
      robots: noindex,
    });
  });

  it("a page past the last is titled as the last page", async () => {
    expect((await meta({ q: "enflasyon", arsiv: "9" })).title).toEqual({ absolute: "“enflasyon” araması — 4. sayfa — Tayf" });
  });

  it("page 1, an unreadable value and a repeated value keep today's title", async () => {
    const today = { title: { absolute: "“enflasyon” araması — Tayf" }, robots: noindex };
    for (const arsiv of [undefined, "1", "0", "abc", "", ["2", "3"]]) {
      expect(await meta({ q: "enflasyon", arsiv }), JSON.stringify(arsiv)).toEqual(today);
    }
  });

  it("arsiv wins over page, and neither reads the feed", async () => {
    expect((await meta({ q: "enflasyon", page: "3", arsiv: "2" })).title).toEqual({ absolute: "“enflasyon” araması — 2. sayfa — Tayf" });
    expect(getPoliticsClusters).not.toHaveBeenCalled();
  });

  it("arsiv without a searchable q changes nothing: the plain home metadata, or the too-short query's title", async () => {
    expect(await meta({ arsiv: "2" })).toEqual({});
    expect(await meta({ q: "", arsiv: "2" })).toEqual({});
    expect(await meta({ q: "a", arsiv: "3" })).toEqual({ title: { absolute: "“a” araması — Tayf" }, robots: noindex });
    expect(await meta({ q: "!!", arsiv: "3" })).toEqual({ title: { absolute: "“!!” araması — Tayf" }, robots: noindex });
    expect(getPoliticsClusters).not.toHaveBeenCalled();
  });

  it("the title never carries markup from the query", async () => {
    const result = await meta({ q: "<b>x</b>", arsiv: "2" });
    expect(result.title).toEqual({ absolute: "“<b>x</b>” araması — 2. sayfa — Tayf" });
  });
});

// ---------------------------------------------------------------------------
// h170-roadmap-3: the compact "Yükselen konular" rail. It sits right after the first story section
// of page 1 of the plain feed (after Son Dakika when the strip has stories, otherwise after the first
// ranked section: the two spots the "Günün Tayf'ı" teaser uses), in a Suspense of its own with a null
// fallback, so a slow or failed rising read can never delay or fail the feed. Nothing above the first
// story section changes. What the rail renders is pinned in src/components/home/rising-rail.test.tsx.
// Its read (loadRisingRail) starts beside the feed read, so the rail's data is not waiting for HomeFeed
// to finish rendering (react-2: a rail that starts reading only after the feed returned reveals later
// than the feed and shifts everything below it); the feed never awaits it.
// ---------------------------------------------------------------------------

describe("HomeFeed — the 'Yükselen konular' rail (h170-roadmap-3)", () => {
  type Params = { q?: string | string[]; page?: string | string[]; arsiv?: string | string[] };

  beforeEach(() => {
    teaserOverride = null;
    getRisingEntities.mockReset();
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });
  });

  /** What the feed returns, in document order, with Fragments and arrays flattened and nothing else opened. */
  function siblingsOf(node: unknown, out: Elementish[] = []): Elementish[] {
    if (Array.isArray(node)) {
      for (const child of node) siblingsOf(child, out);
      return out;
    }
    if (node && typeof node === "object") {
      const el = node as Elementish;
      if (el.type === Fragment) siblingsOf(el.props?.children, out);
      else if (el.type !== undefined) out.push(el);
    }
    return out;
  }

  const isRail = (el: Elementish): boolean =>
    el.type === Suspense && (el.props?.children as Elementish | undefined)?.type === RisingRail;

  const isTeaser = (el: Elementish): boolean => el.type === "aside" && el.props?.["aria-label"] === "Günün Tayf'ı";

  const heading = (section: Elementish): string =>
    textOf(collectElements(section).find((el) => el.type === "h2"));

  async function feedFor(params: Params, feed: PoliticsClustersResult) {
    getPoliticsClusters.mockResolvedValue(feed);
    return siblingsOf(await HomeFeed({ searchParams: Promise.resolve(params) }));
  }

  const railsIn = (siblings: Elementish[]) => siblings.filter(isRail);

  /** `bundle()` with its day fixed, so the day buckets are known. */
  function dated(id: string, iso: string) {
    const b = bundle(id, `Haber ${id}`);
    b.cluster.first_published = iso;
    b.cluster.updated_at = iso;
    return b;
  }

  const NOW = Date.parse("2026-11-12T10:00:00Z");

  /** Two day buckets (Bugün, Dün) and, when asked, a Son Dakika strip of two. */
  function twoBuckets(withStrip: boolean) {
    return {
      bundles: [dated("t", "2026-11-12T05:00:00Z"), dated("y", "2026-11-11T08:00:00Z")],
      breakingBundles: withStrip
        ? [dated("s1", "2026-11-12T09:50:00Z"), dated("s2", "2026-11-12T09:40:00Z")]
        : [],
    } as unknown as PoliticsClustersResult;
  }

  describe("where it sits", () => {
    it("right after Son Dakika when the strip has stories, before the first day bucket", async () => {
      nowOverrideMs = NOW;
      const siblings = await feedFor({}, twoBuckets(true));

      const sections = siblings.filter((el) => el.type === "section");
      expect(sections.map(heading)).toEqual(["Son Dakika", "Bugün", "Dün"]);
      expect(railsIn(siblings)).toHaveLength(1);
      const at = siblings.findIndex(isRail);
      expect(siblings[at - 1]).toBe(sections[0]);
      expect(at).toBeLessThan(siblings.indexOf(sections[1]!));
    });

    it("otherwise right after the first ranked section, not the last", async () => {
      nowOverrideMs = NOW;
      const siblings = await feedFor({}, twoBuckets(false));

      const sections = siblings.filter((el) => el.type === "section");
      expect(sections.map(heading)).toEqual(["Bugün", "Dün"]);
      expect(railsIn(siblings)).toHaveLength(1);
      const at = siblings.findIndex(isRail);
      expect(siblings[at - 1]).toBe(sections[0]);
      expect(at).toBeLessThan(siblings.indexOf(sections[1]!));
    });

    it("shares the gap after the first section with the 'Günün Tayf'ı' teaser, in both spots", async () => {
      nowOverrideMs = NOW;
      for (const withStrip of [true, false]) {
        const siblings = await feedFor({}, twoBuckets(withStrip));
        const sections = siblings.filter((el) => el.type === "section");
        const gap = siblings.slice(siblings.indexOf(sections[0]!) + 1, siblings.indexOf(sections[1]!));
        expect(gap.some(isRail), `rail, strip ${withStrip}`).toBe(true);
        expect(gap.some(isTeaser), `teaser, strip ${withStrip}`).toBe(true);
      }
    });

    it("renders whether or not the teaser does (a null teaser slot leaves the rail in place)", async () => {
      nowOverrideMs = NOW;
      teaserOverride = () => null;
      for (const withStrip of [true, false]) {
        const siblings = await feedFor({}, twoBuckets(withStrip));
        const sections = siblings.filter((el) => el.type === "section");
        expect(siblings.some(isTeaser), `teaser, strip ${withStrip}`).toBe(false);
        expect(railsIn(siblings), `rail, strip ${withStrip}`).toHaveLength(1);
        expect(siblings[siblings.findIndex(isRail) - 1], `position, strip ${withStrip}`).toBe(sections[0]);
      }
    });

    it("is one boundary: a Suspense with a null fallback around <RisingRail data={promise} />", async () => {
      const siblings = await feedFor({}, twoBuckets(true));

      const boundary = siblings.find(isRail)!;
      expect(boundary.props?.fallback).toBeNull();
      const rail = boundary.props?.children as Elementish;
      expect(rail.type).toBe(RisingRail);
      // Nothing from the request reaches it but the read HomeFeed started: one `data` promise.
      expect(Object.keys(rail.props ?? {})).toEqual(["data"]);
      expect(rail.props?.data).toBeInstanceOf(Promise);
    });

    it("is not a sibling of the cards: no ClusterCard element sits inside the boundary", async () => {
      const siblings = await feedFor({}, twoBuckets(true));
      expect(collectElements(siblings.find(isRail)).filter((el) => el.props?.cluster !== undefined)).toHaveLength(0);
    });
  });

  describe("on the plain feed only", () => {
    const base = () => feedOf(...manyBundles(5));

    it("renders once on the plain home feed, on an explicit ?page=1, on a blank ?q= and on a clamped ?page=99 of a one-page feed", async () => {
      for (const params of [{}, { page: "1" }, { q: "   " }, { page: "99" }] as Params[]) {
        expect(railsIn(await feedFor(params, base())), JSON.stringify(params)).toHaveLength(1);
      }
    });

    it("renders when ?arsiv= comes without a query (the parameter is ignored there)", async () => {
      expect(railsIn(await feedFor({ arsiv: "2" }, base()))).toHaveLength(1);
    });

    it("is absent on ?page=2, and on the later page ?page=99 clamps to", async () => {
      const big = () => feedOf(...manyBundles(31));
      expect(railsIn(await feedFor({ page: "2" }, big()))).toHaveLength(0);
      expect(railsIn(await feedFor({ page: "99" }, big()))).toHaveLength(0);
    });

    it("is absent on a /?q= search, a repeated ?q=, and a search on page 2", async () => {
      const feed = () => feedOf(...manyBundles(5).map((b, i) => bundle(b.cluster.id, `Seçim haberi ${i}`)));
      expect(railsIn(await feedFor({ q: "seçim" }, feed()))).toHaveLength(0);
      expect(railsIn(await feedFor({ q: ["seçim", "ekonomi"] }, feed()))).toHaveLength(0);
      expect(railsIn(await feedFor({ q: "seçim", page: "2" }, feed()))).toHaveLength(0);
    });

    it("is absent on a later page of a search archive (?arsiv=N) and on a too-short query", async () => {
      expect(railsIn(await feedFor({ q: "haber", arsiv: "2" }, base()))).toHaveLength(0);
      expect(railsIn(await feedFor({ q: "a" }, base()))).toHaveLength(0);
    });

    it("is absent in the outage shell", async () => {
      getPoliticsClusters.mockRejectedValue(new Error("db down"));
      const siblings = siblingsOf(await HomeFeed({ searchParams: Promise.resolve({}) }));
      expect(railsIn(siblings)).toHaveLength(0);
    });

    it("is absent when the feed has nothing to list (no sections, so no 'first section' to follow)", async () => {
      expect(railsIn(await feedFor({}, feedOf()))).toHaveLength(0);
    });
  });

  describe("starts beside the feed read and never delays or fails the feed", () => {
    /** The `data` promise of the rail element HomeFeed returned. */
    const dataOf = (siblings: Elementish[]): Promise<unknown> =>
      ((railsIn(siblings)[0]!.props?.children as Elementish).props?.data) as Promise<unknown>;

    /** One macrotask: every already-queued microtask (the awaits of HomeFeed) has run. */
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    it("getRisingEntities is called before the feed read resolves", async () => {
      let resolveFeed: (feed: PoliticsClustersResult) => void = () => {};
      getPoliticsClusters.mockReturnValue(
        new Promise<PoliticsClustersResult>((resolve) => {
          resolveFeed = resolve;
        }),
      );

      const pending = HomeFeed({ searchParams: Promise.resolve({}) });
      await flush();
      expect(getPoliticsClusters).toHaveBeenCalledTimes(1);
      expect(getRisingEntities).toHaveBeenCalledTimes(1);

      resolveFeed(feedOf(...manyBundles(5)));
      const siblings = siblingsOf(await pending);
      expect(railsIn(siblings)).toHaveLength(1);
      // Read once: the rail does not start a second read of its own.
      expect(getRisingEntities).toHaveBeenCalledTimes(1);
    });

    it("HomeFeed resolves with the rising read still pending, and the rail's data is still pending", async () => {
      getRisingEntities.mockReturnValue(new Promise(() => {}));
      const siblings = await feedFor({}, feedOf(...manyBundles(5)));
      expect(railsIn(siblings)).toHaveLength(1);
      expect(getRisingEntities).toHaveBeenCalledTimes(1);
      const state = await Promise.race([dataOf(siblings), flush().then(() => "pending")]);
      expect(state).toBe("pending");
    });

    it("HomeFeed resolves when the rising read rejects, and the rail's data resolves to null", async () => {
      getRisingEntities.mockRejectedValue(new Error("rising down"));
      const siblings = await feedFor({}, feedOf(...manyBundles(5)));
      expect(railsIn(siblings)).toHaveLength(1);
      expect(getRisingEntities).toHaveBeenCalledTimes(1);
      await expect(dataOf(siblings)).resolves.toBeNull();
    });

    it("the rail's data resolves to null when there is nothing rising to show (insufficient history)", async () => {
      getRisingEntities.mockResolvedValue({ status: "insufficient" });
      const siblings = await feedFor({}, feedOf(...manyBundles(5)));
      await expect(dataOf(siblings)).resolves.toBeNull();
    });

    it("getRisingEntities is not called on a /?q= search, a repeated ?q= or a too-short query", async () => {
      const feed = () => feedOf(...manyBundles(5).map((b, i) => bundle(b.cluster.id, `Seçim haberi ${i}`)));
      for (const params of [{ q: "seçim" }, { q: ["seçim", "ekonomi"] }, { q: "a" }, { q: "seçim", arsiv: "2" }] as Params[]) {
        await feedFor(params, feed());
        expect(getRisingEntities, JSON.stringify(params)).not.toHaveBeenCalled();
      }
    });

    it("is read for the plain feed, including a blank ?q= (the same test the rail uses), once per render", async () => {
      for (const params of [{}, { q: "   " }] as Params[]) {
        getRisingEntities.mockClear();
        await feedFor(params, feedOf(...manyBundles(5)));
        expect(getRisingEntities, JSON.stringify(params)).toHaveBeenCalledTimes(1);
      }
    });

    it("the outage shell still resolves, with no rail", async () => {
      getPoliticsClusters.mockRejectedValue(new Error("db down"));
      getRisingEntities.mockRejectedValue(new Error("rising down"));
      const siblings = siblingsOf(await HomeFeed({ searchParams: Promise.resolve({}) }));
      expect(railsIn(siblings)).toHaveLength(0);
    });
  });

  describe("nothing above the first story section changes (the LCP path)", () => {
    it("the feed opens with the same four elements as before, and the rail is none of them", async () => {
      nowOverrideMs = NOW;
      for (const withStrip of [true, false]) {
        const siblings = await feedFor({}, twoBuckets(withStrip));
        const firstSection = siblings.findIndex((el) => el.type === "section");
        expect(siblings.slice(0, firstSection).map(typeName), `strip ${withStrip}`).toEqual([
          "SearchStatus",
          "NewSinceLastVisit",
          "NewBreakingPill",
          "FocusFeedOnPageChange",
        ]);
        expect(siblings.findIndex(isRail)).toBeGreaterThan(firstSection);
      }
    });

    it("the static shell (HomePage) does not mention the rail: it lives behind the feed boundary", () => {
      const tree = HomePage({ searchParams: Promise.resolve({}) });
      expect(collectElements(tree).some((el) => el.type === RisingRail)).toBe(false);
      expect(collectElements(tree).some(isRail)).toBe(false);
    });
  });
});
