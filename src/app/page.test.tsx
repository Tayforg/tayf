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

import { HomeFeed } from "./page";
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
