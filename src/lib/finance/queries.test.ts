import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Harness mirrors src/lib/sources/active-count.test.ts's shared-fake wiring:
// `createSupabaseFake`'s client is returned from a mocked
// `@supabase/supabase-js` `createClient`, so `createFinanceServerClient()`'s
// real (non-fixture) branch resolves to the fake client end to end — no
// need to mock `@/lib/supabase/server` itself. next/cache's cacheLife /
// cacheTag are stubbed since the "use cache" directive is a no-op outside
// a Next.js cacheComponents build.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));

const fixture = vi.hoisted(() => ({
  kapDisclosures: [] as unknown[],
  bars5m: [] as Array<{ ts: string; close: number; volume: number }>,
  econFeedRows: [] as unknown[],
  lastKapState: null as unknown,
  // SEC-07 follow-up: fetchKapBreakerState reads kap_fetch_state (migration
  // 059). `undefined` = table errors (simulates a Supabase error envelope);
  // an object = the row; `null` = no row (maybeSingle's zero-row case).
  kapFetchStateRow: undefined as
    | { blocked_until: string | null; last_status: number | null; last_error: string | null; updated_at: string }
    | null
    | undefined,
  // reader-data (§4(b)): article_tickers rows for fetchTopTickers /
  // fetchTickerPage, and the shared jev_shadow_predictions ticker_relevance
  // rows both the `.in('subject_id', …)` (fetchRelevanceScores) and
  // `.lt('jev_prob', …)` (fetchLowRelevanceSince) call shapes read from.
  articleTickers: [] as Array<{ ticker: string; article_id: string; published_at: string; source_id: string }>,
  jevRows: [] as Array<{ subject_id: string; jev_prob: number; created_at: string }>,
  bistCompanies: [] as Array<{ tickers: string[]; title: string }>,
  tickerArticlesRows: [] as unknown[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      kap_disclosures: (state: unknown) => {
        fixture.lastKapState = state;
        return { data: fixture.kapDisclosures, error: null };
      },
      bist_bars_5m: (state: unknown) => {
        const s = state as import("../../../tests/_helpers/supabase-fake").BuilderState;
        const desc = s.order.some((o) => (o.opts as { ascending?: boolean } | undefined)?.ascending === false);
        const since = s.gte.find((g) => g.col === "ts")?.val as string | undefined;
        const rows = fixture.bars5m.filter((r) => !since || Date.parse(r.ts) >= Date.parse(since));
        const sorted = [...rows].sort((a, b) => (desc ? Date.parse(b.ts) - Date.parse(a.ts) : Date.parse(a.ts) - Date.parse(b.ts)));
        return { data: s.limit ? sorted.slice(0, s.limit) : sorted, error: null };
      },
      kap_fetch_state: () => {
        if (fixture.kapFetchStateRow === undefined) {
          return { data: null, error: { message: "kap_fetch_state read failed" } };
        }
        return { data: fixture.kapFetchStateRow, error: null };
      },
      article_tickers: (state: unknown) => {
        const s = state as import("../../../tests/_helpers/supabase-fake").BuilderState;
        const ticker = s.eq.find((e) => e.col === "ticker")?.val as string | undefined;
        const since = s.gte.find((g) => g.col === "published_at")?.val as string | undefined;
        let rows = fixture.articleTickers.filter(
          (r) => (!ticker || r.ticker === ticker) && (!since || r.published_at >= since),
        );
        if (s.range) rows = rows.slice(s.range.from, s.range.to + 1);
        return { data: rows, error: null };
      },
      jev_shadow_predictions: (state: unknown) => {
        const s = state as import("../../../tests/_helpers/supabase-fake").BuilderState;
        const inFilter = s.in.find((i) => i.col === "subject_id");
        if (inFilter) {
          const wanted = new Set(inFilter.vals as string[]);
          return { data: fixture.jevRows.filter((r) => wanted.has(r.subject_id)), error: null };
        }
        const ltFilter = s.lt.find((l) => l.col === "jev_prob");
        const since = s.gte.find((g) => g.col === "created_at")?.val as string | undefined;
        if (ltFilter) {
          return {
            data: fixture.jevRows.filter(
              (r) => r.jev_prob < (ltFilter.val as number) && (!since || r.created_at >= since),
            ),
            error: null,
          };
        }
        return { data: [], error: null };
      },
      bist_companies: () => ({ data: fixture.bistCompanies, error: null }),
    },
    rpc: {
      econ_feed: () => ({ data: fixture.econFeedRows, error: null }),
      ticker_articles: () => ({ data: fixture.tickerArticlesRows, error: null }),
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import { istToday } from "./format";
import {
  bucketLags,
  coverageStats,
  fetchCircuitBreakers,
  fetchEconFeed,
  fetchIntraday,
  fetchKapBreakerState,
  fetchRecentDisclosures,
  fetchTickerPage,
  fetchTopTickers,
  rankAttention,
  toFeedItem,
} from "./queries";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.kapDisclosures = [];
  fixture.bars5m = [];
  fixture.econFeedRows = [];
  fixture.lastKapState = null;
  fixture.kapFetchStateRow = undefined;
  fixture.articleTickers = [];
  fixture.jevRows = [];
  fixture.bistCompanies = [];
  fixture.tickerArticlesRows = [];
  supabaseFake.calls.rpc.length = 0;
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.useRealTimers();
});

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

  it("measures first coverage after the filing and flags only abnormal pre-filing attention", () => {
    const rows = [
      // 1: one routine mention before, first real coverage 30 min after
      { disclosure_index: 1, lag_minutes: -600 },
      { disclosure_index: 1, lag_minutes: 30 },
      { disclosure_index: 1, lag_minutes: 400 },
      // 2: only a mention two days before, never covered afterwards
      { disclosure_index: 2, lag_minutes: -2000 },
      // 3: four articles in the 24 h before, coverage 90 min after
      { disclosure_index: 3, lag_minutes: -1200 },
      { disclosure_index: 3, lag_minutes: -300 },
      { disclosure_index: 3, lag_minutes: -200 },
      { disclosure_index: 3, lag_minutes: -20 },
      { disclosure_index: 3, lag_minutes: 90 },
    ];
    // quiet ticker: 4 articles in a day is abnormal
    expect(coverageStats(rows, 5, 0.2)).toEqual({ disclosures: 5, covered: 2, medianLagMinutes: 60, pressAhead: 1 });
    // busy ticker (3 a day): the same 4 articles are just Tuesday
    expect(coverageStats(rows, 5, 3).pressAhead).toBe(0);
  });

  it("buckets lags into the fixed histogram", () => {
    const b = bucketLags([-3000, -100, -5, 10, 200, 900, 5000]);
    expect(b.map((x) => x.count)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });
});

describe("finance query fetchers (live Supabase shape)", () => {
  it("fetchRecentDisclosures keeps a row whose subject is null, not just non-breaker rows (TS-06)", async () => {
    fixture.kapDisclosures = [
      {
        disclosure_index: 1662301,
        published_at: "2026-09-13T08:00:00Z",
        kap_title: "ÖRNEK A.Ş.",
        stock_codes: ["ASELS"],
        subject: null,
        summary: null,
        disclosure_class: null,
      },
    ];
    const rows = await fetchRecentDisclosures(10);
    expect(rows).toEqual([
      {
        disclosureIndex: 1662301,
        publishedAt: "2026-09-13T08:00:00Z",
        kapTitle: "ÖRNEK A.Ş.",
        stockCodes: ["ASELS"],
        subject: null,
        summary: null,
        disclosureClass: null,
      },
    ]);
  });

  it("fetchCircuitBreakers' gte cut-off tracks istToday() for a fixed clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T20:00:00Z"));
    await fetchCircuitBreakers();
    const state = fixture.lastKapState as BuilderState;
    const gte = state.gte.find((g) => g.col === "published_at");
    expect(gte?.val).toBe(`${istToday()}T00:00:00+03:00`);
  });

  it("fetchIntraday picks the Istanbul day of the newest bar across a 21:00 UTC boundary", async () => {
    // 21:05 UTC is 00:05 Istanbul the NEXT calendar day.
    fixture.bars5m = [
      { ts: "2026-09-13T18:00:00Z", close: 10, volume: 100 },
      { ts: "2026-09-13T21:05:00Z", close: 11, volume: 120 },
    ];
    const { day, bars } = await fetchIntraday("THYAO");
    expect(day).toBe("2026-09-14");
    expect(bars.map((b) => b.ts)).toEqual(["2026-09-13T21:05:00Z"]);
  });

  it("fetchEconFeed maps econ_feed RPC rows into FeedItem with tickers deduped and sorted", async () => {
    fixture.econFeedRows = [
      {
        id: "a1",
        title: "Vestel'in kârı arttı",
        url: "https://x/1",
        published_at: "2026-09-13T08:00:00Z",
        category: "ekonomi",
        source_name: "Bloomberg HT",
        source_slug: "bloomberght",
        tickers: ["VESTL", "VESTL", "ASELS"],
      },
    ];
    const items = await fetchEconFeed(10);
    expect(items).toEqual([
      {
        id: "a1",
        title: "Vestel'in kârı arttı",
        url: "https://x/1",
        publishedAt: "2026-09-13T08:00:00Z",
        category: "ekonomi",
        source: { name: "Bloomberg HT", slug: "bloomberght" },
        tickers: ["ASELS", "VESTL"],
      },
    ]);
    // reader-data (§4b): over-fetches 1.25x so a hidden-ticker drop still
    // leaves close to `limit` items — ceil(10 * 1.25) = 13.
    expect(supabaseFake.calls.rpc.at(-1)).toEqual({ name: "econ_feed", args: { p_limit: 13 } });
  });

  // SEC-07 follow-up: fetchKapBreakerState is a deliberate exception to
  // this file's "every fetcher throws" rule (see header comment) — no
  // "use cache" (the admin badge wants the live row) and it returns null
  // instead of throwing, so a broken breaker read degrades the badge, not
  // the whole /admin/ekonomi page.
  it("fetchKapBreakerState returns the row, camelCased", async () => {
    fixture.kapFetchStateRow = {
      blocked_until: "2026-09-15T12:00:00.000Z",
      last_status: 403,
      last_error: "[kap-ingest] KAP 403 for 2026-09-15/*",
      updated_at: "2026-09-15T06:00:00.000Z",
    };
    const state = await fetchKapBreakerState();
    expect(state).toEqual({
      blockedUntil: "2026-09-15T12:00:00.000Z",
      lastStatus: 403,
      lastError: "[kap-ingest] KAP 403 for 2026-09-15/*",
      updatedAt: "2026-09-15T06:00:00.000Z",
    });
  });

  it("fetchKapBreakerState returns null on a Supabase error", async () => {
    fixture.kapFetchStateRow = undefined;
    const state = await fetchKapBreakerState();
    expect(state).toBeNull();
  });

  it("fetchKapBreakerState returns null when the row is missing", async () => {
    fixture.kapFetchStateRow = null;
    const state = await fetchKapBreakerState();
    expect(state).toBeNull();
  });

  it("fetchEconFeed maps a row with no source (source_slug null) to source: null", async () => {
    // reader-data (§4b): fetchEconFeed now drops any item left with zero
    // tickers (filterFeedTickers), so this fixture carries one real ticker
    // to isolate what this test actually checks — the source:null mapping
    // — from that unrelated behavior (covered separately below).
    fixture.econFeedRows = [
      {
        id: "a2",
        title: "Kaynaksız haber",
        url: "https://x/2",
        published_at: "2026-09-13T09:00:00Z",
        category: "ekonomi",
        source_name: null,
        source_slug: null,
        tickers: ["THYAO"],
      },
    ];
    const items = await fetchEconFeed(10);
    expect(items).toEqual([
      {
        id: "a2",
        title: "Kaynaksız haber",
        url: "https://x/2",
        publishedAt: "2026-09-13T09:00:00Z",
        category: "ekonomi",
        source: null,
        tickers: ["THYAO"],
      },
    ]);
  });

  it("fetchEconFeed drops an item left with zero tickers after mapping (never crashes on tickers: null)", async () => {
    fixture.econFeedRows = [
      {
        id: "a3",
        title: "Etiketsiz genel ekonomi haberi",
        url: "https://x/3",
        published_at: "2026-09-13T09:00:00Z",
        category: "ekonomi",
        source_name: null,
        source_slug: null,
        tickers: null,
      },
    ];
    const items = await fetchEconFeed(10);
    expect(items).toEqual([]);
  });
});

describe("reader-data (§4b): Jev ticker-relevance gate", () => {
  it("fetchEconFeed asks econ_feed for 1.25x the display limit and hides a p<0.2 ticker", async () => {
    fixture.econFeedRows = [
      {
        id: "a1",
        title: "DEVA'dan açıklama geldi",
        url: "https://x/1",
        published_at: "2026-09-13T08:00:00Z",
        category: "ekonomi",
        source_name: "Dünya",
        source_slug: "dunya",
        tickers: ["DEVA", "THYAO"],
      },
      {
        id: "a2",
        title: "Sadece hisse eşleşmesi düşük olan haber",
        url: "https://x/2",
        published_at: "2026-09-13T07:00:00Z",
        category: "ekonomi",
        source_name: "Sözcü",
        source_slug: "sozcu",
        tickers: ["EREGL"],
      },
      {
        id: "a3",
        title: "Skoru henüz yok",
        url: "https://x/3",
        published_at: "2026-09-13T06:00:00Z",
        category: "ekonomi",
        source_name: "NTV",
        source_slug: "ntv",
        tickers: ["ASELS"],
      },
    ];
    fixture.jevRows = [
      { subject_id: "a1:DEVA", jev_prob: 0.05, created_at: "2026-09-13T08:00:00Z" },
      { subject_id: "a2:EREGL", jev_prob: 0.1, created_at: "2026-09-13T07:00:00Z" },
      // a3:ASELS deliberately unscored — fail-open, always shown.
    ];

    const items = await fetchEconFeed(80);

    expect(supabaseFake.calls.rpc.at(-1)).toEqual({ name: "econ_feed", args: { p_limit: 100 } });
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    // a1 keeps THYAO but loses the hidden DEVA match.
    expect(byId.a1?.tickers).toEqual(["THYAO"]);
    // a2's only ticker was hidden — the whole item drops out of the feed.
    expect(byId.a2).toBeUndefined();
    // a3's unscored ticker is fail-open shown.
    expect(byId.a3?.tickers).toEqual(["ASELS"]);
  });

  it("fetchTopTickers excludes a <0.5 scored row from articles/sources but counts an unscored row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T12:00:00Z"));
    fixture.articleTickers = [
      { ticker: "AAA", article_id: "a1", published_at: "2026-09-13T08:00:00Z", source_id: "s1" },
      { ticker: "AAA", article_id: "a2", published_at: "2026-09-13T09:00:00Z", source_id: "s2" },
    ];
    fixture.jevRows = [
      { subject_id: "a1:AAA", jev_prob: 0.3, created_at: "2026-09-13T08:00:00Z" },
      // a2:AAA is unscored — fail-open, counts.
    ];

    const result = await fetchTopTickers(2, 10);
    const aaa = result.find((r) => r.ticker === "AAA");
    expect(aaa).toBeDefined();
    expect(aaa!.articles).toBe(1);
    expect(aaa!.sources).toBe(1);
  });

  it("fetchTickerPage filters both the article list and the attention series by relevance", async () => {
    fixture.articleTickers = [
      { ticker: "BBB", article_id: "a1", published_at: "2026-09-13T08:00:00Z", source_id: "s1" },
      { ticker: "BBB", article_id: "a2", published_at: "2026-09-13T09:00:00Z", source_id: "s2" },
    ];
    fixture.tickerArticlesRows = [
      {
        id: "a1",
        title: "İlgisiz eşleşme",
        url: "https://x/1",
        published_at: "2026-09-13T08:00:00Z",
        category: "ekonomi",
        source_name: "Dünya",
        source_slug: "dunya",
        matched_on: "alias",
      },
      {
        id: "a2",
        title: "İlgili haber",
        url: "https://x/2",
        published_at: "2026-09-13T09:00:00Z",
        category: "ekonomi",
        source_name: "Sözcü",
        source_slug: "sozcu",
        matched_on: "alias",
      },
    ];
    fixture.jevRows = [{ subject_id: "a1:BBB", jev_prob: 0.05, created_at: "2026-09-13T08:00:00Z" }];

    const page = await fetchTickerPage("BBB");

    expect(page.articles.map((a) => a.id)).toEqual(["a2"]);
    const totalAttentionArticles = page.attention.reduce((s, d) => s + d.articles, 0);
    expect(totalAttentionArticles).toBe(1);
  });
});
