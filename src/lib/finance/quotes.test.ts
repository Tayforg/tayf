import { describe, expect, it } from "vitest";

import { fmtPct, fmtWhen, fmtX, limitFlag, moveClass, pctChange } from "./format";
import { parseYahooChart, YahooQuoteSource } from "./quotes";

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
  it("reads price, percent change and closes", () => {
    const q = parseYahooChart("THYAO", SAMPLE)!;
    expect(q.ticker).toBe("THYAO");
    expect(q.price).toBe(300.25);
    expect(q.changePct).toBeCloseTo(0.334, 3);
    expect(q.prevClose).toBeCloseTo(299.25, 1);
    expect(q.closes).toEqual([305, 301.5, 299.25, 300.25]);
    expect(q.currency).toBe("TRY");
  });

  it("falls back to the last two closes when the percent is missing", () => {
    const json = structuredClone(SAMPLE) as { chart: { result: Array<{ meta: Record<string, unknown> }> } };
    delete json.chart.result[0]!.meta.regularMarketChangePercent;
    const q = parseYahooChart("THYAO", json)!;
    expect(q.changePct).toBeCloseTo(((300.25 - 299.25) / 299.25) * 100, 6);
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
