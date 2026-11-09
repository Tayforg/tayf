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

import { formatTurkishDate } from "@/lib/time";

import QualityPage, { chartX, metadata } from "./page";

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

/** Every descendant element whose className holds `needle` (function components are expanded, see collectText). */
function findByClass(node: unknown, needle: string, out: Array<{ props: Record<string, unknown> }> = []) {
  if (Array.isArray(node)) {
    for (const child of node) findByClass(child, needle, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    if (typeof el.type === "function") {
      return findByClass(
        (el.type as (props: Record<string, unknown>) => unknown)(el.props ?? {}),
        needle,
        out,
      );
    }
    if (typeof el.props?.className === "string" && el.props.className.includes(needle)) {
      out.push(el as { props: Record<string, unknown> });
    }
    if (el.props?.children !== undefined) findByClass(el.props.children, needle, out);
  }
  return out;
}

type El = { type?: unknown; props: Record<string, unknown> };

/**
 * Every element of the tree (function components expanded, see collectText)
 * with the element that directly contains it, in document order.
 */
function allElements(
  node: unknown,
  parent: El | null = null,
  out: Array<{ el: El; parent: El | null }> = [],
): Array<{ el: El; parent: El | null }> {
  if (Array.isArray(node)) {
    for (const child of node) allElements(child, parent, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    if (typeof el.type === "function") {
      return allElements(
        (el.type as (props: Record<string, unknown>) => unknown)(el.props ?? {}),
        parent,
        out,
      );
    }
    if (el.props) {
      const self = el as El;
      out.push({ el: self, parent });
      if (el.props.children !== undefined) allElements(el.props.children, self, out);
    }
  }
  return out;
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

// h90-kalite-1: labels for cluster pairs do not exist yet (jev_gold_labels is
// empty and holds article-level labels, not pairs), so the sentence says that
// instead of promising a "300 haberlik altın set".
const PRECISION_RECALL_SENTENCE =
  "Kesinlik ve duyarlılık henüz ölçülmedi: bunun için elle etiketlenmiş bir küme çifti seti gerekiyor ve bu set henüz yok.";

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

  it("keeps the table wrapper as the one keyboard-reachable named scroll region with a visible focus ring (WCAG 2.1.1)", async () => {
    mockSnapshots.value = [
      snapshot({ id: 2, takenAt: "2026-09-18T03:00:00.000Z", singletonRate: 0.9 }),
      snapshot({ id: 1, takenAt: "2026-09-17T03:00:00.000Z", singletonRate: 0.85 }),
    ];

    const tree = await QualityPage();
    const scrollers = findByClass(tree, "overflow-x-auto");

    // Only the table scrolls on a 390 px phone; the chart is fluid (h25-visual-2).
    expect(scrollers).toHaveLength(1);
    const [table] = scrollers;
    expect(table!.props.tabIndex).toBe(0);
    expect(table!.props.role).toBe("region");
    expect(String(table!.props.className)).toContain("focus-visible:ring-2");
    expect(String(table!.props.className)).toContain("focus-visible:ring-ring");
    expect(table!.props["aria-labelledby"]).toBe("kalite-tablo");
  });

  describe("the singleton-rate chart is fluid, with HTML labels (h25-visual-2)", () => {
    const rows = () => [
      snapshot({ id: 2, takenAt: "2026-09-18T03:00:00.000Z", singletonRate: 0.9 }),
      snapshot({ id: 1, takenAt: "2026-09-17T03:00:00.000Z", singletonRate: 0.85 }),
    ];

    it("gives the svg no minimum width, so it never scrolls or clips the end date", async () => {
      mockSnapshots.value = rows();

      const svg = findSvg(await QualityPage());

      expect(svg).not.toBeNull();
      const cls = String(svg!.props.className);
      expect(cls).not.toContain("min-w-[");
      expect(cls).toContain("w-full");
    });

    it("leaves the chart wrapper a plain box: not a scroller, not focusable, not a region", async () => {
      mockSnapshots.value = rows();

      const els = allElements(await QualityPage());
      const svgEntry = els.find((e) => e.el.type === "svg");
      expect(svgEntry).toBeDefined();
      const wrapper = svgEntry!.parent!;

      expect(wrapper.props.tabIndex).toBeUndefined();
      expect(wrapper.props.role).toBeUndefined();
      expect(wrapper.props["aria-label"]).toBeUndefined();
      expect(String(wrapper.props.className)).not.toContain("overflow");
    });

    it("keeps role=img on the svg and names the date range as well as the rates", async () => {
      mockSnapshots.value = rows();

      const svg = findSvg(await QualityPage());
      const first = formatTurkishDate("2026-09-17T03:00:00.000Z");
      const last = formatTurkishDate("2026-09-18T03:00:00.000Z");

      expect(svg!.props.role).toBe("img");
      const label = String(svg!.props["aria-label"]);
      expect(label).toContain(`${first}–${last}`);
      expect(label).toContain("%85");
      expect(label).toContain("%90");
      expect(label).toContain("Son 2 ölçümde");
    });

    it("draws no SVG <text>: the svg holds only gridlines and the polyline", async () => {
      mockSnapshots.value = rows();

      const els = allElements(await QualityPage());
      const svgEntry = els.find((e) => e.el.type === "svg");
      const inside = els.filter(({ el }) => el !== svgEntry!.el).map(({ el }) => el.type);
      expect(inside).not.toContain("text");
      expect(els.some(({ el }) => el.props.fontSize !== undefined)).toBe(false);
    });

    it("renders the four labels as aria-hidden HTML spans: %max, %min, first date, last date", async () => {
      mockSnapshots.value = rows();

      const labels = allElements(await QualityPage()).filter(
        ({ el }) => el.props["data-chart-label"] !== undefined,
      );
      expect(labels).toHaveLength(4);
      for (const { el } of labels) {
        expect(el.type).toBe("span");
        expect(el.props["aria-hidden"]).toBe("true");
        expect(String(el.props.className)).toContain("text-[11px]");
      }
      const texts = labels.map(({ el }) => collectText(el.props.children).join(""));
      expect(texts).toEqual([
        "%90",
        "%85",
        formatTurkishDate("2026-09-17T03:00:00.000Z"),
        formatTurkishDate("2026-09-18T03:00:00.000Z"),
      ]);
    });

    it("places the %max label at the top gridline and the %min label at the bottom one", async () => {
      mockSnapshots.value = rows();

      const labels = allElements(await QualityPage()).filter(
        ({ el }) => el.props["data-chart-label"] !== undefined,
      );
      const top = (i: number) => parseFloat(String((labels[i]!.el.props.style as { top?: string }).top));
      expect(top(0)).toBeGreaterThan(0);
      expect(top(0)).toBeLessThan(top(1));
      expect(top(1)).toBeLessThan(100);
    });

    it("renders no chart labels when there is a single snapshot", async () => {
      mockSnapshots.value = [snapshot({ id: 1 })];

      const labels = allElements(await QualityPage()).filter(
        ({ el }) => el.props["data-chart-label"] !== undefined,
      );
      expect(labels).toHaveLength(0);
    });

    it("keeps a flat series (min == max) readable: both rates equal, no NaN geometry", async () => {
      mockSnapshots.value = [
        snapshot({ id: 2, takenAt: "2026-09-18T03:00:00.000Z", singletonRate: 0.9 }),
        snapshot({ id: 1, takenAt: "2026-09-17T03:00:00.000Z", singletonRate: 0.9 }),
      ];

      const tree = await QualityPage();
      const svg = findSvg(tree);
      const poly = allElements(tree).find(({ el }) => el.type === "polyline");
      expect(String(poly!.el.props.points).includes("NaN")).toBe(false);
      expect(svg!.props.role).toBe("img");
    });
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

  it("explains what a singleton is and why the rate is high (aggregator republishing, stories no other source wrote)", async () => {
    mockSnapshots.value = [snapshot()];

    const tree = await QualityPage();
    const text = collectText(tree).join(" ");

    expect(text).toMatch(/tek(il)? küme|singleton/i);
    expect(text).toMatch(/toplayıcı/i);
  });
});

// ---------------------------------------------------------------------------
// h41-derived-1: the page must state its basis (politics only) and its timing
// (a daily job that GitHub runs late, so the hour varies and days can be
// missing) truthfully, and the chart must not hide missing days.
// ---------------------------------------------------------------------------

const FORBIDDEN_TIMING_COPY = ["03:00 UTC", "aynı gece", "her gece", "gecelik"];

function expectNoNightlyClaims(text: string) {
  for (const phrase of FORBIDDEN_TIMING_COPY) {
    expect(text).not.toContain(phrase);
  }
  expect(text).not.toMatch(/son\s+\d+\s+gece/i);
  // No remaining "gece" wording of any kind: the job is daily, not nightly.
  expect(text).not.toMatch(/gece/i);
}

describe("timing copy: a daily job whose hour varies, not a fixed 03:00 nightly run", () => {
  it("metadata says günde bir kez and no nightly claim", () => {
    const description = metadata.description as string;
    expect(description).toContain("günde bir kez");
    expect(description).not.toContain("her gece");
    expect(description).not.toMatch(/gece/i);
  });

  it("states the cadence as günde bir kez and warns the hour varies and days can be missing (data present)", async () => {
    mockSnapshots.value = [
      snapshot({ id: 2, takenAt: "2026-09-18T08:12:00.000Z" }),
      snapshot({ id: 1, takenAt: "2026-09-17T09:40:00.000Z" }),
    ];

    const text = collectText(await QualityPage()).join(" ");

    expect(text).toContain("günde bir kez");
    expect(text).toContain("GitHub zamanlanmış işleri geciktirebildiği için ölçüm saati değişir");
    expect(text).toContain("bazı günler ölçüm alınamayabilir");
    expect(text).toContain("Aşağıda son 30 ölçüm gösterilir.");
    expectNoNightlyClaims(text);
  });

  it("makes no nightly claim in the unavailable state", async () => {
    mockSnapshots.value = null;

    const text = collectText(await QualityPage()).join(" ");

    expect(text).toContain("günde bir kez");
    expectNoNightlyClaims(text);
  });

  it("makes no nightly claim in the empty state and drops the fixed hour", async () => {
    mockSnapshots.value = [];

    const text = collectText(await QualityPage()).join(" ");

    expect(text).toContain("günde bir kez");
    expect(text).toContain("Henüz hiç denetim ölçümü kaydedilmedi");
    expectNoNightlyClaims(text);
  });

  it("says 'en az iki ölçüm' (not gece) when there is a single snapshot", async () => {
    mockSnapshots.value = [snapshot({ id: 1 })];

    const text = collectText(await QualityPage()).join(" ");

    expect(text).toContain("en az iki ölçüm");
    expectNoNightlyClaims(text);
  });

  it("names the chart 'son {n} ölçüm' and its aria-label 'Son {n} ölçümde'", async () => {
    mockSnapshots.value = [
      snapshot({ id: 3, takenAt: "2026-09-19T08:00:00.000Z" }),
      snapshot({ id: 2, takenAt: "2026-09-18T08:00:00.000Z" }),
      snapshot({ id: 1, takenAt: "2026-09-17T08:00:00.000Z" }),
    ];

    const tree = await QualityPage();
    const text = collectText(tree).join(" ");
    const label = String(findSvg(tree)!.props["aria-label"]);

    expect(text).toContain("Tekil küme oranı — son 3 ölçüm");
    expect(label).toContain("Son 3 ölçümde");
    expect(label).not.toMatch(/gece/i);
  });

  it("titles the screen-reader table 'Günlük kalite ölçümleri'", async () => {
    mockSnapshots.value = [snapshot()];

    const text = collectText(await QualityPage()).join(" ");

    expect(text).toContain("Günlük kalite ölçümleri");
    expect(text).not.toContain("Gece gece");
  });

  it("shows each row's actual measurement time (Istanbul), not only its date", async () => {
    mockSnapshots.value = [
      snapshot({ id: 2, takenAt: "2026-11-05T10:26:54.000Z" }),
      snapshot({ id: 1, takenAt: "2026-11-04T07:35:10.000Z" }),
    ];

    const tree = await QualityPage();
    const cells = allElements(tree)
      .filter(({ el }) => el.type === "td")
      .map(({ el }) => collectText(el.props.children).join(""));

    // 10:26Z = 13:26 and 07:35Z = 10:35 in Istanbul (UTC+3).
    expect(cells.some((c) => c.includes("13:26"))).toBe(true);
    expect(cells.some((c) => c.includes("10:35"))).toBe(true);
    expect(collectText(tree).join(" ")).toContain("İstanbul saati");
  });
});

describe("scope copy: counts are politics-only", () => {
  it("labels the stat tiles 'Siyaset haberi (48 saat)' and 'Küme sayısı (tek haberliler dahil)'", async () => {
    mockSnapshots.value = [snapshot()];

    const text = collectText(await QualityPage()).join(" ");

    expect(text).toContain("Siyaset haberi (48 saat)");
    expect(text).toContain("Küme sayısı (tek haberliler dahil)");
    expect(text).not.toContain("Haber sayısı");
  });

  it("defines a 'Kapsam' term that says politika ve son dakika", async () => {
    mockSnapshots.value = [snapshot()];

    const els = allElements(await QualityPage());
    const dt = els.find(
      ({ el }) => el.type === "dt" && collectText(el.props.children).join("") === "Kapsam",
    );

    expect(dt).toBeDefined();
    const box = collectText(dt!.parent!.props.children).join(" ");
    expect(box).toContain("politika ve son dakika");
    expect(box).toContain("tek haberli kümeler de dahildir");
  });

  it("defines Kapsam even when there is no data", async () => {
    mockSnapshots.value = null;

    const text = collectText(await QualityPage()).join(" ");

    expect(text).toContain("Kapsam");
    expect(text).toContain("politika ve son dakika");
  });
});

describe("chartX: points sit at their Istanbul calendar-day offset, not at their index", () => {
  const LEFT = 4;
  const WIDTH = 632;

  it("puts the first snapshot at the left edge and the last at the right edge", () => {
    const first = "2026-10-12T08:00:00.000Z";
    const last = "2026-10-15T09:00:00.000Z";

    expect(chartX(first, first, last, LEFT, WIDTH)).toBeCloseTo(LEFT, 6);
    expect(chartX(last, first, last, LEFT, WIDTH)).toBeCloseTo(LEFT + WIDTH, 6);
  });

  it("puts the middle of 10-12, 10-13, 10-15 at one third of the plot width, not one half", () => {
    const first = "2026-10-12T08:00:00.000Z";
    const mid = "2026-10-13T09:30:00.000Z";
    const last = "2026-10-15T10:38:00.000Z";

    expect(chartX(mid, first, last, LEFT, WIDTH)).toBeCloseTo(LEFT + WIDTH / 3, 6);
  });

  it("counts the Istanbul day, not the UTC day (21:30Z is already the next day in Istanbul)", () => {
    const first = "2026-10-12T08:00:00.000Z"; // 10-12 in Istanbul
    const mid = "2026-10-12T21:30:00.000Z"; // 10-13 00:30 in Istanbul
    const last = "2026-10-14T08:00:00.000Z"; // 10-14 in Istanbul

    expect(chartX(mid, first, last, LEFT, WIDTH)).toBeCloseTo(LEFT + WIDTH / 2, 6);
  });

  it("with two snapshots the points sit at both ends", () => {
    const first = "2026-10-12T08:00:00.000Z";
    const last = "2026-10-13T08:30:00.000Z";

    expect(chartX(first, first, last, LEFT, WIDTH)).toBe(LEFT);
    expect(chartX(last, first, last, LEFT, WIDTH)).toBe(LEFT + WIDTH);
  });

  it("two snapshots on the same Istanbul day still sit at both ends, with no NaN", () => {
    const first = "2026-10-12T08:00:00.000Z";
    const last = "2026-10-12T10:00:00.000Z";
    const middle = "2026-10-12T09:00:00.000Z";

    expect(chartX(first, first, last, LEFT, WIDTH)).toBe(LEFT);
    expect(chartX(last, first, last, LEFT, WIDTH)).toBe(LEFT + WIDTH);
    expect(chartX(middle, first, last, LEFT, WIDTH)).toBeCloseTo(LEFT + WIDTH / 2, 6);
  });

  it("returns the left edge for an unparseable timestamp instead of NaN", () => {
    const x = chartX("not-a-date", "2026-10-12T08:00:00.000Z", "2026-10-13T08:00:00.000Z", LEFT, WIDTH);

    expect(Number.isFinite(x)).toBe(true);
    expect(x).toBe(LEFT);
  });

  it("draws the polyline by calendar day: a missing day leaves a wider step", async () => {
    mockSnapshots.value = [
      snapshot({ id: 3, takenAt: "2026-10-15T08:00:00.000Z", singletonRate: 0.7 }),
      snapshot({ id: 2, takenAt: "2026-10-13T08:00:00.000Z", singletonRate: 0.8 }),
      snapshot({ id: 1, takenAt: "2026-10-12T08:00:00.000Z", singletonRate: 0.9 }),
    ];

    const tree = await QualityPage();
    const poly = allElements(tree).find(({ el }) => el.type === "polyline");
    const xs = String(poly!.el.props.points)
      .split(" ")
      .map((pt) => Number(pt.split(",")[0]));

    expect(xs).toHaveLength(3);
    // 10-12 -> 10-13 is one day of three, 10-13 -> 10-15 is two.
    expect(xs[1]! - xs[0]!).toBeCloseTo((xs[2]! - xs[0]!) / 3, 0);
  });
});

describe("gap note: missing measurement days are stated, not collapsed", () => {
  it("says how many days have no measurement when days are missing", async () => {
    mockSnapshots.value = [
      snapshot({ id: 4, takenAt: "2026-10-15T08:00:00.000Z" }),
      snapshot({ id: 3, takenAt: "2026-10-13T08:00:00.000Z" }),
      snapshot({ id: 2, takenAt: "2026-10-12T08:00:00.000Z" }),
    ];

    const text = collectText(await QualityPage()).join(" ");

    // 10-12..10-15 is 4 days, 3 rows: 10-14 is missing.
    expect(text).toContain("Bu aralıkta 1 gün ölçüm yok.");
  });

  it("counts every missing day across several gaps (10-14, 10-20 and 10-21 -> 3)", async () => {
    const days = ["10-12", "10-13", "10-15", "10-16", "10-17", "10-18", "10-19", "10-22"];
    mockSnapshots.value = days
      .map((d, i) => snapshot({ id: i + 1, takenAt: `2026-${d}T08:00:00.000Z` }))
      .reverse();

    const text = collectText(await QualityPage()).join(" ");

    // 10-12..10-22 is 11 days, 8 rows.
    expect(text).toContain("Bu aralıkta 3 gün ölçüm yok.");
  });

  it("is absent when every day has a measurement", async () => {
    mockSnapshots.value = [
      snapshot({ id: 3, takenAt: "2026-10-14T08:00:00.000Z" }),
      snapshot({ id: 2, takenAt: "2026-10-13T09:00:00.000Z" }),
      snapshot({ id: 1, takenAt: "2026-10-12T07:35:00.000Z" }),
    ];

    const text = collectText(await QualityPage()).join(" ");

    expect(text).not.toContain("ölçüm yok");
  });

  it("is absent with a single snapshot (no chart, no range)", async () => {
    mockSnapshots.value = [snapshot({ id: 1 })];

    const text = collectText(await QualityPage()).join(" ");

    expect(text).not.toContain("ölçüm yok");
  });

  it("counts days by Istanbul calendar day: 21:30Z and 08:00Z next day are one day, not two", async () => {
    mockSnapshots.value = [
      snapshot({ id: 2, takenAt: "2026-10-13T08:00:00.000Z" }),
      snapshot({ id: 1, takenAt: "2026-10-12T21:30:00.000Z" }),
    ];

    const text = collectText(await QualityPage()).join(" ");

    expect(text).not.toContain("ölçüm yok");
  });

  it("does not let a second measurement on one day hide a missing day", async () => {
    mockSnapshots.value = [
      snapshot({ id: 3, takenAt: "2026-10-14T08:00:00.000Z" }),
      snapshot({ id: 2, takenAt: "2026-10-12T15:00:00.000Z" }),
      snapshot({ id: 1, takenAt: "2026-10-12T08:00:00.000Z" }),
    ];

    const text = collectText(await QualityPage()).join(" ");

    // 3 rows over 3 days, but 10-13 has none.
    expect(text).toContain("Bu aralıkta 1 gün ölçüm yok.");
  });
});

// ---------------------------------------------------------------------------
// h90-kalite-1: the explanations must match what the numbers actually count.
// Re-verified read-only against prod (snapshot 61 window, politika and
// son_dakika, 2026-11-09): articles outlet 2,050 / aggregator 749 / niche 149 /
// wire 108; 1,188 of 1,580 clusters are singletons, 444 of them aggregator-only
// (434 haberler-com) and 29 wire-only; the DHA and İHA sources have never
// supplied an article; and jev_gold_labels (article-level labels, no cluster
// pairs) is empty.
// ---------------------------------------------------------------------------

/** Text of the Definitions box whose <dt> is exactly `term`. */
function definitionBox(tree: unknown, term: string): string {
  const dt = allElements(tree).find(
    ({ el }) => el.type === "dt" && collectText(el.props.children).join("") === term,
  );
  expect(dt, `definition term "${term}" is rendered`).toBeDefined();
  return collectText(dt!.parent!.props.children).join(" ");
}

/** Text of the whole Definitions <dl>. */
function definitionsText(tree: unknown): string {
  const dl = allElements(tree).find(({ el }) => el.type === "dl");
  expect(dl, "the Definitions <dl> is rendered").toBeDefined();
  return collectText(dl!.el.props.children).join(" ");
}

/** Text of the precision/recall card (the <p> that starts with its sentence). */
function precisionText(tree: unknown): string {
  const p = allElements(tree).find(
    ({ el }) =>
      el.type === "p" &&
      collectText(el.props.children).join("").startsWith("Kesinlik ve duyarlılık"),
  );
  expect(p, "the precision/recall sentence is rendered").toBeDefined();
  return collectText(p!.el.props.children).join("");
}

describe("explanation copy matches what the numbers count (h90-kalite-1)", () => {
  const states: Array<[string, () => typeof mockSnapshots.value]> = [
    ["data present", () => [snapshot()]],
    ["unavailable (null)", () => null],
    ["empty ([])", () => []],
  ];

  describe.each(states)("%s", (_name, make) => {
    it("Kapsam says aggregator and niche sources are counted and that /trends is not comparable", async () => {
      mockSnapshots.value = make();

      const box = definitionBox(await QualityPage(), "Kapsam");

      expect(box).toContain("politika ve son dakika");
      expect(box).toContain("toplayıcı ve niş");
      expect(box).toContain("Haberler.com");
      expect(box).toContain("/trends");
      expect(box).toContain("doğrudan karşılaştırılamaz");
      expect(box).toContain("tek haberli kümeler de dahildir");
      // The old claim: only the category differs, so these counts are smaller.
      expect(box).not.toContain("küçüktür");
    });

    it("Tekil küme names the 48 h window and the aggregator/no-other-source causes, never DHA or İHA", async () => {
      mockSnapshots.value = make();

      const box = definitionBox(await QualityPage(), "Tekil küme (singleton)");

      expect(box).toContain("Son 48 saatlik pencerede");
      expect(box).toContain("pencereden önceki eski üyeleri sayılmaz");
      expect(box).toContain("toplayıcı kaynakların");
      expect(box).toContain("başka hiçbir kaynağın yazmadığı");
      expect(box).toContain("aynı ajans metnini kopyalayan haberler ise genellikle birleşir");
      expect(box).toContain(
        "\"Tek kaynak\" her zaman \"diğerleri görmezden geldi\" anlamına gelmez.",
      );
      expect(box).not.toContain("Sadece bir makaleden");
    });

    it("the Kör nokta tutarsızlık oranı definition says vetoed blindspot claims do not enter the rate", async () => {
      mockSnapshots.value = make();

      const box = definitionBox(await QualityPage(), "Kör nokta tutarsızlık oranı");

      expect(box).toContain("Veto kurallarıyla geri çekilen kör nokta iddiaları bu orana girmez");
      expect(box).toContain(
        "oran yalnızca saklanan bayrağın yeniden hesaplamayla uyuşup uyuşmadığını ölçer",
      );
      // The existing definition is kept, the veto sentence is appended.
      expect(box).toContain("En az beş üyeli kümelerde");
      expect(box).toContain("bayrağın yeniden hesaplanmadığı anlamına gelir");
    });

    it("never blames DHA, İHA or 'ajans (AA' anywhere on the page, and never mentions a 300-article gold set", async () => {
      mockSnapshots.value = make();

      const text = collectText(await QualityPage()).join(" ");

      expect(text).toContain("toplayıcı ve niş");
      expect(text).toContain("Son 48 saatlik pencerede");
      expect(text).toContain("Veto kurallarıyla");
      expect(text).not.toContain("DHA");
      expect(text).not.toContain("İHA");
      expect(text).not.toContain("ajans (AA");
      expect(text).not.toContain("altın set");
      expect(text).not.toContain("300 haber");
    });

    it("the precision sentence says a labelled cluster-pair set is needed and does not exist yet", async () => {
      mockSnapshots.value = make();

      const sentence = precisionText(await QualityPage());

      expect(sentence).toBe(PRECISION_RECALL_SENTENCE);
      expect(sentence).toContain("küme çifti");
      expect(sentence).toContain("henüz yok");
      expect(sentence).not.toContain("300");
    });
  });

  it("takes the window length from the snapshot rather than a literal (a 24 h audit says 24)", async () => {
    mockSnapshots.value = [snapshot({ windowHours: 24 })];

    const box = definitionBox(await QualityPage(), "Tekil küme (singleton)");

    expect(box).toContain("Son 24 saatlik pencerede");
    expect(box).not.toContain("48");
  });

  it("falls back to the clusterer's own 48 h window when the snapshot has no usable window length", async () => {
    mockSnapshots.value = [snapshot({ windowHours: 0 })];

    const box = definitionBox(await QualityPage(), "Tekil küme (singleton)");

    expect(box).toContain("Son 48 saatlik pencerede");
  });

  it("keeps the h41-derived-1 scope and timing copy", async () => {
    mockSnapshots.value = [snapshot()];

    const text = collectText(await QualityPage()).join(" ");

    expect(text).toContain("politika ve son dakika");
    expect(text).toContain("günde bir kez");
    expect(text).toContain("Siyaset haberi (48 saat)");
    expect(text).toContain("Küme sayısı (tek haberliler dahil)");
    expect(text).toContain("Tekil küme oranı");
    expect(text).toContain("Kaynak çeşitliliği");
    expect(text).toContain("Kör nokta tutarsızlık oranı");
    expectNoNightlyClaims(text);
  });

  it("the Definitions list holds exactly the five terms, in order", async () => {
    mockSnapshots.value = [snapshot()];

    const dts = allElements(await QualityPage())
      .filter(({ el }) => el.type === "dt")
      .map(({ el }) => collectText(el.props.children).join(""));

    expect(dts).toEqual([
      "Kapsam",
      "Tekil küme (singleton)",
      "Küme (cluster)",
      "Kaynak çeşitliliği",
      "Kör nokta tutarsızlık oranı",
    ]);
    expect(definitionsText(await QualityPage())).toContain("Küme (cluster)");
  });
});
