import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// daily-zones.ts's fetchIstanbulTimeline is a "use cache" cached fetcher — mocked
// wholesale (mirrors src/app/metodoloji/page.test.tsx's `@/lib/headline/
// status` mock) so this suite exercises only TrendsPage's three-state
// branching (null / empty / data), not Supabase or Next's cache machinery.
//
// fetchIstanbulTimeline resolves `null` on a Supabase error instead of throwing
// (see src/lib/trends/daily-zones.ts) — a throw inside a "use cache"
// function aborts the whole `next build` prerender. The page must render an
// honest "unavailable" state for `null`, distinct from the existing
// "veri bulunamadı" copy for a genuinely empty (all-zero) result.
// ---------------------------------------------------------------------------

type Zone = "iktidar" | "bagimsiz" | "muhalefet";
type Bucket = {
  day: string;
  counts: Record<Zone, number>;
  total: number;
  /** h37-content-3: set by bucketIstanbulDays on the current Istanbul day only. */
  partial?: boolean;
};

let mockBuckets: Bucket[] | null = null;

// "Yükselen Konular" (migration 112): getRisingEntities is another "use cache"
// fetcher, mocked wholesale for the same reason. Default `null` keeps every
// pre-existing test on the failure branch of the new section.
let mockRising: RisingResult | null = null;

// h43-entities-3: the page reads the hub of each rising row (getEntityHub, a
// resolveCachedOrRetry getter) AFTER the rising list resolved, outside any
// "use cache" function. Mocked per key; an unlisted key is a failed read (null).
// `callLog` records the order of the two kinds of read.
let mockHubs: Record<string, unknown> = {};
const callLog: string[] = [];

vi.mock("@/lib/trends/rising-query", () => ({
  getRisingEntities: vi.fn(async () => {
    callLog.push("rising");
    return mockRising;
  }),
}));

vi.mock("@/lib/entities/entity-hub-query", () => ({
  getEntityHub: vi.fn(async (key: string) => {
    callLog.push(`hub:${key}`);
    return mockHubs[key] ?? null;
  }),
}));

vi.mock("@/lib/trends/daily-zones", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/trends/daily-zones")
  >("@/lib/trends/daily-zones");
  return {
    ...actual,
    fetchIstanbulTimeline: vi.fn(async () => mockBuckets),
  };
});

import TrendsPage, { metadata } from "./page";
import { WINDOW_DAYS } from "@/lib/trends/daily-zones";
import { RisingTopics } from "@/components/trends/rising-topics";
import { PageHero } from "@/components/ui/page-hero";
import { MAX_ITEMS, type RisingItem, type RisingResult } from "@/lib/trends/rising";
import { getEntityHub } from "@/lib/entities/entity-hub-query";
import { ZONE_META } from "@/lib/bias/config";
import { ScrollToEnd } from "@/components/trends/scroll-to-end";
import { formatCountTr } from "@/lib/format/number-tr";

/** Collects every string/number leaf under a React element tree. */
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

/** Collects every `href` prop found anywhere in a React element tree. */
function collectHrefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectHrefs(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { props?: { href?: unknown; children?: ReactNode } };
    if (typeof el.props?.href === "string") out.push(el.props.href);
    if (el.props?.children !== undefined) collectHrefs(el.props.children, out);
  }
  return out;
}

function zeroBuckets(): Bucket[] {
  const buckets: Bucket[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    // 30 distinct, consecutive days (2024-01-01 .. 2024-01-30) like the real
    // timeline, so the data table's per-day <tr key> never collides.
    buckets.push({
      day: `2024-01-${String(i + 1).padStart(2, "0")}`,
      counts: { iktidar: 0, bagimsiz: 0, muhalefet: 0 },
      total: 0,
    });
  }
  return buckets;
}

const UNAVAILABLE_COPY = "Trend verileri şu anda yüklenemiyor.";
const EMPTY_COPY = "Son 30 gün için veri bulunamadı.";

describe("/trends page", () => {
  it("renders the honest unavailable state (not the empty-data state) when fetchIstanbulTimeline resolves null", async () => {
    mockBuckets = null;

    const tree = await TrendsPage();
    const text = collectText(tree).join(" ");

    expect(text).toContain(UNAVAILABLE_COPY);
    expect(text).not.toContain(EMPTY_COPY);
    // A retry hint pointing back at /trends, inside the normal layout.
    expect(collectHrefs(tree)).toContain("/trends");
  });

  it("renders the empty-state copy only for a genuinely empty (all-zero) result", async () => {
    mockBuckets = zeroBuckets();

    const tree = await TrendsPage();
    const text = collectText(tree).join(" ");

    expect(text).toContain(EMPTY_COPY);
    expect(text).not.toContain(UNAVAILABLE_COPY);
  });

  it("renders bucketed totals for data (neither null nor empty copy)", async () => {
    const buckets = zeroBuckets();
    buckets[buckets.length - 1]!.counts.iktidar = 4;
    buckets[buckets.length - 1]!.counts.muhalefet = 1;
    buckets[buckets.length - 1]!.total = 5;
    mockBuckets = buckets;

    const tree = await TrendsPage();
    const text = collectText(tree).join(" ");

    expect(text).not.toContain(UNAVAILABLE_COPY);
    expect(text).not.toContain(EMPTY_COPY);
    expect(text).toContain("5");
  });

  it("shows the Istanbul-day / voting-kinds caption", async () => {
    mockBuckets = zeroBuckets();

    const tree = await TrendsPage();
    const text = collectText(tree).join(" ");

    expect(text).toContain(
      "Yalnızca spektruma sayılan kaynaklar (haber siteleri ve ajanslar) · günler Türkiye saatine göre",
    );
  });
});

// ---------------------------------------------------------------------------
// seo-error-states B (A.4's /trends noindex was dropped: the failed state is
// memoised for cacheLife 3600s and baked into the static HTML)
// ---------------------------------------------------------------------------

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

function noindexMetas(tree: unknown): Elementish[] {
  return collectElements(tree).filter(
    (el) =>
      el.type === "meta" &&
      el.props?.name === "robots" &&
      el.props?.content === "noindex",
  );
}

/** A month of buckets where only the last day has data (4 iktidar + 1 muhalefet). */
function seededBuckets(): { buckets: Bucket[]; lastDay: string } {
  const buckets = zeroBuckets();
  const last = buckets[buckets.length - 1]!;
  last.counts.iktidar = 4;
  last.counts.muhalefet = 1;
  last.total = 5;
  return { buckets, lastDay: last.day };
}

describe("/trends page — never noindex (the unavailable state is memoised)", () => {
  // fetchIstanbulTimelineCached() runs under cacheLife({ revalidate: 3600 })
  // and returns the attemptCached() sentinel, so a transient Supabase blip or
  // empty result at `next build` prefill time is memoised as { ok: false } for
  // the whole hour and baked into the static /trends HTML. A noindex on that
  // branch would therefore ship in <head> to Googlebot for >= 3600s and could
  // drop the page from the index. The live-request surfaces (/, /blindspots,
  // /sources) are not pinned like this; /trends must stay indexable.
  it("does not emit noindex when the timeline is null (cached failure sentinel)", async () => {
    mockBuckets = null;

    const tree = await TrendsPage();

    expect(noindexMetas(tree)).toHaveLength(0);
    // Still renders the honest unavailable state + retry link.
    expect(collectText(tree).join(" ")).toContain("yüklenemiyor");
  });

  it("does not emit any robots meta at all on the null branch (inherits the layout's index,follow)", async () => {
    mockBuckets = null;

    const tree = await TrendsPage();

    const robots = collectElements(tree).filter(
      (el) => el.type === "meta" && el.props?.name === "robots",
    );
    expect(robots).toHaveLength(0);
  });

  it("does not emit noindex for the data branch", async () => {
    mockBuckets = seededBuckets().buckets;

    const tree = await TrendsPage();

    expect(noindexMetas(tree)).toHaveLength(0);
  });

  it("does not emit noindex for the genuinely empty (all-zero) branch", async () => {
    mockBuckets = zeroBuckets();

    const tree = await TrendsPage();

    expect(noindexMetas(tree)).toHaveLength(0);
  });
});

describe("/trends page — chart scroller opens on the newest days (browser-5)", () => {
  it("wraps the server-rendered svg in <ScrollToEnd> on the data branch", async () => {
    mockBuckets = seededBuckets().buckets;

    const tree = await TrendsPage();

    const scrollers = collectElements(tree).filter(
      (el) => el.type === ScrollToEnd,
    );
    expect(scrollers).toHaveLength(1);
    const scroller = scrollers[0]!;
    // The scroller keeps the original overflow container classes.
    expect(scroller.props?.className).toBe(
      "w-full overflow-x-auto spectrum-glow",
    );
    // h17-a11y-1: and is a named, keyboard-reachable region.
    expect(scroller.props?.label).toBe(
      "Son 30 gün grafiği (yatay kaydırılabilir)",
    );
    // The chart stays server-rendered as the scroller's children.
    const svgInside = collectElements(scroller.props?.children).filter(
      (el) => el.type === "svg",
    );
    expect(svgInside).toHaveLength(1);
  });

  it("does not render a scroller on the unavailable branch (no chart)", async () => {
    mockBuckets = null;

    const tree = await TrendsPage();

    expect(collectElements(tree).filter((el) => el.type === ScrollToEnd)).toHaveLength(0);
  });
});

describe("/trends page — SVG <title> is a single string", () => {
  it("renders every <title> with exactly one string child equal to 'day · label: count'", async () => {
    const { buckets, lastDay } = seededBuckets();
    mockBuckets = buckets;

    const tree = await TrendsPage();

    const titles = collectElements(tree).filter((el) => el.type === "title");
    expect(titles).toHaveLength(2); // iktidar + muhalefet on the seeded day
    for (const title of titles) {
      expect(typeof title.props?.children).toBe("string");
    }
    expect(titles.map((t) => t.props?.children)).toEqual([
      `${lastDay} · ${ZONE_META.iktidar.label}: 4`,
      `${lastDay} · ${ZONE_META.muhalefet.label}: 1`,
    ]);
  });

  it("groups a count of 1000 or more with the tr-TR dot, as a single string", async () => {
    const { buckets, lastDay } = seededBuckets();
    const last = buckets[buckets.length - 1]!;
    last.counts.iktidar = 3830;
    last.counts.muhalefet = 1146;
    last.total = 3830 + 1146;
    mockBuckets = buckets;

    const tree = await TrendsPage();

    const titles = collectElements(tree).filter((el) => el.type === "title");
    expect(titles.map((t) => t.props?.children)).toEqual([
      `${lastDay} · ${ZONE_META.iktidar.label}: 3.830`,
      `${lastDay} · ${ZONE_META.muhalefet.label}: 1.146`,
    ]);
    for (const title of titles) {
      expect(typeof title.props?.children).toBe("string");
    }
  });

  it("serialises to non-empty <title> markup (no '<title></title>')", async () => {
    const { buckets, lastDay } = seededBuckets();
    mockBuckets = buckets;

    const tree = await TrendsPage();

    const svg = collectElements(tree).find((el) => el.type === "svg");
    expect(svg).toBeDefined();
    const markup = renderToStaticMarkup(svg as unknown as React.ReactElement);

    expect(markup).toContain(`<title>${lastDay} · `);
    expect(markup).not.toContain("<title></title>");
  });
});

// ---------------------------------------------------------------------------
// "Yükselen Konular" (migration 112): the section sits right after the hero in
// BOTH branches (null buckets and data), is fed by getRisingEntities, and
// degrades on its own without taking the chart down.
// ---------------------------------------------------------------------------

const RISING_OK: RisingResult = {
  status: "ok",
  day: "2026-10-23",
  items: [
    {
      key: "erdogan",
      label: "Erdoğan",
      href: "/?q=Erdo%C4%9Fan",
      count: 15,
      baseline: 3,
      ratio: 5,
      ratioLabel: "5,0",
      ratioIsLowerBound: false,
      isNew: false,
    },
  ],
};

/** The element list of the page's root container (its direct children). */
function rootChildren(tree: unknown): Elementish[] {
  const root = tree as { props?: { children?: unknown } };
  const kids = root.props?.children;
  return (Array.isArray(kids) ? kids : [kids]).filter(Boolean) as Elementish[];
}

describe("/trends page — Yükselen Konular section", () => {
  it.each([
    ["null buckets (fetch failed)", () => null as Bucket[] | null],
    ["data", () => seededBuckets().buckets as Bucket[] | null],
  ])("renders <RisingTopics> right after the hero: %s", async (_name, make) => {
    mockBuckets = make();
    mockRising = RISING_OK;

    const tree = await TrendsPage();

    const kids = rootChildren(tree);
    const heroIdx = kids.findIndex((el) => el.type === PageHero);
    expect(heroIdx).toBe(0);
    expect(kids[heroIdx + 1]?.type).toBe(RisingTopics);
    // The hub of "erdogan" is not mocked (a failed read), so its row links to
    // the home search, exactly the fixture's href: the data is equal, not the
    // same object (the page re-links the rows).
    expect(kids[heroIdx + 1]?.props?.data).toEqual(RISING_OK);
    expect(collectElements(tree).filter((el) => el.type === RisingTopics)).toHaveLength(1);
  });

  it.each([
    ["null buckets", () => null as Bucket[] | null],
    ["data", () => seededBuckets().buckets as Bucket[] | null],
  ])("the section heading renders in the %s branch", async (_name, make) => {
    mockBuckets = make();
    mockRising = RISING_OK;

    const tree = await TrendsPage();
    const section = collectElements(tree).find((el) => el.type === RisingTopics);
    const html = renderToStaticMarkup(section as unknown as React.ReactElement);

    expect(html).toContain("Yükselen Konular");
    expect(html).toContain("Erdoğan");
  });

  it("a null rising result shows the 'hesaplanamıyor' copy and leaves the chart alone", async () => {
    mockBuckets = seededBuckets().buckets;
    mockRising = null;

    const tree = await TrendsPage();
    const section = collectElements(tree).find((el) => el.type === RisingTopics);
    const html = renderToStaticMarkup(section as unknown as React.ReactElement);

    expect(html).toContain("Yükselen konular şu anda hesaplanamıyor.");
    // The chart still renders.
    expect(collectElements(tree).filter((el) => el.type === "svg")).toHaveLength(1);
    expect(collectText(tree).join(" ")).not.toContain(UNAVAILABLE_COPY);
  });

  it("a failed chart does not hide the rising section", async () => {
    mockBuckets = null;
    mockRising = RISING_OK;

    const tree = await TrendsPage();

    expect(collectText(tree).join(" ")).toContain(UNAVAILABLE_COPY);
    expect(collectElements(tree).filter((el) => el.type === RisingTopics)).toHaveLength(1);
  });

  it("fetches the timeline and the rising list exactly once per render", async () => {
    const { getRisingEntities } = await import("@/lib/trends/rising-query");
    const { fetchIstanbulTimeline } = await import("@/lib/trends/daily-zones");
    mockBuckets = zeroBuckets();
    mockRising = RISING_OK;
    vi.mocked(getRisingEntities).mockClear();
    vi.mocked(fetchIstanbulTimeline).mockClear();

    await TrendsPage();

    expect(getRisingEntities).toHaveBeenCalledTimes(1);
    expect(fetchIstanbulTimeline).toHaveBeenCalledTimes(1);
  });

  it("h24-pages-3: the <title>, og:title and twitter:title read 'Medya DNA trendi' (sentence case)", () => {
    expect(metadata.title).toBe("Medya DNA trendi");
    expect(metadata.openGraph?.title).toBe("Medya DNA trendi — Tayf");
    expect(metadata.twitter?.title).toBe("Medya DNA trendi — Tayf");
  });

  it("the page description mentions today's rising topics", () => {
    expect(String(metadata.description)).toContain("bugün yükselen konular");
  });
});

// ---------------------------------------------------------------------------
// Nice-number y-axis (h14-polish-5): the gridlines sit on round tick values
// from niceScale(), the labels use the tr-TR grouping, and the bars are scaled
// to the same axis maximum so a bar never overshoots its own gridline.
// ---------------------------------------------------------------------------

/** One busiest day of 8791 articles (5000 + 2000 + 1791) among quiet days. */
function busiestDayBuckets(): Bucket[] {
  const buckets = zeroBuckets();
  const quiet = buckets[buckets.length - 2]!;
  quiet.counts.iktidar = 1000;
  quiet.counts.bagimsiz = 500;
  quiet.counts.muhalefet = 698;
  quiet.total = 2198;
  const busiest = buckets[buckets.length - 1]!;
  busiest.counts.iktidar = 5000;
  busiest.counts.bagimsiz = 2000;
  busiest.counts.muhalefet = 1791;
  busiest.total = 8791;
  return buckets;
}

async function chartMarkup(buckets: Bucket[]): Promise<string> {
  mockBuckets = buckets;
  const tree = await TrendsPage();
  const svg = collectElements(tree).find((el) => el.type === "svg");
  expect(svg).toBeDefined();
  return renderToStaticMarkup(svg as unknown as React.ReactElement);
}

function attr(tag: string, name: string): number {
  const m = tag.match(new RegExp(`\\s${name}="([^"]+)"`));
  expect(m, `${name} in ${tag}`).not.toBeNull();
  return Number(m![1]);
}

/**
 * Texts of the y-axis tick labels. h46-mobile-3: they are aria-hidden HTML
 * spans in a gutter beside the chart (not svg <text>), one per tick.
 */
async function yAxisLabels(buckets: Bucket[]): Promise<string[]> {
  mockBuckets = buckets;
  const tree = await TrendsPage();
  return collectElements(tree)
    .filter((el) => el.props?.["data-y-label"] !== undefined)
    .map((el) => collectText(el.props?.children).join(""));
}

describe("/trends page — nice-number y-axis", () => {
  it("labels the axis 0 / 2.500 / 5.000 / 7.500 / 10.000 for a busiest day of 8791", async () => {
    expect(await yAxisLabels(busiestDayBuckets())).toEqual([
      "0",
      "2.500",
      "5.000",
      "7.500",
      "10.000",
    ]);
  });

  it("never prints the raw quarter-of-the-maximum values (8791, 2198, 4396, 6593)", async () => {
    const labels = await yAxisLabels(busiestDayBuckets());

    for (const raw of ["8791", "8.791", "2198", "2.198", "4396", "6593"]) {
      expect(labels).not.toContain(raw);
    }
  });

  it("draws one gridline per tick, evenly spaced from the baseline to the top", async () => {
    const markup = await chartMarkup(busiestDayBuckets());

    const ys = [...markup.matchAll(/<line\b[^>]*>/g)].map((m) => attr(m[0], "y1"));
    expect(ys).toHaveLength(5);
    // First tick (0) is the lowest line (largest y); last tick (max) the highest.
    const sorted = [...ys].sort((a, b) => b - a);
    const gaps = sorted.slice(1).map((y, i) => sorted[i]! - y);
    for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0]!, 6);
    expect(gaps[0]).toBeGreaterThan(0);
  });

  it("scales the bars to the axis maximum: the tallest bar fills 0.8791 of the gridline span", async () => {
    const markup = await chartMarkup(busiestDayBuckets());

    const ys = [...markup.matchAll(/<line\b[^>]*>/g)].map((m) => attr(m[0], "y1"));
    const span = Math.max(...ys) - Math.min(...ys);

    // Sum the stacked rect heights per bar (same x).
    const heightByX = new Map<number, number>();
    for (const m of markup.matchAll(/<rect\b[^>]*>/g)) {
      const x = attr(m[0], "x");
      heightByX.set(x, (heightByX.get(x) ?? 0) + attr(m[0], "height"));
    }
    const tallest = Math.max(...heightByX.values());

    expect(tallest).toBeCloseTo(0.8791 * span, 4);
    // The tallest bar must stay below the top gridline.
    expect(tallest).toBeLessThan(span);
  });

  it("keeps a sane 0 / 1 axis for an empty month", async () => {
    expect(await yAxisLabels(zeroBuckets())).toEqual(["0", "1"]);
  });

  it("uses the shared tr-TR formatter and the niceScale ticks in the source", () => {
    const src = readFileSync(resolve(__dirname, "page.tsx"), "utf8");

    expect(src).toContain("niceScale(yMax)");
    expect(src).toContain("formatCountTr(t)");
    expect(src).not.toContain("gridSteps");
    expect(src).not.toContain("Math.round(yMax * step)");
  });
});

// ---------------------------------------------------------------------------
// h17-a11y-1 (WCAG 2.1.1 / 1.1.1 / 1.3.1): the chart scroller is a named,
// focusable region and the per-day numbers are also offered as a real table.
// ---------------------------------------------------------------------------

/** The element tree's direct parent of `child`, found by identity. */
function parentOf(tree: unknown, child: unknown): Elementish | null {
  for (const el of collectElements(tree)) {
    const kids = el.props?.children;
    if (kids === child) return el;
    if (Array.isArray(kids) && kids.includes(child)) return el;
  }
  return null;
}

function tableDetails(tree: unknown): Elementish[] {
  return collectElements(tree).filter((el) => el.type === "details");
}

async function detailsMarkup(buckets: Bucket[]): Promise<string> {
  mockBuckets = buckets;
  const tree = await TrendsPage();
  const details = tableDetails(tree);
  expect(details).toHaveLength(1);
  return renderToStaticMarkup(details[0] as unknown as React.ReactElement);
}

/** Text of every <td> in each tbody row, plus the row header. */
function bodyRows(markup: string): { header: string; cells: string[] }[] {
  const tbody = markup.match(/<tbody[^>]*>([\s\S]*)<\/tbody>/)?.[1] ?? "";
  return [...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => ({
    header: m[1]!.match(/<th[^>]*>([^<]*)<\/th>/)?.[1] ?? "",
    cells: [...m[1]!.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((c) => c[1]!),
  }));
}

describe("/trends page — keyboard-reachable chart and data table (h17-a11y-1)", () => {
  it("names the scroller region and keeps the svg's role=img summary", async () => {
    mockBuckets = seededBuckets().buckets;

    const tree = await TrendsPage();

    const scroller = collectElements(tree).find((el) => el.type === ScrollToEnd);
    expect(scroller?.props?.label).toBe("Son 30 gün grafiği (yatay kaydırılabilir)");
    expect(scroller?.props?.className).toBe("w-full overflow-x-auto spectrum-glow");
    const svg = collectElements(scroller?.props?.children).find((el) => el.type === "svg");
    expect(svg?.props?.role).toBe("img");
    expect(String(svg?.props?.["aria-label"])).toContain("Toplam");
  });

  it("renders exactly one <details>, a later sibling of the chart row that holds the scroller", async () => {
    mockBuckets = seededBuckets().buckets;

    const tree = await TrendsPage();

    const details = tableDetails(tree);
    expect(details).toHaveLength(1);
    const scroller = collectElements(tree).find((el) => el.type === ScrollToEnd)!;
    // h46-mobile-3: the scroller sits in a flex row next to the y-axis gutter,
    // so the table follows that row rather than the scroller itself.
    const chartRow = parentOf(tree, scroller);
    expect(chartRow).not.toBeNull();
    expect(chartRow!.props?.["data-trends-chart"]).toBeDefined();
    const card = parentOf(tree, chartRow);
    expect(card).not.toBeNull();
    expect(parentOf(tree, details[0])).toBe(card);
    const kids = card!.props!.children as unknown[];
    expect(kids.indexOf(details[0])).toBeGreaterThan(kids.indexOf(chartRow));
  });

  it("the <details> has the Turkish summary and a caption", async () => {
    const html = await detailsMarkup(seededBuckets().buckets);

    expect(html).toContain("<summary");
    expect(html).toContain("Günlük sayıları tablo olarak göster");
    expect(html).toContain("<caption");
    expect(html).toContain(
      "Son 30 günde Medya DNA bölgesine göre günlük haber sayısı (günler Türkiye saatine göre)",
    );
  });

  it("has five column headers in order: Gün, İktidar, Bağımsız, Muhalefet, Toplam", async () => {
    const html = await detailsMarkup(seededBuckets().buckets);

    const cols = [...html.matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(cols).toEqual(["Gün", "İktidar", "Bağımsız", "Muhalefet", "Toplam"]);
    expect(html.match(/<th scope="col"/g)).toHaveLength(5);
  });

  it("has one body row per day, each starting with a row header", async () => {
    const html = await detailsMarkup(seededBuckets().buckets);

    const tbody = html.match(/<tbody[^>]*>([\s\S]*)<\/tbody>/)?.[1] ?? "";
    const rows = [...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]!);
    expect(rows).toHaveLength(WINDOW_DAYS);
    for (const row of rows) expect(row.startsWith('<th scope="row"')).toBe(true);
    // 3 zone counts + the total per row.
    for (const { cells } of bodyRows(html)) expect(cells).toHaveLength(4);
  });

  it("lists the days oldest first with a Turkish day label", async () => {
    const html = await detailsMarkup(seededBuckets().buckets);

    const headers = bodyRows(html).map((r) => r.header);
    expect(headers[0]).toBe("1 Ocak");
    expect(headers[WINDOW_DAYS - 1]).toBe("30 Ocak");
  });

  it("the seeded last day reads 4, 0, 1, 5", async () => {
    const html = await detailsMarkup(seededBuckets().buckets);

    const rows = bodyRows(html);
    expect(rows[rows.length - 1]!.cells).toEqual(["4", "0", "1", "5"]);
    // Every other day is a quiet zero row.
    for (const row of rows.slice(0, -1)) {
      expect(row.cells).toEqual(["0", "0", "0", "0"]);
    }
  });

  it("formats counts with the tr-TR grouping (2.198, 8.791)", async () => {
    const html = await detailsMarkup(busiestDayBuckets());

    const cells = bodyRows(html).flatMap((r) => r.cells);
    expect(cells).toContain("2.198");
    expect(cells).toContain("8.791");
    expect(cells).toContain("5.000");
    expect(cells).not.toContain("8791");
  });

  it("does not wrap the table in a second overflow container (axe scrollable-region-focusable)", async () => {
    const html = await detailsMarkup(seededBuckets().buckets);

    expect(html).not.toContain("overflow");
    expect(html).not.toContain("tabindex");
  });

  it("renders no <details> on the all-zero branch", async () => {
    mockBuckets = zeroBuckets();

    const tree = await TrendsPage();

    expect(tableDetails(tree)).toHaveLength(0);
    expect(collectText(tree).join(" ")).toContain(EMPTY_COPY);
  });

  it("renders no <details> on the unavailable (null) branch", async () => {
    mockBuckets = null;

    const tree = await TrendsPage();

    expect(tableDetails(tree)).toHaveLength(0);
  });

  it("leaves the svg's <title> children and role untouched", async () => {
    const { buckets, lastDay } = seededBuckets();
    mockBuckets = buckets;

    const tree = await TrendsPage();

    const titles = collectElements(tree).filter((el) => el.type === "title");
    expect(titles.map((t) => t.props?.children)).toEqual([
      `${lastDay} · ${ZONE_META.iktidar.label}: 4`,
      `${lastDay} · ${ZONE_META.muhalefet.label}: 1`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// h37-content-3: the last bucket is today's still-running Istanbul day. It must
// not read as a collapse: lighter + dashed bar, a header note, a svg summary
// sentence, a ' (son gün, eksik)' bar title and a '(eksik)' table row. The
// markers are worded relative to the snapshot, never as 'today': the cached
// entry that carries the flag is served up to about an hour past Istanbul
// midnight, and longer to the first request after an idle spell. Only the presentation changes: yMax and the totals stay as they were,
// and the flag comes from the cached fetcher (no clock in the render).
// ---------------------------------------------------------------------------

const PARTIAL_BAR_SUFFIX = " (son gün, eksik)";

// Mirrors of page.tsx's private chart geometry (900 wide, 4 left, 16 right, 4
// gap). h46-mobile-3: the left padding is 4, not 48: the y labels live in an
// HTML gutter beside the svg, so the plot starts at the svg's left edge.
const CHART_W_FOR_TEST = 900;
const CHART_H_FOR_TEST = 320;
const PAD_LEFT_FOR_TEST = 4;
const PAD_RIGHT_FOR_TEST = 16;
const PAD_TOP_FOR_TEST = 16;
const PAD_BOTTOM_FOR_TEST = 36;
const BAR_GAP_FOR_TEST = 4;
function barWidthForTest(): number {
  return (
    (CHART_W_FOR_TEST -
      PAD_LEFT_FOR_TEST -
      PAD_RIGHT_FOR_TEST -
      BAR_GAP_FOR_TEST * (WINDOW_DAYS - 1)) /
    WINDOW_DAYS
  );
}

/** A month where the busiest day (8791) is the last, partial one. */
function partialBusiestBuckets(): Bucket[] {
  const buckets = busiestDayBuckets();
  buckets[buckets.length - 1]!.partial = true;
  return buckets;
}

/** The seeded month (last day 4 + 1) with the last day flagged partial. */
function partialSeededBuckets(): { buckets: Bucket[]; lastDay: string } {
  const seeded = seededBuckets();
  seeded.buckets[seeded.buckets.length - 1]!.partial = true;
  return seeded;
}

/** Plain text of the "Toplam N haber, son 30 gün ..." header line. */
async function headerLine(buckets: Bucket[]): Promise<string> {
  mockBuckets = buckets;
  const tree = await TrendsPage();
  const line = collectElements(tree).find(
    (el) =>
      el.type === "div" &&
      el.props?.className === undefined &&
      collectText(el).join("").startsWith("Toplam"),
  );
  expect(line).toBeDefined();
  return collectText(line!).join("");
}

async function svgAriaLabel(buckets: Bucket[]): Promise<string> {
  mockBuckets = buckets;
  const tree = await TrendsPage();
  const svg = collectElements(tree).find((el) => el.type === "svg");
  expect(svg).toBeDefined();
  return String(svg!.props?.["aria-label"]);
}

/** Every <rect ...> start tag of the chart markup. */
function rectTags(markup: string): string[] {
  return [...markup.matchAll(/<rect\b[^>]*>/g)].map((m) => m[0]);
}

describe("/trends page — partial current day (h37-content-3)", () => {
  it("draws the partial bucket's rects lighter (fill-opacity 0.45) with a dashed outline", async () => {
    const { buckets } = partialSeededBuckets();
    const markup = await chartMarkup(buckets);

    const rects = rectTags(markup);
    expect(rects).toHaveLength(2); // iktidar + muhalefet of the seeded last day
    for (const rect of rects) {
      expect(rect).toContain('fill-opacity="0.45"');
      expect(rect).toContain("stroke-dasharray=");
      expect(rect).toMatch(/\sstroke="#[0-9a-f]{6}"/);
    }
  });

  it("keeps finished days at full strength: no fill-opacity and no dash", async () => {
    const buckets = partialBusiestBuckets();
    const markup = await chartMarkup(buckets);

    const lastX = PAD_LEFT_FOR_TEST + (WINDOW_DAYS - 1) * (barWidthForTest() + BAR_GAP_FOR_TEST);
    const finished = rectTags(markup).filter((r) => Math.abs(attr(r, "x") - lastX) > 0.001);
    const partial = rectTags(markup).filter((r) => Math.abs(attr(r, "x") - lastX) <= 0.001);

    expect(partial).toHaveLength(3);
    expect(finished).toHaveLength(3); // the quiet day before it
    for (const rect of finished) {
      expect(rect).not.toContain("fill-opacity");
      expect(rect).not.toContain("stroke-dasharray");
    }
  });

  it("marks nothing when no bucket is partial (flag absent or false)", async () => {
    const plain = await chartMarkup(busiestDayBuckets());
    expect(plain).not.toContain("fill-opacity");
    expect(plain).not.toContain("stroke-dasharray");

    const buckets = busiestDayBuckets();
    buckets[buckets.length - 1]!.partial = false;
    const flaggedFalse = await chartMarkup(buckets);
    expect(flaggedFalse).toBe(plain);
  });

  it("header reads 'Toplam N haber, son 30 gün (son gün dahil, eksik)' for a partial window", async () => {
    expect(await headerLine(partialSeededBuckets().buckets)).toBe(
      "Toplam 5 haber, son 30 gün (son gün dahil, eksik)",
    );
    // The total still counts the partial day (8791 + 2198).
    expect(await headerLine(partialBusiestBuckets())).toBe(
      "Toplam 10.989 haber, son 30 gün (son gün dahil, eksik)",
    );
  });

  it("header is unchanged when no bucket is partial", async () => {
    expect(await headerLine(seededBuckets().buckets)).toBe("Toplam 5 haber, son 30 gün");
  });

  it("the svg aria-label adds 'Son günün sayımı eksik.' after the total", async () => {
    const label = await svgAriaLabel(partialBusiestBuckets());

    expect(label).toContain("Toplam 10.989 haber.");
    expect(label.endsWith("Toplam 10.989 haber. Son günün sayımı eksik.")).toBe(true);
  });

  it("the svg aria-label is unchanged when no bucket is partial", async () => {
    const label = await svgAriaLabel(busiestDayBuckets());

    expect(label).not.toContain("eksik");
    expect(label.endsWith("Toplam 10.989 haber.")).toBe(true);
  });

  it("the partial bucket's <title>s end with ' (son gün, eksik)'; finished days' do not", async () => {
    const buckets = partialBusiestBuckets();
    mockBuckets = buckets;

    const tree = await TrendsPage();

    const titles = collectElements(tree)
      .filter((el) => el.type === "title")
      .map((t) => t.props?.children as string);
    expect(titles).toHaveLength(6);
    const quietDay = buckets[buckets.length - 2]!.day;
    const lastDay = buckets[buckets.length - 1]!.day;
    for (const title of titles) {
      expect(typeof title).toBe("string");
      if (title.startsWith(lastDay)) expect(title.endsWith(PARTIAL_BAR_SUFFIX)).toBe(true);
      else {
        expect(title.startsWith(quietDay)).toBe(true);
        expect(title).not.toContain("bugün");
      }
    }
    expect(titles.filter((t) => t.endsWith(PARTIAL_BAR_SUFFIX))).toEqual([
      `${lastDay} · ${ZONE_META.iktidar.label}: 5.000${PARTIAL_BAR_SUFFIX}`,
      `${lastDay} · ${ZONE_META.bagimsiz.label}: 2.000${PARTIAL_BAR_SUFFIX}`,
      `${lastDay} · ${ZONE_META.muhalefet.label}: 1.791${PARTIAL_BAR_SUFFIX}`,
    ]);
  });

  it("the data table's last row header reads '30 Ocak (eksik)'; the others are plain", async () => {
    const html = await detailsMarkup(partialSeededBuckets().buckets);

    const headers = bodyRows(html).map((r) => r.header);
    expect(headers[WINDOW_DAYS - 1]).toBe("30 Ocak (eksik)");
    expect(headers[WINDOW_DAYS - 2]).toBe("29 Ocak");
    expect(headers.filter((h) => h.includes("eksik"))).toHaveLength(1);
    // The numbers of the partial row are untouched.
    const rows = bodyRows(html);
    expect(rows[rows.length - 1]!.cells).toEqual(["4", "0", "1", "5"]);
  });

  it("says nothing about 'today': no 'bugün' and no 'sürüyor' anywhere in the rendered chart, header, aria-label, titles or table", async () => {
    // The flag is baked into a cache entry served up to about an hour past
    // Istanbul midnight (and longer after an idle spell: no `expire`), so the
    // markers describe the snapshot's last day, never 'today'.
    const buckets = partialBusiestBuckets();
    mockBuckets = buckets;
    const tree = await TrendsPage();

    expect(collectText(tree).join(" ")).not.toMatch(/bugün|sürüyor/i);
    expect(await headerLine(buckets)).not.toMatch(/bugün|sürüyor/i);
    expect(await svgAriaLabel(buckets)).not.toMatch(/bugün|sürüyor/i);
    const titles = collectElements(tree)
      .filter((el) => el.type === "title")
      .map((t) => String(t.props?.children));
    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) expect(title).not.toMatch(/bugün|sürüyor/i);
    const markup = await chartMarkup(buckets);
    expect(markup).not.toMatch(/bugün|sürüyor/i);
    expect(await detailsMarkup(buckets)).not.toMatch(/bugün|sürüyor/i);
  });

  it("does not move the y-axis: a partial busiest day still sets the maximum, labels identical", async () => {
    const withFlag = await chartMarkup(partialBusiestBuckets());
    const without = await chartMarkup(busiestDayBuckets());

    const labelsWithFlag = await yAxisLabels(partialBusiestBuckets());
    expect(labelsWithFlag).toEqual(["0", "2.500", "5.000", "7.500", "10.000"]);
    expect(labelsWithFlag).toEqual(await yAxisLabels(busiestDayBuckets()));

    // Same geometry: the bars are scaled to the same axis, only styling differs.
    const geometry = (markup: string) =>
      rectTags(markup).map((r) => [attr(r, "x"), attr(r, "y"), attr(r, "height")]);
    expect(geometry(withFlag)).toEqual(geometry(without));
  });

  it("the partial bar never overshoots the top gridline", async () => {
    const markup = await chartMarkup(partialBusiestBuckets());

    const ys = [...markup.matchAll(/<line\b[^>]*>/g)].map((m) => attr(m[0], "y1"));
    const top = Math.min(...ys);
    for (const rect of rectTags(markup)) {
      expect(attr(rect, "y")).toBeGreaterThanOrEqual(top - 0.001);
    }
  });

  it("adds no partial note to the unavailable branch", async () => {
    mockBuckets = null;

    const tree = await TrendsPage();
    const text = collectText(tree).join(" ");

    expect(text).not.toContain("son gün dahil");
    expect(text).not.toContain("eksik");
  });

  it("reads the flag from the fetched buckets: no clock in page.tsx", () => {
    const src = readFileSync(resolve(__dirname, "page.tsx"), "utf8");
    // Strip comments so prose can mention Date.now() (the file header does not,
    // but the guard must not depend on that).
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    expect(code).not.toMatch(/Date\.now\s*\(/);
    expect(code).not.toMatch(/new Date\b/);
    expect(code).not.toMatch(/istanbulDayKey/);
    expect(code).toMatch(/\.partial\b/);
  });
});

// ---------------------------------------------------------------------------
// h43-entities-3: a rising row links to its /gundem hub only when the hub is
// indexable. "Merkez Bankası · Bugün 38 haber" used to open a noindex hub with
// one unrelated cluster. The hub reads happen at page level, after
// getRisingEntities resolved, for at most MAX_ITEMS rows, and never inside a
// "use cache" function (tests/guards/cache-retry-prerender.test.ts).
// ---------------------------------------------------------------------------

/** A hub read holding `n` bundles (only the length is read). */
function hubWith(n: number): unknown {
  return { bundles: Array.from({ length: n }, () => ({})), total: n, asOfMs: 0 };
}

function risingRow(key: string, label: string): RisingItem {
  return {
    key,
    label,
    href: `/gundem/${key}`,
    count: 30,
    baseline: 5,
    ratio: 6,
    ratioLabel: "6,0",
    ratioIsLowerBound: false,
    isNew: false,
  };
}

function okRising(items: RisingItem[]): RisingResult {
  return { status: "ok", day: "2026-11-05", items };
}

/** The data prop the page hands to <RisingTopics>. */
async function risingData(): Promise<RisingResult | null> {
  const tree = await TrendsPage();
  const section = collectElements(tree).find((el) => el.type === RisingTopics);
  expect(section).toBeDefined();
  return section!.props!.data as RisingResult | null;
}

function hrefs(data: RisingResult | null): string[] {
  if (data === null || data.status !== "ok") throw new Error("expected ok data");
  return data.items.map((i) => i.href);
}

describe("/trends page: rising rows link only to indexable hubs", () => {
  beforeEach(() => {
    callLog.length = 0;
    mockHubs = {};
    mockBuckets = zeroBuckets();
    vi.mocked(getEntityHub).mockClear();
  });

  it("keeps the /gundem link for an indexable hub and sends thin, empty and failed hubs to the home search", async () => {
    mockRising = okRising([
      risingRow("msb", "MSB"),
      risingRow("tcmb", "Merkez Bankası"),
      risingRow("hamas", "Hamas"),
      risingRow("meclis", "Meclis"),
    ]);
    mockHubs = {
      msb: hubWith(9), // indexable
      tcmb: hubWith(1), // thin
      hamas: hubWith(0), // empty
      // meclis: not mocked -> null (failed read)
    };

    expect(hrefs(await risingData())).toEqual([
      "/gundem/msb",
      "/?q=Merkez%20Bankas%C4%B1",
      "/?q=Hamas",
      "/?q=Meclis",
    ]);
  });

  it("renders the thin row's link in the page markup", async () => {
    mockRising = okRising([risingRow("tcmb", "Merkez Bankası")]);
    mockHubs = { tcmb: hubWith(1) };

    const tree = await TrendsPage();
    const section = collectElements(tree).find((el) => el.type === RisingTopics);
    const html = renderToStaticMarkup(section as unknown as React.ReactElement);

    expect(html).toContain('href="/?q=Merkez%20Bankas%C4%B1"');
    expect(html).not.toContain("/gundem/tcmb");
  });

  it("changes only href: counts, ratios and the day label pass through", async () => {
    const items = [risingRow("tcmb", "Merkez Bankası")];
    mockRising = okRising(items);
    mockHubs = { tcmb: hubWith(1) };

    const data = await risingData();

    expect(data).toEqual({
      ...okRising([{ ...items[0]!, href: "/?q=Merkez%20Bankas%C4%B1" }]),
    });
    // The cached result itself is never mutated.
    expect(items[0]!.href).toBe("/gundem/tcmb");
  });

  it("reads the hubs only after the rising list resolved, once per row", async () => {
    mockRising = okRising([risingRow("msb", "MSB"), risingRow("tcmb", "Merkez Bankası")]);

    await TrendsPage();

    expect(callLog[0]).toBe("rising");
    const hubReads = callLog.filter((c) => c.startsWith("hub:")).sort();
    expect(hubReads).toEqual(["hub:msb", "hub:tcmb"]);
    expect(callLog.lastIndexOf("rising")).toBeLessThan(callLog.indexOf(hubReads[0]!));
  });

  it("reads at most MAX_ITEMS hubs and lists at most MAX_ITEMS rows", async () => {
    expect(MAX_ITEMS).toBe(8);
    mockRising = okRising(
      Array.from({ length: 12 }, (_, i) => risingRow(`k${i}`, `Konu ${i}`)),
    );

    const data = await risingData();

    expect(getEntityHub).toHaveBeenCalledTimes(MAX_ITEMS);
    expect(vi.mocked(getEntityHub).mock.calls.map((c) => c[0])).toEqual(
      Array.from({ length: MAX_ITEMS }, (_, i) => `k${i}`),
    );
    expect(hrefs(data)).toHaveLength(MAX_ITEMS);
  });

  it.each([
    ["a failed rising read (null)", null as RisingResult | null],
    ["insufficient history", { status: "insufficient" } as RisingResult],
    ["nothing rising", okRising([])],
  ])("reads no hub for %s and passes the result through", async (_name, rising) => {
    mockRising = rising;

    const data = await risingData();

    expect(getEntityHub).not.toHaveBeenCalled();
    expect(data).toBe(rising);
  });

  it("links the same way in the unavailable-chart branch", async () => {
    mockBuckets = null;
    mockRising = okRising([risingRow("msb", "MSB"), risingRow("tcmb", "Merkez Bankası")]);
    mockHubs = { msb: hubWith(9), tcmb: hubWith(2) };

    expect(hrefs(await risingData())).toEqual(["/gundem/msb", "/?q=Merkez%20Bankas%C4%B1"]);
  });

  it("never reads a hub inside a \"use cache\" function (the page itself carries no cache directive)", () => {
    const src = readFileSync(resolve(__dirname, "page.tsx"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    expect(code).not.toMatch(/["']use cache/);
    expect(code).toMatch(/getEntityHub\(/);
    expect(code).toMatch(/withHubLinks\(/);
  });
});

// ---------------------------------------------------------------------------
// h46-mobile-3: on a 360-390 px phone the chart opened scrolled right with the
// value axis off-screen, and its labels (svg <text>, sized in viewBox units, so
// 10 units in a 900-unit viewBox shown 640 px wide) rendered at about 7 px; the
// day labels carried no month. The fix mirrors /kalite (h25-visual-2): every
// label is HTML around the svg. The y labels sit in a fixed gutter BESIDE the
// scroller (a sibling, so they never scroll away); the x labels sit over the
// svg's blank bottom padding inside the scroller (so they scroll with the bars)
// and carry the Turkish month on the first label and after a month change.
// ---------------------------------------------------------------------------

/** Thirty consecutive days, 2026-10-28 .. 2026-11-26: crosses a month boundary. */
function octNovBuckets(): Bucket[] {
  const t0 = Date.parse("2026-10-28T00:00:00Z");
  return Array.from({ length: WINDOW_DAYS }, (_, i) => ({
    day: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10),
    counts: { iktidar: i + 1, bagimsiz: 1, muhalefet: 1 },
    total: i + 3,
  }));
}

function withAttr(tree: unknown, name: string): Elementish[] {
  return collectElements(tree).filter((el) => el.props?.[name] !== undefined);
}

function classTokens(el: Elementish): string[] {
  return String(el.props?.className ?? "")
    .split(/\s+/)
    .filter(Boolean);
}

/** The px size of a literal `text-[Npx]` class, or null when there is none. */
function pxSize(el: Elementish): number | null {
  const token = classTokens(el).find((t) => /^text-\[\d+(\.\d+)?px\]$/.test(t));
  return token ? Number(token.slice(6, -3)) : null;
}

function styleOf(el: Elementish): { top?: string; left?: string; height?: string } {
  return (el.props?.style ?? {}) as { top?: string; left?: string; height?: string };
}

const xLabelTexts = (labels: Elementish[]) =>
  labels.map((el) => collectText(el.props?.children).join(""));

async function chartParts(buckets: Bucket[]) {
  mockBuckets = buckets;
  const tree = await TrendsPage();
  const scroller = collectElements(tree).find((el) => el.type === ScrollToEnd)!;
  const gutter = withAttr(tree, "data-y-axis")[0];
  return {
    tree,
    scroller,
    gutter,
    yLabels: withAttr(tree, "data-y-label"),
    xLabels: withAttr(scroller.props?.children, "data-x-label"),
  };
}

describe("/trends page — labels are HTML, not svg text (h46-mobile-3)", () => {
  it("the chart svg contains no <text> element and nothing in the page carries a fontSize prop", async () => {
    const { tree } = await chartParts(octNovBuckets());

    const svg = collectElements(tree).find((el) => el.type === "svg")!;
    expect(collectElements(svg.props?.children).some((el) => el.type === "text")).toBe(false);
    expect(collectElements(tree).some((el) => el.props?.fontSize !== undefined)).toBe(false);
    const markup = renderToStaticMarkup(svg as unknown as React.ReactElement);
    expect(markup).not.toContain("<text");
    expect(markup).not.toContain("font-size");
  });

  it("keeps the svg's role=img, aria-label, gridlines and bar <title>s", async () => {
    const { tree } = await chartParts(octNovBuckets());

    const svg = collectElements(tree).find((el) => el.type === "svg")!;
    expect(svg.props?.role).toBe("img");
    expect(String(svg.props?.["aria-label"])).toContain("Toplam");
    const markup = renderToStaticMarkup(svg as unknown as React.ReactElement);
    expect(markup.match(/<line\b/g)?.length).toBeGreaterThan(1);
    expect(markup).toContain("<title>2026-11-26 · ");
  });

  it("plots from the svg's left edge: gridlines and the first bar start within 8 units of x=0", async () => {
    const markup = await chartMarkup(octNovBuckets());

    const x1s = [...markup.matchAll(/<line\b[^>]*>/g)].map((m) => attr(m[0], "x1"));
    expect(x1s.length).toBeGreaterThan(1);
    for (const x1 of x1s) expect(x1).toBe(PAD_LEFT_FOR_TEST);
    const firstBarX = Math.min(...rectTags(markup).map((r) => attr(r, "x")));
    expect(firstBarX).toBe(PAD_LEFT_FOR_TEST);
    // The right padding still keeps the last bar inside the viewBox.
    const lastBar = Math.max(...rectTags(markup).map((r) => attr(r, "x") + attr(r, "width")));
    expect(lastBar).toBeCloseTo(CHART_W_FOR_TEST - PAD_RIGHT_FOR_TEST, 6);
  });
});

describe("/trends page — y labels sit in a fixed gutter beside the scroller (h46-mobile-3)", () => {
  it("the gutter is aria-hidden, before the scroller, and a sibling of it, never a descendant", async () => {
    const { tree, scroller, gutter, yLabels } = await chartParts(busiestDayBuckets());

    expect(gutter).toBeDefined();
    expect(gutter!.props?.["aria-hidden"]).toBe("true");
    expect(parentOf(tree, gutter)).not.toBeNull();
    expect(parentOf(tree, gutter)).toBe(parentOf(tree, scroller));
    const kids = parentOf(tree, scroller)!.props!.children as unknown[];
    expect(kids.indexOf(gutter)).toBeLessThan(kids.indexOf(scroller));
    // No y label inside the scrolling region: they cannot scroll away.
    expect(withAttr(scroller.props?.children, "data-y-label")).toHaveLength(0);
    expect(withAttr(scroller.props?.children, "data-y-axis")).toHaveLength(0);
    // Every y label belongs to the gutter.
    expect(withAttr(gutter!.props?.children, "data-y-label")).toHaveLength(yLabels.length);
  });

  it("the row is a fixed-gutter grid and sizes the gutter by container units", async () => {
    const { tree, gutter } = await chartParts(busiestDayBuckets());

    // A grid, not a flex row: the second column is minmax(0,1fr), so the 640 px
    // box inside the scroller overflows the scroller instead of widening the page.
    const row = withAttr(tree, "data-trends-chart")[0]!;
    const tokens = classTokens(row);
    expect(tokens).toContain("grid");
    expect(tokens).toContain("@container");
    const columns = tokens.find((t) => t.startsWith("grid-cols-["));
    const gutterRem = columns?.match(/^grid-cols-\[(\d+(?:\.\d+)?)rem_minmax\(0,1fr\)\]$/)?.[1];
    expect(gutterRem, `gutter column in ${columns}`).toBeDefined();
    expect(classTokens(gutter!)).toContain("relative");
    // The gutter is as tall as the svg box: max(640px, row width - gutter) at the
    // viewBox aspect ratio, so the percentage tops line up with the gridlines
    // whatever the scrollbar does to the scroller's own height.
    const height = String(styleOf(gutter!).height);
    expect(height).toContain("100cqw");
    expect(height).toContain("max(640px");
    expect(height).toContain(`${gutterRem}rem`);
    expect(height).toContain(String(CHART_H_FOR_TEST / CHART_W_FOR_TEST).slice(0, 6));
  });

  it("the svg's box is at least 640 px wide and drops the inline-svg descender gap", async () => {
    const { tree, scroller } = await chartParts(busiestDayBuckets());

    const svg = collectElements(tree).find((el) => el.type === "svg")!;
    const box = parentOf(scroller.props?.children, svg);
    expect(box).not.toBeNull();
    expect(classTokens(box!)).toContain("min-w-[640px]");
    expect(classTokens(box!)).toContain("relative");
    expect(classTokens(svg)).toContain("block");
    expect(classTokens(svg)).toContain("w-full");
  });

  it("has one label per scale tick, formatted with formatCountTr, at text-[11px] or larger", async () => {
    const { yLabels } = await chartParts(busiestDayBuckets());

    expect(yLabels.map((el) => collectText(el.props?.children).join(""))).toEqual(
      [0, 2500, 5000, 7500, 10000].map((t) => formatCountTr(t)),
    );
    for (const el of yLabels) {
      expect(el.type).toBe("span");
      expect(pxSize(el)).not.toBeNull();
      expect(pxSize(el)!).toBeGreaterThanOrEqual(11);
      expect(classTokens(el)).toContain("absolute");
      expect(classTokens(el)).toContain("whitespace-nowrap");
    }
  });

  it("puts each label at its gridline: top = (PAD_TOP + PLOT_H * (1 - t / max)) / CHART_H", async () => {
    const buckets = busiestDayBuckets();
    const { yLabels } = await chartParts(buckets);
    const plotH = CHART_H_FOR_TEST - PAD_TOP_FOR_TEST - PAD_BOTTOM_FOR_TEST;
    const ticks = [0, 2500, 5000, 7500, 10000];

    const tops = yLabels.map((el) => parseFloat(String(styleOf(el).top)));
    ticks.forEach((t, i) => {
      const expected = ((PAD_TOP_FOR_TEST + plotH * (1 - t / 10000)) / CHART_H_FOR_TEST) * 100;
      expect(tops[i]).toBeCloseTo(expected, 1);
    });
    // And they agree with the svg's own gridlines.
    const markup = await chartMarkup(buckets);
    const lineTops = [...markup.matchAll(/<line\b[^>]*>/g)].map(
      (m) => (attr(m[0], "y1") / CHART_H_FOR_TEST) * 100,
    );
    expect(lineTops).toHaveLength(tops.length);
    tops.forEach((top, i) => expect(top).toBeCloseTo(lineTops[i]!, 1));
    // Lowest value is lowest on the page; every top is inside the svg box.
    for (let i = 1; i < tops.length; i++) expect(tops[i]!).toBeLessThan(tops[i - 1]!);
    for (const top of tops) {
      expect(top).toBeGreaterThan(0);
      expect(top).toBeLessThan(100);
    }
  });

  it("keeps the 0 / 1 axis of an empty month in the gutter", async () => {
    const { yLabels } = await chartParts(zeroBuckets());

    expect(yLabels.map((el) => collectText(el.props?.children).join(""))).toEqual(["0", "1"]);
  });

  it("renders no gutter, no labels and no chart row on the unavailable branch", async () => {
    mockBuckets = null;
    const tree = await TrendsPage();

    expect(withAttr(tree, "data-y-axis")).toHaveLength(0);
    expect(withAttr(tree, "data-y-label")).toHaveLength(0);
    expect(withAttr(tree, "data-x-label")).toHaveLength(0);
    expect(withAttr(tree, "data-trends-chart")).toHaveLength(0);
  });
});

describe("/trends page — the zone legend is at least 11 px (h46-mobile-3)", () => {
  it("renders every legend item at text-[11px] or larger", async () => {
    mockBuckets = octNovBuckets();
    const tree = await TrendsPage();

    const items = collectElements(tree).filter(
      (el) => el.type === "li" && classTokens(el).includes("uppercase"),
    );
    expect(items).toHaveLength(3);
    for (const li of items) expect(pxSize(li)!).toBeGreaterThanOrEqual(11);
  });
});

describe("/trends page — x labels are HTML and carry the month (h46-mobile-3)", () => {
  it("are aria-hidden HTML spans inside the scroller, so they scroll with the bars", async () => {
    const { tree, scroller, xLabels } = await chartParts(octNovBuckets());

    expect(xLabels).toHaveLength(7);
    // Not in the gutter and not outside the scroller.
    expect(withAttr(tree, "data-x-label")).toHaveLength(7);
    const row = withAttr(scroller.props?.children, "data-x-axis")[0]!;
    expect(row.props?.["aria-hidden"]).toBe("true");
    expect(withAttr(row.props?.children, "data-x-label")).toHaveLength(7);
    for (const el of xLabels) {
      expect(el.type).toBe("span");
      expect(pxSize(el)!).toBeGreaterThanOrEqual(11);
      expect(classTokens(el)).toContain("whitespace-nowrap");
    }
  });

  it("pins the Oct to Nov window: first '28 Eki', first after the change '02 Kas', the rest day-only", async () => {
    const { xLabels } = await chartParts(octNovBuckets());

    expect(xLabelTexts(xLabels)).toEqual(["28 Eki", "02 Kas", "07", "12", "17", "22", "26"]);
  });

  it("gives the first label its month inside a single month too", async () => {
    const { xLabels } = await chartParts(zeroBuckets());

    expect(xLabelTexts(xLabels)).toEqual(["01 Oca", "06", "11", "16", "21", "26", "30"]);
  });

  it("positions each label by percentage of the viewBox width, centred on its bar", async () => {
    const { xLabels } = await chartParts(octNovBuckets());
    const bw = barWidthForTest();
    const centreOf = (idx: number) =>
      ((PAD_LEFT_FOR_TEST + idx * (bw + BAR_GAP_FOR_TEST) + bw / 2) / CHART_W_FOR_TEST) * 100;

    // idx 5, 10, ... 25 are plain centred labels.
    [5, 10, 15, 20, 25].forEach((idx, i) => {
      const el = xLabels[i + 1]!;
      expect(parseFloat(String(styleOf(el).left))).toBeCloseTo(centreOf(idx), 1);
      expect(classTokens(el)).toContain("-translate-x-1/2");
    });
    // Every label is a percentage inside the svg, strictly left to right.
    const lefts = xLabels.map((el) => parseFloat(String(styleOf(el).left)));
    for (const left of lefts) {
      expect(left).toBeGreaterThan(0);
      expect(left).toBeLessThan(100);
    }
    for (let i = 1; i < lefts.length; i++) expect(lefts[i]!).toBeGreaterThan(lefts[i - 1]!);
  });

  it("anchors the first label at its bar's left edge and the last at its right edge, so a month label never clips", async () => {
    const { xLabels } = await chartParts(octNovBuckets());
    const bw = barWidthForTest();
    const first = xLabels[0]!;
    const last = xLabels[xLabels.length - 1]!;

    expect(parseFloat(String(styleOf(first).left))).toBeCloseTo(
      (PAD_LEFT_FOR_TEST / CHART_W_FOR_TEST) * 100,
      1,
    );
    expect(classTokens(first)).not.toContain("-translate-x-1/2");
    expect(classTokens(first)).not.toContain("-translate-x-full");
    expect(parseFloat(String(styleOf(last).left))).toBeCloseTo(
      ((PAD_LEFT_FOR_TEST + (WINDOW_DAYS - 1) * (bw + BAR_GAP_FOR_TEST) + bw) / CHART_W_FOR_TEST) *
        100,
      1,
    );
    expect(classTokens(last)).toContain("-translate-x-full");
  });

  it("puts the labels in the blank padding under the bars, inside the svg's box", async () => {
    const { xLabels } = await chartParts(octNovBuckets());
    const baseline =
      ((CHART_H_FOR_TEST - PAD_BOTTOM_FOR_TEST) / CHART_H_FOR_TEST) * 100;

    for (const el of xLabels) {
      const top = parseFloat(String(styleOf(el).top));
      expect(top).toBeGreaterThan(baseline);
      expect(top).toBeLessThan(100);
      expect(classTokens(el)).toContain("-translate-y-1/2");
    }
  });

  it("renders the labels for an all-zero month, none for the unavailable branch", async () => {
    expect((await chartParts(zeroBuckets())).xLabels).toHaveLength(7);
    mockBuckets = null;
    expect(withAttr(await TrendsPage(), "data-x-label")).toHaveLength(0);
  });

  it("leaves the h17-a11y-1 scroller contract intact: name, class, one svg inside", async () => {
    const { scroller } = await chartParts(octNovBuckets());

    expect(scroller.props?.label).toBe("Son 30 gün grafiği (yatay kaydırılabilir)");
    expect(scroller.props?.className).toBe("w-full overflow-x-auto spectrum-glow");
    expect(
      collectElements(scroller.props?.children).filter((el) => el.type === "svg"),
    ).toHaveLength(1);
  });

  it("keeps the chart data unchanged: same bars, same titles, same total", async () => {
    const buckets = octNovBuckets();
    mockBuckets = buckets;
    const tree = await TrendsPage();

    const titles = collectElements(tree).filter((el) => el.type === "title");
    expect(titles).toHaveLength(WINDOW_DAYS * 3);
    expect(titles[0]!.props?.children).toBe(`2026-10-28 · ${ZONE_META.iktidar.label}: 1`);
    const sum = buckets.reduce((acc, b) => acc + b.total, 0);
    expect(collectText(tree).join(" ")).toContain(formatCountTr(sum));
  });
});
