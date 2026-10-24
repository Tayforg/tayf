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
  tickerArticlesError: null as string | null,
  // migration 107: ids of BİK court / official notices. The ticker readers
  // drop these before aggregating. `legalNoticeError` simulates the lookup
  // failing (statement timeout, or the table not applied yet); `lastLegalState`
  // records the builder state of the most recent lookup.
  legalNotices: [] as Array<{ article_id: string; published_at: string }>,
  legalNoticeError: null as string | null,
  lastLegalState: null as unknown,
  // cached-failure-sweep: bist_quote_stats rows + the builder state of the
  // last read (to see the normalised ticker list), and an econ_feed error.
  quoteStats: [] as unknown[],
  lastQuoteStatsState: null as unknown,
  econFeedError: null as string | null,
  // Counts every supabase-js createClient() call, and lets a test make the
  // factory throw (a client that cannot be built = a failing read).
  clientBuilds: 0,
  clientFailure: null as string | null,
  // The first N client builds throw, later ones succeed (a transient blip).
  clientBlips: 0,
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
      bist_quote_stats: (state: unknown) => {
        fixture.lastQuoteStatsState = state;
        return { data: fixture.quoteStats, error: null };
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
      legal_notice_articles: (state: unknown) => {
        const s = state as import("../../../tests/_helpers/supabase-fake").BuilderState;
        fixture.lastLegalState = s;
        if (fixture.legalNoticeError) return { data: null, error: { message: fixture.legalNoticeError } };
        const since = s.gte.find((g) => g.col === "published_at")?.val as string | undefined;
        const rows = fixture.legalNotices
          .filter((r) => !since || r.published_at >= since)
          .sort((a, b) => b.published_at.localeCompare(a.published_at) || a.article_id.localeCompare(b.article_id));
        // Like PostgREST: a response never exceeds max_rows (1,000), whatever limit/range asks.
        const from = s.range ? s.range.from : 0;
        const asked = s.range ? s.range.to - s.range.from + 1 : (s.limit ?? rows.length);
        return { data: rows.slice(from, from + Math.min(asked, 1000)), error: null };
      },
    },
    rpc: {
      econ_feed: () =>
        fixture.econFeedError
          ? { data: null, error: { message: fixture.econFeedError } }
          : { data: fixture.econFeedRows, error: null },
      ticker_articles: () =>
        fixture.tickerArticlesError
          ? { data: null, error: { message: fixture.tickerArticlesError } }
          : { data: fixture.tickerArticlesRows, error: null },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => {
    fixture.clientBuilds += 1;
    if (fixture.clientBlips > 0) {
      fixture.clientBlips -= 1;
      throw new Error("blip");
    }
    if (fixture.clientFailure) throw new Error(fixture.clientFailure);
    return supabaseFake.client;
  },
}));

import { cacheLife, cacheTag } from "next/cache";
import { istToday } from "./format";
import {
  bucketLags,
  coverageStats,
  fetchCircuitBreakers,
  fetchEconFeed,
  fetchFinanceHealth,
  fetchIntraday,
  fetchKapBreakerState,
  fetchLagHistogram,
  fetchQuoteStats,
  fetchRecentDisclosures,
  fetchReferencePrices,
  fetchSignals,
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
  fixture.tickerArticlesError = null;
  fixture.legalNotices = [];
  fixture.legalNoticeError = null;
  fixture.lastLegalState = null;
  fixture.quoteStats = [];
  fixture.lastQuoteStatsState = null;
  fixture.econFeedError = null;
  fixture.clientBuilds = 0;
  fixture.clientFailure = null;
  fixture.clientBlips = 0;
  supabaseFake.calls.rpc.length = 0;
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
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
    // Freeze the clock like the sibling tests: fetchTickerPage windows by
    // Date.now(), so real time silently ages these fixtures out.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T12:00:00Z"));
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

describe("ticker-legal-notices (migration 107): BİK notices do not count as ticker attention", () => {
  const NOW = "2026-09-13T12:00:00Z";

  function warnSpy() {
    return vi.spyOn(console, "warn").mockImplementation(() => {});
  }

  function topTickerRows() {
    return [
      // n1 is a court notice that string-matched GARAN ("Garanti" in a debtor name).
      { ticker: "GARAN", article_id: "n1", published_at: "2026-09-13T08:00:00Z", source_id: "s1" },
      { ticker: "GARAN", article_id: "a2", published_at: "2026-09-13T09:00:00Z", source_id: "s2" },
    ];
  }

  it("fetchTopTickers does not count a GARAN row whose article is in legal_notice_articles", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    fixture.articleTickers = topTickerRows();
    fixture.legalNotices = [{ article_id: "n1", published_at: "2026-09-13T08:00:00Z" }];

    const garan = (await fetchTopTickers(2, 10)).find((r) => r.ticker === "GARAN");

    expect(garan).toBeDefined();
    expect(garan!.articles).toBe(1);
    expect(garan!.sources).toBe(1);
  });

  it("drops a ticker whose only articles are notices from the ranking altogether", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    fixture.articleTickers = [topTickerRows()[0]!];
    fixture.legalNotices = [{ article_id: "n1", published_at: "2026-09-13T08:00:00Z" }];

    expect(await fetchTopTickers(2, 10)).toEqual([]);
  });

  it("fetchTopTickers asks for notice ids over the same 8-day window as article_tickers, newest cap 5000", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    fixture.articleTickers = topTickerRows();

    await fetchTopTickers(2, 10);

    const state = fixture.lastLegalState as BuilderState;
    expect(state.table).toBe("legal_notice_articles");
    // days=2, baseline 6 -> 7 Istanbul days back from 2026-09-13.
    expect(state.gte).toEqual([{ col: "published_at", val: "2026-09-06T00:00:00+03:00" }]);
    expect(state.limit).toBe(5000);
  });

  it("fetchTopTickers excludes a notice that sits beyond PostgREST's 1,000-row response cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    fixture.articleTickers = topTickerRows();
    // 1,200 newer notices fill the first response; n1 is the oldest, row 1,201.
    fixture.legalNotices = [
      ...Array.from({ length: 1200 }, (_, i) => ({
        article_id: `x${String(i).padStart(4, "0")}`,
        published_at: new Date(Date.parse("2026-09-13T11:00:00Z") - i * 1000).toISOString(),
      })),
      { article_id: "n1", published_at: "2026-09-13T08:00:00Z" },
    ];

    const garan = (await fetchTopTickers(2, 10)).find((r) => r.ticker === "GARAN");

    expect(garan!.articles).toBe(1);
    expect(garan!.sources).toBe(1);
  });

  it("fetchTopTickers counts the notice row when the lookup errors (fail-open) and warns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    fixture.articleTickers = topTickerRows();
    fixture.legalNotices = [{ article_id: "n1", published_at: "2026-09-13T08:00:00Z" }];
    fixture.legalNoticeError = "canceling statement due to statement timeout";
    const spy = warnSpy();
    try {
      const garan = (await fetchTopTickers(2, 10)).find((r) => r.ticker === "GARAN");
      expect(garan!.articles).toBe(2);
      expect(garan!.sources).toBe(2);
      expect(spy.mock.calls.some((c) => String(c[0]).includes("legal-notice lookup unavailable"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("fetchTopTickers still counts everything on a pre-migration database (no notice rows)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    fixture.articleTickers = topTickerRows();
    const garan = (await fetchTopTickers(2, 10)).find((r) => r.ticker === "GARAN");
    expect(garan!.articles).toBe(2);
  });

  function tickerPageArticles() {
    return [
      {
        id: "n1",
        title: "Garanti Faktoring borçlusu için satış duyurusu",
        url: "https://x/n1",
        published_at: "2026-09-13T08:00:00Z",
        category: "ekonomi",
        source_name: "Dünya",
        source_slug: "dunya",
        matched_on: "alias",
      },
      {
        id: "a2",
        title: "Garanti BBVA kâr açıkladı",
        url: "https://x/a2",
        published_at: "2026-09-13T09:00:00Z",
        category: "ekonomi",
        source_name: "Sözcü",
        source_slug: "sozcu",
        matched_on: "alias",
      },
    ];
  }

  it("fetchTickerPage's attention series and article list both exclude the notice id", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    fixture.articleTickers = topTickerRows();
    fixture.tickerArticlesRows = tickerPageArticles();
    fixture.legalNotices = [{ article_id: "n1", published_at: "2026-09-13T08:00:00Z" }];

    const page = await fetchTickerPage("GARAN");

    // The list: n1's title is not caught by the title filter, only by the id set.
    expect(page.articles.map((a) => a.id)).toEqual(["a2"]);
    expect(page.attention.reduce((s, d) => s + d.articles, 0)).toBe(1);
  });

  it("fetchTickerPage looks notices up over its 30-day attention window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    fixture.articleTickers = topTickerRows();
    fixture.tickerArticlesRows = tickerPageArticles();

    await fetchTickerPage("GARAN");

    const state = fixture.lastLegalState as BuilderState;
    expect(state.table).toBe("legal_notice_articles");
    expect(state.gte).toEqual([{ col: "published_at", val: "2026-08-15T00:00:00+03:00" }]);
    expect(state.limit).toBe(5000);
  });

  it("fetchTickerPage does not throw when the lookup errors, and keeps everything (fail-open)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    fixture.articleTickers = topTickerRows();
    fixture.tickerArticlesRows = tickerPageArticles();
    fixture.legalNotices = [{ article_id: "n1", published_at: "2026-09-13T08:00:00Z" }];
    fixture.legalNoticeError = 'relation "public.legal_notice_articles" does not exist';
    const spy = warnSpy();
    try {
      const page = await fetchTickerPage("GARAN");
      expect(page.articles.map((a) => a.id).sort()).toEqual(["a2", "n1"]);
      expect(page.attention.reduce((s, d) => s + d.articles, 0)).toBe(2);
      expect(spy.mock.calls.some((c) => String(c[0]).includes("legal-notice lookup unavailable"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("fetchTickerPage still throws on a real page-content error (the lookup is the only fail-open read)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    fixture.tickerArticlesError = "ticker_articles boom";
    // The cached attempt logs once and the live retry once; the retry's own
    // error is what the caller sees.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(fetchTickerPage("GARAN")).rejects.toThrow(/fetchTickerPage articles: ticker_articles boom/);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// cached-failure-sweep: the cache lifetime follows the read's outcome, and a
// failed read is retried live exactly once, then rethrown to the caller (the
// route's error.tsx), never served as an empty page.
//
// Shape under test, per fetcher: `fetchX` (exported, uncached) =
// resolveCachedOrThrow(label, <fetchX>Cached, readX). The Cached body picks its
// cacheLife AFTER attemptCached. Failing client = the supabase-js factory
// throws, so BOTH the cached attempt and the live retry fail, and the client
// factory is built exactly twice. tests/guards/cache-life-after-attempt.test.ts
// pins the textual order; this pins the behaviour.
// ---------------------------------------------------------------------------

const FEED_PROFILE = { stale: 30, revalidate: 60, expire: 600 };
const ADMIN_PROFILE = { stale: 30, revalidate: 60, expire: 300 };

const SWEPT_FETCHERS: Array<{
  name: string;
  call: () => Promise<unknown>;
  tags: string[];
  profile: typeof FEED_PROFILE;
}> = [
  { name: "fetchEconFeed", call: () => fetchEconFeed(10), tags: ["finance-feed"], profile: FEED_PROFILE },
  { name: "fetchTopTickers", call: () => fetchTopTickers(2, 10), tags: ["finance-feed"], profile: FEED_PROFILE },
  { name: "fetchRecentDisclosures", call: () => fetchRecentDisclosures(10), tags: ["finance-feed"], profile: FEED_PROFILE },
  { name: "fetchCircuitBreakers", call: () => fetchCircuitBreakers(10), tags: ["finance-feed"], profile: FEED_PROFILE },
  { name: "fetchQuoteStats", call: () => fetchQuoteStats(["THYAO"]), tags: ["finance-bars"], profile: FEED_PROFILE },
  { name: "fetchReferencePrices", call: () => fetchReferencePrices(["a1"]), tags: ["finance-bars"], profile: FEED_PROFILE },
  { name: "fetchIntraday", call: () => fetchIntraday("THYAO"), tags: ["finance-bars", "finance-ticker:THYAO"], profile: FEED_PROFILE },
  { name: "fetchTickerPage", call: () => fetchTickerPage("THYAO"), tags: ["finance-feed", "finance-ticker:THYAO"], profile: FEED_PROFILE },
  // The admin trio keeps having no cacheTag.
  { name: "fetchFinanceHealth", call: () => fetchFinanceHealth(), tags: [], profile: ADMIN_PROFILE },
  { name: "fetchSignals", call: () => fetchSignals(10), tags: [], profile: ADMIN_PROFILE },
  { name: "fetchLagHistogram", call: () => fetchLagHistogram(7), tags: [], profile: ADMIN_PROFILE },
];

/** cacheTag (when the fetcher has tags) is invoked before the one cacheLife. */
function expectTagsBeforeLife(tags: string[]) {
  if (tags.length === 0) {
    expect(cacheTag).not.toHaveBeenCalled();
    return;
  }
  expect(cacheTag).toHaveBeenCalledWith(...tags);
  expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
    vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
  );
}

describe("cached-failure-sweep: cacheLife follows the outcome of each finance fetcher", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("covers every \"use cache\" fetcher exported from queries.ts (11)", () => {
    expect(SWEPT_FETCHERS.map((f) => f.name)).toHaveLength(11);
    expect(new Set(SWEPT_FETCHERS.map((f) => f.name)).size).toBe(11);
  });

  it.each(SWEPT_FETCHERS)(
    "$name: a failing client rejects after one live retry, and the failure is cached for 'minutes' only",
    async ({ call, tags }) => {
      fixture.clientFailure = "db down";

      await expect(call()).rejects.toThrow(/db down/);

      expect(cacheLife).toHaveBeenCalledTimes(1);
      expect(cacheLife).toHaveBeenCalledWith("minutes");
      expectTagsBeforeLife(tags);
      // Attempt (inside the cache) + one live retry (outside it).
      expect(fixture.clientBuilds).toBe(2);
    },
  );

  it.each(SWEPT_FETCHERS)(
    "$name: a successful read keeps its profile and builds the client once",
    async ({ call, tags, profile }) => {
      await call();

      expect(cacheLife).toHaveBeenCalledTimes(1);
      expect(cacheLife).toHaveBeenCalledWith(profile);
      expectTagsBeforeLife(tags);
      expect(fixture.clientBuilds).toBe(1);
    },
  );

  it("a Supabase error envelope (not just a throwing client) is also retried live once, then rethrown", async () => {
    fixture.econFeedError = "canceling statement due to statement timeout";

    await expect(fetchEconFeed(10)).rejects.toThrow(/fetchEconFeed: canceling statement/);

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(supabaseFake.calls.rpc.filter((c) => c.name === "econ_feed")).toHaveLength(2);
  });

  it("a blip on the cached attempt is healed by the live retry: data returned, failure cached for 'minutes'", async () => {
    // Only the first client build (the cached attempt) fails.
    fixture.clientBlips = 1;
    fixture.econFeedRows = [
      {
        id: "a1",
        title: "Vestel'in kârı arttı",
        url: "https://x/1",
        published_at: "2026-09-13T08:00:00Z",
        category: "ekonomi",
        source_name: "Bloomberg HT",
        source_slug: "bloomberght",
        tickers: ["VESTL"],
      },
    ];

    const items = await fetchEconFeed(10);

    expect(items.map((i) => i.id)).toEqual(["a1"]);
    expect(fixture.clientBuilds).toBe(2);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });
});

describe("cached-failure-sweep: input normalisation and short-circuits live in the exported function", () => {
  it("fetchQuoteStats([]) returns {} without a client, a cache entry or a cacheLife", async () => {
    await expect(fetchQuoteStats([])).resolves.toEqual({});
    expect(fixture.clientBuilds).toBe(0);
    expect(cacheLife).not.toHaveBeenCalled();
    expect(cacheTag).not.toHaveBeenCalled();
  });

  it("fetchReferencePrices([]) returns {} without a client, a cache entry or a cacheLife", async () => {
    await expect(fetchReferencePrices([])).resolves.toEqual({});
    expect(fixture.clientBuilds).toBe(0);
    expect(cacheLife).not.toHaveBeenCalled();
    expect(cacheTag).not.toHaveBeenCalled();
  });

  it("fetchQuoteStats dedupes and sorts the tickers before the query, whatever the call order", async () => {
    await fetchQuoteStats(["THYAO", "ASELS", "THYAO"]);
    const first = fixture.lastQuoteStatsState as BuilderState;
    expect(first.in).toEqual([{ col: "ticker", vals: ["ASELS", "THYAO"] }]);

    fixture.lastQuoteStatsState = null;
    await fetchQuoteStats(["ASELS", "THYAO"]);
    const second = fixture.lastQuoteStatsState as BuilderState;
    expect(second.in).toEqual(first.in);
  });

  it("fetchReferencePrices dedupes and sorts the article ids before the rpc", async () => {
    await fetchReferencePrices(["b2", "a1", "b2"]);
    expect(supabaseFake.calls.rpc.at(-1)).toEqual({
      name: "feed_reference_prices",
      args: { p_article_ids: ["a1", "b2"] },
    });
  });

  it("fetchQuoteStats maps a bist_quote_stats row into a QuoteStat", async () => {
    fixture.quoteStats = [
      {
        ticker: "THYAO",
        last_day: "2026-09-12",
        last_close: "300.25",
        prev_close: null,
        last_volume: 1000,
        avg_volume_20: "800",
        rvol: 1.25,
      },
    ];
    await expect(fetchQuoteStats(["THYAO"])).resolves.toEqual({
      THYAO: {
        ticker: "THYAO",
        lastDay: "2026-09-12",
        lastClose: 300.25,
        prevClose: null,
        lastVolume: 1000,
        avgVolume20: 800,
        rvol: 1.25,
      },
    });
  });
});
