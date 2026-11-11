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
}));

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

vi.mock("@/lib/entities/entity-hub-query", () => ({
  getEntityHub: (...args: unknown[]) => {
    mocks.hubCalls.push(args);
    return Promise.resolve(mocks.result);
  },
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import Link from "next/link";

import { BiasSpectrum } from "@/components/story/bias-spectrum";
import { ClusterCard } from "@/components/story/cluster-card";
import { FollowButton } from "@/components/follow/follow-button";

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
