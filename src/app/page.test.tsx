import { Suspense, createElement } from "react";
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
import { ClearSearchLink } from "@/components/home/clear-search-link";
import { FocusFeedOnPageChange } from "@/components/home/focus-feed-on-page-change";
import { FollowButton } from "@/components/follow/follow-button";
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
      "için en ilgili 24 sonuç. Arama sorgunun ilk 64 karakteriyle yapıldı.",
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

  it("leaves the 'ak' prefix behaviour alone", async () => {
    getPoliticsClusters.mockResolvedValue(
      feedOf(
        bundle("grup", "AK Parti Grup Başkanı açıkladı"),
        bundle("aks", "Akşener açıklama yaptı"),
        bundle("bas", "Başbakan dakikaya kadar bekledi"),
      ),
    );
    searchClusters.mockResolvedValue({ ok: true, bundles: [] });

    const tree = await HomeFeed({ searchParams: Promise.resolve({ q: "ak" }) });

    expect(clusterCardIds(tree)).toEqual(["grup", "aks"]);
  });
});

describe("HomeFeed: a query past the search cap says so (h42-search-2)", () => {
  const six = "Erdoğan Erdoğan Erdoğan Erdoğan Erdoğan Erdoğan";
  const seven = `${six} zebra`;
  const TERM_NOTE = "Arama ilk 6 kelimeyle yapıldı.";
  const LENGTH_NOTE = "Arama sorgunun ilk 64 karakteriyle yapıldı.";

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
