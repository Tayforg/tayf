import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `getQuote`/`getQuotes` are wrapped in "use cache"; next/cache's real
// cacheLife() throws outside a Next.js cacheComponents build ("`cacheLife()`
// is only available with the `cacheComponents` config"), so it's stubbed
// here the same way src/lib/finance/queries.test.ts stubs it.
vi.mock("next/cache", () => ({ cacheLife: vi.fn() }));

import { cacheLife } from "next/cache";
import { fmtPct, fmtWhen, fmtX, limitFlag, moveClass, pctChange } from "./format";
import { defaultQuoteSource, getQuotes, parseYahooChart, YahooQuoteSource } from "./quotes";
import { chartBaseline, marketCueText } from "./session";

// Shape captured from query1.finance.yahoo.com on 2026-09-13 for THYAO.IS.
const SAMPLE = {
  chart: {
    result: [
      {
        meta: {
          currency: "TRY",
          symbol: "THYAO.IS",
          regularMarketTime: 1789139387,
          regularMarketPrice: 300.25,
          regularMarketChangePercent: 0.334,
          chartPreviousClose: 305.0,
        },
        indicators: { quote: [{ close: [305, 301.5, null, 299.25, 300.25] }] },
      },
    ],
    error: null,
  },
};

describe("parseYahooChart", () => {
  it("reads price and closes, and prefers regularMarketChangePercent over the pre-window chartPreviousClose (TS-09)", () => {
    const q = parseYahooChart("THYAO", SAMPLE)!;
    expect(q.ticker).toBe("THYAO");
    expect(q.price).toBe(300.25);
    expect(q.changePct).toBeCloseTo(0.334, 6);
    expect(q.prevClose).toBeCloseTo(300.25 / (1 + 0.334 / 100), 6);
    expect(q.closes).toEqual([305, 301.5, 299.25, 300.25]);
    expect(q.currency).toBe("TRY");
  });

  it("falls back to the last two closes when regularMarketChangePercent is missing, ignoring the 5-day chartPreviousClose", () => {
    const json = structuredClone(SAMPLE) as { chart: { result: Array<{ meta: Record<string, unknown> }> } };
    delete json.chart.result[0]!.meta.regularMarketChangePercent;
    const q = parseYahooChart("THYAO", json)!;
    expect(q.prevClose).toBeCloseTo(299.25, 1);
    expect(q.changePct).toBeCloseTo(((300.25 - 299.25) / 299.25) * 100, 6);
  });

  it("falls back to the last two closes when chartPreviousClose is not a usable positive number and pct is missing", () => {
    const json = structuredClone(SAMPLE) as { chart: { result: Array<{ meta: Record<string, unknown> }> } };
    json.chart.result[0]!.meta.chartPreviousClose = 0;
    delete json.chart.result[0]!.meta.regularMarketChangePercent;
    const q = parseYahooChart("THYAO", json)!;
    expect(q.changePct).toBeCloseTo(((300.25 - 299.25) / 299.25) * 100, 6);
    expect(q.prevClose).toBeCloseTo(299.25, 1);
  });

  it("uses chartPreviousClose only for a 1-day chart (single close)", () => {
    const json = structuredClone(SAMPLE) as { chart: { result: Array<{ meta: Record<string, unknown> }> } };
    delete json.chart.result[0]!.meta.regularMarketChangePercent;
    (json.chart.result[0] as { indicators: { quote: Array<{ close: unknown[] }> } }).indicators.quote[0]!.close = [300.25];
    const q = parseYahooChart("THYAO", json)!;
    expect(q.prevClose).toBe(305);
    expect(q.changePct).toBeCloseTo(((300.25 - 305) / 305) * 100, 6);
  });

  it("OZATD regression: a 10% taban move on a 5-day chart uses regularMarketChangePercent, not the pre-window close", () => {
    const json = {
      chart: {
        result: [
          {
            meta: {
              currency: "TRY",
              regularMarketPrice: 1935,
              regularMarketChangePercent: -10,
              chartPreviousClose: 2945,
            },
            indicators: { quote: [{ close: [2945, 2652.5, 2388, 2150, 1935] }] },
          },
        ],
        error: null,
      },
    };
    const q = parseYahooChart("OZATD", json)!;
    expect(q.changePct).toBeCloseTo(-10, 6);
    expect(q.prevClose).toBeCloseTo(2150, 6);
    expect(limitFlag(q.changePct)).toBe("taban");
  });

  it("THYAO regression: a -1.29% move on a 5-day chart uses regularMarketChangePercent", () => {
    const json = {
      chart: {
        result: [
          {
            meta: {
              currency: "TRY",
              regularMarketPrice: 287,
              regularMarketChangePercent: -1.29,
              chartPreviousClose: 298,
            },
            indicators: { quote: [{ close: [298, 298.5, 288.5, 290.75, 287] }] },
          },
        ],
        error: null,
      },
    };
    const q = parseYahooChart("THYAO", json)!;
    expect(q.changePct).toBeCloseTo(-1.29, 6);
    expect(q.prevClose).toBeCloseTo(290.75, 2);
  });

  it("guards against changePct === -100 producing an infinite or NaN prevClose (TS-13)", () => {
    const json = structuredClone(SAMPLE) as { chart: { result: Array<{ meta: Record<string, unknown> }> } };
    delete json.chart.result[0]!.meta.chartPreviousClose;
    json.chart.result[0]!.meta.regularMarketChangePercent = -100;
    const q = parseYahooChart("THYAO", json)!;
    expect(Number.isFinite(q.prevClose)).toBe(true);
    expect(Number.isFinite(q.changePct)).toBe(true);
    expect(q.prevClose).toBe(300.25);
    expect(q.changePct).toBe(0);
  });

  it("returns null for an unknown symbol payload", () => {
    expect(parseYahooChart("XXXX", { chart: { result: null, error: { code: "Not Found" } } })).toBeNull();
  });
});

// hasBaseline separates a real %0,00 from "no baseline known": the TS-13
// fallback keeps changePct 0 / prevClose = price so nothing non-finite leaks,
// but readers must show '—' for that move, never '%0,00'.
describe("parseYahooChart hasBaseline", () => {
  type Json = { chart: { result: Array<{ meta: Record<string, unknown>; indicators: { quote: Array<{ close: unknown[] }> } }> } };

  it("is true when regularMarketChangePercent is present", () => {
    expect(parseYahooChart("THYAO", SAMPLE)!.hasBaseline).toBe(true);
  });

  it("is true for a genuine %0,00 move reported by Yahoo", () => {
    const json = structuredClone(SAMPLE) as unknown as Json;
    json.chart.result[0]!.meta.regularMarketChangePercent = 0;
    const q = parseYahooChart("THYAO", json)!;
    expect(q.hasBaseline).toBe(true);
    expect(q.changePct).toBe(0);
  });

  it("is true when the baseline comes from the last two closes", () => {
    const json = structuredClone(SAMPLE) as unknown as Json;
    delete json.chart.result[0]!.meta.regularMarketChangePercent;
    expect(parseYahooChart("THYAO", json)!.hasBaseline).toBe(true);
  });

  it("is true when the baseline comes from chartPreviousClose on a 1-day chart", () => {
    const json = structuredClone(SAMPLE) as unknown as Json;
    delete json.chart.result[0]!.meta.regularMarketChangePercent;
    json.chart.result[0]!.indicators.quote[0]!.close = [300.25];
    expect(parseYahooChart("THYAO", json)!.hasBaseline).toBe(true);
  });

  it("is false with no regularMarketChangePercent, at most one close and no chartPreviousClose", () => {
    const json = structuredClone(SAMPLE) as unknown as Json;
    delete json.chart.result[0]!.meta.regularMarketChangePercent;
    delete json.chart.result[0]!.meta.chartPreviousClose;
    json.chart.result[0]!.indicators.quote[0]!.close = [300.25];
    const q = parseYahooChart("THYAO", json)!;
    expect(q.hasBaseline).toBe(false);
    expect(q.changePct).toBe(0);
    expect(q.prevClose).toBe(300.25);

    json.chart.result[0]!.indicators.quote[0]!.close = [];
    expect(parseYahooChart("THYAO", json)!.hasBaseline).toBe(false);
  });

  it("is false for the changePct === -100 fallback (TS-13)", () => {
    const json = structuredClone(SAMPLE) as unknown as Json;
    delete json.chart.result[0]!.meta.chartPreviousClose;
    json.chart.result[0]!.meta.regularMarketChangePercent = -100;
    const q = parseYahooChart("THYAO", json)!;
    expect(q.hasBaseline).toBe(false);
    expect(q.changePct).toBe(0);
    expect(q.prevClose).toBe(300.25);
  });
});

// h20-numbers-1: before the first BIST trade of the day Yahoo reports
// regularMarketChangePercent = 0 as a placeholder, which used to render a fake
// '%0,00' and suppress the tavan/taban tag. The baseline is now the last close
// of an earlier Istanbul day than the quote's own session (timestamp array),
// and only falls back to Yahoo's percent when that cannot be derived.
describe("parseYahooChart pre-open baseline", () => {
  const epoch = (y: number, m: number, d: number, h: number, min: number, s = 0): number =>
    Date.UTC(y, m - 1, d, h, min, s) / 1000;

  // 26, 27, 28 and 30 Oct 2026 plus the (pre-open, null-close) 2 Nov bar.
  // 29 Oct is a holiday, so there is no bar for it.
  const FIVE_DAYS = [
    epoch(2026, 10, 26, 6, 30),
    epoch(2026, 10, 27, 6, 30),
    epoch(2026, 10, 28, 6, 30),
    epoch(2026, 10, 30, 6, 30),
    epoch(2026, 11, 2, 6, 30),
  ];
  const LAST_SESSION = epoch(2026, 10, 30, 15, 9, 57);
  const OPEN_SESSION = epoch(2026, 11, 2, 7, 14);

  interface ChartInput {
    price: number;
    pct?: number;
    time?: number;
    chartPreviousClose?: number;
    closes: Array<number | null>;
    timestamp?: Array<number | null>;
  }
  const chart = (i: ChartInput) => ({
    chart: {
      result: [
        {
          meta: {
            currency: "TRY",
            regularMarketPrice: i.price,
            ...(i.pct === undefined ? {} : { regularMarketChangePercent: i.pct }),
            ...(i.time === undefined ? {} : { regularMarketTime: i.time }),
            ...(i.chartPreviousClose === undefined ? {} : { chartPreviousClose: i.chartPreviousClose }),
          },
          ...(i.timestamp === undefined ? {} : { timestamp: i.timestamp }),
          indicators: { quote: [{ close: i.closes }] },
        },
      ],
      error: null,
    },
  });

  const bimasPreOpen = (over: Partial<ChartInput> = {}): ChartInput => ({
    price: 347.5,
    pct: 0,
    time: LAST_SESSION,
    chartPreviousClose: 380,
    closes: [374.5, 363, 364.75, 347.5, null],
    timestamp: FIVE_DAYS,
    ...over,
  });

  it("BIMAS pre-open: Yahoo's 0 placeholder is replaced by the real last-session move", () => {
    const q = parseYahooChart("BIMAS", chart(bimasPreOpen()))!;
    expect(q.changePct).toBeCloseTo(-4.729, 2);
    expect(q.prevClose).toBe(364.75);
    expect(q.hasBaseline).toBe(true);
    expect(limitFlag(q.changePct, q.prevClose, q.price)).toBeNull();
    expect(q.closes).toEqual([374.5, 363, 364.75, 347.5]);
    expect(q.currency).toBe("TRY");
  });

  it("DOAS pre-open: the +9.95 percent limit-up is back and tagged tavan", () => {
    const q = parseYahooChart(
      "DOAS",
      chart(bimasPreOpen({ price: 149.2, closes: [128.4, 134.3, 135.7, 149.2, null] })),
    )!;
    expect(q.changePct).toBeCloseTo(9.948, 2);
    expect(q.prevClose).toBe(135.7);
    expect(q.hasBaseline).toBe(true);
    expect(limitFlag(q.changePct, q.prevClose, q.price)).toBe("tavan");
    expect(q.closes).toEqual([128.4, 134.3, 135.7, 149.2]);
  });

  it("open session: today's bar is on the session day, so the baseline is the previous close and Yahoo's 0.647 is reproduced", () => {
    const q = parseYahooChart(
      "BIMAS",
      chart({
        price: 349.75,
        pct: 0.647,
        time: OPEN_SESSION,
        chartPreviousClose: 380,
        closes: [374.5, 363, 364.75, 347.5, 349.75],
        timestamp: FIVE_DAYS,
      }),
    )!;
    expect(q.changePct).toBeCloseTo(0.647, 2);
    expect(q.prevClose).toBe(347.5);
    expect(q.hasBaseline).toBe(true);
    expect(q.closes).toEqual([374.5, 363, 364.75, 347.5, 349.75]);
  });

  it("a genuine flat day (today's bar equals yesterday's close) stays a measured 0 with a baseline", () => {
    const q = parseYahooChart(
      "BIMAS",
      chart({
        price: 347.5,
        pct: 0,
        time: epoch(2026, 11, 2, 8, 0),
        closes: [374.5, 363, 364.75, 347.5, 347.5],
        timestamp: FIVE_DAYS,
      }),
    )!;
    expect(q.changePct).toBe(0);
    expect(q.prevClose).toBe(347.5);
    expect(q.hasBaseline).toBe(true);
  });

  it("asOf stays the quote's own regularMarketTime", () => {
    const q = parseYahooChart("BIMAS", chart(bimasPreOpen()))!;
    expect(q.asOf).toBe("2026-10-30T15:09:57.000Z");
  });

  it("callers: the freshness label still reads the unchanged asOf, and the quote's prevClose is the right dashed baseline for the last session", () => {
    const q = parseYahooChart("BIMAS", chart(bimasPreOpen()))!;
    // Pre-open (09:51 Istanbul) and mid-morning before today's quote refresh (10:08).
    expect(marketCueText(q.asOf, Date.parse("2026-11-02T06:51:00Z"))).toBe("Piyasa kapalı · son seans 30.10");
    expect(marketCueText(q.asOf, Date.parse("2026-11-02T07:08:00Z"))).toBe("Veriler gecikmeli · son seans 30.10");
    // No daily stat row: the chart falls back to the quote's prevClose, which is
    // now 28 Oct's close (the base of the 30 Oct move) rather than 347.5.
    expect(chartBaseline({ stat: null, intradayDay: "2026-10-30", quotePrevClose: q.prevClose })).toBe(364.75);
  });

  it("measures the session day in Istanbul (UTC+3), not UTC", () => {
    // 1 Nov 21:30Z is already 2 Nov 00:30 in Istanbul: it belongs to the
    // session day of a 2 Nov quote and must not be taken as the baseline.
    const q = parseYahooChart(
      "BIMAS",
      chart({
        price: 349.75,
        pct: 0,
        time: OPEN_SESSION,
        closes: [363, 364.75, 347.5, 349.75],
        timestamp: [epoch(2026, 10, 27, 6, 30), epoch(2026, 10, 28, 6, 30), epoch(2026, 10, 30, 6, 30), epoch(2026, 11, 1, 21, 30)],
      }),
    )!;
    expect(q.prevClose).toBe(347.5);
    expect(q.changePct).toBeCloseTo(0.647, 2);
  });

  it("skips bars that are null, non-positive or have no usable timestamp when scanning back", () => {
    const q = parseYahooChart(
      "BIMAS",
      chart({
        price: 349.75,
        pct: 0,
        time: OPEN_SESSION,
        closes: [374.5, 363, 364.75, 0, 349.75],
        timestamp: FIVE_DAYS,
      }),
    )!;
    expect(q.prevClose).toBe(364.75);

    const nullTs = parseYahooChart(
      "BIMAS",
      chart({
        price: 349.75,
        pct: 0,
        time: OPEN_SESSION,
        closes: [374.5, 363, 364.75, 347.5, 349.75],
        timestamp: [FIVE_DAYS[0]!, FIVE_DAYS[1]!, FIVE_DAYS[2]!, null, FIVE_DAYS[4]!],
      }),
    )!;
    expect(nullTs.prevClose).toBe(364.75);
    expect(nullTs.changePct).toBeCloseTo(((349.75 - 364.75) / 364.75) * 100, 6);
  });

  describe("falls back to the old chain (regularMarketChangePercent first)", () => {
    it("BIMAS with the timestamp array removed keeps Yahoo's 0", () => {
      const q = parseYahooChart("BIMAS", chart(bimasPreOpen({ timestamp: undefined })))!;
      expect(q.changePct).toBe(0);
      expect(q.prevClose).toBe(347.5);
      expect(q.hasBaseline).toBe(true);
    });

    it("timestamp length differs from the close length", () => {
      const q = parseYahooChart("BIMAS", chart(bimasPreOpen({ timestamp: FIVE_DAYS.slice(0, 4) })))!;
      expect(q.changePct).toBe(0);
      expect(q.prevClose).toBe(347.5);
    });

    it("regularMarketTime is missing", () => {
      const q = parseYahooChart("BIMAS", chart(bimasPreOpen({ time: undefined })))!;
      expect(q.changePct).toBe(0);
      expect(q.prevClose).toBe(347.5);
    });

    it("no earlier-day non-null close exists (all bars on the session day)", () => {
      const day = epoch(2026, 11, 2, 6, 30);
      const q = parseYahooChart(
        "BIMAS",
        chart({
          price: 349.75,
          pct: 0.647,
          time: OPEN_SESSION,
          closes: [null, 349.75],
          timestamp: [day, day + 60],
        }),
      )!;
      expect(q.changePct).toBeCloseTo(0.647, 6);
      expect(q.prevClose).toBeCloseTo(349.75 / (1 + 0.647 / 100), 6);
    });

    it("earlier-day bars exist but every close is null", () => {
      const q = parseYahooChart(
        "BIMAS",
        chart(bimasPreOpen({ closes: [null, null, null, null, null], pct: 0.647 })),
      )!;
      expect(q.changePct).toBeCloseTo(0.647, 6);
    });

    it("no timestamps and no Yahoo percent still uses the last two closes", () => {
      const q = parseYahooChart(
        "BIMAS",
        chart(bimasPreOpen({ pct: undefined, timestamp: undefined, closes: [374.5, 363, 364.75, 347.5] })),
      )!;
      expect(q.prevClose).toBe(364.75);
      expect(q.changePct).toBeCloseTo(-4.729, 2);
    });
  });

  describe("TS-13 guard still applies", () => {
    it("pct -100 with no usable timestamps gives hasBaseline false and changePct 0", () => {
      for (const timestamp of [undefined, FIVE_DAYS.slice(0, 2)]) {
        const q = parseYahooChart("BIMAS", chart(bimasPreOpen({ pct: -100, timestamp, chartPreviousClose: undefined })))!;
        expect(q.hasBaseline).toBe(false);
        expect(q.changePct).toBe(0);
        expect(q.prevClose).toBe(347.5);
        expect(Number.isFinite(q.prevClose)).toBe(true);
      }
    });

    it("pct -100 with timestamps but no earlier-day close gives hasBaseline false", () => {
      const day = epoch(2026, 11, 2, 6, 30);
      const q = parseYahooChart(
        "BIMAS",
        chart({ price: 349.75, pct: -100, time: OPEN_SESSION, closes: [349.75], timestamp: [day] }),
      )!;
      expect(q.hasBaseline).toBe(false);
      expect(q.changePct).toBe(0);
      expect(q.prevClose).toBe(349.75);
    });
  });
});

// h120-finance-1: Yahoo's 5d/1d array drops the D-1 settled close during a session, so the page needs to know
// which Istanbul day each kept close belongs to (session.sparklineCloses puts the settled close back).
// closeDays is index-aligned with `closes` (the same indexes the closes filter keeps); it is absent whenever
// the alignment cannot be proven, and absent in a cache entry written before the field existed.
describe("parseYahooChart closeDays (h120-finance-1)", () => {
  const epoch = (y: number, m: number, d: number, h: number, min: number): number => Date.UTC(y, m - 1, d, h, min) / 1000;

  // CITAS 2026-11-11 11:16 Istanbul: the daily bars of 5, 6 and 9 Nov, then the live bar of 11 Nov (10:30 Istanbul).
  // 10 Nov, the settled close, is the bar Yahoo leaves out during the session.
  const TS = [epoch(2026, 11, 5, 7, 0), epoch(2026, 11, 6, 7, 0), epoch(2026, 11, 9, 7, 0), epoch(2026, 11, 11, 7, 30)];
  const chart = (closes: Array<number | null>, timestamp?: unknown) => ({
    chart: {
      result: [
        {
          meta: { currency: "TRY", regularMarketPrice: 81.85, regularMarketTime: epoch(2026, 11, 11, 8, 16) },
          ...(timestamp === undefined ? {} : { timestamp }),
          indicators: { quote: [{ close: closes }] },
        },
      ],
      error: null,
    },
  });

  it("names the Istanbul day of every kept close, in order", () => {
    const q = parseYahooChart("CITAS", chart([108.9, 101, 101, 81.85], TS))!;
    expect(q.closes).toEqual([108.9, 101, 101, 81.85]);
    expect(q.closeDays).toEqual(["2026-11-05", "2026-11-06", "2026-11-09", "2026-11-11"]);
  });

  it("uses the Istanbul calendar day, not the UTC day (a 22:30Z bar belongs to the next Istanbul day)", () => {
    const q = parseYahooChart("CITAS", chart([100, 101], [epoch(2026, 11, 5, 22, 30), epoch(2026, 11, 6, 7, 0)]))!;
    expect(q.closeDays).toEqual(["2026-11-06", "2026-11-06"]);
  });

  it("a null close is skipped in both closes and closeDays, so the two stay the same length", () => {
    const q = parseYahooChart("CITAS", chart([108.9, null, 101, 81.85], TS))!;
    expect(q.closes).toEqual([108.9, 101, 81.85]);
    expect(q.closeDays).toEqual(["2026-11-05", "2026-11-09", "2026-11-11"]);
    expect(q.closeDays).toHaveLength(q.closes.length);
  });

  it("a dropped bar may carry a null timestamp: only the kept indexes need a usable one", () => {
    const q = parseYahooChart("CITAS", chart([108.9, null, 101, 81.85], [TS[0]!, null, TS[2]!, TS[3]!]))!;
    expect(q.closeDays).toEqual(["2026-11-05", "2026-11-09", "2026-11-11"]);
  });

  it("is undefined when the timestamp array is missing, not an array, or not the same length as the closes", () => {
    expect(parseYahooChart("CITAS", chart([108.9, 101, 101, 81.85]))!.closeDays).toBeUndefined();
    expect(parseYahooChart("CITAS", chart([108.9, 101, 101, 81.85], null))!.closeDays).toBeUndefined();
    expect(parseYahooChart("CITAS", chart([108.9, 101, 101, 81.85], "2026-11-05"))!.closeDays).toBeUndefined();
    expect(parseYahooChart("CITAS", chart([108.9, 101, 101, 81.85], TS.slice(0, 3)))!.closeDays).toBeUndefined();
    expect(parseYahooChart("CITAS", chart([108.9, 101, 101], TS))!.closeDays).toBeUndefined();
  });

  it("is undefined when a kept index has a null or non-finite timestamp", () => {
    expect(parseYahooChart("CITAS", chart([108.9, 101, 101, 81.85], [TS[0]!, null, TS[2]!, TS[3]!]))!.closeDays).toBeUndefined();
    expect(parseYahooChart("CITAS", chart([108.9, 101, 101, 81.85], [TS[0]!, Number.NaN, TS[2]!, TS[3]!]))!.closeDays).toBeUndefined();
    expect(parseYahooChart("CITAS", chart([108.9, 101, 101, 81.85], [TS[0]!, "x", TS[2]!, TS[3]!]))!.closeDays).toBeUndefined();
  });

  it("leaves the key off the quote when it is undefined, and changes nothing else in it", () => {
    const withTs = parseYahooChart("CITAS", chart([108.9, 101, 101, 81.85], TS))!;
    const without = parseYahooChart("CITAS", chart([108.9, 101, 101, 81.85]))!;
    expect("closeDays" in without).toBe(false);
    const { closeDays: _days, ...rest } = withTs;
    expect(rest).toEqual(without);
  });

  it("an empty close array gives an empty closeDays when the timestamps are empty too", () => {
    expect(parseYahooChart("CITAS", chart([], []))!.closeDays).toEqual([]);
  });
});

describe("YahooQuoteSource", () => {
  it("skips symbols that fail and keeps the rest", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("DEAD.IS")) return new Response("nope", { status: 404 });
      return new Response(JSON.stringify(SAMPLE), { status: 200 });
    }) as typeof fetch;
    const quotes = await new YahooQuoteSource(fetchImpl).getQuotes(["THYAO", "DEAD", "ASELS"]);
    expect(quotes.map((q) => q.ticker).sort()).toEqual(["ASELS", "THYAO"]);
    vi.mocked(console.info).mockRestore();
  });
});

// h28-errors-3: a Yahoo 404 is a permanent "this symbol is not listed" answer,
// a different outcome from a 5xx / timeout / unparseable payload ("try again
// soon"). lookup() keeps the three apart; getQuotes() still returns quotes only.
describe("YahooQuoteSource.lookup", () => {
  let info: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    info = vi.spyOn(console, "info").mockImplementation(() => {});
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    info.mockRestore();
    warn.mockRestore();
  });

  const respond = (status: number, body: string = "nope") =>
    (async () => new Response(body, { status })) as typeof fetch;

  it("a 404 is 'unlisted' and is logged at info level with the status and the ticker, never as a warning", async () => {
    const outcome = await new YahooQuoteSource(respond(404)).lookup("DEAD");

    expect(outcome).toEqual({ kind: "unlisted" });
    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0]?.[0]);
    expect(line).toContain("404");
    expect(line).toContain("DEAD");
    expect(warn).not.toHaveBeenCalled();
  });

  it("a 503 is 'unavailable' and keeps the warning", async () => {
    const outcome = await new YahooQuoteSource(respond(503)).lookup("DEAD");

    expect(outcome).toEqual({ kind: "unavailable" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("503");
    expect(String(warn.mock.calls[0]?.[0])).toContain("DEAD");
    expect(info).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 429, 500, 502])("a %i is 'unavailable', not 'unlisted'", async (status) => {
    expect(await new YahooQuoteSource(respond(status)).lookup("DEAD")).toEqual({ kind: "unavailable" });
    expect(info).not.toHaveBeenCalled();
  });

  it("a rejecting fetch is 'unavailable' and warns", async () => {
    const outcome = await new YahooQuoteSource((async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch).lookup("DEAD");

    expect(outcome).toEqual({ kind: "unavailable" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("DEAD");
  });

  it("a 200 whose chart has no result is 'unavailable'", async () => {
    const outcome = await new YahooQuoteSource(
      respond(200, JSON.stringify({ chart: { result: null, error: { code: "Not Found" } } })),
    ).lookup("XXXX");

    expect(outcome).toEqual({ kind: "unavailable" });
  });

  it("a 200 with a body that is not JSON is 'unavailable' (the json() throw is caught)", async () => {
    expect(await new YahooQuoteSource(respond(200, "<html>")).lookup("XXXX")).toEqual({ kind: "unavailable" });
  });

  it("a good payload is a 'quote' carrying the parsed Quote", async () => {
    const outcome = await new YahooQuoteSource(respond(200, JSON.stringify(SAMPLE))).lookup("THYAO");

    expect(outcome.kind).toBe("quote");
    if (outcome.kind !== "quote") throw new Error("unreachable");
    expect(outcome.quote).toEqual(parseYahooChart("THYAO", SAMPLE));
  });

  it("getQuotes keeps its Quote[] signature and collects only the 'quote' outcomes", async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("GONE.IS")) return new Response("nope", { status: 404 });
      if (u.includes("DOWN.IS")) return new Response("nope", { status: 503 });
      return new Response(JSON.stringify(SAMPLE), { status: 200 });
    }) as typeof fetch;

    const quotes = await new YahooQuoteSource(fetchImpl).getQuotes(["THYAO", "GONE", "DOWN", "ASELS"]);

    expect(quotes.map((q) => q.ticker).sort()).toEqual(["ASELS", "THYAO"]);
  });
});

describe("getQuotes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns quotes for all 60 requested tickers, not just the alphabetical first 40 (TS-01 regression)", async () => {
    const tickers = Array.from({ length: 60 }, (_, i) => `TICK${String(i).padStart(2, "0")}`);
    vi.stubGlobal(
      "fetch",
      (async () => new Response(JSON.stringify(SAMPLE), { status: 200 })) as typeof fetch,
    );
    const quotes = await getQuotes(tickers);
    expect(Object.keys(quotes).sort()).toEqual([...tickers].sort());
  });

  it("returns an empty object without fetching for an empty ticker list", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy as unknown as typeof fetch);
    expect(await getQuotes([])).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// The documented swap point: quotes.ts tells maintainers to implement
// `QuoteSource` over a paid feed and return it from `defaultQuoteSource()`.
// That only works if `getQuote` (the cache boundary behind /ekonomi) reaches
// its source through `defaultQuoteSource()` and the interface carries the
// `lookup()` outcome, 'unlisted' included.
describe("defaultQuoteSource (the swap point)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("hands back a QuoteSource that reports lookup outcomes", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubGlobal("fetch", (async () => new Response("Not Found", { status: 404 })) as typeof fetch);

    const source: Pick<ReturnType<typeof defaultQuoteSource>, "lookup"> = defaultQuoteSource();

    await expect(source.lookup("DEAD")).resolves.toEqual({ kind: "unlisted" });
  });

  it("getQuote reaches its source through defaultQuoteSource().lookup, not a hard-wired Yahoo class", () => {
    const src = readFileSync(join(resolve(__dirname, "..", "..", ".."), "src/lib/finance/quotes.ts"), "utf8");
    const start = src.indexOf("async function getQuote(");
    const end = src.indexOf("\n}\n", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);

    expect(body).toContain("defaultQuoteSource().lookup(ticker)");
    expect(body).not.toContain("new YahooQuoteSource");
  });
});

// ---------------------------------------------------------------------------
// cached-failure-sweep: getQuote's lifetime follows the outcome. A real quote
// keeps the 5-minute window; a Yahoo non-200, a reject, or an unknown symbol
// (YahooQuoteSource turns all of them into "no quote") is memoised for
// 'minutes' only, so a blip cannot blank a ticker chip for 5-15 minutes.
// ---------------------------------------------------------------------------

describe("getQuotes cache lifetime", () => {
  const QUOTE_PROFILE = { stale: 60, revalidate: 300, expire: 900 };
  // h28-errors-3: a Yahoo 404 (a symbol Yahoo does not list) is cached for 6 h.
  const UNLISTED_PROFILE = { stale: 3600, revalidate: 21600, expire: 86400 };

  beforeEach(() => {
    vi.mocked(cacheLife).mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.mocked(console.warn).mockRestore();
    vi.mocked(console.info).mockRestore();
    vi.unstubAllGlobals();
  });

  it("success: the quote and exactly one cacheLife with the object profile", async () => {
    vi.stubGlobal("fetch", (async () => new Response(JSON.stringify(SAMPLE), { status: 200 })) as typeof fetch);

    const quotes = await getQuotes(["THYAO"]);

    expect(Object.keys(quotes)).toEqual(["THYAO"]);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith(QUOTE_PROFILE);
  });

  it("a Yahoo non-200: no quote, cached for 'minutes' only", async () => {
    vi.stubGlobal("fetch", (async () => new Response("nope", { status: 503 })) as typeof fetch);

    await expect(getQuotes(["THYAO"])).resolves.toEqual({});

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("a rejecting fetch (network down): no quote, cached for 'minutes' only", async () => {
    vi.stubGlobal("fetch", (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);

    await expect(getQuotes(["THYAO"])).resolves.toEqual({});

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("an unknown symbol payload (no result): no quote, cached for 'minutes' only", async () => {
    vi.stubGlobal(
      "fetch",
      (async () =>
        new Response(JSON.stringify({ chart: { result: null, error: { code: "Not Found" } } }), {
          status: 200,
        })) as typeof fetch,
    );

    await expect(getQuotes(["XXXX"])).resolves.toEqual({});

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("a Yahoo 404 (an unlisted symbol): no quote, exactly one cacheLife with the 6 h profile, an info line and no warning", async () => {
    vi.stubGlobal("fetch", (async () => new Response("Not Found", { status: 404 })) as typeof fetch);

    await expect(getQuotes(["DEAD"])).resolves.toEqual({});

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith(UNLISTED_PROFILE);
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledTimes(1);
    const line = String(vi.mocked(console.info).mock.calls[0]?.[0]);
    expect(line).toContain("404");
    expect(line).toContain("DEAD");
  });

  it("only a 404 gets the long profile: other 4xx statuses keep 'minutes'", async () => {
    for (const status of [400, 403, 429]) {
      vi.mocked(cacheLife).mockClear();
      vi.stubGlobal("fetch", (async () => new Response("nope", { status })) as typeof fetch);

      await expect(getQuotes(["THYAO"])).resolves.toEqual({});

      expect(cacheLife).toHaveBeenCalledTimes(1);
      expect(cacheLife).toHaveBeenCalledWith("minutes");
    }
  });

  it("each ticker picks its own lifetime: one live quote and one dead symbol", async () => {
    vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
      if (String(url).includes("DEAD.IS")) return new Response("nope", { status: 404 });
      return new Response(JSON.stringify(SAMPLE), { status: 200 });
    }) as typeof fetch);

    const quotes = await getQuotes(["THYAO", "DEAD"]);

    expect(quotes).toEqual({
      THYAO: expect.objectContaining({ ticker: "THYAO", price: expect.any(Number) }),
    });
    expect("DEAD" in quotes).toBe(false);
    expect(cacheLife).toHaveBeenCalledTimes(2);
    const profiles = vi.mocked(cacheLife).mock.calls.map((c) => c[0]);
    expect(profiles).toContainEqual(QUOTE_PROFILE);
    expect(profiles).toContainEqual(UNLISTED_PROFILE);
    expect(profiles).not.toContain("minutes");
  });

  it("the empty list short-circuits before any cache entry: no cacheLife at all", async () => {
    await expect(getQuotes([])).resolves.toEqual({});
    expect(cacheLife).not.toHaveBeenCalled();
  });
});

describe("format", () => {
  it("formats signed percent in Turkish", () => {
    expect(fmtPct(1.5)).toBe("+%1,50");
    expect(fmtPct(-0.25)).toBe("-%0,25");
  });

  it("colours moves and treats noise as flat", () => {
    expect(moveClass(0.3)).toContain("emerald");
    expect(moveClass(-0.3)).toContain("red");
    expect(moveClass(0.001)).toContain("muted");
  });

  it("computes the move since a reference price and flags the BIST limit", () => {
    expect(pctChange(100, 101.5)).toBeCloseTo(1.5, 9);
    expect(pctChange(null, 101.5)).toBeNull();
    expect(pctChange(0, 5)).toBeNull();
    expect(limitFlag(9.6)).toBe("tavan");
    expect(limitFlag(-9.8)).toBe("taban");
    expect(limitFlag(4)).toBeNull();
    expect(fmtX(2.44)).toBe("2,4x");
  });

  it("shows only the clock for today in Istanbul", () => {
    const now = Date.parse("2026-09-13T10:00:00Z");
    expect(fmtWhen("2026-09-13T07:05:00Z", now)).toBe("10:05");
    expect(fmtWhen("2026-09-12T07:05:00Z", now)).toMatch(/^12\.09 10:05$/);
  });
});
