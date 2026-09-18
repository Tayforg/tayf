import { afterEach, describe, expect, it, vi } from "vitest";

// `getQuote`/`getQuotes` are wrapped in "use cache"; next/cache's real
// cacheLife() throws outside a Next.js cacheComponents build ("`cacheLife()`
// is only available with the `cacheComponents` config"), so it's stubbed
// here the same way src/lib/finance/queries.test.ts stubs it.
vi.mock("next/cache", () => ({ cacheLife: vi.fn() }));

import { fmtPct, fmtWhen, fmtX, limitFlag, moveClass, pctChange } from "./format";
import { getQuotes, parseYahooChart, YahooQuoteSource } from "./quotes";

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
  it("reads price and closes, and prefers chartPreviousClose for the percent change (TS-09)", () => {
    const q = parseYahooChart("THYAO", SAMPLE)!;
    expect(q.ticker).toBe("THYAO");
    expect(q.price).toBe(300.25);
    expect(q.prevClose).toBe(305);
    expect(q.changePct).toBeCloseTo(((300.25 - 305) / 305) * 100, 6);
    expect(q.closes).toEqual([305, 301.5, 299.25, 300.25]);
    expect(q.currency).toBe("TRY");
  });

  it("uses chartPreviousClose for the change when regularMarketChangePercent is missing", () => {
    const json = structuredClone(SAMPLE) as { chart: { result: Array<{ meta: Record<string, unknown> }> } };
    delete json.chart.result[0]!.meta.regularMarketChangePercent;
    const q = parseYahooChart("THYAO", json)!;
    expect(q.prevClose).toBe(305);
    expect(q.changePct).toBeCloseTo(((300.25 - 305) / 305) * 100, 6);
  });

  it("falls back to regularMarketChangePercent when chartPreviousClose is not a usable positive number", () => {
    const json = structuredClone(SAMPLE) as { chart: { result: Array<{ meta: Record<string, unknown> }> } };
    json.chart.result[0]!.meta.chartPreviousClose = 0;
    const q = parseYahooChart("THYAO", json)!;
    expect(q.changePct).toBeCloseTo(0.334, 3);
    expect(q.prevClose).toBeCloseTo(299.25, 1);
  });

  it("falls back to the last two closes when both chartPreviousClose and regularMarketChangePercent are missing", () => {
    const json = structuredClone(SAMPLE) as { chart: { result: Array<{ meta: Record<string, unknown> }> } };
    delete json.chart.result[0]!.meta.regularMarketChangePercent;
    delete json.chart.result[0]!.meta.chartPreviousClose;
    const q = parseYahooChart("THYAO", json)!;
    expect(q.prevClose).toBeCloseTo(299.25, 1);
    expect(q.changePct).toBeCloseTo(((300.25 - 299.25) / 299.25) * 100, 6);
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

describe("format", () => {
  it("formats signed percent in Turkish", () => {
    expect(fmtPct(1.5)).toBe("+1,50%");
    expect(fmtPct(-0.25)).toBe("-0,25%");
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
