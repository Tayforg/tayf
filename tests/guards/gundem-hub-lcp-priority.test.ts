import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (h159-perf-3): /gundem/[key] must not promote its first
// card's banner to fetchpriority=high when the trend chart pushes that card
// below the fold.
//
// mobileBannerImageProps(index) makes card 0 eager, preloaded and
// fetchpriority=high. Since PR #283 (6b053ac) page 1 of a hub draws
// HubTrendChart and the spectrum section above the list, so the first card of
// /gundem/erdogan sits at y=898 on a 915 px viewport (17 px visible). Its
// 17 KB banner was requested at High priority at about 650 ms, never became the
// LCP (the chart caption does), and competed with the 20 KB render-blocking CSS.
//
// The page therefore decides once whether the chart is shown (`trendShown`, the
// chart conditional) and whether the FULL chart is drawn (`trendChartDrawn`:
// trendShown and hubTrendState(trend.days) === "chart"), and hands each card
// hubCardBannerIndex(i, trendChartDrawn): undefined while the full chart is
// above the list (lazy banner), the position itself otherwise (page 2+, no
// chart, or a sparse or empty chart: HubTrendChart then draws only a heading and
// a note, or nothing, so card 0 is back above the fold and keeps its priority
// hint).
//
// The page is a server component, so this reads the source as text and uses
// indexOf / includes only (no regex over JSX).
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const PAGE_PATH = resolve(ROOT, "src/app/gundem/[key]/page.tsx");
const page = readFileSync(PAGE_PATH, "utf8");

/** How many times `needle` occurs in `haystack` (non-overlapping, linear). */
function count(haystack: string, needle: string): number {
  let n = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return n;
    n += 1;
    from = at + needle.length;
  }
}

describe("/gundem/[key] first-card banner priority (h159-perf-3)", () => {
  it("declares trendShown with the same semantics as the old chart conditional", () => {
    expect(page).toContain('const trendShown = trend !== null && trend.status === "ok"');
  });

  it("decides 'chart shown' in one place: the status check appears once", () => {
    expect(count(page, 'trend.status === "ok"')).toBe(1);
  });

  it("draws HubTrendChart behind trendShown", () => {
    const at = page.indexOf("<HubTrendChart");
    expect(at).toBeGreaterThan(-1);
    expect(count(page, "<HubTrendChart")).toBe(1);
    const lead = page.slice(Math.max(0, at - 40), at);
    expect(lead).toContain("{trendShown ? (");
  });

  it("derives trendChartDrawn from trendShown and the sparse/chart state of the days", () => {
    expect(page).toContain('const trendChartDrawn = trendShown && hubTrendState(trend.days) === "chart"');
    expect(count(page, "const trendChartDrawn")).toBe(1);
  });

  it("hands every ClusterCard hubCardBannerIndex(i, trendChartDrawn), never the bare position or trendShown", () => {
    expect(page).toContain("index={hubCardBannerIndex(i, trendChartDrawn)}");
    expect(page).not.toContain("index={hubCardBannerIndex(i, trendShown)}");
    expect(page).not.toContain("index={i}");
    expect(count(page, "<ClusterCard")).toBe(1);
  });

  it("imports hubTrendState from the hub-trend module", () => {
    const from = page.indexOf('from "@/lib/entities/hub-trend";');
    expect(from).toBeGreaterThan(-1);
    const open = page.lastIndexOf("import {", from);
    expect(open).toBeGreaterThan(-1);
    expect(page.slice(open, from)).toContain("hubTrendState");
  });

  it("imports hubCardBannerIndex from the entity-hub module", () => {
    const from = page.indexOf('from "@/lib/entities/entity-hub";');
    expect(from).toBeGreaterThan(-1);
    const open = page.lastIndexOf("import {", from);
    expect(open).toBeGreaterThan(-1);
    expect(page.slice(open, from)).toContain("hubCardBannerIndex");
  });

  it("declares trendShown and trendChartDrawn before the JSX that uses them, in that order", () => {
    const shown = page.indexOf("const trendShown");
    const drawn = page.indexOf("const trendChartDrawn");
    expect(shown).toBeGreaterThan(-1);
    expect(drawn).toBeGreaterThan(shown);
    expect(shown).toBeLessThan(page.indexOf("<HubTrendChart"));
    expect(drawn).toBeLessThan(page.indexOf("<ClusterCard"));
  });
});
