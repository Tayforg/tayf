import { describe, expect, it } from "vitest";

import { istDay, parseDailyBars, parseIntradayBars, yahooChartUrl } from "../../supabase/functions/_shared/bars.ts";

// Shapes captured from query1.finance.yahoo.com on 2026-09-14 (THYAO.IS).
const daily = {
  chart: {
    result: [
      {
        timestamp: [1789367400, 1789453800, 1789453800],
        indicators: {
          quote: [
            {
              open: [298, 300, 300.5],
              high: [302, 303, 303],
              low: [296, 299, 299],
              close: [299.25, null, 300.25],
              volume: [38386110, 36184804, 36184805],
            },
          ],
        },
      },
    ],
  },
};

describe("bars", () => {
  it("builds the Yahoo URL for a BIST code", () => {
    expect(yahooChartUrl("THYAO", "1d", "5m")).toBe(
      "https://query1.finance.yahoo.com/v8/finance/chart/THYAO.IS?range=1d&interval=5m",
    );
  });

  it("maps daily bars to Istanbul dates, drops null closes, keeps the last repeat", () => {
    const rows = parseDailyBars("THYAO", daily);
    expect(rows.map((r) => r.day)).toEqual([istDay(1789367400), istDay(1789453800)]);
    expect(rows[1]).toMatchObject({ close: 300.25, volume: 36184805 });
  });

  it("floors intraday timestamps to the 5-minute grid", () => {
    const rows = parseIntradayBars("THYAO", {
      chart: {
        result: [
          {
            timestamp: [1789368900, 1789369200, 1789369311],
            indicators: { quote: [{ close: [297, 297.5, 297.5], volume: [10, 20, 5] }] },
          },
        ],
      },
    });
    // 1789369311 floors to 1789369200 and overwrites that bar.
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ ts: new Date(1789369200 * 1000).toISOString(), close: 297.5, volume: 5 });
  });

  it("returns nothing for an error payload", () => {
    expect(parseDailyBars("X", { chart: { result: null } })).toEqual([]);
    expect(parseIntradayBars("X", {})).toEqual([]);
  });
});
