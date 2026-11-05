import { describe, it, expect, vi } from "vitest";
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

vi.mock("@/lib/trends/rising-query", () => ({
  getRisingEntities: vi.fn(async () => mockRising),
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
import type { RisingResult } from "@/lib/trends/rising";
import { ZONE_META } from "@/lib/bias/config";
import { ScrollToEnd } from "@/components/trends/scroll-to-end";

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
  dayLabel: "Bugün",
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
    expect(kids[heroIdx + 1]?.props?.data).toBe(RISING_OK);
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

/** Texts of the y-axis labels (text-anchor="end"); x labels are "middle". */
function yLabels(markup: string): string[] {
  return [...markup.matchAll(/<text[^>]*text-anchor="end"[^>]*>([^<]*)<\/text>/g)].map(
    (m) => m[1]!,
  );
}

describe("/trends page — nice-number y-axis", () => {
  it("labels the axis 0 / 2.500 / 5.000 / 7.500 / 10.000 for a busiest day of 8791", async () => {
    const markup = await chartMarkup(busiestDayBuckets());

    expect(yLabels(markup)).toEqual(["0", "2.500", "5.000", "7.500", "10.000"]);
  });

  it("never prints the raw quarter-of-the-maximum values (8791, 2198, 4396, 6593)", async () => {
    const labels = yLabels(await chartMarkup(busiestDayBuckets()));

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
    const markup = await chartMarkup(zeroBuckets());

    expect(yLabels(markup)).toEqual(["0", "1"]);
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

  it("renders exactly one <details>, a later sibling of the scroller", async () => {
    mockBuckets = seededBuckets().buckets;

    const tree = await TrendsPage();

    const details = tableDetails(tree);
    expect(details).toHaveLength(1);
    const scroller = collectElements(tree).find((el) => el.type === ScrollToEnd)!;
    const parent = parentOf(tree, scroller);
    expect(parent).not.toBeNull();
    expect(parentOf(tree, details[0])).toBe(parent);
    const kids = parent!.props!.children as unknown[];
    expect(kids.indexOf(details[0])).toBeGreaterThan(kids.indexOf(scroller));
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

// Mirrors of page.tsx's private chart geometry (900 wide, 48 left, 16 right, 4 gap).
const PAD_LEFT_FOR_TEST = 48;
const BAR_GAP_FOR_TEST = 4;
function barWidthForTest(): number {
  return (900 - 48 - 16 - BAR_GAP_FOR_TEST * (WINDOW_DAYS - 1)) / WINDOW_DAYS;
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

    expect(yLabels(withFlag)).toEqual(["0", "2.500", "5.000", "7.500", "10.000"]);
    expect(yLabels(withFlag)).toEqual(yLabels(without));

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
