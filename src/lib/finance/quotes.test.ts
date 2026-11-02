import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `getQuote`/`getQuotes` are wrapped in "use cache"; next/cache's real
// cacheLife() throws outside a Next.js cacheComponents build ("`cacheLife()`
// is only available with the `cacheComponents` config"), so it's stubbed
// here the same way src/lib/finance/queries.test.ts stubs it.
vi.mock("next/cache", () => ({ cacheLife: vi.fn() }));

import { cacheLife } from "next/cache";
import { fmtPct, fmtWhen, fmtX, limitFlag, moveClass, pctChange } from "./format";
import { getQuotes, parseYahooChart, YahooQuoteSource } from "./quotes";
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

describe("YahooQuoteSource", () => {
  it("skips symbols that fail and keeps the rest", async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("DEAD.IS")) return new Response("nope", { status: 404 });
      return new Response(JSON.stringify(SAMPLE), { status: 200 });
    }) as typeof fetch;
    const quotes = await new YahooQuoteSource(fetchImpl).getQuotes(["THYAO", "DEAD", "ASELS"]);
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

// ---------------------------------------------------------------------------
// cached-failure-sweep: getQuote's lifetime follows the outcome. A real quote
// keeps the 5-minute window; a Yahoo non-200, a reject, or an unknown symbol
// (YahooQuoteSource turns all of them into "no quote") is memoised for
// 'minutes' only, so a blip cannot blank a ticker chip for 5-15 minutes.
// ---------------------------------------------------------------------------

describe("getQuotes cache lifetime", () => {
  const QUOTE_PROFILE = { stale: 60, revalidate: 300, expire: 900 };

  beforeEach(() => {
    vi.mocked(cacheLife).mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.mocked(console.warn).mockRestore();
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

  it("each ticker picks its own lifetime: one live quote and one dead symbol", async () => {
    vi.stubGlobal("fetch", (async (url: string | URL | Request) => {
      if (String(url).includes("DEAD.IS")) return new Response("nope", { status: 404 });
      return new Response(JSON.stringify(SAMPLE), { status: 200 });
    }) as typeof fetch);

    const quotes = await getQuotes(["THYAO", "DEAD"]);

    expect(Object.keys(quotes)).toEqual(["THYAO"]);
    expect(cacheLife).toHaveBeenCalledTimes(2);
    const profiles = vi.mocked(cacheLife).mock.calls.map((c) => c[0]);
    expect(profiles).toContainEqual(QUOTE_PROFILE);
    expect(profiles).toContain("minutes");
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
