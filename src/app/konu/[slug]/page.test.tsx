import { describe, it, expect, vi, beforeEach } from "vitest";
import Link from "next/link";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// /konu/[slug] failed state. Harness copied from src/app/hafta/page.test.tsx:
// mock the data module (the Supabase round-trips are covered by
// src/lib/clusters/topic-query.test.ts) and call the default export as a plain
// async function -- no React renderer needed for an async Server Component.
//
// What this pins: the failed read (getTopicClusters -> null) emits one body
// <meta name="robots" content="noindex">. An empty page PAST the last one emits
// NO body meta: generateMetadata's topicPageRobots already puts
// `noindex, follow` in <head> from the same cache key, so the page carries ONE
// robots meta, not two. The ok state and an empty page 1 emit none, or a
// healthy hub would drop out of the index. The failure is cached for "minutes"
// (topic-query.ts), so the prerendered noindex lives about a minute.
//
// Past the last page the reader is never left on a dead end: the pager offers
// the first page, the last page when it is known, and never a "Sonraki".
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  result: null as unknown,
}));

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

// Everything except the fetcher stays real (slug validation, labels, page
// clamp, JSON-LD builder), so the page runs exactly as shipped.
vi.mock("@/lib/clusters/topic-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clusters/topic-query")>();
  return {
    ...actual,
    getTopicClusters: () => Promise.resolve(mocks.result),
  };
});

import { BiasSpectrum } from "@/components/story/bias-spectrum";
import { ClusterCard } from "@/components/story/cluster-card";

import TopicHubPage, { generateMetadata } from "./page";

const UNAVAILABLE_COPY =
  "Konu listesi şu anda yüklenemiyor. Birkaç dakika içinde tekrar deneyin.";

/** Every element in the tree (own JSX only; custom components stay unexpanded). */
function walk(node: unknown, visit: (el: { type?: unknown; props?: Record<string, unknown> }) => void) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (node && typeof node === "object") {
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    visit(el);
    if (el.props?.children !== undefined) walk(el.props.children, visit);
  }
}

function robotsMetas(tree: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  walk(tree, (el) => {
    if (el.type === "meta" && el.props?.name === "robots") out.push(el.props);
  });
  return out;
}

function collectText(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { props?: { children?: ReactNode } };
    if (el.props?.children !== undefined) collectText(el.props.children, out);
  }
  return out;
}

const LOCAL_PAGERS = new Set(["TopicPager", "PastEndPager"]);

/** Expands the page's own (unexported) pager components so their links are
 *  visible to walk(); every other custom component stays unexpanded. */
function expandLocalPagers(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expandLocalPagers);
  if (node && typeof node === "object") {
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    if (typeof el.type === "function" && LOCAL_PAGERS.has(el.type.name)) {
      return expandLocalPagers((el.type as (p: unknown) => unknown)(el.props));
    }
    if (el.props?.children !== undefined) {
      return { ...el, props: { ...el.props, children: expandLocalPagers(el.props.children) } };
    }
  }
  return node;
}

/** The <nav aria-label="Sayfalar"> links, in document order. */
function pagerLinks(tree: unknown): Array<{ href: string; label: string }> {
  const out: Array<{ href: string; label: string }> = [];
  const navs: unknown[] = [];
  walk(expandLocalPagers(tree), (el) => {
    if (el.type === "nav" && el.props?.["aria-label"] === "Sayfalar") navs.push(el);
  });
  for (const nav of navs) {
    walk(nav, (el) => {
      if (el.type === Link) {
        out.push({ href: String(el.props?.href), label: collectText(el).join("") });
      }
    });
  }
  return out;
}

async function render(page = 1) {
  return TopicHubPage({
    params: Promise.resolve({ slug: "dunya" }),
    searchParams: Promise.resolve(page === 1 ? {} : { sayfa: String(page) }),
  });
}

function bundle(id: string, dist?: unknown) {
  return {
    cluster: {
      id,
      title_tr: `Küme ${id}`,
      updated_at: "2026-09-18T11:00:00.000Z",
      bias_distribution: dist,
    },
    articles: [],
    sources: [],
    isWireRedistribution: false,
    effectiveArticleCount: 1,
  };
}

beforeEach(() => {
  mocks.result = null;
});

describe("/konu/[slug] failed state", () => {
  it("emits <meta name=robots content=noindex> and the unavailable copy when the read failed (null)", async () => {
    mocks.result = null;

    const tree = await render();
    const metas = robotsMetas(tree);

    expect(metas).toHaveLength(1);
    expect(metas[0]?.content).toBe("noindex");
    expect(collectText(tree).join("")).toContain(UNAVAILABLE_COPY);
  });

  it("does NOT emit a robots meta when the page has bundles", async () => {
    mocks.result = { bundles: [bundle("c1"), bundle("c2")], hasMore: false, page: 1 };

    const tree = await render();

    expect(robotsMetas(tree)).toEqual([]);
    expect(collectText(tree).join("")).not.toContain(UNAVAILABLE_COPY);
  });

  it("does NOT emit a robots meta for a legitimately empty page 1 (read fine, nothing matched)", async () => {
    mocks.result = { bundles: [], hasMore: false, page: 1 };

    const tree = await render();

    expect(robotsMetas(tree)).toEqual([]);
    const text = collectText(tree).join("");
    expect(text).toContain("Bu konuda son 7 günde küme oluşmadı.");
    expect(text).not.toContain(UNAVAILABLE_COPY);
  });

  it("emits NO body robots meta for an empty page past the last one (generateMetadata owns the single noindex)", async () => {
    mocks.result = { bundles: [], hasMore: false, page: 3 };

    const tree = await render(3);

    expect(robotsMetas(tree)).toEqual([]);
    const text = collectText(tree).join("");
    expect(text).toContain("Bu sayfada küme yok.");
    expect(text).not.toContain(UNAVAILABLE_COPY);
  });
});

// ---------------------------------------------------------------------------
// Past the last page: never a dead end. Prod today: ?sayfa=16 shows "Bu sayfada
// küme yok." with a single link to ?sayfa=15 (also empty); ?sayfa=999 clamps to
// 20 with a single link to ?sayfa=19; nothing leads back to page 1. The status
// stays 200 plus the empty state (the PPR shell has flushed already; no other
// paged route 404s) and the page stays noindex.
// ---------------------------------------------------------------------------

describe("/konu/[slug] past the last page", () => {
  it("page 16, last page 13: says where the list ends and links to the first and the last page only", async () => {
    mocks.result = { bundles: [], hasMore: false, page: 16, lastPage: 13 };

    const tree = await render(16);
    const text = collectText(tree).join("");

    expect(text).toContain("Bu sayfada küme yok.");
    expect(text).toContain("Liste 13. sayfada bitiyor.");
    expect(text).not.toContain(UNAVAILABLE_COPY);
    expect(pagerLinks(tree)).toEqual([
      { href: "/konu/dunya", label: "İlk sayfaya dön" },
      { href: "/konu/dunya?sayfa=13", label: "Son sayfaya git" },
    ]);
  });

  it("never links to the empty neighbours (page - 1, page + 1) or says Sonraki", async () => {
    mocks.result = { bundles: [], hasMore: false, page: 16, lastPage: 13 };

    const tree = await render(16);
    const hrefs = pagerLinks(tree).map((l) => l.href);
    const labels = pagerLinks(tree).map((l) => l.label);

    expect(hrefs).not.toContain("/konu/dunya?sayfa=15");
    expect(hrefs).not.toContain("/konu/dunya?sayfa=17");
    expect(labels).not.toContain("Sonraki");
    expect(labels).not.toContain("Önceki");
  });

  it("emits zero body robots metas, and generateMetadata supplies the single noindex,follow for the same result", async () => {
    mocks.result = { bundles: [], hasMore: false, page: 16, lastPage: 13 };

    const tree = await render(16);
    const m = await meta("dunya", "16");

    expect(robotsMetas(tree)).toHaveLength(0);
    expect(m.robots).toEqual({ index: false, follow: true });
    expect(m.alternates?.canonical).toBe("/konu/dunya?sayfa=16");
  });

  it("?sayfa=999 (clamped to 20), last page 13: the same two links, nothing toward page 19", async () => {
    mocks.result = { bundles: [], hasMore: false, page: 20, lastPage: 13 };

    const tree = await render(999);

    expect(pagerLinks(tree)).toEqual([
      { href: "/konu/dunya", label: "İlk sayfaya dön" },
      { href: "/konu/dunya?sayfa=13", label: "Son sayfaya git" },
    ]);
    expect(collectText(tree).join("")).toContain("Liste 13. sayfada bitiyor.");
  });

  it("lastPage null (count unavailable): first page plus Önceki to page - 1, no end claim, no next", async () => {
    mocks.result = { bundles: [], hasMore: false, page: 16, lastPage: null };

    const tree = await render(16);
    const text = collectText(tree).join("");

    expect(text).toContain("Bu sayfada küme yok.");
    expect(text).not.toContain("sayfada bitiyor");
    expect(pagerLinks(tree)).toEqual([
      { href: "/konu/dunya", label: "İlk sayfaya dön" },
      { href: "/konu/dunya?sayfa=15", label: "Önceki" },
    ]);
    expect(robotsMetas(tree)).toHaveLength(0);
  });

  it("lastPage absent (older cache entry) behaves like null", async () => {
    mocks.result = { bundles: [], hasMore: false, page: 4 };

    const tree = await render(4);

    expect(pagerLinks(tree)).toEqual([
      { href: "/konu/dunya", label: "İlk sayfaya dön" },
      { href: "/konu/dunya?sayfa=3", label: "Önceki" },
    ]);
    expect(collectText(tree).join("")).not.toContain("sayfada bitiyor");
  });

  it("lastPage null on page 2: Önceki would equal the first page, so only İlk sayfaya dön", async () => {
    mocks.result = { bundles: [], hasMore: false, page: 2, lastPage: null };

    const tree = await render(2);

    expect(pagerLinks(tree)).toEqual([{ href: "/konu/dunya", label: "İlk sayfaya dön" }]);
  });

  it("lastPage 1 on page 3: only İlk sayfaya dön (no Son sayfaya git to the same page)", async () => {
    mocks.result = { bundles: [], hasMore: false, page: 3, lastPage: 1 };

    const tree = await render(3);

    expect(pagerLinks(tree)).toEqual([{ href: "/konu/dunya", label: "İlk sayfaya dön" }]);
    expect(collectText(tree).join("")).toContain("Liste 1. sayfada bitiyor.");
  });

  it("a lastPage that is not before the current page never produces a Son sayfaya git link", async () => {
    mocks.result = { bundles: [], hasMore: false, page: 3, lastPage: 3 };

    const tree = await render(3);

    expect(pagerLinks(tree).map((l) => l.label)).toEqual(["İlk sayfaya dön"]);
  });

  it("uses the slug of the requested hub in every link", async () => {
    mocks.result = { bundles: [], hasMore: false, page: 9, lastPage: 4 };

    const tree = await TopicHubPage({
      params: Promise.resolve({ slug: "spor" }),
      searchParams: Promise.resolve({ sayfa: "9" }),
    });

    expect(pagerLinks(tree)).toEqual([
      { href: "/konu/spor", label: "İlk sayfaya dön" },
      { href: "/konu/spor?sayfa=4", label: "Son sayfaya git" },
    ]);
  });

  it("an empty page 1 shows no pager at all", async () => {
    mocks.result = { bundles: [], hasMore: false, page: 1 };

    expect(pagerLinks(await render())).toEqual([]);
  });

  it("the failed read (null) still shows no pager", async () => {
    mocks.result = null;

    expect(pagerLinks(await render(16))).toEqual([]);
  });
});

// The normal pager is unchanged: next only while hasMore and below the ceiling.
describe("/konu/[slug] pager on a page with clusters", () => {
  it("page 3 with more: Önceki to page 2 and Sonraki to page 4", async () => {
    mocks.result = { bundles: [bundle("c1")], hasMore: true, page: 3 };

    expect(pagerLinks(await render(3))).toEqual([
      { href: "/konu/dunya?sayfa=2", label: "Önceki" },
      { href: "/konu/dunya?sayfa=4", label: "Sonraki" },
    ]);
  });

  it("page 2 Önceki goes to the bare hub URL", async () => {
    mocks.result = { bundles: [bundle("c1")], hasMore: false, page: 2 };

    expect(pagerLinks(await render(2))).toEqual([{ href: "/konu/dunya", label: "Önceki" }]);
  });

  it("the last allowed page (20) never offers Sonraki even when hasMore is true", async () => {
    mocks.result = { bundles: [bundle("c1")], hasMore: true, page: 20 };

    expect(pagerLinks(await render(20))).toEqual([
      { href: "/konu/dunya?sayfa=19", label: "Önceki" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Aggregate source-mix bar. The page sums the listed bundles' own
// bias_distribution (voting kinds only, written by cluster-consumer), so no new
// query: page N aggregates page N, and the heading says "Listelenen".
// ---------------------------------------------------------------------------

const SPECTRUM_HEADING = "Listelenen haberlerin kaynak dağılımı";
const SPECTRUM_EMPTY_COPY = "Listelenen haberlerde dağılıma sayılan kaynak yok.";

function elementsOfType(tree: unknown, type: unknown) {
  const out: Array<{ type?: unknown; props?: Record<string, unknown> }> = [];
  walk(tree, (el) => {
    if (el.type === type) out.push(el);
  });
  return out;
}

function spectrumSections(tree: unknown) {
  const out: Array<{ type?: unknown; props?: Record<string, unknown> }> = [];
  walk(tree, (el) => {
    if (el.type === "section" && el.props?.["aria-labelledby"] === "topic-spectrum-heading") {
      out.push(el);
    }
  });
  return out;
}

function headingsById(tree: unknown, id: string) {
  const out: Array<{ type?: unknown; props?: Record<string, unknown> }> = [];
  walk(tree, (el) => {
    if (el.type === "h2" && el.props?.id === id) out.push(el);
  });
  return out;
}

/** Document order of the first element matching each predicate (Infinity when absent). */
function firstIndexOf(tree: unknown, match: (el: { type?: unknown; props?: Record<string, unknown> }) => boolean) {
  let i = 0;
  let found = Number.POSITIVE_INFINITY;
  walk(tree, (el) => {
    if (found === Number.POSITIVE_INFINITY && match(el)) found = i;
    i += 1;
  });
  return found;
}

describe("/konu/[slug] kaynak dağılımı", () => {
  it("renders one compact BiasSpectrum with the summed distribution above the cluster list", async () => {
    mocks.result = {
      bundles: [
        bundle("c1", { pro_government: 2, opposition: 1 }),
        bundle("c2", { opposition: 3, center: 1 }),
      ],
      hasMore: false,
      page: 1,
    };

    const tree = await render();
    const spectra = elementsOfType(tree, BiasSpectrum);

    expect(spectra).toHaveLength(1);
    expect(spectra[0]?.props?.compact).toBe(true);
    expect(spectra[0]?.props?.distribution).toEqual({
      pro_government: 2,
      state_media: 0,
      gov_leaning: 0,
      islamist_conservative: 0,
      center: 1,
      international: 0,
      pro_kurdish: 0,
      opposition_leaning: 0,
      opposition: 4,
      nationalist: 0,
    });
    const text = collectText(tree).join("");
    expect(text).toContain(SPECTRUM_HEADING);
    expect(text).not.toContain(SPECTRUM_EMPTY_COPY);
  });

  it("wraps the heading in <section aria-labelledby=topic-spectrum-heading> placed before the ClusterCard list", async () => {
    mocks.result = {
      bundles: [bundle("c1", { opposition: 2 }), bundle("c2", { center: 1 })],
      hasMore: false,
      page: 1,
    };

    const tree = await render();
    const sections = spectrumSections(tree);

    expect(sections).toHaveLength(1);
    expect(headingsById(sections[0], "topic-spectrum-heading")).toHaveLength(1);
    expect(collectText(sections[0]).join("")).toContain(SPECTRUM_HEADING);

    const sectionAt = firstIndexOf(
      tree,
      (el) => el.type === "section" && el.props?.["aria-labelledby"] === "topic-spectrum-heading",
    );
    const cardAt = firstIndexOf(tree, (el) => el.type === ClusterCard);
    expect(sectionAt).toBeLessThan(cardAt);
    expect(cardAt).not.toBe(Number.POSITIVE_INFINITY);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["all zero", { pro_government: 0, opposition: 0 }],
    ["malformed", { opposition: -2, center: "3" }],
  ])(
    "states honestly that nothing was counted, and draws no bar, when every distribution is %s",
    async (_label, dist) => {
      mocks.result = {
        bundles: [bundle("c1", dist), bundle("c2", dist)],
        hasMore: false,
        page: 1,
      };

      const tree = await render();
      const text = collectText(tree).join("");

      expect(elementsOfType(tree, BiasSpectrum)).toHaveLength(0);
      expect(spectrumSections(tree)).toHaveLength(1);
      expect(text).toContain(SPECTRUM_HEADING);
      expect(text).toContain(SPECTRUM_EMPTY_COPY);
      // The clusters themselves still list.
      expect(elementsOfType(tree, ClusterCard)).toHaveLength(2);
    },
  );

  it("shows neither the heading nor a bar when the read failed (null)", async () => {
    mocks.result = null;

    const tree = await render();

    expect(elementsOfType(tree, BiasSpectrum)).toHaveLength(0);
    expect(spectrumSections(tree)).toHaveLength(0);
    expect(collectText(tree).join("")).not.toContain(SPECTRUM_HEADING);
  });

  it.each([1, 3])("shows neither the heading nor a bar for an empty page %i", async (page) => {
    mocks.result = { bundles: [], hasMore: false, page };

    const tree = await render(page);

    expect(elementsOfType(tree, BiasSpectrum)).toHaveLength(0);
    expect(spectrumSections(tree)).toHaveLength(0);
    expect(collectText(tree).join("")).not.toContain(SPECTRUM_HEADING);
  });
});

// ---------------------------------------------------------------------------
// Structured data: a hub with at least one bundle ships ONE ld+json script that
// holds the CollectionPage and a BreadcrumbList (Anasayfa > Konular > <label>),
// the same pair /gundem/[key] ships. No bundle, no script.
// ---------------------------------------------------------------------------

function ldJsonScripts(tree: unknown) {
  const out: Array<{ type?: unknown; props?: Record<string, unknown> }> = [];
  walk(tree, (el) => {
    if (el.type === "script" && el.props?.type === "application/ld+json") out.push(el);
  });
  return out;
}

function ldJsonPayload(script: { props?: Record<string, unknown> } | undefined): unknown {
  const inner = script?.props?.dangerouslySetInnerHTML as { __html: string } | undefined;
  return JSON.parse(String(inner?.__html));
}

describe("/konu/[slug] structured data", () => {
  it("ships one ld+json script: the CollectionPage first, then the BreadcrumbList", async () => {
    mocks.result = { bundles: [bundle("c1")], hasMore: false, page: 1 };

    const tree = await TopicHubPage({
      params: Promise.resolve({ slug: "spor" }),
      searchParams: Promise.resolve({}),
    });
    const scripts = ldJsonScripts(tree);

    expect(scripts).toHaveLength(1);
    const payload = ldJsonPayload(scripts[0]) as Array<Record<string, unknown>>;
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(2);
    expect(payload[0]?.["@type"]).toBe("CollectionPage");
    expect(payload[1]?.["@type"]).toBe("BreadcrumbList");
  });

  it("the breadcrumb reads Anasayfa > Konular > <label> and the last item is the hub URL", async () => {
    mocks.result = { bundles: [bundle("c1")], hasMore: false, page: 1 };

    const tree = await TopicHubPage({
      params: Promise.resolve({ slug: "spor" }),
      searchParams: Promise.resolve({}),
    });
    const payload = ldJsonPayload(ldJsonScripts(tree)[0]) as Array<{
      itemListElement?: Array<{ name: string; item: string; position: number }>;
    }>;
    const items = payload[1]?.itemListElement ?? [];

    expect(items.map((i) => i.name)).toEqual(["Anasayfa", "Konular", "Spor"]);
    expect(items.map((i) => i.position)).toEqual([1, 2, 3]);
    expect(items[2]?.item.endsWith("/konu/spor")).toBe(true);
    expect(items[1]?.item.endsWith("/konu")).toBe(true);
  });

  it.each([
    ["no bundles on page 1", { bundles: [], hasMore: false, page: 1 }],
    ["no bundles past the last page", { bundles: [], hasMore: false, page: 3 }],
    ["a failed read", null],
  ])("renders no ld+json script for %s", async (_label, result) => {
    mocks.result = result;

    expect(ldJsonScripts(await render())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// generateMetadata: the share/canonical identity of each hub page. The real
// topicMetadata runs (only the fetcher is mocked above), so this pins the
// wiring: slug + parsed ?sayfa= -> canonical and og:url agree, and the RSS
// alternate survives the merge.
// ---------------------------------------------------------------------------

function meta(slug: string, sayfa?: string | string[]) {
  return generateMetadata({
    params: Promise.resolve({ slug }),
    searchParams: Promise.resolve(sayfa === undefined ? {} : { sayfa }),
  });
}

describe("/konu/[slug] generateMetadata", () => {
  // generateMetadata now reads the same cached feed as the body (to noindex a
  // failed read or a page past the last one), so give these identity tests a
  // healthy, non-empty page. The robots cases live in tests/app/konu-metadata.test.ts.
  beforeEach(() => {
    mocks.result = { bundles: [bundle("c1")], hasMore: false, page: 1 };
  });

  it("page 1: canonical and og:url are /konu/<slug>, and the RSS alternate is advertised", async () => {
    const m = await meta("spor");

    expect(m.alternates?.canonical).toBe("/konu/spor");
    expect(m.openGraph?.url).toBe("/konu/spor");
    expect(m.alternates?.types).toEqual({
      "application/rss+xml": "/rss/spor.xml",
    });
    expect(m.title).toBe("Spor haberleri");
    expect(m.openGraph?.title).toBe("Spor haberleri — Tayf");
    expect(m.robots).toBeUndefined();
  });

  it("the description is the jargon-free copy on page 1 and on a paged URL alike", async () => {
    const first = await meta("spor");
    const paged = await meta("spor", "2");

    expect(first.description).toBe(
      "Son 7 günün spor haberleri, olaylara göre gruplanmış: iktidar, bağımsız ve muhalefet medyasının her olaya ne kadar yer verdiğini görün.",
    );
    expect(paged.description).toBe(first.description);
    expect(String(first.description)).not.toMatch(/jev|eşik|0,8/i);
  });

  it('?sayfa=2: canonical and og:url both carry "?sayfa=2"', async () => {
    const m = await meta("spor", "2");

    expect(m.alternates?.canonical).toBe("/konu/spor?sayfa=2");
    expect(m.openGraph?.url).toBe("/konu/spor?sayfa=2");
    expect(m.alternates?.types).toEqual({
      "application/rss+xml": "/rss/spor.xml",
    });
  });

  it('?sayfa=999 is clamped: both carry "?sayfa=20"', async () => {
    const m = await meta("spor", "999");

    expect(m.alternates?.canonical).toBe("/konu/spor?sayfa=20");
    expect(m.openGraph?.url).toBe("/konu/spor?sayfa=20");
  });

  it("a repeated ?sayfa= uses the first value, exactly like the page body", async () => {
    const m = await meta("ekonomi", ["3", "7"]);

    expect(m.alternates?.canonical).toBe("/konu/ekonomi?sayfa=3");
    expect(m.openGraph?.url).toBe("/konu/ekonomi?sayfa=3");
  });

  it.each(["abc", "0", "-4", "1"])(
    "?sayfa=%s falls back to page 1 (no query on the canonical or og:url)",
    async (raw) => {
      const m = await meta("dunya", raw);

      expect(m.alternates?.canonical).toBe("/konu/dunya");
      expect(m.openGraph?.url).toBe("/konu/dunya");
    },
  );

  it("politika (redirect slug) and unknown slugs get {}: the redirect/404 is the answer, not a meta tag", async () => {
    await expect(meta("politika")).resolves.toEqual({});
    await expect(meta("saglik")).resolves.toEqual({});
    await expect(meta("../admin")).resolves.toEqual({});
  });
});
