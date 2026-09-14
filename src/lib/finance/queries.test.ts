import { describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));

import { bucketLags, coverageStats, rankAttention, toFeedItem } from "./queries";

describe("finance query transforms", () => {
  it("flattens an article row with embedded source and tickers", () => {
    const item = toFeedItem({
      id: "a1",
      title: "Vestel'in kârı arttı",
      url: "https://x/1",
      published_at: "2026-09-13T08:00:00Z",
      category: "ekonomi",
      source: [{ name: "Bloomberg HT", slug: "bloomberght" }],
      article_tickers: [{ ticker: "VESTL" }, { ticker: "VESTL" }, { ticker: "ASELS" }],
    });
    expect(item.source?.slug).toBe("bloomberght");
    expect(item.tickers).toEqual(["ASELS", "VESTL"]);
  });

  it("ranks attention on the recent window and rates it against the baseline", () => {
    const ranked = rankAttention(
      [
        { ticker: "THYAO", day: "2026-09-06", articles: 1, sources: 1 },
        { ticker: "THYAO", day: "2026-09-09", articles: 2, sources: 1 },
        { ticker: "THYAO", day: "2026-09-12", articles: 2, sources: 2 },
        { ticker: "THYAO", day: "2026-09-13", articles: 5, sources: 4 },
        { ticker: "VESTL", day: "2026-09-13", articles: 6, sources: 1 },
        { ticker: "OLD", day: "2026-09-08", articles: 9, sources: 3 },
      ],
      new Map([["THYAO", "TÜRK HAVA YOLLARI A.O."]]),
      10,
      "2026-09-12",
      2,
      6,
    );
    expect(ranked.map((r) => r.ticker)).toEqual(["THYAO", "VESTL"]);
    // 7 articles over 2 days vs 3 over the 6 baseline days: 3.5 / 0.5 = 7x
    expect(ranked[0]).toMatchObject({ articles: 7, sources: 4, title: "TÜRK HAVA YOLLARI A.O.", ratio: 7 });
    expect(ranked[1]).toMatchObject({ title: null, ratio: null });
  });

  it("computes first-coverage lag per disclosure", () => {
    const stats = coverageStats(
      [
        { disclosure_index: 1, lag_minutes: 30 },
        { disclosure_index: 1, lag_minutes: 400 },
        { disclosure_index: 2, lag_minutes: -180 },
      ],
      5,
    );
    expect(stats).toEqual({ disclosures: 5, covered: 2, medianLagMinutes: -75, pressAhead: 1 });
  });

  it("buckets lags into the fixed histogram", () => {
    const b = bucketLags([-3000, -100, -5, 10, 200, 900, 5000]);
    expect(b.map((x) => x.count)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });
});
