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
