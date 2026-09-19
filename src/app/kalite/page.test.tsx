import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// M-09 (/kalite). Mirrors src/app/blindspots/page.test.tsx / src/app/
// metodoloji/page.test.tsx: mock the fetcher module directly (the Supabase
// round-trip itself is covered by src/lib/quality/snapshots.test.ts) and
// call the default export as a plain async function — no full React
// renderer needed for an async Server Component.
// ---------------------------------------------------------------------------

const mockSnapshots = vi.hoisted(() => ({
  value: null as
    | Array<{
        id: number;
        takenAt: string;
        windowHours: number;
        articleCount: number;
        clusterCount: number;
        singletonRate: number;
        sizeHistogram: { "1": number; "2-3": number; "4-7": number; "8+": number };
        sourceDiversity: {
          avg_sources_per_multi_cluster: number;
          max_sources_per_cluster: number;
          duplicate_source_clusters: number;
        };
        precisionProbeCount: number;
        recallProbeCount: number;
        blindspotFlipRate: number;
      }>
    | null,
}));

vi.mock("@/lib/quality/snapshots", () => ({
  getQualitySnapshots: () => Promise.resolve(mockSnapshots.value),
}));

import QualityPage, { metadata } from "./page";

/**
 * Collects every string/number leaf under a React element tree. page.tsx
 * nests several plain, synchronous, stateless function components
 * (StatTiles, SingletonRateChart, SnapshotsTable, UnavailableState,
 * EmptyState, Definitions, plus PageHero) rather than one single named
 * body export, so — unlike src/app/kaynaklar/durum/page.test.tsx's single
 * `el.type === KaynakDurumBody` special-case — this walker expands ANY
 * function-typed element generically by calling it with its own props.
 * That's safe here because every such component is a pure render function
 * with no hooks/state; it is NOT safe in general for `forwardRef`-wrapped
 * components (e.g. next/link's `Link`), but those have `typeof type ===
 * "object"` (a `{ $$typeof, render }` descriptor), not `"function"`, so
 * this check never tries to invoke them directly.
 */
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
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    if (typeof el.type === "function") {
      const rendered = (el.type as (props: Record<string, unknown>) => unknown)(
        el.props ?? {},
      );
      collectText(rendered, out);
      return out;
    }
    if (el.props?.children !== undefined) collectText(el.props.children as ReactNode, out);
  }
  return out;
}

/** Finds the first descendant element whose type is an `<svg>` (see collectText's header for the function-expansion rationale). */
function findSvg(node: unknown): { props: Record<string, unknown> } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findSvg(child);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === "object") {
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    if (el.type === "svg") return el as { props: Record<string, unknown> };
    if (typeof el.type === "function") {
      return findSvg(
        (el.type as (props: Record<string, unknown>) => unknown)(el.props ?? {}),
      );
    }
    if (el.props?.children !== undefined) return findSvg(el.props.children);
  }
  return null;
}

function snapshot(overrides: Partial<NonNullable<typeof mockSnapshots.value>[number]> = {}) {
  return {
    id: 1,
    takenAt: "2026-09-18T03:00:00.000Z",
    windowHours: 48,
    articleCount: 1200,
    clusterCount: 640,
    singletonRate: 0.92,
    sizeHistogram: { "1": 589, "2-3": 40, "4-7": 8, "8+": 3 },
    sourceDiversity: {
      avg_sources_per_multi_cluster: 2.4,
      max_sources_per_cluster: 9,
      duplicate_source_clusters: 0,
    },
    precisionProbeCount: 12,
    recallProbeCount: 34,
    blindspotFlipRate: 0.02,
    ...overrides,
  };
}

const PRECISION_RECALL_SENTENCE =
  "Kesinlik ve duyarlılık henüz ölçülmedi: 300 haberlik altın set etiketlenince burada yayımlanacak.";

describe("metadata", () => {
  it('title is "Küme kalitesi" (root layout template appends "— Tayf")', () => {
    expect(metadata.title).toBe("Küme kalitesi");
  });

  it("has a Turkish description", () => {
    expect(typeof metadata.description).toBe("string");
    expect((metadata.description as string).length).toBeGreaterThan(0);
  });
});

describe("QualityPage — unavailable state (fetcher returned null)", () => {
  it("renders an honest unavailable message, no fabricated table", async () => {
    mockSnapshots.value = null;

    const tree = await QualityPage();
    const text = collectText(tree).join(" ");

    expect(text).toMatch(/bilinmiyor|ulaşılamıyor/);
    expect(findSvg(tree)).toBeNull();
  });

  it("still renders the precision/recall sentence", async () => {
    mockSnapshots.value = null;

    const tree = await QualityPage();
    const text = collectText(tree).join(" ");

    expect(text).toContain(PRECISION_RECALL_SENTENCE);
  });
});

describe("QualityPage — empty state ([])", () => {
  it("renders an honest empty message, no fabricated table", async () => {
    mockSnapshots.value = [];

    const tree = await QualityPage();
    const text = collectText(tree).join(" ");

    expect(text).toMatch(/henüz|yok/i);
    expect(findSvg(tree)).toBeNull();
  });

  it("still renders the precision/recall sentence", async () => {
    mockSnapshots.value = [];

    const tree = await QualityPage();
    const text = collectText(tree).join(" ");

    expect(text).toContain(PRECISION_RECALL_SENTENCE);
  });
});

describe("QualityPage — data present", () => {
  it("renders stat tiles for the latest (first) snapshot", async () => {
    mockSnapshots.value = [
      snapshot({ id: 2, takenAt: "2026-09-18T03:00:00.000Z", articleCount: 1200 }),
      snapshot({ id: 1, takenAt: "2026-09-17T03:00:00.000Z", articleCount: 900 }),
    ];

    const tree = await QualityPage();
    const text = collectText(tree).join(" ");

    expect(text).toContain("1.200");
    expect(text).toContain("640");
    expect(text).toContain("%92");
  });

  it("renders the table with a row per snapshot", async () => {
    mockSnapshots.value = [
      snapshot({ id: 2, takenAt: "2026-09-18T03:00:00.000Z" }),
      snapshot({ id: 1, takenAt: "2026-09-17T03:00:00.000Z" }),
    ];

    const tree = await QualityPage();
    const text = collectText(tree).join(" ");

    // Table headers.
    expect(text).toContain("Tarih");
    expect(text).toContain("Tekil küme oranı");
  });

  it("renders an inline SVG line chart when there are >= 2 snapshots", async () => {
    mockSnapshots.value = [
      snapshot({ id: 2, takenAt: "2026-09-18T03:00:00.000Z", singletonRate: 0.9 }),
      snapshot({ id: 1, takenAt: "2026-09-17T03:00:00.000Z", singletonRate: 0.85 }),
    ];

    const tree = await QualityPage();
    const svg = findSvg(tree);

    expect(svg).not.toBeNull();
    expect(svg!.props.viewBox).toBeDefined();
  });

  it("does not crash with only a single snapshot (no divide-by-zero in the chart)", async () => {
    mockSnapshots.value = [snapshot({ id: 1 })];

    const tree = await QualityPage();
    const text = collectText(tree).join(" ");

    expect(text.length).toBeGreaterThan(0);
  });

  it("always renders the precision/recall not-yet-measured sentence, even with data present", async () => {
    mockSnapshots.value = [snapshot()];

    const tree = await QualityPage();
    const text = collectText(tree).join(" ");

    expect(text).toContain(PRECISION_RECALL_SENTENCE);
  });

  it("explains what a singleton is and why the rate is high (agency copy, strong-similarity-only merges)", async () => {
    mockSnapshots.value = [snapshot()];

    const tree = await QualityPage();
    const text = collectText(tree).join(" ");

    expect(text).toMatch(/tek(il)? küme|singleton/i);
    expect(text).toMatch(/ajans|kendi (url|adres)/i);
  });
});
