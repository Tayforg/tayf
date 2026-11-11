import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Bar5m } from "@/lib/finance/queries";
import { IntradayChart, priceTagTops, sessionAxisTicks, type ChartMarker } from "./intraday-chart";

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
