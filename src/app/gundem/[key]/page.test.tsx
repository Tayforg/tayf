import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// /gundem/[key] source-mix bar (h50-biasmath-2). The bar is sumDistributions
// over the listed clusters: one source slot per outlet per story, so the same
// outlet counts once per story. The tooltips must say 'kaynak kaydı', not
// 'kaynak' (which reads as distinct outlets). The wider page-body states live in
// tests/app/gundem-routes.test.ts; getEntityHub is mocked here exactly as there.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  result: null as unknown,
  // [key, page] of every getEntityHub call (h136-roadmap-2).
  hubCalls: [] as unknown[][],
  // The daily chart's read (h154-hub-trend): what getHubTrend resolves, and its calls.
  trend: null as unknown,
  trendCalls: [] as unknown[][],
  // "trend" / "hub" in the order the page started the two reads.
  order: [] as string[],
}));

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

vi.mock("@/lib/entities/entity-hub-query", () => ({
  getEntityHub: (...args: unknown[]) => {
    mocks.order.push("hub");
    mocks.hubCalls.push(args);
    return Promise.resolve(mocks.result);
  },
}));

vi.mock("@/lib/entities/hub-trend-query", () => ({
  getHubTrend: (...args: unknown[]) => {
    mocks.order.push("trend");
    mocks.trendCalls.push(args);
    return Promise.resolve(mocks.trend);
  },
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import Link from "next/link";
import { Fragment } from "react";

import { BiasSpectrum } from "@/components/story/bias-spectrum";
import { ClusterCard } from "@/components/story/cluster-card";
import { FollowButton } from "@/components/follow/follow-button";
import { HubTrendChart } from "@/components/trends/hub-trend-chart";
import { entityByKey } from "@/lib/entities/entity-hub";

import EntityHubPage, { generateMetadata } from "./page";

type El = { type?: unknown; props?: Record<string, unknown> };

// The page's own pager components (HubPager, PastEndPager) are plain functions of
// their props, so the walk expands them in place: their <nav> and links are then
// visible to the same queries as the rest of the tree. Every other component stays
// opaque, as before.
const LOCAL_COMPONENTS = new Set(["HubPager", "PastEndPager"]);

function walk(node: unknown, visit: (el: El) => void) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (node && typeof node === "object") {
    const el = node as El;
    visit(el);
    if (typeof el.type === "function" && LOCAL_COMPONENTS.has((el.type as { name?: string }).name ?? "")) {
      walk((el.type as (props: unknown) => unknown)(el.props), visit);
    }
    if (el.props?.children !== undefined) walk(el.props.children, visit);
  }
}

function walkAll(tree: unknown): El[] {
  const out: El[] = [];
  walk(tree, (el) => out.push(el));
  return out;
}

function elementsOfType(tree: unknown, type: unknown): El[] {
  const out: El[] = [];
  walk(tree, (el) => {
    if (el.type === type) out.push(el);
  });
  return out;
}

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object") return textOf((node as El).props?.children);
  return "";
}

function spectrumSections(tree: unknown): El[] {
  const out: El[] = [];
  walk(tree, (el) => {
    if (el.type === "section" && el.props?.["aria-labelledby"] === "entity-spectrum-heading") {
      out.push(el);
    }
  });
  return out;
}

// `bundle("a")` carries one centre source; `bundle("a", undefined)` really has no distribution.
function bundle(id: string, ...rest: [dist?: unknown]) {
  const dist = rest.length > 0 ? rest[0] : { center: 1 };
  return {
    cluster: {
      id,
      title_tr: `Başlık ${id}`,
      first_published: "2026-10-30T08:00:00.000Z",
      updated_at: "2026-10-30T10:00:00.000Z",
      bias_distribution: dist,
    },
    articles: [],
    sources: [],
    isWireRedistribution: false,
    effectiveArticleCount: 2,
  };
}

type Sayfa = string | string[] | undefined;
const searchParamsOf = (sayfa?: Sayfa) => Promise.resolve(sayfa === undefined ? {} : { sayfa });

const renderHub = (key = "erdogan", sayfa?: Sayfa) =>
  EntityHubPage({ params: Promise.resolve({ key }), searchParams: searchParamsOf(sayfa) });

beforeEach(() => {
  mocks.result = null;
  mocks.hubCalls = [];
  mocks.trend = null;
  mocks.trendCalls = [];
  mocks.order = [];
});

describe("/gundem/[key] kaynak dağılımı", () => {
  it("counts the summed slots as 'kaynak kaydı' in every rendered spectrum title", async () => {
    mocks.result = {
      bundles: [
        bundle("a", { pro_government: 1, opposition: 1 }),
        bundle("b", { pro_government: 1, center: 1 }),
      ],
      total: 2,
      asOfMs: 0,
    };

    const spectra = elementsOfType(await renderHub(), BiasSpectrum);

    expect(spectra).toHaveLength(1);
    expect(spectra[0]?.props?.compact).toBe(true);
    expect(spectra[0]?.props?.countUnit).toBe("kaynak kaydı");

    const markup = renderToStaticMarkup(spectra[0] as unknown as ReactElement);
    const titles = [...markup.matchAll(/ title="([^"]*)"/g)].map((m) => m[1]);
    expect(titles).toEqual([
      "İktidar: 2 kaynak kaydı (%50)",
      "Bağımsız: 1 kaynak kaydı (%25)",
      "Muhalefet: 1 kaynak kaydı (%25)",
      "İktidar: 2 kaynak kaydı (%50)",
      "Bağımsız: 1 kaynak kaydı (%25)",
      "Muhalefet: 1 kaynak kaydı (%25)",
    ]);
    expect(markup).not.toContain(" kaynak (");
  });
});

// ---------------------------------------------------------------------------
// h61-emptystates-1. A hub whose listed clusters have only aggregator or niche
// sources sums to 0 (bias_distribution counts voting kinds only), and
// BiasSpectrum renders nothing for a zero total. The section must then say so
// instead of leaving a headed, empty region (live on /gundem/tcmb, 2026-11-07).
// /konu/[slug] already did; both pages share SPECTRUM_EMPTY_COPY.
// ---------------------------------------------------------------------------

const SPECTRUM_HEADING = "Listelenen haberlerin kaynak dağılımı";
const SPECTRUM_EMPTY_COPY = "Listelenen haberlerde dağılıma sayılan kaynak yok.";

describe("/gundem/[key] kaynak dağılımı, nothing counted", () => {
  it.each([
    ["all zero", { pro_government: 0, opposition: 0 }],
    ["an empty object", {}],
    ["null", null],
    ["missing", undefined],
    ["malformed", { opposition: -2, center: "3" }],
  ])(
    "keeps the heading, says no source was counted and draws no bar when every distribution is %s",
    async (_label, dist) => {
      mocks.result = {
        bundles: [bundle("a", dist), bundle("b", dist)],
        total: 2,
        asOfMs: 0,
      };

      const tree = await renderHub();
      const sections = spectrumSections(tree);

      expect(sections).toHaveLength(1);
      const text = textOf(sections[0]);
      expect(text).toContain(SPECTRUM_HEADING);
      expect(text).toContain(SPECTRUM_EMPTY_COPY);
      expect(elementsOfType(tree, BiasSpectrum)).toHaveLength(0);
      // The note is the section's own paragraph, in the muted note style.
      const notes = elementsOfType(sections[0], "p");
      expect(notes).toHaveLength(1);
      expect(notes[0]?.props?.className).toBe("text-xs text-muted-foreground");
      expect(textOf(notes[0])).toBe(SPECTRUM_EMPTY_COPY);
    },
  );

  it("still lists the clusters when nothing was counted", async () => {
    mocks.result = {
      bundles: [bundle("a", {}), bundle("b", { center: 0 })],
      total: 2,
      asOfMs: 0,
    };

    const tree = await renderHub();
    const cards = elementsOfType(tree, ClusterCard);

    expect(cards).toHaveLength(2);
  });

  it("draws the bar, not the note, when at least one listed cluster has a voting source", async () => {
    mocks.result = {
      bundles: [bundle("a", { pro_government: 0, opposition: 0 }), bundle("b", { opposition: 2, center: 1 })],
      total: 2,
      asOfMs: 0,
    };

    const tree = await renderHub();
    const sections = spectrumSections(tree);
    const spectra = elementsOfType(tree, BiasSpectrum);

    expect(sections).toHaveLength(1);
    expect(textOf(sections[0])).not.toContain(SPECTRUM_EMPTY_COPY);
    expect(spectra).toHaveLength(1);
    const dist = spectra[0]?.props?.distribution as Record<string, number>;
    expect(dist.opposition).toBe(2);
    expect(dist.center).toBe(1);
    expect(dist.pro_government).toBe(0);
  });

  it("shows no spectrum section at all for an empty or failed hub (unchanged)", async () => {
    mocks.result = { bundles: [], total: 0, asOfMs: 0 };
    expect(spectrumSections(await renderHub())).toHaveLength(0);

    mocks.result = null;
    expect(spectrumSections(await renderHub())).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// h128-hubs-1. One static MATCH_NOTE printed 'tam metin aramasıyla' on all 62 hubs, but a hub never searches the
// whole text: it searches the headline and the first line of the summary, and akp the headline only. The note now
// comes from hubMatchNote(entity), so it says what that hub searches.
// ---------------------------------------------------------------------------

describe("/gundem/[key] eşleşme notu", () => {
  const AKP_NOTE =
    "Eşleşme, küme başlığında geçen ada göre yapılır; adı yalnızca özette geçen haberler listelenmez. Eş adlı kişi ve kurumlar karışabilir.";
  const LEAD_NOTE =
    "Eşleşme, küme başlığında ve özetin ilk paragrafında geçen ada göre yapılır; eş adlı kişi ve kurumlar karışabilir.";

  const noteOf = async (key: string) => {
    mocks.result = { bundles: [bundle("a", { center: 1 })], total: 1, asOfMs: 0 };
    const tree = await renderHub(key);
    return elementsOfType(tree, "p")
      .filter((el) => el.props?.className === "text-xs text-muted-foreground")
      .map((el) => textOf(el))
      .filter((t) => t.startsWith("Eşleşme,"));
  };

  it("akp (headline only) says a name found only in the summary is not listed", async () => {
    expect(await noteOf("akp")).toEqual([AKP_NOTE]);
  });

  it("chp, the generic-word hubs and the person hubs say headline plus the first paragraph (first line) of the summary", async () => {
    for (const key of ["chp", "erdogan", "enflasyon", "borsa", "asgari-ucret"]) {
      expect(await noteOf(key), key).toEqual([LEAD_NOTE]);
    }
  });

  it("no hub page claims a full-text search any more", async () => {
    for (const key of ["akp", "chp", "faiz", "dolar", "tcmb"]) {
      const [note] = await noteOf(key);
      expect(note, key).toBeDefined();
      expect(note, key).not.toContain("tam metin");
    }
  });

  it("prints the note beside the count, also for an empty or failed hub (unchanged placement)", async () => {
    mocks.result = null;
    const tree = await renderHub("akp");
    const texts = elementsOfType(tree, "p").map((el) => textOf(el));
    expect(texts).toContain(AKP_NOTE);
  });
});

// ---------------------------------------------------------------------------
// h136-roadmap-3. Each hub has an RSS feed at /rss/gundem-<key>.xml: the head says
// so (alternates.types, which becomes <link rel="alternate" type="application/rss+xml">)
// and the page has a visible 'RSS' link beside the follow button, in every state.
// ---------------------------------------------------------------------------

describe("/gundem/[key] RSS feed", () => {
  const meta = (key: string) =>
    generateMetadata({ params: Promise.resolve({ key }), searchParams: searchParamsOf() });
  const rssLinks = (tree: unknown) =>
    walkAll(tree).filter((el) => el.type === "a" && el.props?.type === "application/rss+xml");

  it("generateMetadata adds the rss alternate and keeps the canonical", async () => {
    mocks.result = { bundles: [bundle("a"), bundle("b"), bundle("c")], total: 9, asOfMs: 0 };
    const m = await meta("erdogan");
    expect(m.alternates?.types).toEqual({ "application/rss+xml": "/rss/gundem-erdogan.xml" });
    expect(m.alternates?.canonical).toBe("/gundem/erdogan");
  });

  it("the alternate follows the key, also for a hyphenated key and for a thin or failed hub", async () => {
    mocks.result = null;
    const failed = await meta("ozgur-ozel");
    expect(failed.alternates?.types).toEqual({ "application/rss+xml": "/rss/gundem-ozgur-ozel.xml" });
    expect(failed.alternates?.canonical).toBe("/gundem/ozgur-ozel");
    expect(failed.robots).toEqual({ index: false, follow: true });
    mocks.result = { bundles: [bundle("a")], total: 1, asOfMs: 0 };
    expect((await meta("ysk")).alternates?.types).toEqual({ "application/rss+xml": "/rss/gundem-ysk.xml" });
  });

  it("an unknown key gets no metadata at all, so no alternate", async () => {
    await expect(meta("bilinmeyen")).resolves.toEqual({});
  });

  it("renders one visible 'RSS' plain anchor to the hub's feed, in every state", async () => {
    for (const result of [
      null,
      { bundles: [], total: 0, asOfMs: 0 },
      { bundles: [bundle("a"), bundle("b"), bundle("c")], total: 3, asOfMs: 0 },
    ]) {
      mocks.result = result;
      const links = rssLinks(await renderHub());
      expect(links).toHaveLength(1);
      expect(links[0]?.props?.href).toBe("/rss/gundem-erdogan.xml");
      expect(textOf(links[0])).toBe("RSS");
    }
  });

  it("the RSS link sits beside the follow button, in the same row, with literal classes and a 24 px target", async () => {
    mocks.result = { bundles: [bundle("a")], total: 1, asOfMs: 0 };
    const tree = await renderHub();
    const rows = walkAll(tree).filter(
      (el) =>
        el.type === "div" &&
        typeof el.props?.className === "string" &&
        (el.props.className as string).includes("justify-between"),
    );
    expect(rows).toHaveLength(1);
    const inRow = walkAll(rows[0]);
    expect(inRow.some((el) => el.type === FollowButton)).toBe(true);
    const link = inRow.find((el) => el.type === "a" && el.props?.type === "application/rss+xml");
    expect(link).toBeDefined();
    const cls = link?.props?.className as string;
    expect(typeof cls).toBe("string");
    expect(cls).toContain("min-h-8");
    expect(cls).toContain("underline");
  });
});

// ---------------------------------------------------------------------------
// h136-roadmap-2: /gundem/<key>?sayfa=N pages through every matched cluster of the
// 14-day window, 20 per page. Page 1 is exactly what it was; a later page is its own
// canonical, noindex, with a pager that mirrors /konu/[slug].
// ---------------------------------------------------------------------------

const PAGE_META = (key: string, sayfa?: Sayfa) =>
  generateMetadata({ params: Promise.resolve({ key }), searchParams: searchParamsOf(sayfa) });

const bundles = (n: number, from = 1) => Array.from({ length: n }, (_, i) => bundle(`c${from + i}`, { center: 1 }));

const navs = (tree: unknown) =>
  walkAll(tree).filter((el) => el.type === "nav" && el.props?.["aria-label"] === "Sayfalar");

const linksIn = (node: unknown) =>
  walkAll(node)
    .filter((el) => el.type === Link)
    .map((el) => ({ href: el.props?.href as string, text: textOf(el) }));

describe("/gundem/[key] ?sayfa metadata", () => {
  it("page 1 keeps today's title, canonical and robots (no ?sayfa, ?sayfa=1 and junk values)", async () => {
    mocks.result = { bundles: bundles(20), total: 152, asOfMs: 0 };
    for (const sayfa of [undefined, "1", "abc", "0", "-1", "2.5", "", ["x", "3"]] as Sayfa[]) {
      const m = await PAGE_META("chp", sayfa);
      expect(m.title, JSON.stringify(sayfa)).toBe("CHP haberleri");
      expect(m.alternates?.canonical, JSON.stringify(sayfa)).toBe("/gundem/chp");
      expect("robots" in m, JSON.stringify(sayfa)).toBe(false);
      expect((m.openGraph as { url?: string } | undefined)?.url).toBe("/gundem/chp");
    }
  });

  it("page 1 of a thin hub is still noindex,follow, from entityHubRobots", async () => {
    mocks.result = { bundles: bundles(2), total: 2, asOfMs: 0 };
    expect((await PAGE_META("ysk")).robots).toEqual({ index: false, follow: true });
  });

  it("page 2: title 'CHP — Sayfa 2', its own canonical and og:url, noindex,follow, page 1's description, the rss alternate", async () => {
    mocks.result = { bundles: bundles(20, 21), total: 152, asOfMs: 0 };
    const m = await PAGE_META("chp", "2");
    expect(m.title).toBe("CHP — Sayfa 2");
    expect(m.alternates?.canonical).toBe("/gundem/chp?sayfa=2");
    expect((m.openGraph as { url?: string } | undefined)?.url).toBe("/gundem/chp?sayfa=2");
    expect(m.robots).toEqual({ index: false, follow: true });
    expect(m.description).toBe("CHP hakkında son 14 günün haber kümeleri ve kaynak dağılımı.");
    expect(m.alternates?.types).toEqual({ "application/rss+xml": "/rss/gundem-chp.xml" });
    expect(mocks.hubCalls).toEqual([["chp", 2]]);
  });

  it("takes the first value of a repeated ?sayfa and reads that page", async () => {
    mocks.result = { bundles: bundles(20, 41), total: 152, asOfMs: 0 };
    const m = await PAGE_META("chp", ["3", "4"]);
    expect(m.alternates?.canonical).toBe("/gundem/chp?sayfa=3");
    expect(m.title).toBe("CHP — Sayfa 3");
    expect(mocks.hubCalls).toEqual([["chp", 3]]);
  });

  it("a page past the end names the page that was asked for: title and canonical are never clamped to the last page or to page 1 (h79/h98)", async () => {
    mocks.result = { bundles: [], total: 152, asOfMs: 0 };
    for (const sayfa of ["9", "52", "99999"]) {
      const m = await PAGE_META("chp", sayfa);
      expect(m.title, sayfa).toBe(`CHP — Sayfa ${sayfa}`);
      expect(m.alternates?.canonical, sayfa).toBe(`/gundem/chp?sayfa=${sayfa}`);
      expect((m.openGraph as { url?: string } | undefined)?.url, sayfa).toBe(`/gundem/chp?sayfa=${sayfa}`);
      expect(m.robots, sayfa).toEqual({ index: false, follow: true });
    }
  });

  it("a failed or unavailable later page is noindex,follow under its own canonical too", async () => {
    mocks.result = null;
    const failed = await PAGE_META("chp", "2");
    expect(failed.robots).toEqual({ index: false, follow: true });
    expect(failed.alternates?.canonical).toBe("/gundem/chp?sayfa=2");
    mocks.result = { bundles: [], total: 0, asOfMs: 0, unavailable: true };
    const unavailable = await PAGE_META("chp", "2");
    expect(unavailable.robots).toEqual({ index: false, follow: true });
    expect(unavailable.title).toBe("CHP — Sayfa 2");
  });

  it("an unknown key gets {} and reads nothing, with or without ?sayfa", async () => {
    await expect(PAGE_META("bilinmeyen", "2")).resolves.toEqual({});
    expect(mocks.hubCalls).toEqual([]);
  });
});

describe("/gundem/[key] ?sayfa body", () => {
  it("page 1 of a big hub: today's note, then a pager with Sayfa 1 / 8 and only 'Sonraki'", async () => {
    mocks.result = { bundles: bundles(20), total: 152, asOfMs: 0 };
    const tree = await renderHub("chp");
    expect(textOf(tree)).toContain("Son 14 günde 152 küme · en yeni 20 tanesi listeleniyor");
    const pager = navs(tree);
    expect(pager).toHaveLength(1);
    expect(textOf(pager[0])).toContain("Sayfa 1 / 8");
    expect(linksIn(pager[0])).toEqual([{ href: "/gundem/chp?sayfa=2", text: "Sonraki" }]);
    expect(mocks.hubCalls).toEqual([["chp", 1]]);
  });

  it("page 1 of a hub that fits one page has no pager at all (exactly as before)", async () => {
    for (const total of [3, 20]) {
      mocks.result = { bundles: bundles(Math.min(total, 20)), total, asOfMs: 0 };
      expect(navs(await renderHub("chp")), String(total)).toHaveLength(0);
    }
  });

  it("page 2: the note names 21-40, 'Önceki' goes to the bare hub URL, 'Sonraki' to page 3, the counter says Sayfa 2 / 8", async () => {
    mocks.result = { bundles: bundles(20, 21), total: 152, asOfMs: 0 };
    const tree = await renderHub("chp", "2");
    expect(textOf(tree)).toContain("Son 14 günde 152 küme · 21-40 arası listeleniyor");
    expect(textOf(tree)).not.toContain("en yeni 20 tanesi listeleniyor");
    const pager = navs(tree);
    expect(pager).toHaveLength(1);
    expect(linksIn(pager[0])).toEqual([
      { href: "/gundem/chp", text: "Önceki" },
      { href: "/gundem/chp?sayfa=3", text: "Sonraki" },
    ]);
    expect(textOf(pager[0])).toContain("Sayfa 2 / 8");
    const current = walkAll(pager[0]).filter((el) => el.props?.["aria-current"] === "page");
    expect(current).toHaveLength(1);
    expect(textOf(current[0])).toBe("Sayfa 2 / 8");
    // 20 cards, listed from index 0 of this page
    expect(elementsOfType(tree, ClusterCard)).toHaveLength(20);
  });

  it("page 3 links back to page 2 with ?sayfa=2", async () => {
    mocks.result = { bundles: bundles(20, 41), total: 152, asOfMs: 0 };
    const pager = navs(await renderHub("chp", "3"));
    expect(linksIn(pager[0])[0]).toEqual({ href: "/gundem/chp?sayfa=2", text: "Önceki" });
  });

  it("the last page has no 'Sonraki' and a short list ranges 141-152", async () => {
    mocks.result = { bundles: bundles(12, 141), total: 152, asOfMs: 0 };
    const tree = await renderHub("chp", "8");
    expect(textOf(tree)).toContain("Son 14 günde 152 küme · 141-152 arası listeleniyor");
    const pager = navs(tree);
    expect(linksIn(pager[0])).toEqual([{ href: "/gundem/chp?sayfa=7", text: "Önceki" }]);
    expect(textOf(pager[0])).toContain("Sayfa 8 / 8");
  });

  it("the pager stops at 51 pages however large the total", async () => {
    mocks.result = { bundles: bundles(20, 1001), total: 5000, asOfMs: 0 };
    const pager = navs(await renderHub("erdogan", "51"));
    expect(textOf(pager[0])).toContain("Sayfa 51 / 51");
    expect(linksIn(pager[0]).map((l) => l.text)).toEqual(["Önceki"]);
  });

  it("the pager uses /konu's literal classes and the site's 44 px phone floor", async () => {
    mocks.result = { bundles: bundles(20, 21), total: 152, asOfMs: 0 };
    const pager = navs(await renderHub("chp", "2"))[0]!;
    expect(pager.props?.className).toBe("flex items-center justify-between gap-3 pt-2 text-sm");
    const link = walkAll(pager).find((el) => el.type === Link)!;
    expect(link.props?.className).toBe(
      "inline-flex max-sm:min-h-11 items-center touch-manipulation font-medium text-foreground underline decoration-dotted underline-offset-2 hover:text-primary",
    );
  });

  it("past the last page: an empty-state line naming where the list ends, a link to page 1 and one to the last page, no next link", async () => {
    mocks.result = { bundles: [], total: 152, asOfMs: 0 };
    const tree = await renderHub("chp", "9");
    const text = textOf(tree);
    expect(text).toContain("Bu sayfada küme yok. Liste 8. sayfada bitiyor.");
    expect(text).not.toContain("Son 14 günde bu konuda küme yok.");
    expect(text).not.toContain("Listelenen haberlerin kaynak dağılımı");
    expect(elementsOfType(tree, ClusterCard)).toHaveLength(0);
    const pager = navs(tree);
    expect(pager).toHaveLength(1);
    expect(linksIn(pager[0])).toEqual([
      { href: "/gundem/chp", text: "İlk sayfaya dön" },
      { href: "/gundem/chp?sayfa=8", text: "Son sayfaya git" },
    ]);
    expect(textOf(pager[0])).not.toContain("Sonraki");
  });

  it("past the end of a one-page hub: only the link to page 1; a huge page number still says so", async () => {
    mocks.result = { bundles: [], total: 15, asOfMs: 0 };
    const pager = navs(await renderHub("chp", "3"));
    expect(linksIn(pager[0])).toEqual([{ href: "/gundem/chp", text: "İlk sayfaya dön" }]);
    mocks.result = { bundles: [], total: 700, asOfMs: 0 };
    const far = navs(await renderHub("erdogan", "99999"));
    expect(linksIn(far[0])).toEqual([
      { href: "/gundem/erdogan", text: "İlk sayfaya dön" },
      { href: "/gundem/erdogan?sayfa=35", text: "Son sayfaya git" },
    ]);
  });

  it("past the end of a hub with no matches at all: says the page is empty and links to page 1", async () => {
    mocks.result = { bundles: [], total: 0, asOfMs: 0 };
    const tree = await renderHub("ysk", "2");
    expect(textOf(tree)).toContain("Bu sayfada küme yok.");
    expect(linksIn(navs(tree)[0])).toEqual([{ href: "/gundem/ysk", text: "İlk sayfaya dön" }]);
  });

  it("v4 missing (unavailable page): the honest line and a link to page 1, no pager, no list, no spectrum", async () => {
    mocks.result = { bundles: [], total: 0, asOfMs: 0, unavailable: true };
    const tree = await renderHub("chp", "2");
    const text = textOf(tree);
    expect(text).toContain("Bu sayfa şu an gösterilemiyor");
    expect(text).not.toContain("Bu sayfada küme yok");
    expect(text).not.toContain("Birkaç dakika içinde tekrar deneyin");
    expect(text).not.toContain("Listelenen haberlerin kaynak dağılımı");
    expect(elementsOfType(tree, ClusterCard)).toHaveLength(0);
    expect(navs(tree)).toHaveLength(0);
    const toFirst = walkAll(tree).filter((el) => el.type === Link && el.props?.href === "/gundem/chp");
    expect(toFirst.length).toBeGreaterThanOrEqual(1);
    expect(toFirst.map((l) => textOf(l))).toContain("İlk sayfaya dön");
    // the body carries no robots meta: generateMetadata already sends noindex,follow for the page
    expect(robotsMetasOf(tree)).toHaveLength(0);
  });

  it("a failed read on a later page is the generic unavailable state with the body noindex meta (as on page 1)", async () => {
    mocks.result = null;
    const tree = await renderHub("chp", "2");
    expect(textOf(tree)).toContain("Bu sayfa şu anda yüklenemiyor. Birkaç dakika içinde tekrar deneyin.");
    expect(robotsMetasOf(tree)).toHaveLength(1);
    expect(navs(tree)).toHaveLength(0);
  });

  it("emits no CollectionPage JSON-LD on a later page (it is noindex), and still does on an indexable page 1", async () => {
    mocks.result = { bundles: bundles(20, 21), total: 152, asOfMs: 0 };
    const ldOf = (tree: unknown) =>
      walkAll(tree).filter((el) => el.type === "script" && el.props?.type === "application/ld+json");
    expect(ldOf(await renderHub("chp", "2"))).toHaveLength(0);
    mocks.result = { bundles: bundles(20), total: 152, asOfMs: 0 };
    expect(ldOf(await renderHub("chp"))).toHaveLength(1);
  });

  it("keeps the RSS link, the follow button and the hub match note on a later page", async () => {
    mocks.result = { bundles: bundles(20, 21), total: 152, asOfMs: 0 };
    const tree = await renderHub("akp", "2");
    expect(elementsOfType(tree, FollowButton)).toHaveLength(1);
    expect(walkAll(tree).filter((el) => el.type === "a" && el.props?.type === "application/rss+xml")).toHaveLength(1);
    expect(textOf(tree)).toContain("küme başlığında geçen ada göre");
  });

  it("an unknown key still 404s, with a ?sayfa too", async () => {
    await expect(renderHub("bilinmeyen", "2")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.hubCalls).toEqual([]);
  });

  it("junk or repeated-junk ?sayfa values render page 1 and read page 1", async () => {
    mocks.result = { bundles: bundles(20), total: 152, asOfMs: 0 };
    for (const sayfa of ["abc", "0", "-3", "1.5", ["x", "4"]] as Sayfa[]) {
      mocks.hubCalls = [];
      const tree = await renderHub("chp", sayfa);
      expect(textOf(tree), JSON.stringify(sayfa)).toContain("en yeni 20 tanesi listeleniyor");
      expect(mocks.hubCalls).toEqual([["chp", 1]]);
    }
  });
});

function robotsMetasOf(tree: unknown) {
  return walkAll(tree).filter((el) => el.type === "meta" && el.props?.name === "robots");
}

// ---------------------------------------------------------------------------
// h154-hub-trend. Page 1 of a hub that lists clusters draws a daily bar chart of THIS hub's clusters (migration 206's
// entity_cluster_days through getHubTrend), directly under the "Son 14 günde N küme" header block and before the
// spectrum section. Page 1 only; a failed, unavailable, empty or past-the-end state never draws it; generateMetadata
// never reads it.
// ---------------------------------------------------------------------------

const TREND_DAYS = [
  "2026-10-30",
  "2026-10-31",
  "2026-11-01",
  "2026-11-02",
  "2026-11-03",
  "2026-11-04",
  "2026-11-05",
  "2026-11-06",
  "2026-11-07",
  "2026-11-08",
  "2026-11-09",
  "2026-11-10",
  "2026-11-11",
  "2026-11-12",
];
const TREND_COUNTS = [6, 4, 5, 7, 11, 9, 9, 8, 12, 7, 5, 2, 4, 3];

function okTrend(earlier = 5) {
  return {
    status: "ok" as const,
    days: TREND_DAYS.map((day, i) => ({ day, clusters: TREND_COUNTS[i] })),
    earlier,
  };
}

const charts = (tree: unknown) => elementsOfType(tree, HubTrendChart);

describe("/gundem/[key] günlük küme grafiği", () => {
  it("page 1 with clusters reads getHubTrend(key) once and renders HubTrendChart with label, days and earlier before the spectrum section", async () => {
    mocks.result = { bundles: bundles(20), total: 97, asOfMs: 0 };
    mocks.trend = okTrend(5);

    const tree = await renderHub("ozgur-ozel");

    expect(mocks.trendCalls).toEqual([["ozgur-ozel"]]);
    expect(mocks.hubCalls).toEqual([["ozgur-ozel", 1]]);
    const found = charts(tree);
    expect(found).toHaveLength(1);
    expect(found[0]?.props).toEqual({
      label: entityByKey("ozgur-ozel")!.label,
      days: okTrend(5).days,
      earlier: 5,
    });

    // before the spectrum section, and the FIRST child of the fragment that holds the list
    const all = walkAll(tree);
    const spectrum = spectrumSections(tree);
    expect(spectrum).toHaveLength(1);
    expect(all.indexOf(found[0] as El)).toBeGreaterThan(-1);
    expect(all.indexOf(found[0] as El)).toBeLessThan(all.indexOf(spectrum[0] as El));
    const fragment = all.find(
      (el) => el.type === Fragment && Array.isArray(el.props?.children) && (el.props.children as unknown[]).includes(found[0]),
    ) as El;
    expect(fragment).toBeDefined();
    const children = fragment.props?.children as El[];
    expect(children[0]).toBe(found[0]);
    expect(children[1]).toBe(spectrum[0]);

    // and below the header block: the count note comes first in document order
    const note = all.findIndex((el) => el.type === "p" && textOf(el).startsWith("Son 14 günde 97 küme"));
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(all.indexOf(found[0] as El));
    // the list and the pager keep their place after the spectrum
    expect(elementsOfType(tree, ClusterCard)).toHaveLength(20);
  });

  it("reads the trend for every hub key it renders, one call per render", async () => {
    mocks.result = { bundles: bundles(3), total: 3, asOfMs: 0 };
    mocks.trend = okTrend(0);
    for (const key of ["akp", "chp", "tcmb"]) {
      mocks.trendCalls = [];
      await renderHub(key);
      expect(mocks.trendCalls, key).toEqual([[key]]);
    }
  });

  it("page 2 never calls getHubTrend and renders no chart", async () => {
    mocks.result = { bundles: bundles(20, 21), total: 152, asOfMs: 0 };
    mocks.trend = okTrend();
    for (const sayfa of ["2", "3", "51", "99999", ["2", "x"]] as Sayfa[]) {
      const tree = await renderHub("chp", sayfa);
      expect(charts(tree), JSON.stringify(sayfa)).toHaveLength(0);
    }
    expect(mocks.trendCalls).toEqual([]);
  });

  it("junk ?sayfa values are page 1 and do read the trend", async () => {
    mocks.result = { bundles: bundles(20), total: 152, asOfMs: 0 };
    mocks.trend = okTrend();
    for (const sayfa of ["abc", "0", "1", ["x", "4"]] as Sayfa[]) {
      mocks.trendCalls = [];
      const tree = await renderHub("chp", sayfa);
      expect(charts(tree), JSON.stringify(sayfa)).toHaveLength(1);
      expect(mocks.trendCalls, JSON.stringify(sayfa)).toEqual([["chp"]]);
    }
  });

  it("a null or unavailable trend renders no chart and the rest of the page is unchanged", async () => {
    mocks.result = { bundles: bundles(20), total: 152, asOfMs: 0 };

    mocks.trend = null;
    const none = await renderHub("chp");
    mocks.trend = { status: "unavailable" };
    const unavailable = await renderHub("chp");
    mocks.trend = okTrend();
    const withChart = await renderHub("chp");

    expect(charts(none)).toHaveLength(0);
    expect(charts(unavailable)).toHaveLength(0);
    expect(charts(withChart)).toHaveLength(1);

    // the same elements and the same text everywhere else
    const shape = (tree: unknown) => walkAll(tree).filter((el) => el.type !== HubTrendChart).length;
    expect(shape(unavailable)).toBe(shape(none));
    expect(shape(withChart)).toBe(shape(none));
    expect(textOf(unavailable)).toBe(textOf(none));
    expect(textOf(withChart)).toBe(textOf(none));
    expect(textOf(none)).toContain("Son 14 günde 152 küme · en yeni 20 tanesi listeleniyor");
    expect(elementsOfType(none, ClusterCard)).toHaveLength(20);
    expect(spectrumSections(none)).toHaveLength(1);
    expect(navs(none)).toHaveLength(1);
    // the without-chart fragment starts at the spectrum section
    const fragment = walkAll(none).find(
      (el) => el.type === Fragment && Array.isArray(el.props?.children) && (el.props.children as El[]).some((c) => c === spectrumSections(none)[0]),
    ) as El;
    expect((fragment.props?.children as unknown[])[0]).toBeNull();
    expect(((fragment.props?.children as unknown[])[1] as El).props?.["aria-labelledby"]).toBe("entity-spectrum-heading");
  });

  it("the failed, unavailable-page, empty and past-the-end states render no chart even with an ok trend", async () => {
    mocks.trend = okTrend();

    mocks.result = null;
    expect(charts(await renderHub("chp")), "failed read").toHaveLength(0);

    mocks.result = { bundles: [], total: 0, asOfMs: 0 };
    expect(charts(await renderHub("chp")), "empty hub").toHaveLength(0);

    mocks.result = { bundles: [], total: 0, asOfMs: 0, unavailable: true };
    expect(charts(await renderHub("chp")), "unavailable (page 1 shape)").toHaveLength(0);
    expect(charts(await renderHub("chp", "2")), "unavailable page 2").toHaveLength(0);

    mocks.result = { bundles: [], total: 152, asOfMs: 0 };
    expect(charts(await renderHub("chp", "9")), "past the end").toHaveLength(0);
    expect(charts(await renderHub("chp", "99999")), "far past the end").toHaveLength(0);
  });

  it("an unknown key still 404s and reads no trend", async () => {
    mocks.trend = okTrend();
    await expect(renderHub("bilinmeyen")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.trendCalls).toEqual([]);
  });

  it("generateMetadata does not call getHubTrend", async () => {
    mocks.result = { bundles: bundles(20), total: 152, asOfMs: 0 };
    mocks.trend = okTrend();
    await PAGE_META("chp");
    await PAGE_META("chp", "2");
    await PAGE_META("akp", ["3", "4"]);
    await PAGE_META("bilinmeyen");
    mocks.result = null;
    await PAGE_META("ysk");
    expect(mocks.trendCalls).toEqual([]);
    // the metadata read is the hub's alone
    expect(mocks.hubCalls.length).toBeGreaterThan(0);
  });

  it("the page starts the trend read before the hub read on page 1 only, so both run in parallel", async () => {
    mocks.result = { bundles: bundles(3), total: 3, asOfMs: 0 };
    mocks.trend = okTrend();

    const tree = await renderHub("tcmb");
    expect(mocks.order).toEqual(["trend", "hub"]);
    expect(charts(tree)).toHaveLength(1);

    mocks.order = [];
    await renderHub("tcmb", "2");
    expect(mocks.order).toEqual(["hub"]);
  });
});

// ---------------------------------------------------------------------------
// h159-perf-3. With the FULL chart drawn above the list (hubTrendState === "chart", at least 3 clusters in the window),
// the first card sits below the fold (y=898 of 915 on a phone), so no card may ask for the eager, preloaded,
// fetchpriority=high banner: every ClusterCard gets no `index`. Only the full chart pushes card 0 below the fold: the
// sparse state draws a heading and one or two text lines (about 170-210 px shorter), and 0 clusters over 0 earlier
// renders nothing, so there card 0 is back above the fold and keeps its position, like without a chart (page 2+, or a
// trend that is null or unavailable).
// ---------------------------------------------------------------------------
describe("/gundem/[key] first-card banner priority (h159-perf-3)", () => {
  const cardIndexes = (tree: unknown) => elementsOfType(tree, ClusterCard).map((el) => el.props?.index);

  it("page 1 with the chart: no card carries an index, so card 0 is not the LCP candidate", async () => {
    mocks.result = { bundles: bundles(20), total: 97, asOfMs: 0 };
    mocks.trend = okTrend();

    const tree = await renderHub("erdogan");

    expect(charts(tree)).toHaveLength(1);
    const indexes = cardIndexes(tree);
    expect(indexes).toHaveLength(20);
    expect(indexes.every((i) => i === undefined)).toBe(true);
  });

  it("page 1 without a drawn chart (null or unavailable trend): the cards keep their positions, card 0 is the candidate", async () => {
    mocks.result = { bundles: bundles(3), total: 3, asOfMs: 0 };

    mocks.trend = null;
    expect(cardIndexes(await renderHub("erdogan"))).toEqual([0, 1, 2]);
    mocks.trend = { status: "unavailable" };
    expect(cardIndexes(await renderHub("erdogan"))).toEqual([0, 1, 2]);
  });

  it("page 1 with a sparse or empty chart (under 3 clusters in the window): card 0 is above the fold again and keeps index 0", async () => {
    mocks.result = { bundles: bundles(3), total: 3, asOfMs: 0 };
    const zeros = TREND_DAYS.map((day) => ({ day, clusters: 0 }));
    const twoClusters = TREND_DAYS.map((day, i) => ({ day, clusters: i === 5 || i === 9 ? 1 : 0 }));

    // (a) sparse: two clusters in the window, none earlier. The chart component is still drawn (a heading and a note).
    mocks.trend = { status: "ok" as const, days: twoClusters, earlier: 0 };
    let tree = await renderHub("tcmb");
    expect(charts(tree)).toHaveLength(1);
    expect(cardIndexes(tree)).toEqual([0, 1, 2]);

    // (b) 0 in the window and 0 earlier: HubTrendChart renders null.
    mocks.trend = { status: "ok" as const, days: zeros, earlier: 0 };
    tree = await renderHub("tcmb");
    expect(cardIndexes(tree)).toEqual([0, 1, 2]);

    // (c) sparse, with clusters only earlier than the window.
    mocks.trend = { status: "ok" as const, days: zeros, earlier: 5 };
    tree = await renderHub("tcmb");
    expect(cardIndexes(tree)).toEqual([0, 1, 2]);
  });

  it("page 1 at the boundary: 3 clusters in the window is the full chart (no index), 2 is sparse (positions)", async () => {
    mocks.result = { bundles: bundles(3), total: 3, asOfMs: 0 };
    const withTotal = (total: number) =>
      TREND_DAYS.map((day, i) => ({ day, clusters: i === 13 ? total : 0 }));

    mocks.trend = { status: "ok" as const, days: withTotal(3), earlier: 0 };
    expect(cardIndexes(await renderHub("tcmb"))).toEqual([undefined, undefined, undefined]);

    mocks.trend = { status: "ok" as const, days: withTotal(2), earlier: 0 };
    expect(cardIndexes(await renderHub("tcmb"))).toEqual([0, 1, 2]);
  });

  it("page 2 never draws the chart, so its cards keep their positions", async () => {
    mocks.result = { bundles: bundles(20, 21), total: 97, asOfMs: 0 };
    mocks.trend = okTrend();

    const tree = await renderHub("erdogan", "2");

    expect(charts(tree)).toHaveLength(0);
    expect(cardIndexes(tree)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
});
