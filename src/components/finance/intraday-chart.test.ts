import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Bar5m } from "@/lib/finance/queries";
import { captionMarkers, IntradayChart, priceTagTops, sessionAxisTicks, type ChartMarker } from "./intraday-chart";

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

// h120-finance-2: the last bar of a finished session is an 18:00 pre-auction stub (volume 0) whose close can
// differ from the settled close. SISE 2026-11-10: stub 35,46 (red against the previous close 35,48), settled
// 35,72 (green, header +%0,68). The page now passes the settled close with overrideReason 'auction': the colour,
// the tag and the level follow it, and the aria-label drops the 'gün içi veri eksik' clause (the bars are all
// there; only the last print was a stub). Without overrideReason the 'cut' wording is unchanged.
describe("IntradayChart overrideReason 'auction' (h120-finance-2)", () => {
  const bars: Bar5m[] = [
    { ts: "2026-11-10T07:00:00.000Z", close: 35.5, volume: 900 },
    { ts: "2026-11-10T09:00:00.000Z", close: 35.4, volume: 700 },
    { ts: "2026-11-10T14:55:00.000Z", close: 35.5, volume: 4000 },
    { ts: "2026-11-10T15:00:00.000Z", close: 35.46, volume: 0 },
  ];
  const PREV = 35.48;
  const render = (extra: { closeOverride?: number | null; overrideReason?: "cut" | "auction" } = {}) =>
    renderToStaticMarkup(IntradayChart({ bars, markers: [], prevClose: PREV, ...extra }));
  const ariaOf = (html: string) => /aria-label="([^"]+)"/.exec(html)?.[1];
  const pathClass = (html: string) => /<path d="[^"]+"[^>]*class="([^"]+)"/.exec(html)?.[1];
  const lastTag = (html: string) =>
    /<span aria-hidden="true" data-chart-label="true" class="[^"]*text-(emerald|red)-400" style="top:([\d.]+)%">([^<]+)<\/span>/.exec(html);

  it("the stub alone reads red 35,46 (the bug the override fixes)", () => {
    const html = render();
    expect(pathClass(html)).toContain("stroke-red-400");
    expect(lastTag(html)?.[1]).toBe("red");
    expect(lastTag(html)?.[3]).toBe("35,46");
    expect(ariaOf(html)).toBe("Seans içi fiyat, son 35,46");
  });

  it("with the settled 35,72, prevClose 35,48 and reason 'auction': emerald path, tag 35,72, plain aria-label", () => {
    const html = render({ closeOverride: 35.72, overrideReason: "auction" });
    expect(pathClass(html)).toContain("stroke-emerald-400");
    expect(pathClass(html)).not.toContain("stroke-red-400");
    expect(lastTag(html)?.[1]).toBe("emerald");
    expect(lastTag(html)?.[3]).toBe("35,72");
    expect(html).not.toContain("35,46");
    expect(ariaOf(html)).toBe("Seans içi fiyat, kapanış 35,72");
    expect(html).not.toContain("gün içi veri eksik");
  });

  it("a settled close below the previous close under 'auction' is red and still has no 'veri eksik' clause", () => {
    const html = render({ closeOverride: 35.3, overrideReason: "auction" });
    expect(pathClass(html)).toContain("stroke-red-400");
    expect(lastTag(html)?.[1]).toBe("red");
    expect(lastTag(html)?.[3]).toBe("35,30");
    expect(ariaOf(html)).toBe("Seans içi fiyat, kapanış 35,30");
  });

  it("the TUPRS shape: the stub is at the previous close (green by >=), the settled close is below it: red", () => {
    const tuprs: Bar5m[] = [
      { ts: "2026-11-10T07:00:00.000Z", close: 332, volume: 900 },
      { ts: "2026-11-10T14:55:00.000Z", close: 331.5, volume: 4000 },
      { ts: "2026-11-10T15:00:00.000Z", close: 332.25, volume: 0 },
    ];
    const stub = renderToStaticMarkup(IntradayChart({ bars: tuprs, markers: [], prevClose: 332.25 }));
    expect(lastTag(stub)?.[1]).toBe("emerald");
    const fixed = renderToStaticMarkup(IntradayChart({ bars: tuprs, markers: [], prevClose: 332.25, closeOverride: 331.25, overrideReason: "auction" }));
    expect(lastTag(fixed)?.[1]).toBe("red");
    expect(lastTag(fixed)?.[3]).toBe("331,25");
    expect(pathClass(fixed)).toContain("stroke-red-400");
  });

  it("the path still draws the bars, whatever the override", () => {
    const d = (html: string) => /<path d="([^"]+)"/.exec(html)?.[1];
    expect(d(render({ closeOverride: 35.72, overrideReason: "auction" }))).toBe(d(render()));
  });

  it("the tag moves to the settled level (higher on the chart), inside 0-100", () => {
    const before = Number(lastTag(render())?.[2]);
    const after = Number(lastTag(render({ closeOverride: 35.72, overrideReason: "auction" }))?.[2]);
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThanOrEqual(0);
    expect(after).toBeLessThanOrEqual(100);
  });

  it("with the reason omitted the 'cut' aria-label is unchanged, and it equals an explicit 'cut'", () => {
    const omitted = render({ closeOverride: 35.72 });
    expect(ariaOf(omitted)).toBe("Seans içi fiyat, kapanış 35,72, gün içi veri eksik");
    expect(render({ closeOverride: 35.72, overrideReason: "cut" })).toBe(omitted);
  });

  it("a reason with no usable override changes nothing: null, undefined and non-finite all read the last bar", () => {
    const plain = render();
    expect(render({ closeOverride: null, overrideReason: "auction" })).toBe(plain);
    expect(render({ closeOverride: undefined, overrideReason: "auction" })).toBe(plain);
    expect(render({ closeOverride: Number.NaN, overrideReason: "auction" })).toBe(plain);
    expect(render({ closeOverride: Number.POSITIVE_INFINITY, overrideReason: "auction" })).toBe(plain);
  });
});

// h101-a11yrecent-2 (WCAG 3.1.2 Language of Parts): the page is lang="tr", and the caption under the chart
// prints each marker's headline. An English outlet's headline (Daily Sabah, Hürriyet Daily News, ...) was read
// with Turkish phonetics. The page now passes lang: 'en' on such a marker and the caption's label span carries
// it; a Turkish headline, and the Turkish "KAP: ..." label, render no attribute (they inherit tr).
describe("IntradayChart marker captions carry their language (h101-a11yrecent-2)", () => {
  const bars: Bar5m[] = [
    { ts: "2026-11-06T07:00:00.000Z", close: 11.8, volume: 100 },
    { ts: "2026-11-06T08:30:00.000Z", close: 11.7, volume: 60 },
    { ts: "2026-11-06T11:00:00.000Z", close: 11.9, volume: 60 },
  ];
  // 08:00Z, 08:10Z and 08:20Z are 11:00, 11:10 and 11:20 in Istanbul: inside the session window.
  const EN = "Aselsan signs $1.1 billion air defense export deal";
  const TR = "Aselsan yeni ihracat sözleşmesi imzaladı";
  const KAP = "KAP: Yeni İş İlişkisi";
  const render = (markers: ChartMarker[]) => renderToStaticMarkup(IntradayChart({ bars, markers, prevClose: 11.67 }));
  const langCount = (html: string) => (html.match(/\blang=/g) ?? []).length;

  it("a marker with lang 'en' renders its caption label with lang=\"en\"", () => {
    const html = render([{ ts: "2026-11-06T08:00:00.000Z", label: EN, lang: "en" }]);
    expect(html).toContain(`<span class="truncate" lang="en">${EN}</span>`);
    expect(langCount(html)).toBe(1);
  });

  it("a marker without lang renders no lang attribute anywhere", () => {
    const html = render([{ ts: "2026-11-06T08:00:00.000Z", label: TR }]);
    expect(html).toContain(`<span class="truncate">${TR}</span>`);
    expect(html).not.toContain("lang=");
  });

  it("an explicit lang: undefined renders no attribute (a Turkish outlet's marker)", () => {
    const html = render([{ ts: "2026-11-06T08:00:00.000Z", label: TR, lang: undefined }]);
    expect(html).toContain(`<span class="truncate">${TR}</span>`);
    expect(html).not.toContain("lang=");
  });

  it("in a mixed list only the English headline's label is marked, and only the label span", () => {
    const html = render([
      { ts: "2026-11-06T08:00:00.000Z", label: TR },
      { ts: "2026-11-06T08:10:00.000Z", label: EN, lang: "en" },
      { ts: "2026-11-06T08:20:00.000Z", label: KAP },
    ]);
    expect(html).toContain(`<span class="truncate">${TR}</span>`);
    expect(html).toContain(`<span class="truncate" lang="en">${EN}</span>`);
    expect(html).toContain(`<span class="truncate">${KAP}</span>`);
    // The ▲ glyph, the clock and the chart's own aria-label stay Turkish.
    expect(langCount(html)).toBe(1);
  });

  it("every English marker in the caption is marked (the caption shows up to six)", () => {
    const six: ChartMarker[] = Array.from({ length: 6 }, (_, i) => ({
      ts: `2026-11-06T08:0${i}:00.000Z`,
      label: `Headline number ${i}`,
      lang: "en" as const,
    }));
    expect(langCount(render(six))).toBe(6);
  });

  it("a marker outside the session window is not captioned, so its language is not printed either", () => {
    // 05:00Z is 08:00 in Istanbul, before the 09:30 floor.
    const html = render([{ ts: "2026-11-06T05:00:00.000Z", label: EN, lang: "en" }]);
    expect(html).not.toContain(EN);
    expect(html).not.toContain("lang=");
  });
});

// h142-a11y-2: the chart draws every in-session marker as a triangle, but the caption under it listed only the
// first six (THYAO: 18 triangles, 6 rows) and said nothing about the rest, and because the markers are sorted
// ascending the cap kept the earliest and dropped the latest, the ones nearest the current price. The ▲ before
// each row was also read aloud. captionMarkers keeps the LATEST rows and counts what it hides; the caption says so.
describe("captionMarkers (h142-a11y-2)", () => {
  /** n markers 20 minutes apart from 07:00Z (10:00 Istanbul), ascending. */
  const many = (n: number): ChartMarker[] =>
    Array.from({ length: n }, (_, i) => ({
      ts: new Date(Date.UTC(2026, 10, 6, 7, 0) + i * 20 * 60_000).toISOString(),
      label: `Haber ${i}`,
    }));

  it("18 markers: the LAST six, in ascending order, and 12 hidden", () => {
    const all = many(18);
    const { shown, hidden } = captionMarkers(all);
    expect(shown).toEqual(all.slice(12));
    expect(shown.map((m) => m.label)).toEqual(["Haber 12", "Haber 13", "Haber 14", "Haber 15", "Haber 16", "Haber 17"]);
    expect(hidden).toBe(12);
  });

  it("5 markers: all five, none hidden", () => {
    const all = many(5);
    expect(captionMarkers(all)).toEqual({ shown: all, hidden: 0 });
  });

  it("exactly six: all six, none hidden; seven: the last six and one hidden", () => {
    expect(captionMarkers(many(6))).toEqual({ shown: many(6), hidden: 0 });
    const seven = many(7);
    expect(captionMarkers(seven)).toEqual({ shown: seven.slice(1), hidden: 1 });
  });

  it("no markers: nothing shown, nothing hidden", () => {
    expect(captionMarkers([])).toEqual({ shown: [], hidden: 0 });
  });

  it("takes the cap as the second argument", () => {
    const all = many(10);
    expect(captionMarkers(all, 3)).toEqual({ shown: all.slice(7), hidden: 7 });
    expect(captionMarkers(all, 10)).toEqual({ shown: all, hidden: 0 });
    expect(captionMarkers(all, 25)).toEqual({ shown: all, hidden: 0 });
  });

  it("a cap of 0 (or less) shows nothing and hides everything; slice(-0) would have shown the lot", () => {
    const all = many(4);
    expect(captionMarkers(all, 0)).toEqual({ shown: [], hidden: 4 });
    expect(captionMarkers(all, -2)).toEqual({ shown: [], hidden: 4 });
  });

  it("a NaN cap falls back to the default of six; a fractional cap rounds down", () => {
    const all = many(9);
    expect(captionMarkers(all, Number.NaN)).toEqual({ shown: all.slice(3), hidden: 3 });
    expect(captionMarkers(all, 2.9)).toEqual({ shown: all.slice(7), hidden: 7 });
  });

  it("keeps the LATEST by time even when the input is not sorted, and returns them ascending", () => {
    const all = many(8);
    const shuffled = [all[5]!, all[0]!, all[7]!, all[2]!, all[6]!, all[1]!, all[4]!, all[3]!];
    const { shown, hidden } = captionMarkers(shuffled, 3);
    expect(shown.map((m) => m.label)).toEqual(["Haber 5", "Haber 6", "Haber 7"]);
    expect(hidden).toBe(5);
  });

  it("does not reorder or mutate the caller's array", () => {
    const all = many(8);
    const shuffled = [all[5]!, all[0]!, all[7]!, all[2]!, all[6]!, all[1]!, all[4]!, all[3]!];
    const copy = [...shuffled];
    captionMarkers(shuffled, 3);
    expect(shuffled).toEqual(copy);
  });

  it("markers at the same instant keep their input order", () => {
    const ts = "2026-11-06T08:00:00.000Z";
    const tied: ChartMarker[] = [
      { ts, label: "a" },
      { ts, label: "b" },
      { ts, label: "c" },
    ];
    expect(captionMarkers(tied, 2).shown.map((m) => m.label)).toEqual(["b", "c"]);
  });

  it("copes with 10k markers", () => {
    const { shown, hidden } = captionMarkers(many(10_000));
    expect(shown).toHaveLength(6);
    expect(hidden).toBe(9_994);
    expect(shown[5]!.label).toBe("Haber 9999");
  });
});

describe("IntradayChart caption lists the latest markers and counts the rest (h142-a11y-2)", () => {
  const bars: Bar5m[] = [
    { ts: "2026-11-06T07:00:00.000Z", close: 11.8, volume: 100 },
    { ts: "2026-11-06T09:30:00.000Z", close: 11.7, volume: 60 },
    { ts: "2026-11-06T12:00:00.000Z", close: 11.9, volume: 60 },
  ];
  /** n in-session markers, 20 minutes apart from 07:00Z: 10:00, 10:20, ... Istanbul. All inside 09:30-18:10. */
  const markersOf = (n: number): ChartMarker[] =>
    Array.from({ length: n }, (_, i) => ({
      ts: new Date(Date.UTC(2026, 10, 6, 7, 0) + i * 20 * 60_000).toISOString(),
      label: `Haber numarası ${i}`,
    }));
  const render = (markers: ChartMarker[]) => renderToStaticMarkup(IntradayChart({ bars, markers, prevClose: 11.67 }));

  const OPEN = "<figcaption";
  const CLOSE = "</figcaption>";
  /** The figcaption element's markup ("" when there is none). indexOf/slice only, no regular expression over markup. */
  function captionOf(html: string): string {
    const start = html.indexOf(OPEN);
    const end = html.indexOf(CLOSE);
    return start === -1 || end === -1 ? "" : html.slice(start, end + CLOSE.length);
  }
  /** Text nodes only, by a character walk (never a tag-stripping regex). */
  function textIn(html: string): string {
    let text = "";
    let inTag = false;
    for (const ch of html) {
      if (ch === "<") inTag = true;
      else if (ch === ">") inTag = false;
      else if (!inTag) text += ch;
    }
    return text;
  }
  const ROW = '<div class="flex gap-2">';
  const rowCount = (caption: string) => caption.split(ROW).length - 1;
  const clocks = (caption: string) => Array.from(caption.matchAll(/<span class="tabular-nums">(\d\d:\d\d)<\/span>/g), (m) => m[1]);

  it("18 markers: six rows ending at the latest marker, then one '+12' line", () => {
    const html = render(markersOf(18));
    const caption = captionOf(html);

    // The chart still draws all eighteen triangles.
    expect(html.split("<polygon").length - 1).toBe(18);
    expect(rowCount(caption)).toBe(6);
    // 07:00Z + 12..17 x 20 min = 11:00Z..12:40Z = 14:00..15:40 Istanbul.
    expect(clocks(caption)).toEqual(["14:00", "14:20", "14:40", "15:00", "15:20", "15:40"]);
    expect(caption).toContain("Haber numarası 17");
    expect(caption).not.toContain("Haber numarası 11<");
    expect(caption).not.toContain("Haber numarası 0<");
    expect(textIn(caption)).toContain("+12 işaret daha · tümü aşağıdaki listelerde");
    // Exactly one such line, after the last row.
    expect(textIn(caption).split("+12").length - 1).toBe(1);
    expect(caption.lastIndexOf("+12")).toBeGreaterThan(caption.lastIndexOf("Haber numarası 17"));
  });

  it("the extra line is not a marker row (no clock, no triangle)", () => {
    const caption = captionOf(render(markersOf(18)));
    // The last <div> of the caption is the note line.
    const line = caption.slice(caption.lastIndexOf("<div"));

    expect(textIn(line)).toBe("+12 işaret daha · tümü aşağıdaki listelerde");
    expect(line.startsWith(ROW)).toBe(false);
    expect(line.includes("▲")).toBe(false);
    expect(clocks(line)).toEqual([]);
    expect(rowCount(caption)).toBe(6);
  });

  it("the hidden count follows the number of in-session markers: 7 give '+1', 6 give no line", () => {
    expect(textIn(captionOf(render(markersOf(7))))).toContain("+1 işaret daha");
    expect(rowCount(captionOf(render(markersOf(7))))).toBe(6);
    expect(captionOf(render(markersOf(6))).includes("işaret daha")).toBe(false);
  });

  it("5 markers: five rows and no '+' line", () => {
    const caption = captionOf(render(markersOf(5)));

    expect(rowCount(caption)).toBe(5);
    expect(clocks(caption)).toEqual(["10:00", "10:20", "10:40", "11:00", "11:20"]);
    expect(caption.includes("+")).toBe(false);
    expect(caption.includes("işaret daha")).toBe(false);
  });

  it("no markers: no caption at all", () => {
    expect(render([]).includes(OPEN)).toBe(false);
  });

  it("markers outside the session window are neither captioned nor counted in the hidden total", () => {
    // 05:00Z is 08:00 Istanbul, before the 09:30 floor: 7 in session + 3 outside = '+1', not '+4'.
    const outside: ChartMarker[] = ["05:00", "05:10", "05:20"].map((t, i) => ({ ts: `2026-11-06T${t}:00.000Z`, label: `Seans dışı ${i}` }));
    const caption = captionOf(render([...outside, ...markersOf(7)]));

    expect(caption.includes("Seans dışı")).toBe(false);
    expect(textIn(caption)).toContain("+1 işaret daha");
    expect(textIn(caption).includes("+4")).toBe(false);
  });

  it("every ▲ in the caption sits directly inside an element marked aria-hidden", () => {
    for (const n of [1, 5, 6, 18]) {
      const caption = captionOf(render(markersOf(n)));
      const triangles: number[] = [];
      for (let at = caption.indexOf("▲"); at !== -1; at = caption.indexOf("▲", at + 1)) triangles.push(at);

      expect(triangles).toHaveLength(Math.min(n, 6));
      for (const at of triangles) {
        // The glyph is the whole text of its span, so the nearest tag before it is its parent's opening tag.
        const tag = caption.slice(caption.lastIndexOf("<", at), at);
        expect(tag.startsWith("<span")).toBe(true);
        expect(tag).toContain('aria-hidden="true"');
      }
    }
  });

  it("the caption's clock, label and lang= are unchanged (the language attribute stays on the label span)", () => {
    const html = render([
      { ts: "2026-11-06T08:00:00.000Z", label: "Aselsan signs a deal", lang: "en" },
      { ts: "2026-11-06T08:10:00.000Z", label: "KAP: Yeni İş İlişkisi" },
    ]);

    expect(html).toContain('<span class="tabular-nums">11:00</span>');
    expect(html).toContain('<span class="truncate" lang="en">Aselsan signs a deal</span>');
    expect(html).toContain('<span class="truncate">KAP: Yeni İş İlişkisi</span>');
    expect((html.match(/\blang=/g) ?? []).length).toBe(1);
  });

  it("the svg's aria-label also says how many markers it draws, only when it draws some", () => {
    const ariaOf = (html: string) => /aria-label="([^"]+)"/.exec(html)?.[1];

    expect(ariaOf(render(markersOf(18)))).toBe("Seans içi fiyat, son 11,90 · 18 işaret");
    expect(ariaOf(render(markersOf(1)))).toBe("Seans içi fiyat, son 11,90 · 1 işaret");
    expect(ariaOf(render([]))).toBe("Seans içi fiyat, son 11,90");
  });
});
