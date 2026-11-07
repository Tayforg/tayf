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
}));

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

vi.mock("@/lib/entities/entity-hub-query", () => ({
  getEntityHub: () => Promise.resolve(mocks.result),
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { BiasSpectrum } from "@/components/story/bias-spectrum";
import { ClusterCard } from "@/components/story/cluster-card";

import EntityHubPage from "./page";

type El = { type?: unknown; props?: Record<string, unknown> };

function walk(node: unknown, visit: (el: El) => void) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (node && typeof node === "object") {
    const el = node as El;
    visit(el);
    if (el.props?.children !== undefined) walk(el.props.children, visit);
  }
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

function bundle(id: string, dist: unknown) {
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

const renderHub = () => EntityHubPage({ params: Promise.resolve({ key: "erdogan" }) });

beforeEach(() => {
  mocks.result = null;
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
