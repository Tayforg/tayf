import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { niceScale } from "@/lib/format/nice-scale";
import { formatCountTr } from "@/lib/format/number-tr";
import {
  HUB_TREND_CAPTION,
  HUB_TREND_HEADING,
  HUB_TREND_TABLE_TOGGLE,
  hubTrendAriaLabel,
  hubTrendEarlierNote,
  hubTrendSparseEarlierNote,
  hubTrendSparseLine,
  hubTrendTableCaption,
  hubTrendTotalLine,
  type HubTrendDay,
} from "@/lib/entities/hub-trend";
import { xAxisLabels } from "@/lib/trends/axis-labels";
import { trendBarTitle } from "@/lib/trends/bar-title";
import { dayLabelTr } from "@/lib/trends/day-label";

import { HubTrendChart } from "./hub-trend-chart";

// ---------------------------------------------------------------------------
// h154-hub-trend. The daily bar chart of /gundem/[key] (migration 206's entity_cluster_days), a synchronous server
// component. Markup is read with includes / indexOf / split counts only: no regular expression ever strips or parses
// the HTML, and every text rewrite is replaceAll.
// ---------------------------------------------------------------------------

const DAYS = [
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
] as const;
const ERDOGAN = [34, 26, 11, 29, 30, 19, 19, 27, 19, 32, 49, 58, 51, 12] as const;

const daysOf = (counts: readonly number[] = ERDOGAN): HubTrendDay[] =>
  DAYS.map((day, i) => ({ day, clusters: counts[i] as number }));

const render = (counts: readonly number[] = ERDOGAN, earlier = 41, label = "Erdoğan"): string =>
  renderToStaticMarkup(<HubTrendChart label={label} days={daysOf(counts)} earlier={earlier} />);

/** `counts` with only the last day's value set, the others 0. */
const lastDayOnly = (n: number): number[] => DAYS.map((_, i) => (i === 13 ? n : 0));

// The /trends class strings, literally (src/app/trends/page.tsx), plus top-1/2 on the x labels.
const Y_LABEL_CLASS =
  "absolute right-1 -translate-y-1/2 whitespace-nowrap font-mono text-[11px] leading-none tabular-nums text-muted-foreground";
const X_LABEL_CLASS = {
  start:
    "absolute top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[11px] leading-none tabular-nums text-muted-foreground",
  center:
    "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[11px] leading-none tabular-nums text-muted-foreground",
  end: "absolute top-1/2 -translate-x-full -translate-y-1/2 whitespace-nowrap font-mono text-[11px] leading-none tabular-nums text-muted-foreground",
} as const;

const SUMMARY_CLASS =
  "cursor-pointer select-none rounded py-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/** The text between the first `open` and the next `close` at or after it; throws when absent. */
function between(haystack: string, open: string, close: string, from = 0): string {
  const a = haystack.indexOf(open, from);
  if (a < 0) throw new Error(`no "${open}"`);
  const b = haystack.indexOf(close, a + open.length);
  if (b < 0) throw new Error(`no "${close}" after "${open}"`);
  return haystack.slice(a + open.length, b);
}

/** The value of an attribute inside one tag chunk, or null. */
function attr(chunk: string, name: string): string | null {
  const needle = ` ${name}="`;
  const at = chunk.indexOf(needle);
  if (at < 0) return null;
  const start = at + needle.length;
  return chunk.slice(start, chunk.indexOf('"', start));
}

/** Every <rect ...>...</rect> of the markup, as the text from `<rect` to `</rect>`. */
const rects = (html: string): string[] =>
  html
    .split("<rect")
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf("</rect>")));

const titleOf = (rect: string): string => between(rect, "<title>", "</title>");

/** The `<svg ...>...</svg>` part. */
const svgOf = (html: string): string => html.slice(html.indexOf("<svg"), html.indexOf("</svg>") + "</svg>".length);

/** The pct() of src/app/trends/page.tsx, restated here on purpose. */
const pct = (units: number, total: number): string => `${((units / total) * 100).toFixed(2)}%`;

// The geometry the spec fixes.
const VIEW_W = 420;
const VIEW_H = 112;
const PAD_TOP = 6;
const PAD_BOTTOM = 6;
const PAD_LEFT = 2;
const PAD_RIGHT = 2;
const BAR_GAP = 6;
const PLOT_H = VIEW_H - PAD_TOP - PAD_BOTTOM;
const PLOT_W = VIEW_W - PAD_LEFT - PAD_RIGHT;
const BAR_W = (PLOT_W - BAR_GAP * 13) / 14;

describe("<HubTrendChart> chart state", () => {
  it("chart state: a section labelled by its h2, the caption, one svg role=img with the exact aria-label", () => {
    const html = render();
    expect(html.startsWith("<section")).toBe(true);
    expect(html.endsWith("</section>")).toBe(true);
    const sectionTag = html.slice(0, html.indexOf(">") + 1);
    expect(sectionTag).toContain('aria-labelledby="hub-trend-heading"');
    expect(sectionTag).toContain("data-hub-trend");
    expect(sectionTag).toContain('class="space-y-3 rounded-xl ring-1 ring-border/60 bg-card/60 p-4 sm:p-6"');
    expect(count(html, "<section")).toBe(1);

    expect(html).toContain(
      `<h2 id="hub-trend-heading" class="text-sm font-semibold text-foreground">${HUB_TREND_HEADING}</h2>`,
    );
    expect(count(html, "<h2")).toBe(1);
    expect(HUB_TREND_HEADING).toBe("Günlere göre küme sayısı");

    // the caption is the first paragraph, right after the heading
    expect(html).toContain(`</h2><p class="text-xs text-muted-foreground">${HUB_TREND_CAPTION}</p>`);

    // exactly one svg and one image role, with the exact name
    expect(count(html, "<svg")).toBe(1);
    expect(count(html, 'role="img"')).toBe(1);
    const svgTag = svgOf(html).slice(0, svgOf(html).indexOf(">") + 1);
    expect(attr(svgTag, "role")).toBe("img");
    expect(attr(svgTag, "aria-label")).toBe(hubTrendAriaLabel("Erdoğan", 416));
    expect(attr(svgTag, "aria-label")).toBe(
      "Erdoğan: son 14 günde ilk haberin gününe göre küme sayısı, günlük sütun grafiği. Grafikte 416 küme. Son günün sayımı eksik.",
    );
    expect(attr(svgTag, "viewBox")).toBe("0 0 420 112");
    expect(attr(svgTag, "preserveAspectRatio")).toBe("none");
    expect(attr(svgTag, "class")).toBe("block h-28 w-full");
  });

  it("escapes a label with markup characters in the aria-label and the table caption", () => {
    const html = render(ERDOGAN, 0, 'A&B "q" <b>');
    expect(html).not.toContain('<b>"');
    expect(html).toContain("A&amp;B &quot;q&quot; &lt;b&gt;: son 14 günde");
    expect(count(html, "<b>")).toBe(0);
  });

  it("draws one rect per non-zero day, each with its trendBarTitle, and nothing for a zero day", () => {
    const counts = [0, 26, 0, 29, 30, 0, 19, 27, 19, 0, 49, 58, 51, 12];
    const html = render(counts, 3);
    const found = rects(html);
    const expectedDays = DAYS.filter((_, i) => (counts[i] as number) > 0);
    expect(found).toHaveLength(expectedDays.length);
    expect(found).toHaveLength(10);

    const titles = found.map(titleOf);
    const expected = DAYS.flatMap((day, i) =>
      (counts[i] as number) > 0 ? [trendBarTitle(day, "Küme", counts[i] as number, i === 13)] : [],
    );
    expect(titles).toEqual(expected);
    // a zero day has no title and no bar at all
    for (const [i, day] of DAYS.entries()) {
      if (counts[i] === 0) expect(html.includes(`${day} · Küme`), day).toBe(false);
    }
    // one string per <title> (React 19 would render several children as an empty title)
    expect(html.includes("<title></title>")).toBe(false);
    expect(count(html, "<title>")).toBe(10);
    // counts use tr-TR grouping in the name
    expect(titles[0]).toBe("2026-10-31 · Küme: 26");
    expect(trendBarTitle("2026-11-11", "Küme", 1234)).toBe("2026-11-11 · Küme: 1.234");
  });

  it("draws every day when none is zero, with bars scaled to niceScale of the busiest day", () => {
    const html = render();
    const found = rects(html);
    expect(found).toHaveLength(14);

    const scale = niceScale(58);
    expect(scale.ticks).toEqual([0, 20, 40, 60]);
    const barWidth = BAR_W;
    found.forEach((rect, i) => {
      const n = ERDOGAN[i] as number;
      const height = (n / scale.max) * PLOT_H;
      expect(attr(rect, "x"), `x ${i}`).toBe(String(PAD_LEFT + i * (barWidth + BAR_GAP)));
      expect(attr(rect, "width"), `width ${i}`).toBe(String(barWidth));
      expect(attr(rect, "height"), `height ${i}`).toBe(String(height));
      expect(attr(rect, "y"), `y ${i}`).toBe(String(PAD_TOP + PLOT_H - height));
    });
    // the tallest bar stays inside the plot box, under the top gridline
    const tallest = found[11] as string;
    expect(Number(attr(tallest, "y"))).toBeGreaterThan(PAD_TOP);
    expect(Number(attr(tallest, "y")) + Number(attr(tallest, "height"))).toBe(PAD_TOP + PLOT_H);
  });

  it("one gridline per tick, each non-scaling, in a muted group with currentColor", () => {
    const html = render();
    const scale = niceScale(58);
    const svg = svgOf(html);
    expect(count(svg, "<line")).toBe(scale.ticks.length);
    expect(count(svg, 'vector-effect="non-scaling-stroke"')).toBe(scale.ticks.length + 1); // + the running day's bar
    expect(svg).toContain('<g class="text-muted-foreground" stroke="currentColor" stroke-opacity="0.15">');
    for (const t of scale.ticks) {
      const y = PAD_TOP + PLOT_H * (1 - t / scale.max);
      expect(svg, `tick ${t}`).toContain(`y1="${y}" y2="${y}"`);
    }
    expect(svg).toContain(`x1="${PAD_LEFT}"`);
    expect(svg).toContain(`x2="${VIEW_W - PAD_RIGHT}"`);
  });

  it("bars sit in a text-primary group filled with currentColor, with no hard-coded colour", () => {
    const html = render();
    const svg = svgOf(html);
    expect(svg).toContain('<g class="text-primary" fill="currentColor">');
    for (const banned of ["#", "rgb(", "rgba(", "hsl(", "hsla(", "oklch(", "oklab(", "fill=\"red", "fill=\"blue", "fill=\"green"]) {
      expect(html.includes(banned), banned).toBe(false);
    }
    // every fill and stroke the svg uses is currentColor
    for (const name of ["fill", "stroke"]) {
      const marker = ` ${name}="`;
      let from = 0;
      for (;;) {
        const at = svg.indexOf(marker, from);
        if (at < 0) break;
        const value = svg.slice(at + marker.length, svg.indexOf('"', at + marker.length));
        expect(value, `${name} value`).toBe("currentColor");
        from = at + marker.length;
      }
    }
    // no zone colour classes: a cluster has no single zone
    for (const zone of ["bg-red", "bg-emerald", "bg-zinc", "text-red", "text-emerald", "fill-red", "iktidar", "muhalefet"]) {
      expect(html.includes(zone), zone).toBe(false);
    }
  });

  it("only the last day's bar is partial (fill-opacity 0.45, dashed stroke)", () => {
    const html = render();
    const found = rects(html);
    expect(count(html, 'fill-opacity="0.45"')).toBe(1);
    expect(count(html, 'stroke-dasharray="3 2"')).toBe(1);
    found.forEach((rect, i) => {
      const last = i === 13;
      expect(attr(rect, "fill-opacity") === "0.45", `fill-opacity ${i}`).toBe(last);
      expect(attr(rect, "stroke-dasharray") === "3 2", `dash ${i}`).toBe(last);
      expect(attr(rect, "stroke") === "currentColor", `stroke ${i}`).toBe(last);
      expect(attr(rect, "stroke-width") === "1", `stroke-width ${i}`).toBe(last);
      expect(attr(rect, "vector-effect") === "non-scaling-stroke", `vector-effect ${i}`).toBe(last);
    });
    expect(titleOf(found[13] as string)).toBe("2026-11-12 · Küme: 12 (son gün, eksik)");
    // the partial treatment is attributes, not classes
    expect((found[13] as string).includes("class=")).toBe(false);
    expect(html.includes("opacity-")).toBe(false);
  });

  it("the partial mark follows the LAST day even when it is zero: no running bar, no partial treatment", () => {
    const html = render([3, 4, 5, 6, 7, 8, 9, 3, 4, 5, 6, 7, 8, 0], 0);
    expect(rects(html)).toHaveLength(13);
    expect(count(html, 'fill-opacity="0.45"')).toBe(0);
    expect(html.includes("(son gün, eksik)")).toBe(false); // that suffix names a bar, and there is none
    expect(html.includes("Son günün sayımı eksik.")).toBe(true); // the aria label still says the last day is incomplete
    expect(html.includes("eksik)</th>")).toBe(true); // the last table row header
  });

  it("y and x labels are aria-hidden HTML outside the svg; x labels are xAxisLabels of the days", () => {
    const html = render();
    const svgStart = html.indexOf("<svg");
    const svgEnd = html.indexOf("</svg>");
    const svg = svgOf(html);
    expect(svg.includes("<text")).toBe(false);
    expect(svg.includes("<span")).toBe(false);

    // y gutter: first grid column, before the svg, aria-hidden, as tall as the box
    expect(count(html, "grid-cols-[2.5rem_minmax(0,1fr)]")).toBe(1);
    expect(html).toContain('<div class="grid grid-cols-[2.5rem_minmax(0,1fr)]">');
    const gutterAt = html.indexOf('<div aria-hidden="true" class="relative h-28">');
    expect(gutterAt).toBeGreaterThan(0);
    expect(gutterAt).toBeLessThan(svgStart);
    const gutter = html.slice(gutterAt, svgStart);
    const scale = niceScale(58);
    expect(count(gutter, Y_LABEL_CLASS)).toBe(scale.ticks.length);
    for (const t of scale.ticks) {
      const top = pct(PAD_TOP + PLOT_H * (1 - t / scale.max), VIEW_H);
      expect(gutter, `y label ${t}`).toContain(`style="top:${top}">${formatCountTr(t)}</span>`);
    }
    expect(gutter).toContain("top:94.64%");
    expect(gutter).toContain("top:5.36%");

    // x labels: after the svg, in an aria-hidden h-5 row
    const rowAt = html.indexOf('<div aria-hidden="true" class="relative h-5">', svgEnd);
    expect(rowAt).toBeGreaterThan(svgEnd);
    const row = html.slice(rowAt, html.indexOf("</div>", rowAt));
    const labels = xAxisLabels(DAYS);
    expect(labels.map((l) => l.idx)).toEqual([0, 5, 10, 13]);
    expect(labels.map((l) => l.text)).toEqual(["30 Eki", "04 Kas", "09", "12"]);
    expect(count(row, "<span")).toBe(labels.length);
    labels.forEach(({ idx, text }) => {
      const barLeft = PAD_LEFT + idx * (BAR_W + BAR_GAP);
      const align = idx === 0 ? "start" : idx === 13 ? "end" : "center";
      const anchor = align === "start" ? barLeft : align === "end" ? barLeft + BAR_W : barLeft + BAR_W / 2;
      expect(row, `x label ${text}`).toContain(
        `<span class="${X_LABEL_CLASS[align]}" style="left:${pct(anchor, VIEW_W)}">${text}</span>`,
      );
    });
    // first start-anchored (left edge), last end-anchored (right edge), the rest centred
    expect(count(row, X_LABEL_CLASS.start)).toBe(1);
    expect(count(row, X_LABEL_CLASS.end)).toBe(1);
    expect(count(row, X_LABEL_CLASS.center)).toBe(2);
    expect(row).toContain("left:0.48%");
    expect(row).toContain("left:99.52%");

    // the labels exist nowhere else: not as chart text, not in the accessible name
    expect(count(html, "font-mono")).toBe(scale.ticks.length + labels.length);
  });

  it("the plot box has a fixed h-28 height (no layout shift)", () => {
    const html = render();
    const svgTag = svgOf(html).slice(0, svgOf(html).indexOf(">") + 1);
    expect(attr(svgTag, "class")).toBe("block h-28 w-full");
    expect(html).toContain('<div aria-hidden="true" class="relative h-28">');
    // never a height that depends on the data or on the box width
    for (const banned of ["h-auto", "aspect-", "min-h-", "max-h-", "height:", "animate-", "transition"]) {
      expect(html.includes(banned), banned).toBe(false);
    }
    // the svg has no width/height attributes of its own, the class gives both
    expect(attr(svgTag, "height")).toBeNull();
    expect(attr(svgTag, "width")).toBeNull();
    // the same box and the same gutter for a quiet hub and a busy one
    for (const counts of [lastDayOnly(3), [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], ERDOGAN, DAYS.map(() => 100_000)]) {
      const other = render(counts, 0);
      expect(other, JSON.stringify(counts)).toContain('<div aria-hidden="true" class="relative h-28">');
      expect(other).toContain("block h-28 w-full");
      expect(other).toContain('class="relative h-5"');
    }
  });

  it("the text alternative: the details toggle, an sr-only caption, Gün/Küme column headers, 14 row headers and counts in tr-TR grouping", () => {
    const counts = [1234, 26, 11, 29, 30, 19, 19, 27, 19, 32, 49, 58, 51, 12];
    const html = render(counts, 41);
    expect(count(html, "<details")).toBe(1);
    expect(html).toContain('<details class="text-xs">');
    expect(html).toContain(`<summary class="${SUMMARY_CLASS}">${HUB_TREND_TABLE_TOGGLE}</summary>`);
    expect(HUB_TREND_TABLE_TOGGLE).toBe("Günlük sayıları tablo olarak göster");

    expect(count(html, "<table")).toBe(1);
    expect(html).toContain('<table class="mt-3 w-full text-xs tabular-nums">');
    expect(html).toContain(`<caption class="sr-only">${hubTrendTableCaption("Erdoğan")}</caption>`);
    expect(html).toContain('<th scope="col">Gün</th>');
    expect(html).toContain('<th scope="col">Küme</th>');
    expect(count(html, '<th scope="col"')).toBe(2);
    expect(html).toContain(
      '<thead class="[&amp;_th]:px-1.5 [&amp;_th]:py-1 [&amp;_th]:text-right [&amp;_th]:font-medium [&amp;_th:first-child]:text-left">',
    );

    // one row per day, the label as the row header, the count right-aligned in tr-TR grouping
    expect(count(html, '<th scope="row"')).toBe(14);
    expect(count(html, "<tr>")).toBe(15); // header row + 14
    DAYS.forEach((day, i) => {
      const label = i === 13 ? `${dayLabelTr(day)} (eksik)` : dayLabelTr(day);
      expect(html, day).toContain(
        `<th scope="row" class="px-1.5 py-1 text-left font-normal">${label}</th><td class="px-1.5 py-1 text-right">${formatCountTr(counts[i] as number)}</td>`,
      );
    });
    expect(html).toContain(">1.234</td>");
    expect(html.includes(">1234</td>")).toBe(false);
    expect(html).toContain("12 Kasım (eksik)");
    expect(count(html, "(eksik)</th>")).toBe(1);

    // the text alternative lives outside the svg, and is NOT in an overflow wrapper (a second tab stop)
    const details = html.slice(html.indexOf("<details"), html.indexOf("</details>"));
    expect(details.includes("overflow")).toBe(false);
    expect(html.includes("overflow")).toBe(false);
    expect(svgOf(html).includes("<table")).toBe(false);
  });

  it("earlier > 0 adds the earlier note after the total line; earlier 0 omits it", () => {
    const withEarlier = render(ERDOGAN, 41);
    const total = hubTrendTotalLine(416);
    const note = hubTrendEarlierNote(41) as string;
    expect(total).toBe("Grafikte 416 küme, son 14 gün (son gün dahil, eksik).");
    expect(note).toBe("İlk haberi 14 günden önce çıkan 41 küme yukarıdaki sayıya dahil, grafikte yok.");
    expect(withEarlier).toContain(`<p class="text-xs text-muted-foreground">${total} ${note}</p>`);
    expect(withEarlier.indexOf(total)).toBeLessThan(withEarlier.indexOf(note));
    expect(withEarlier.indexOf(total)).toBeGreaterThan(withEarlier.indexOf("</svg>"));
    expect(withEarlier.indexOf(note)).toBeLessThan(withEarlier.indexOf("<details"));

    const without = render(ERDOGAN, 0);
    expect(without).toContain(`<p class="text-xs text-muted-foreground">${total}</p>`);
    expect(without.includes("İlk haberi 14 günden önce")).toBe(false);
    expect(without.includes("yukarıdaki sayıya dahil")).toBe(false);

    // grouped counts in both
    const big = render([1234, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 1500);
    expect(big).toContain("Grafikte 1.234 küme");
    expect(big).toContain("çıkan 1.500 küme");
  });

  it("renders no zone legend, no heading other than its own and no link", () => {
    const html = render();
    expect(count(html, "<h")).toBe(1);
    expect(html.includes("<a ")).toBe(false);
    expect(html.includes("<button")).toBe(false);
    expect(html.includes("<ul")).toBe(false);
    expect(html.includes("<li>")).toBe(false);
    expect(html.includes("<script")).toBe(false);
  });

  it("renders the same markup twice (pure: no clock, no state)", () => {
    expect(render()).toBe(render());
  });
});

describe("<HubTrendChart> sparse state", () => {
  it("an all-zero trend (no day and no earlier cluster) renders nothing", () => {
    // On /gundem/[key] the chart only mounts under a non-empty list ("Son 14 günde N küme", N >= 1), so 0 / 0 can only be a stale
    // chart entry; printing "ilk haberi çıkan küme yok" above that list would contradict it.
    expect(render(lastDayOnly(0), 0)).toBe("");
    expect(render(DAYS.map(() => 0), 0, "TCMB")).toBe("");
  });

  it("sparse state: the heading and the sparse line only, no svg and no table, for sums 1 and 2", () => {
    const cases: Array<[string, number[], number]> = [
      ["sum 1", lastDayOnly(1), 0],
      ["sum 2, spread", DAYS.map((_, i) => (i === 3 || i === 9 ? 1 : 0)), 0],
      ["sum 2", lastDayOnly(2), 0],
    ];
    for (const [label, counts, earlier] of cases) {
      const html = render(counts, earlier, "TCMB");
      const sum = counts.reduce((a, b) => a + b, 0);
      expect(html, label).toContain(
        `<h2 id="hub-trend-heading" class="text-sm font-semibold text-foreground">${HUB_TREND_HEADING}</h2>`,
      );
      expect(html, label).toContain('aria-labelledby="hub-trend-heading"');
      expect(html, label).toContain(
        `<p class="text-xs text-muted-foreground">${hubTrendSparseLine(sum, earlier)}</p>`,
      );
      expect(count(html, "<p"), label).toBe(1);
      for (const banned of ["<svg", "<table", "<details", "<summary", "<rect", "<line", 'role="img"', "font-mono", "h-28"]) {
        expect(html.includes(banned), `${label}: ${banned}`).toBe(false);
      }
      // the caption belongs to the chart
      expect(html.includes(HUB_TREND_CAPTION), label).toBe(false);
    }
    expect(render(lastDayOnly(1), 0)).toContain("Son 14 günde ilk haberi çıkan 1 küme var; günlük grafik için çok az.");
    expect(render(lastDayOnly(2), 0)).toContain("Son 14 günde ilk haberi çıkan 2 küme var; günlük grafik için çok az.");
  });

  it("sparse state with earlier clusters: sum 0 says only the one line, sum 1 and 2 add the earlier note in a second paragraph", () => {
    const zero = render(lastDayOnly(0), 5);
    expect(count(zero, "<p")).toBe(1);
    expect(zero).toContain("Bu başlıktaki 5 kümenin ilk haberi 14 günden önce çıktı; günlük grafik çizilmedi.");
    expect(zero.includes("yukarıdaki sayıya dahil")).toBe(false);

    for (const n of [1, 2]) {
      const html = render(lastDayOnly(n), 5);
      expect(count(html, "<p"), String(n)).toBe(2);
      expect(html).toContain(`<p class="text-xs text-muted-foreground">${hubTrendSparseLine(n, 5)}</p>`);
      // the sparse state draws no chart, so its note must not point at one ("grafikte yok") or at "the number above"
      expect(html).toContain(`<p class="text-xs text-muted-foreground">${hubTrendSparseEarlierNote(5)}</p>`);
      expect(html.includes("grafikte yok")).toBe(false);
      expect(html.includes("yukarıdaki sayıya dahil")).toBe(false);
      expect(html.indexOf(hubTrendSparseLine(n, 5))).toBeLessThan(html.indexOf(hubTrendSparseEarlierNote(5) as string));
      expect(html.includes("<svg")).toBe(false);
    }
  });

  it("three clusters are enough for the chart", () => {
    const html = render(lastDayOnly(3), 0);
    expect(html).toContain("<svg");
    expect(rects(html)).toHaveLength(1);
    expect(html.includes("günlük grafik için çok az")).toBe(false);
  });
});

describe("hub-trend-chart.tsx source", () => {
  const src = readFileSync(resolve(__dirname, "hub-trend-chart.tsx"), "utf8");

  it("is a synchronous server component: no use client, not async, no hook, no state", () => {
    expect(src.includes("use client")).toBe(false);
    expect(src.includes("async ")).toBe(false);
    expect(src.includes("useState")).toBe(false);
    expect(src.includes("useEffect")).toBe(false);
    expect(src.includes("dangerouslySetInnerHTML")).toBe(false);
    expect(src.includes("Date.now")).toBe(false);
    expect(src.includes("new Date")).toBe(false);
    expect(HubTrendChart.constructor.name).toBe("Function");
  });

  it("uses theme tokens only: no hex colour, no opacity-NN or text-*/NN class, even in comments", () => {
    expect(src.includes("#")).toBe(false);
    expect(src.includes("opacity-")).toBe(false);
    // a text colour class with a slash opacity: "text-" followed by token characters and "/" then a digit
    let from = 0;
    for (;;) {
      const at = src.indexOf("text-", from);
      if (at < 0) break;
      let end = at + 5;
      while (end < src.length && ((src.charAt(end) >= "a" && src.charAt(end) <= "z") || src.charAt(end) === "-")) end += 1;
      const slashDigit = src.charAt(end) === "/" && src.charAt(end + 1) >= "0" && src.charAt(end + 1) <= "9";
      expect(slashDigit, src.slice(at, end + 3)).toBe(false);
      from = at + 5;
    }
  });

  it("reuses the /trends helpers instead of copying them", () => {
    for (const piece of [
      '"@/lib/format/nice-scale"',
      '"@/lib/format/number-tr"',
      '"@/lib/trends/axis-labels"',
      '"@/lib/trends/bar-title"',
    ]) {
      expect(src, piece).toContain(piece);
    }
  });
});
