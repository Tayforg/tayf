import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
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
    buckets.push({
      day: `2024-01-${String((i % 28) + 1).padStart(2, "0")}`,
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

  it("the page description mentions today's rising topics", () => {
    expect(String(metadata.description)).toContain("bugün yükselen konular");
  });
});
