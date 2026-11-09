import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Bar5m } from "@/lib/finance/queries";
import { IntradayChart, priceTagTops, sessionAxisTicks } from "./intraday-chart";

// The chart labels are HTML positioned over the SVG (an SVG <text> shrinks
// with the viewBox: about 3 px on a 390 px phone). Their horizontal and
// vertical anchors come from the same geometry as the plot, so these pure
// helpers are what keep a label under its gridline.

describe("sessionAxisTicks", () => {
  const ticks = sessionAxisTicks();

  it("labels 10:00, 12:00, 14:00, 16:00 and 18:00 in order", () => {
    expect(ticks.map((t) => t.label)).toEqual(["10:00", "12:00", "14:00", "16:00", "18:00"]);
  });

  it("keeps every leftPct inside 0-100 and strictly increasing", () => {
    for (const t of ticks) {
      expect(t.leftPct).toBeGreaterThanOrEqual(0);
      expect(t.leftPct).toBeLessThanOrEqual(100);
    }
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!.leftPct).toBeGreaterThan(ticks[i - 1]!.leftPct);
    }
  });

  it("derives leftPct from the plot geometry: evenly spaced two hours apart on a 490-minute session", () => {
    // 120 of the 490 session minutes per step, scaled by the plot share of the viewBox.
    const step = ticks[1]!.leftPct - ticks[0]!.leftPct;
    for (let i = 2; i < ticks.length; i++) {
      expect(ticks[i]!.leftPct - ticks[i - 1]!.leftPct).toBeCloseTo(step, 6);
    }
    // 10:00 sits on the left plot edge, which is not the left edge of the svg.
    expect(ticks[0]!.leftPct).toBeGreaterThan(0);
    expect(ticks[0]!.leftPct).toBeLessThan(5);
  });

  it("aligns 10:00 to the start and 18:00 to the end (it is past 90 %), the rest to the centre", () => {
    expect(ticks[0]!.align).toBe("start");
    expect(ticks[4]!.leftPct).toBeGreaterThan(90);
    expect(ticks[4]!.align).toBe("end");
    expect(ticks.slice(1, 4).map((t) => t.align)).toEqual(["center", "center", "center"]);
  });
});

describe("priceTagTops", () => {
  const H = 150;

  it("returns each y as a percentage of H when the tags do not collide", () => {
    const tops = priceTagTops(30, 120, H);
    expect(tops.last).toBeCloseTo(20, 6);
    expect(tops.prev).toBeCloseTo(80, 6);
  });

  it("returns a null prev for a chart with no previous close", () => {
    const tops = priceTagTops(75, null, H);
    expect(tops.last).toBeCloseTo(50, 6);
    expect(tops.prev).toBeNull();
  });

  it("pushes two tags that collide at least 14 points apart, symmetrically about their midpoint", () => {
    // 60 and 63 of 150: 40 % and 42 %, midpoint 41 %.
    const tops = priceTagTops(60, 63, H);
    expect(tops.prev! - tops.last).toBeGreaterThanOrEqual(14);
    expect((tops.last + tops.prev!) / 2).toBeCloseTo(41, 6);
    // The one that was lower on the chart stays lower.
    expect(tops.prev!).toBeGreaterThan(tops.last);
  });

  it("keeps the order when the last price is the lower tag", () => {
    const tops = priceTagTops(63, 60, H);
    expect(tops.last - tops.prev!).toBeGreaterThanOrEqual(14);
    expect((tops.last + tops.prev!) / 2).toBeCloseTo(41, 6);
  });

  it("separates two tags at the exact same height", () => {
    const tops = priceTagTops(75, 75, H);
    expect(Math.abs(tops.last - tops.prev!)).toBeGreaterThanOrEqual(14);
    expect((tops.last + tops.prev!) / 2).toBeCloseTo(50, 6);
  });

  it("leaves a pair that is already 14 points apart where it is", () => {
    const tops = priceTagTops(60, 81, H);
    expect(tops.last).toBeCloseTo(40, 6);
    expect(tops.prev).toBeCloseTo(54, 6);
  });

  it("clamps into 0-100 and keeps the 14-point gap when the pair is pushed past the top edge", () => {
    const tops = priceTagTops(1.5, 3, H);
    expect(tops.last).toBeGreaterThanOrEqual(0);
    expect(tops.prev!).toBeLessThanOrEqual(100);
    expect(tops.prev! - tops.last).toBeGreaterThanOrEqual(14);
    expect(tops.last).toBeCloseTo(0, 6);
  });

  it("clamps into 0-100 and keeps the 14-point gap when the pair is pushed past the bottom edge", () => {
    const tops = priceTagTops(149, 148, H);
    expect(tops.last).toBeLessThanOrEqual(100);
    expect(tops.prev!).toBeGreaterThanOrEqual(0);
    expect(tops.last - tops.prev!).toBeGreaterThanOrEqual(14);
    expect(tops.last).toBeCloseTo(100, 6);
  });

  it("takes a wider minimum gap when asked (the chart asks for 22 so two 10 px tags clear each other on a phone)", () => {
    const tops = priceTagTops(75, 75, H, 22);
    expect(tops.prev! - tops.last).toBeGreaterThanOrEqual(22 - 1e-9);
    expect((tops.last + tops.prev!) / 2).toBeCloseTo(50, 6);
    // Still slides back inside 0-100 without closing the gap.
    const edge = priceTagTops(1, 2, H, 22);
    expect(edge.last).toBeCloseTo(0, 6);
    expect(edge.prev! - edge.last).toBeGreaterThanOrEqual(22 - 1e-9);
    // A pair already wider than the asked gap is left alone.
    const apart = priceTagTops(30, 90, H, 22);
    expect(apart.last).toBeCloseTo(20, 6);
    expect(apart.prev).toBeCloseTo(60, 6);
  });

  it("clamps a single tag that falls outside the viewBox", () => {
    expect(priceTagTops(-10, null, H).last).toBe(0);
    expect(priceTagTops(400, null, H).last).toBe(100);
  });
});

// h92-marketclock-1: when bist_intraday_targets dropped a ticker mid-session the newest
// bar is not where the day settled (VKING: last bar 12:05 Istanbul at 11,53, the daily
// close 12,09). The page then passes the settled close as closeOverride: the colour, the
// last-price tag and the aria-label follow it; the path stays the bars.
describe("IntradayChart closeOverride (h92-marketclock-1)", () => {
  // VKING's shape: down from 11,67 to 11,53 by 12:05, while the day closed at 12,09.
  const bars: Bar5m[] = [
    { ts: "2026-11-06T07:00:00.000Z", close: 11.8, volume: 100 },
    { ts: "2026-11-06T07:30:00.000Z", close: 11.62, volume: 80 },
    { ts: "2026-11-06T08:30:00.000Z", close: 11.7, volume: 60 },
    { ts: "2026-11-06T09:05:00.000Z", close: 11.53, volume: 0 },
  ];
  const PREV = 11.67;
  const render = (extra: { closeOverride?: number | null; prevClose?: number | null } = {}) =>
    renderToStaticMarkup(IntradayChart({ bars, markers: [], prevClose: PREV, ...extra }));
  const pathOf = (html: string) => /<path d="([^"]+)"/.exec(html)?.[1];
  const ariaOf = (html: string) => /aria-label="([^"]+)"/.exec(html)?.[1];
  /** The last-price tag: the data-chart-label span coloured emerald or red. */
  const lastTag = (html: string) =>
    /<span aria-hidden="true" data-chart-label="true" class="[^"]*text-(emerald|red)-400" style="top:([\d.]+)%">([^<]+)<\/span>/.exec(html);

  it("without the prop, with null, with undefined and with a non-finite value the markup is identical", () => {
    const plain = render();
    expect(render({ closeOverride: null })).toBe(plain);
    expect(render({ closeOverride: undefined })).toBe(plain);
    expect(render({ closeOverride: Number.NaN })).toBe(plain);
    expect(render({ closeOverride: Number.POSITIVE_INFINITY })).toBe(plain);
  });

  it("without the prop it still reads the last bar: 'son 11,53', red against the previous close", () => {
    const html = render();
    expect(ariaOf(html)).toBe("Seans içi fiyat, son 11,53");
    expect(html).toContain("stroke-red-400");
    expect(lastTag(html)?.[1]).toBe("red");
    expect(lastTag(html)?.[3]).toBe("11,53");
  });

  it("with the settled close: the aria-label says it and that the intraday data is incomplete", () => {
    expect(ariaOf(render({ closeOverride: 12.09 }))).toBe("Seans içi fiyat, kapanış 12,09, gün içi veri eksik");
  });

  it("with the settled close above the previous close the line and the tag are green and the tag prints 12,09", () => {
    const html = render({ closeOverride: 12.09 });
    expect(html).toContain("stroke-emerald-400");
    expect(html).not.toContain("stroke-red-400");
    expect(lastTag(html)?.[1]).toBe("emerald");
    expect(lastTag(html)?.[3]).toBe("12,09");
    expect(html).not.toContain("11,53");
  });

  it("with a settled close below the previous close everything stays red", () => {
    const html = render({ closeOverride: 11.4 });
    expect(html).toContain("stroke-red-400");
    expect(lastTag(html)?.[1]).toBe("red");
    expect(lastTag(html)?.[3]).toBe("11,40");
  });

  it("the path is the bars' path, whatever the override", () => {
    expect(pathOf(render({ closeOverride: 12.09 }))).toBe(pathOf(render()));
  });

  it("the tag moves to the settled close's level (higher on the chart), through priceTagTops, inside 0-100", () => {
    const before = Number(lastTag(render())?.[2]);
    const after = Number(lastTag(render({ closeOverride: 12.09 }))?.[2]);
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThanOrEqual(0);
    expect(after).toBeLessThanOrEqual(100);
  });

  it("with no previous close the override is compared with the first bar's close", () => {
    const up = render({ prevClose: null, closeOverride: 12.09 });
    expect(up).toContain("stroke-emerald-400");
    expect(lastTag(up)?.[1]).toBe("emerald");
    const down = render({ prevClose: null, closeOverride: 11.0 });
    expect(down).toContain("stroke-red-400");
    expect(lastTag(down)?.[1]).toBe("red");
  });

  it("still draws nothing for fewer than two bars", () => {
    expect(IntradayChart({ bars: bars.slice(0, 1), markers: [], prevClose: PREV, closeOverride: 12.09 })).toBeNull();
  });
});
