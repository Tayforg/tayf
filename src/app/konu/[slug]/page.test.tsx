import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// /konu/[slug] failed state. Harness copied from src/app/hafta/page.test.tsx:
// mock the data module (the Supabase round-trips are covered by
// src/lib/clusters/topic-query.test.ts) and call the default export as a plain
// async function -- no React renderer needed for an async Server Component.
//
// What this pins: the failed read (getTopicClusters -> null) and an empty page
// PAST the last one emit <meta name="robots" content="noindex"> (mirroring
// generateMetadata's topicPageRobots). The ok state and an empty page 1 must
// not, or a healthy hub would drop out of the index. The failure is cached for
// "minutes" (topic-query.ts), so the prerendered noindex lives about a minute.
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

  it("emits <meta name=robots content=noindex> for an empty page past the last one", async () => {
    mocks.result = { bundles: [], hasMore: false, page: 3 };

    const tree = await render(3);
    const metas = robotsMetas(tree);

    expect(metas).toHaveLength(1);
    expect(metas[0]?.content).toBe("noindex");
    const text = collectText(tree).join("");
    expect(text).toContain("Bu sayfada küme yok.");
    expect(text).not.toContain(UNAVAILABLE_COPY);
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
