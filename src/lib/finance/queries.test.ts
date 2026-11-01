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
  // When set, the kap_disclosures read resolves this error envelope.
  kapError: null as string | null,
  // h11-finance-3: the head:true / count:'exact' read of kap_disclosures (the
  // 30-day total behind the "son 60 bildirim (30 günde N)" label). `kapCount`
  // is its `count`; `kapCountError` makes it fail; `lastKapCountState` and
  // `kapStates` record the builder state of the count read / of every read.
  kapCount: null as number | null,
  kapCountError: null as string | null,
  lastKapCountState: null as unknown,
  kapStates: [] as Array<import("../../../tests/_helpers/supabase-fake").BuilderState>,
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
  // Builder state of every article_tickers read (paging assertions).
  articleTickerStates: [] as Array<import("../../../tests/_helpers/supabase-fake").BuilderState>,
  // disclosure_coverage rows for fetchTickerPage / fetchLagHistogram, the
  // builder state of EVERY read (one per page), and an error switch.
  coverageRows: [] as Array<{ ticker: string; disclosure_index: number; lag_minutes: number; article_id: string }>,
  coverageStates: [] as Array<import("../../../tests/_helpers/supabase-fake").BuilderState>,
  coverageError: null as string | null,
  jevRows: [] as Array<{ subject_id: string; jev_prob: number; created_at: string }>,
  bistCompanies: [] as Array<{ tickers: string[]; title: string; shares_traded?: boolean }>,
  // Builder state of every bist_companies read, and an error switch for it.
  companyStates: [] as Array<import("../../../tests/_helpers/supabase-fake").BuilderState>,
  companyError: null as string | null,
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
        const s = state as import("../../../tests/_helpers/supabase-fake").BuilderState;
        fixture.kapStates.push(s);
        const selectOpts = s.selectArgs[1] as { head?: boolean } | undefined;
        if (selectOpts?.head === true) {
          // The count read: no rows, just `count`.
          fixture.lastKapCountState = s;
          if (fixture.kapCountError) return { data: null, error: { message: fixture.kapCountError } };
          return { data: null, error: null, count: fixture.kapCount };
        }
        fixture.lastKapState = s;
        if (fixture.kapError) return { data: null, error: { message: fixture.kapError } };
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
        fixture.articleTickerStates.push(s);
        const ticker = s.eq.find((e) => e.col === "ticker")?.val as string | undefined;
        const since = s.gte.find((g) => g.col === "published_at")?.val as string | undefined;
        const rows = fixture.articleTickers
          .filter((r) => (!ticker || r.ticker === ticker) && (!since || r.published_at >= since))
          .sort(
            (a, b) =>
              a.published_at.localeCompare(b.published_at) ||
              a.article_id.localeCompare(b.article_id) ||
              a.ticker.localeCompare(b.ticker),
          );
        // Like PostgREST: a response never exceeds max_rows (1,000), whatever limit/range asks.
        const from = s.range ? s.range.from : 0;
        const asked = s.range ? s.range.to - s.range.from + 1 : (s.limit ?? rows.length);
        return { data: rows.slice(from, from + Math.min(asked, 1000)), error: null };
      },
      disclosure_coverage: (state: unknown) => {
        const s = state as import("../../../tests/_helpers/supabase-fake").BuilderState;
        fixture.coverageStates.push(s);
        if (fixture.coverageError) return { data: null, error: { message: fixture.coverageError } };
        const ticker = s.eq.find((e) => e.col === "ticker")?.val as string | undefined;
        const indexes = s.in.find((e) => e.col === "disclosure_index")?.vals;
        const rows = fixture.coverageRows
          .filter((r) => !ticker || r.ticker === ticker)
          .filter((r) => !indexes || indexes.includes(r.disclosure_index))
          .sort(
            (a, b) =>
              a.disclosure_index - b.disclosure_index ||
              a.lag_minutes - b.lag_minutes ||
              a.article_id.localeCompare(b.article_id),
          );
        // Like PostgREST: a response never exceeds max_rows (1,000), whatever limit/range asks.
        const from = s.range ? s.range.from : 0;
        const asked = s.range ? s.range.to - s.range.from + 1 : (s.limit ?? rows.length);
        return { data: rows.slice(from, from + Math.min(asked, 1000)), error: null };
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
      bist_companies: (state: unknown) => {
        fixture.companyStates.push(state as import("../../../tests/_helpers/supabase-fake").BuilderState);
        if (fixture.companyError) return { data: null, error: { message: fixture.companyError } };
        return { data: fixture.bistCompanies, error: null };
      },
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
  haltNoticeToShow,
  latestTradingHalt,
  rankAttention,
  toFeedItem,
  type Disclosure,
} from "./queries";
import { tickerDisclosureOr } from "./disclosure-filter";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.kapDisclosures = [];
  fixture.kapError = null;
  fixture.kapCount = null;
  fixture.kapCountError = null;
  fixture.lastKapCountState = null;
  fixture.kapStates = [];
  fixture.bars5m = [];
  fixture.econFeedRows = [];
  fixture.lastKapState = null;
  fixture.kapFetchStateRow = undefined;
  fixture.articleTickers = [];
  fixture.articleTickerStates = [];
  fixture.coverageRows = [];
  fixture.coverageStates = [];
  fixture.coverageError = null;
  fixture.jevRows = [];
  fixture.bistCompanies = [];
  fixture.companyStates = [];
  fixture.companyError = null;
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
        { ticker: "THYAO", day: "2026-09-06", articles: 1, sources: 1, sourceIds: ["s1"] },
        { ticker: "THYAO", day: "2026-09-09", articles: 2, sources: 1, sourceIds: ["s1"] },
        { ticker: "THYAO", day: "2026-09-12", articles: 2, sources: 2, sourceIds: ["s1", "s2"] },
        { ticker: "THYAO", day: "2026-09-13", articles: 5, sources: 4, sourceIds: ["s1", "s2", "s3", "s4"] },
        { ticker: "VESTL", day: "2026-09-13", articles: 6, sources: 1, sourceIds: ["s1"] },
        { ticker: "OLD", day: "2026-09-08", articles: 9, sources: 3, sourceIds: ["s1", "s2", "s3"] },
      ],
      new Map([["THYAO", "TÜRK HAVA YOLLARI A.O."]]),
      10,
      "2026-09-12",
      2,
      6,
      new Set(["THYAO", "VESTL", "OLD"]),
    );
    expect(ranked.map((r) => r.ticker)).toEqual(["THYAO", "VESTL"]);
    // 7 articles over 2 days vs 3 over the 6 baseline days: 3.5 / 0.5 = 7x
    expect(ranked[0]).toMatchObject({ articles: 7, sources: 4, title: "TÜRK HAVA YOLLARI A.O.", ratio: 7 });
    expect(ranked[1]).toMatchObject({ title: null, ratio: null });
  });

  describe("rankAttention: sources are distinct across the recent window", () => {
    const rank = (rows: Array<{ day: string; articles: number; sources: number; sourceIds: string[] }>) =>
      rankAttention(
        rows.map((r) => ({ ticker: "AAA", ...r })),
        new Map(),
        10,
        "2026-09-12",
        2,
        6,
        new Set(["AAA"]),
      );

    it("two recent days with different sources add up to 2, not max(1, 1)", () => {
      const [aaa] = rank([
        { day: "2026-09-12", articles: 1, sources: 1, sourceIds: ["a"] },
        { day: "2026-09-13", articles: 1, sources: 1, sourceIds: ["b"] },
      ]);
      expect(aaa).toMatchObject({ articles: 2, sources: 2 });
    });

    it("two recent days with the same source count it once", () => {
      const [aaa] = rank([
        { day: "2026-09-12", articles: 1, sources: 1, sourceIds: ["a"] },
        { day: "2026-09-13", articles: 1, sources: 1, sourceIds: ["a"] },
      ]);
      expect(aaa).toMatchObject({ articles: 2, sources: 1 });
    });

    it("baseline-day sources never leak into the recent count", () => {
      const [aaa] = rank([
        { day: "2026-09-08", articles: 3, sources: 3, sourceIds: ["x", "y", "z"] },
        { day: "2026-09-13", articles: 1, sources: 1, sourceIds: ["a"] },
      ]);
      expect(aaa).toMatchObject({ articles: 1, sources: 1 });
    });
  });

  describe("rankAttention: only traded tickers, and a ratio only with enough articles (h11-finance-4)", () => {
    const rows = [
      { ticker: "BOYNR", day: "2026-09-13", articles: 2, sources: 2, sourceIds: ["a", "b"] },
      { ticker: "BOYNR", day: "2026-09-08", articles: 1, sources: 1, sourceIds: ["a"] },
      { ticker: "KILER", day: "2026-09-13", articles: 1, sources: 1, sourceIds: ["a"] },
      { ticker: "THYAO", day: "2026-09-13", articles: 4, sources: 3, sourceIds: ["a", "b", "c"] },
      { ticker: "THYAO", day: "2026-09-08", articles: 3, sources: 2, sourceIds: ["a", "b"] },
    ];
    const rank = (traded: ReadonlySet<string>) => rankAttention(rows, new Map(), 10, "2026-09-12", 2, 6, traded);

    it("drops tickers that are not in the traded set (passive or delisted companies)", () => {
      expect(rank(new Set(["THYAO"])).map((r) => r.ticker)).toEqual(["THYAO"]);
      expect(rank(new Set(["THYAO", "BOYNR"])).map((r) => r.ticker)).toEqual(["THYAO", "BOYNR"]);
    });

    it("an empty traded set ranks nothing", () => {
      expect(rank(new Set())).toEqual([]);
    });

    it("the limit applies after the traded filter, so non-traded rows do not eat the slots", () => {
      const out = rankAttention(rows, new Map(), 1, "2026-09-12", 2, 6, new Set(["THYAO"]));
      expect(out.map((r) => r.ticker)).toEqual(["THYAO"]);
    });

    it("a ratio needs >= 3 recent AND >= 3 baseline articles; below that it is null", () => {
      const out = Object.fromEntries(rank(new Set(["THYAO", "BOYNR"])).map((r) => [r.ticker, r.ratio]));
      // BOYNR: 2 recent, 1 baseline -> the "ilgi 6,0x" spike of two articles is not a signal.
      expect(out.BOYNR).toBeNull();
      // THYAO: 4 recent over 2 days vs 3 baseline over 6 days = 2 / 0.5 = 4x.
      expect(out.THYAO).toBe(4);
    });

    it("pins each side of the floor", () => {
      const one = (recent: number, baseline: number) =>
        rankAttention(
          [
            { ticker: "AAA", day: "2026-09-13", articles: recent, sources: 1, sourceIds: ["s"] },
            { ticker: "AAA", day: "2026-09-08", articles: baseline, sources: 1, sourceIds: ["s"] },
          ],
          new Map(),
          5,
          "2026-09-12",
          2,
          6,
          new Set(["AAA"]),
        )[0]!.ratio;
      expect(one(2, 9)).toBeNull(); // recent just under
      expect(one(9, 2)).toBeNull(); // baseline just under
      expect(one(3, 3)).not.toBeNull(); // both at the floor
      expect(one(3, 3)).toBe(3);
    });
  });

  describe("coverageStats: events, not disclosures (h11-finance-3)", () => {
    const T0 = Date.parse("2026-09-10T08:00:00Z");
    const HOUR = 3_600_000;
    const disc = (disclosureIndex: number, hoursAfterT0: number) => ({
      disclosureIndex,
      publishedAt: new Date(T0 + hoursAfterT0 * HOUR).toISOString(),
    });
    const row = (disclosure_index: number, lag_minutes: number, article_id: string) => ({
      disclosure_index,
      lag_minutes,
      article_id,
    });

    /** Five same-morning filings (a warrant, a market-maker notice, ...) at +0..+4 h. */
    const fiveSameDay = [disc(1, 0), disc(2, 1), disc(3, 2), disc(4, 3), disc(5, 4)];

    it("5 same-day disclosures that share 2 pre-filing articles are ONE event with ONE ön ilgi, not 5", () => {
      // The two articles came out 300 and 200 minutes before the first filing; each later filing sees
      // them at a longer lag, exactly as the disclosure_coverage view reports them.
      const rows = fiveSameDay.flatMap((d, k) => [row(d.disclosureIndex, -300 - 60 * k, "p1"), row(d.disclosureIndex, -200 - 60 * k, "p2")]);
      expect(coverageStats(rows, fiveSameDay, 0.2)).toEqual({
        disclosures: 5,
        events: 1,
        covered: 0,
        medianLagMinutes: null,
        pressAhead: 1,
      });
    });

    it("5 same-day disclosures that share 1 later article are 1 covered event with that article's lag", () => {
      // One article 90 minutes after the first filing: lag 90, 30, -30, -90, -150 from the five filings.
      const rows = fiveSameDay.map((d, k) => row(d.disclosureIndex, 90 - 60 * k, "post"));
      expect(coverageStats(rows, fiveSameDay, 0.2)).toEqual({
        disclosures: 5,
        events: 1,
        covered: 1,
        medianLagMinutes: 90,
        pressAhead: 0,
      });
    });

    it("measures the lag from the first filing of the event, not from the filing the view joined it to", () => {
      // 30 minutes after the 2nd filing = 90 minutes after the 1st.
      const out = coverageStats([row(2, 30, "x")], [disc(1, 0), disc(2, 1)], 0.2);
      expect(out.medianLagMinutes).toBe(90);
    });

    it("two disclosures three days apart are two events", () => {
      const out = coverageStats(
        [row(1, 20, "a"), row(2, 40, "b")],
        [disc(1, 0), disc(2, 72)],
        0.2,
      );
      expect(out).toEqual({ disclosures: 2, events: 2, covered: 2, medianLagMinutes: 30, pressAhead: 0 });
    });

    it("a filing exactly 24 h after the event's start joins it; one minute later starts a new event", () => {
      expect(coverageStats([], [disc(1, 0), disc(2, 24)], 0.2).events).toBe(1);
      const late = { disclosureIndex: 2, publishedAt: new Date(T0 + 24 * HOUR + 60_000).toISOString() };
      expect(coverageStats([], [disc(1, 0), late], 0.2).events).toBe(2);
    });

    it("an event is anchored at its FIRST filing: a chain of filings 20 h apart does not stay one event forever", () => {
      // +0, +20 (same event), +40 is 40 h after the start -> new event.
      expect(coverageStats([], [disc(1, 0), disc(2, 20), disc(3, 40)], 0.2).events).toBe(2);
    });

    it("sorts the filings itself: the page lists them newest first", () => {
      const rows = [row(1, 30, "a")];
      const asc = coverageStats(rows, [disc(1, 0), disc(2, 1)], 0.2);
      const desc = coverageStats(rows, [disc(2, 1), disc(1, 0)], 0.2);
      expect(desc).toEqual(asc);
      expect(asc.events).toBe(1);
    });

    it("an article that sits in the view under several filings counts once for ön ilgi", () => {
      // ONE distinct pre-filing article seen by five filings is 1 article, below the floor of 2.
      const rows = fiveSameDay.map((d, k) => row(d.disclosureIndex, -300 - 60 * k, "only"));
      expect(coverageStats(rows, fiveSameDay, 0.2).pressAhead).toBe(0);
    });

    it("pre-filing means [-24 h, 0) from the event start: -1440 counts, -1441 and 0 do not", () => {
      const at = (lags: number[]) => coverageStats(lags.map((l, i) => row(1, l, `a${i}`)), [disc(1, 0)], 0.2);
      expect(at([-1440, -1440]).pressAhead).toBe(1);
      expect(at([-1441, -1441]).pressAhead).toBe(0);
      expect(at([0, 0])).toMatchObject({ pressAhead: 0, covered: 1 });
    });

    it("a busy ticker (3 articles a day) does not read 4 pre-filing articles as abnormal", () => {
      const rows = [-300, -200, -100, -20].map((l, i) => row(1, l, `a${i}`));
      expect(coverageStats(rows, [disc(1, 0)], 0.2).pressAhead).toBe(1);
      expect(coverageStats(rows, [disc(1, 0)], 3).pressAhead).toBe(0);
    });

    it("the median is over covered events only", () => {
      const out = coverageStats(
        [row(1, 30, "a"), row(2, 90, "b"), row(3, -5000, "c")],
        [disc(1, 0), disc(2, 72), disc(3, 144)],
        0.2,
      );
      expect(out).toMatchObject({ events: 3, covered: 2, medianLagMinutes: 60 });
    });

    it("rows of a disclosure that is not listed (a circuit breaker, a stranger) are ignored", () => {
      const rows = [
        row(1, 30, "a"),
        // 9 is not a listed disclosure: covered AND abnormal pre-filing attention if it were counted.
        row(9, -300, "s1"),
        row(9, -200, "s2"),
        row(9, 5, "s3"),
      ];
      expect(coverageStats(rows, [disc(1, 0)], 0.2)).toEqual({
        disclosures: 1,
        events: 1,
        covered: 1,
        medianLagMinutes: 30,
        pressAhead: 0,
      });
    });

    it("no disclosures -> all zeros and a null median", () => {
      expect(coverageStats([row(1, 10, "a")], [], 0.2)).toEqual({
        disclosures: 0,
        events: 0,
        covered: 0,
        medianLagMinutes: null,
        pressAhead: 0,
      });
    });

    it("a disclosure with an unreadable date is counted but cannot anchor an event", () => {
      const out = coverageStats([row(1, 10, "a")], [{ disclosureIndex: 1, publishedAt: "not a date" }, disc(2, 0)], 0.2);
      expect(out.disclosures).toBe(2);
      expect(out.events).toBe(1);
      expect(out.covered).toBe(0);
    });

    it("covered <= events <= disclosures for any mix of filings and coverage rows", () => {
      let seed = 12345;
      const rnd = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      for (let run = 0; run < 300; run++) {
        const n = 1 + Math.floor(rnd() * 12);
        const ds = Array.from({ length: n }, (_, i) => disc(i + 1, Math.floor(rnd() * 24 * 6)));
        const rows = Array.from({ length: Math.floor(rnd() * 40) }, (_, i) =>
          row(1 + Math.floor(rnd() * (n + 2)), Math.floor(rnd() * 6000) - 3000, `a${i % 9}`),
        );
        const out = coverageStats(rows, ds, rnd() * 3);
        expect(out.covered).toBeLessThanOrEqual(out.events);
        expect(out.events).toBeLessThanOrEqual(out.disclosures);
        expect(out.pressAhead).toBeLessThanOrEqual(out.events);
      }
    });
  });

  describe("latestTradingHalt (h11-finance-1)", () => {
    const notice = (index: number, publishedAt: string, summary: string | null, subject: string | null = "Pay İşlem Sırası Kapatma / Açma"): Disclosure => ({
      disclosureIndex: index,
      publishedAt,
      kapTitle: "BORSA İSTANBUL A.Ş.",
      stockCodes: ["TRHOL"],
      subject,
      summary,
      disclosureClass: null,
    });
    const closing = notice(1688666, "2026-10-28T06:38:59Z", "Pay Sırasının İşleme Kapatılması");
    const reopening = notice(1688700, "2026-10-28T13:00:00Z", "Pay Sırasının İşleme Açılması");
    const other = notice(1, "2026-10-29T08:00:00Z", "Genel Kurul", "Özel Durum Açıklaması (Genel)");

    it("returns a closing notice that is newer than the reopening one", () => {
      const olderReopening = notice(1688000, "2026-10-20T06:00:00Z", "Pay Sırasının İşleme Açılması");
      expect(latestTradingHalt([closing, olderReopening])?.disclosureIndex).toBe(1688666);
    });

    it("returns null when the newest halt notice is the reopening", () => {
      expect(latestTradingHalt([reopening, closing])).toBeNull();
      expect(latestTradingHalt([closing, reopening])).toBeNull();
    });

    it("returns null when there is no halt notice at all", () => {
      expect(latestTradingHalt([])).toBeNull();
      expect(latestTradingHalt([other])).toBeNull();
    });

    it("ignores other disclosures, even newer ones", () => {
      expect(latestTradingHalt([other, closing])?.disclosureIndex).toBe(1688666);
    });

    it("does not rely on the list order: it takes the newest by publishedAt", () => {
      expect(latestTradingHalt([reopening, closing, other])).toBeNull();
      expect(latestTradingHalt([closing, other, reopening])).toBeNull();
    });

    it("matches the subject in Turkish lower case (İŞLEM SIRASI, İşlem Sırası, işlem sırası)", () => {
      expect(latestTradingHalt([notice(2, "2026-10-28T06:00:00Z", "Pay Sırasının İşleme Kapatılması", "PAY İŞLEM SIRASI KAPATMA / AÇMA")])?.disclosureIndex).toBe(2);
      expect(latestTradingHalt([notice(3, "2026-10-28T06:00:00Z", "pay sırasının işleme kapatılması", "pay işlem sırası kapatma / açma")])?.disclosureIndex).toBe(3);
    });

    it("recognises the plural and 'geçici olarak' wordings of a closing", () => {
      expect(latestTradingHalt([notice(4, "2026-03-12T06:20:22Z", "Pay Sıralarının İşleme Kapatılması")])?.disclosureIndex).toBe(4);
      expect(latestTradingHalt([notice(5, "2025-08-14T16:11:21Z", "Pay Sırasının Geçici Olarak İşleme Kapatılması")])?.disclosureIndex).toBe(5);
    });

    it("a notice that both closes and reopens the share in one filing is not a halt", () => {
      expect(latestTradingHalt([notice(6, "2024-12-26T06:55:45Z", "Pay Sırasının İşleme Kapatılması ve Açılması")])).toBeNull();
    });

    it("a halt subject with no summary cannot be told from a reopening, so it is not shown", () => {
      expect(latestTradingHalt([notice(7, "2026-10-28T06:00:00Z", null)])).toBeNull();
    });

    it("tolerates a disclosure with a null subject", () => {
      expect(latestTradingHalt([notice(8, "2026-10-28T06:00:00Z", "x", null), closing])?.disclosureIndex).toBe(1688666);
    });
  });

  describe("haltNoticeToShow: the halt is shown only while it explains the price", () => {
    const halt: Disclosure = {
      disclosureIndex: 1688666,
      publishedAt: "2026-10-28T06:38:59Z",
      kapTitle: "BORSA İSTANBUL A.Ş.",
      stockCodes: ["TRHOL"],
      subject: "Pay İşlem Sırası Kapatma / Açma",
      summary: "Pay Sırasının İşleme Kapatılması",
      disclosureClass: null,
    };

    it("is shown when the last trade is older than the notice (TRHOL: last trade 27.10, halt 28.10)", () => {
      expect(haltNoticeToShow(halt, "2026-10-27T15:00:00.000Z")).toBe(halt);
    });

    it("is shown when there is no quote at all", () => {
      expect(haltNoticeToShow(halt, null)).toBe(halt);
      expect(haltNoticeToShow(halt, undefined)).toBe(halt);
    });

    it("is hidden when the stock traded after the notice (the halt is over or was a partial one)", () => {
      expect(haltNoticeToShow(halt, "2026-10-29T15:00:00.000Z")).toBeNull();
      expect(haltNoticeToShow(halt, "2026-10-28T06:38:59Z")).toBeNull();
    });

    it("an unreadable quote date cannot prove a later trade, so the notice stays", () => {
      expect(haltNoticeToShow(halt, "not a date")).toBe(halt);
    });

    it("is null without a halt", () => {
      expect(haltNoticeToShow(null, "2026-10-27T15:00:00.000Z")).toBeNull();
      expect(haltNoticeToShow(null, null)).toBeNull();
    });
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

    fixture.bistCompanies = [{ tickers: ["AAA"], title: "AAA A.Ş.", shares_traded: true }];

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

  // h11-finance-4: the tape only ranks traded companies, so GARAN needs a traded row.
  beforeEach(() => {
    fixture.bistCompanies = [{ tickers: ["GARAN"], title: "TÜRKİYE GARANTİ BANKASI A.Ş.", shares_traded: true }];
  });

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
// ekonomi-coverage: /ekonomi/[ticker] "KAP ile basın arası" is computed over
// ALL disclosure_coverage rows (PostgREST clamps one response at 1,000 rows, so
// the old `.limit(2000)` silently dropped the later disclosures), and over the
// same disclosures the page lists -- circuit-breaker notices excluded, exactly
// like "Medyada yankı" and /ekonomi.
// ---------------------------------------------------------------------------

describe("ekonomi-coverage: fetchTickerPage reads every coverage row and skips circuit breakers", () => {
  const NOW = "2026-09-13T12:00:00Z";
  const NO_BREAKER_FILTER = "subject.is.null,subject.not.ilike.*Devre Kesici*";

  // h11-finance-3: coverage is counted per EVENT (filings within 24 h of the event's first one are
  // one event). The fixtures below are spaced 25 h apart so every listed disclosure is its own event
  // and `covered` still reads as "disclosures with coverage"; the same-day dedupe has its own tests.
  const EVENT_GAP_MS = 25 * 3_600_000;
  function disclosureRow(index: number, subject: string | null = "Özel Durum Açıklaması (Genel)") {
    return {
      disclosure_index: index,
      published_at: new Date(Date.parse("2026-08-01T08:00:00Z") + (index % 24) * EVENT_GAP_MS).toISOString(),
      kap_title: "TÜRKİYE SİGORTA A.Ş.",
      stock_codes: ["TURSG"],
      related_stocks: [] as string[],
      subject,
      summary: null,
      disclosure_class: "ODA",
    };
  }

  /** `perDisclosure` rows for each index: one pre-filing mention, then coverage from 10 + k minutes. */
  function coverageFor(index: number, k: number, perDisclosure: number, ticker = "TURSG") {
    return Array.from({ length: perDisclosure }, (_, j) => ({
      ticker,
      disclosure_index: index,
      lag_minutes: j === 0 ? -30 - k : (j + 9) * 1 + k,
      article_id: `a-${index}-${String(j).padStart(3, "0")}`,
    }));
  }

  function freeze() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  }

  it("reaches disclosures beyond the first 1,000 coverage rows: 18 of 18 covered, median over all 18", async () => {
    freeze();
    const indexes = Array.from({ length: 18 }, (_, k) => 1001 + k);
    fixture.kapDisclosures = indexes.map((i) => disclosureRow(i));
    fixture.coverageRows = [
      // 18 x 100 = 1,800 rows of the page's own disclosures ...
      ...indexes.flatMap((i, k) => coverageFor(i, k, 100)),
      // ... plus 45 rows of a circuit-breaker notice that sorts FIRST (index 999).
      ...coverageFor(999, 0, 45),
    ];
    expect(fixture.coverageRows).toHaveLength(1845);

    const page = await fetchTickerPage("TURSG");

    expect(page.coverage.disclosures).toBe(18);
    expect(page.coverage.events).toBe(18);
    expect(page.coverage.covered).toBe(18);
    // First lag >= 0 per disclosure is 10 + k (k = 0..17): median of 10..27 = 18.5.
    expect(page.coverage.medianLagMinutes).toBe(18.5);
    expect(page.coverage.pressAhead).toBe(0);
  });

  it("pages disclosure_coverage with .range(), in a deterministic order, for the right ticker and window", async () => {
    freeze();
    const indexes = Array.from({ length: 18 }, (_, k) => 1001 + k);
    fixture.kapDisclosures = indexes.map((i) => disclosureRow(i));
    fixture.coverageRows = [...indexes.flatMap((i, k) => coverageFor(i, k, 100)), ...coverageFor(999, 0, 45)];

    await fetchTickerPage("TURSG");

    expect(fixture.coverageStates.map((s) => s.range)).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
    ]);
    for (const s of fixture.coverageStates) {
      expect(s.table).toBe("disclosure_coverage");
      expect(s.order.map((o) => o.col)).toEqual(["disclosure_index", "lag_minutes", "article_id"]);
      expect(s.eq).toEqual([{ col: "ticker", val: "TURSG" }]);
      expect(s.in).toEqual([{ col: "disclosure_index", vals: expect.arrayContaining(indexes) }]);
      expect(s.in[0]?.vals).toHaveLength(indexes.length);
      expect(s.gte).toEqual([{ col: "disclosed_at", val: new Date(Date.parse(NOW) - 30 * 86400_000).toISOString() }]);
      // A bare .limit() is what PostgREST clamps at 1,000 -- never again.
      expect(s.limit).toBeNull();
    }
  });

  it("a single short page makes a single coverage request", async () => {
    freeze();
    fixture.kapDisclosures = [disclosureRow(1)];
    fixture.coverageRows = coverageFor(1, 0, 40);

    const page = await fetchTickerPage("TURSG");

    expect(fixture.coverageStates).toHaveLength(1);
    expect(page.coverage).toMatchObject({ disclosures: 1, events: 1, covered: 1 });
  });

  it("restricts the coverage read to the listed disclosures in the database (.in on disclosure_index), so breaker notices never transfer", async () => {
    freeze();
    fixture.kapDisclosures = [disclosureRow(5), disclosureRow(6), disclosureRow(7)];
    // 1,200 rows of a circuit-breaker notice (index 999) and strangers must stay in the table.
    fixture.coverageRows = [
      ...coverageFor(5, 0, 3),
      ...coverageFor(6, 1, 3),
      ...coverageFor(7, 2, 3),
      ...coverageFor(999, 0, 1200),
    ];

    const page = await fetchTickerPage("TURSG");

    // One request: the 9 allowed rows fit a single page (without the filter it would be 2 pages).
    expect(fixture.coverageStates).toHaveLength(1);
    const inFilters = fixture.coverageStates[0]!.in;
    expect(inFilters).toHaveLength(1);
    expect(inFilters[0]?.col).toBe("disclosure_index");
    expect([...(inFilters[0]?.vals as number[])].sort((a, b) => a - b)).toEqual([5, 6, 7]);
    expect(page.coverage).toMatchObject({ disclosures: 3, events: 3, covered: 3 });
  });

  it("makes no coverage request at all when the ticker has no disclosure in the window", async () => {
    freeze();
    fixture.kapDisclosures = [];
    fixture.coverageRows = coverageFor(1, 0, 5);

    const page = await fetchTickerPage("TURSG");

    expect(fixture.coverageStates).toHaveLength(0);
    expect(page.coverage).toEqual({ disclosures: 0, events: 0, covered: 0, medianLagMinutes: null, pressAhead: 0 });
  });

  it("lists related_stocks-only notices but leaves them out of the coverage read and the coverage numbers", async () => {
    freeze();
    // 1: the issuer's own filing. 2: a halt that names TURSG only in related_stocks. 3: a filing by ASELS
    // that names TURSG in related_stocks. The disclosure_coverage view joins on stock_codes alone, so it
    // can never credit an article to 2 or 3; counting them would show an uncovered event for a halt that
    // has press (h11-finance-1 follow-up).
    fixture.kapDisclosures = [
      disclosureRow(1),
      { ...disclosureRow(2), stock_codes: [] as string[], related_stocks: ["TURSG"], subject: "Pay İşlem Sırası Kapatma / Açma" },
      { ...disclosureRow(3), stock_codes: ["ASELS"], related_stocks: ["TURSG"] },
    ];
    fixture.coverageRows = [
      ...coverageFor(1, 0, 2),
      // Rows the real view would never return for 2 and 3; the fake returns them if asked for them.
      ...coverageFor(2, 1, 2),
      ...coverageFor(3, 2, 2),
    ];

    const page = await fetchTickerPage("TURSG");

    expect(page.disclosures.map((d) => d.disclosureIndex).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(fixture.coverageStates).toHaveLength(1);
    expect(fixture.coverageStates[0]!.in).toEqual([{ col: "disclosure_index", vals: [1] }]);
    expect(page.coverage).toMatchObject({ disclosures: 1, events: 1, covered: 1 });
  });

  it("makes no coverage request when every listed disclosure is a related_stocks-only notice", async () => {
    freeze();
    fixture.kapDisclosures = [
      { ...disclosureRow(1), stock_codes: [] as string[], related_stocks: ["TURSG"], subject: "Pay İşlem Sırası Kapatma / Açma" },
      { ...disclosureRow(2), stock_codes: null as unknown as string[], related_stocks: ["TURSG"] },
    ];
    fixture.coverageRows = [...coverageFor(1, 0, 3), ...coverageFor(2, 1, 3)];

    const page = await fetchTickerPage("TURSG");

    expect(page.disclosures).toHaveLength(2);
    expect(fixture.coverageStates).toHaveLength(0);
    expect(page.coverage).toEqual({ disclosures: 0, events: 0, covered: 0, medianLagMinutes: null, pressAhead: 0 });
  });

  it("a failing disclosure read throws on its own error and never issues the coverage request", async () => {
    freeze();
    fixture.kapDisclosures = [disclosureRow(1)];
    fixture.kapError = "kap boom";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(fetchTickerPage("TURSG")).rejects.toThrow(/fetchTickerPage disclosures: kap boom/);
    } finally {
      errorSpy.mockRestore();
    }
    expect(fixture.coverageStates).toHaveLength(0);
  });

  it("reads the disclosure list with ONE or() that matches stock_codes OR related_stocks and skips breakers, and keeps its 60-row limit", async () => {
    freeze();
    fixture.kapDisclosures = [disclosureRow(1)];

    await fetchTickerPage("TURSG");

    const state = fixture.lastKapState as BuilderState;
    expect(state.or).toEqual([tickerDisclosureOr("TURSG")]);
    expect(state.or).toEqual([
      "and(or(stock_codes.cs.{TURSG},related_stocks.cs.{TURSG}),or(subject.is.null,subject.not.ilike.*Devre Kesici*))",
    ]);
    // The old `.contains("stock_codes", [T])` never saw related_stocks-only notices.
    expect(state.contains).toEqual([]);
    expect(state.limit).toBe(60);
    expect(state.selectArgs[0]).toContain("related_stocks");
    expect(state.gte).toEqual([{ col: "published_at", val: new Date(Date.parse(NOW) - 30 * 86400_000).toISOString() }]);
  });

  it("fetchRecentDisclosures without a ticker keeps the plain breaker or() (one definition for the feed)", async () => {
    await fetchRecentDisclosures(10);
    const state = fixture.lastKapState as BuilderState;
    expect(state.or).toEqual([NO_BREAKER_FILTER]);
    expect(state.contains).toEqual([]);
  });

  it("fetchRecentDisclosures(40, ticker) sends the combined or() once and no contains filter", async () => {
    await fetchRecentDisclosures(40, "TRHOL");
    const state = fixture.lastKapState as BuilderState;
    expect(state.or).toEqual([tickerDisclosureOr("TRHOL")]);
    expect(state.contains).toEqual([]);
    expect(state.limit).toBe(40);
    expect(state.selectArgs[0]).toContain("related_stocks");
  });

  it("fetchRecentDisclosures rejects a ticker that could inject filter clauses, without querying", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(fetchRecentDisclosures(10, "A},subject.is.null,x.cs.{B")).rejects.toThrow(/invalid ticker/);
    } finally {
      errorSpy.mockRestore();
    }
    expect(fixture.kapStates).toHaveLength(0);
  });

  it("a notice tagged only in related_stocks is listed, with its chip taken from related_stocks", async () => {
    fixture.kapDisclosures = [
      {
        disclosure_index: 1688666,
        published_at: "2026-10-28T06:38:59Z",
        kap_title: "BORSA İSTANBUL A.Ş.",
        stock_codes: [],
        related_stocks: ["TRHOL"],
        subject: "Pay İşlem Sırası Kapatma / Açma",
        summary: "Pay Sırasının İşleme Kapatılması",
        disclosure_class: null,
      },
    ];
    const [d] = await fetchRecentDisclosures(10, "TRHOL");
    expect(d?.stockCodes).toEqual(["TRHOL"]);
    expect(d?.disclosureIndex).toBe(1688666);
  });

  it("stock_codes still wins for the chips when it is set", async () => {
    fixture.kapDisclosures = [
      { ...disclosureRow(1), stock_codes: ["TURSG"], related_stocks: ["ASELS"] },
      { ...disclosureRow(2), stock_codes: ["TURSG", "ASELS"], related_stocks: [] },
      { ...disclosureRow(3), stock_codes: [], related_stocks: [] },
      { ...disclosureRow(4), stock_codes: null, related_stocks: null },
    ];
    const rows = await fetchRecentDisclosures(10);
    expect(rows.map((r) => r.stockCodes)).toEqual([["TURSG"], ["TURSG", "ASELS"], [], []]);
  });

  it("DISCLOSURE_SELECT carries related_stocks on the circuit-breaker strip's read too", async () => {
    await fetchCircuitBreakers(5);
    expect((fixture.lastKapState as BuilderState).selectArgs[0]).toContain("related_stocks");
  });

  it("ignores coverage rows whose disclosure is not in the returned list (a circuit breaker)", async () => {
    freeze();
    fixture.kapDisclosures = [disclosureRow(1)];
    fixture.coverageRows = [
      { ticker: "TURSG", disclosure_index: 1, lag_minutes: 30, article_id: "a1" },
      // Index 999 is a breaker notice (filtered out of the list): quick coverage, must not count.
      { ticker: "TURSG", disclosure_index: 999, lag_minutes: 5, article_id: "a2" },
      { ticker: "TURSG", disclosure_index: 998, lag_minutes: 6, article_id: "a3" },
    ];

    const page = await fetchTickerPage("TURSG");

    expect(page.coverage).toEqual({ disclosures: 1, events: 1, covered: 1, medianLagMinutes: 30, pressAhead: 0 });
  });

  it("covered can never exceed disclosures, whatever else the table holds for the ticker", async () => {
    freeze();
    fixture.kapDisclosures = [disclosureRow(1), disclosureRow(2)];
    fixture.coverageRows = Array.from({ length: 7 }, (_, i) => ({
      ticker: "TURSG",
      disclosure_index: 100 + i,
      lag_minutes: 10,
      article_id: `x${i}`,
    }));

    const page = await fetchTickerPage("TURSG");

    expect(page.coverage.disclosures).toBe(2);
    expect(page.coverage.covered).toBe(0);
    expect(page.coverage.medianLagMinutes).toBeNull();
  });

  it("other tickers' coverage rows never leak in", async () => {
    freeze();
    fixture.kapDisclosures = [disclosureRow(1)];
    fixture.coverageRows = [
      { ticker: "OTHER", disclosure_index: 1, lag_minutes: 1, article_id: "o1" },
      { ticker: "TURSG", disclosure_index: 1, lag_minutes: 44, article_id: "t1" },
    ];

    const page = await fetchTickerPage("TURSG");

    expect(page.coverage.medianLagMinutes).toBe(44);
  });

  it("a failing coverage page throws (not a silent empty section), naming the ticker", async () => {
    freeze();
    fixture.kapDisclosures = [disclosureRow(1)];
    fixture.coverageError = "canceling statement due to statement timeout";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(fetchTickerPage("TURSG")).rejects.toThrow(/fetchTickerPage coverage TURSG: canceling statement/);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("pages the attention read past 1,000 rows, ordered, and keeps sourceIds out of the cached page", async () => {
    freeze();
    fixture.articleTickers = Array.from({ length: 1200 }, (_, i) => ({
      ticker: "CCC",
      article_id: `a${String(i).padStart(4, "0")}`,
      published_at: new Date(Date.parse("2026-09-13T06:00:00Z") + i * 1000).toISOString(),
      source_id: `s${i % 3}`,
    }));

    const page = await fetchTickerPage("CCC");

    expect(page.attention).toEqual([{ day: "2026-09-13", articles: 1200, sources: 3 }]);
    const reads = fixture.articleTickerStates.filter((s) => s.eq.some((e) => e.col === "ticker" && e.val === "CCC"));
    expect(reads.map((s) => s.range)).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
    ]);
    for (const s of reads) expect(s.order.map((o) => o.col)).toEqual(["published_at", "article_id"]);
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

describe("h11-finance-4: the tape ranks traded tickers only", () => {
  const NOW = "2026-09-13T12:00:00Z";
  const at = (ticker: string, id: string, hour: number, day = "2026-09-13") => ({
    ticker,
    article_id: id,
    published_at: `${day}T${String(hour).padStart(2, "0")}:00:00Z`,
    source_id: "s1",
  });

  function seed() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    fixture.articleTickers = [
      // BOYNR and KILER are passive (kap_state P, shares_traded false); DNZ has no company row at all.
      at("BOYNR", "b1", 8),
      at("BOYNR", "b2", 9),
      at("KILER", "k1", 8),
      at("DNZ", "d1", 8),
      at("THYAO", "t1", 8),
      at("THYAO", "t2", 9),
      at("THYAO", "t3", 10),
    ];
    fixture.bistCompanies = [
      { tickers: ["BOYNR"], title: "BOYNER BÜYÜK MAĞAZACILIK A.Ş.", shares_traded: false },
      { tickers: ["KILER"], title: "KİLER ALIŞVERİŞ A.Ş.", shares_traded: false },
      { tickers: ["THYAO"], title: "TÜRK HAVA YOLLARI A.O.", shares_traded: true },
    ];
  }

  it("excludes a ticker whose company is shares_traded = false and one with no company row", async () => {
    seed();
    const out = await fetchTopTickers(2, 10);
    expect(out.map((r) => r.ticker)).toEqual(["THYAO"]);
    expect(out[0]?.title).toBe("TÜRK HAVA YOLLARI A.O.");
  });

  it("keeps every share-class ticker of a traded company", async () => {
    seed();
    fixture.articleTickers.push(at("GARAN", "g1", 8), at("TGB", "g2", 9));
    fixture.bistCompanies.push({ tickers: ["GARAN", "TGB"], title: "TÜRKİYE GARANTİ BANKASI A.Ş.", shares_traded: true });
    const out = await fetchTopTickers(2, 10);
    expect(out.map((r) => r.ticker).sort()).toEqual(["GARAN", "TGB", "THYAO"]);
  });

  it("asks bist_companies for shares_traded alongside tickers and title", async () => {
    seed();
    await fetchTopTickers(2, 10);
    expect(fixture.companyStates.at(-1)?.selectArgs[0]).toBe("tickers,title,shares_traded");
  });

  it("a ticker on a traded and a non-traded company row is traded", async () => {
    seed();
    fixture.bistCompanies.push({ tickers: ["BOYNR"], title: "BOYNER (yeniden listeli)", shares_traded: true });
    const out = await fetchTopTickers(2, 10);
    expect(out.map((r) => r.ticker)).toContain("BOYNR");
  });

  it("a company read error still throws (page content, not a fail-open lookup)", async () => {
    seed();
    fixture.companyError = "companies boom";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(fetchTopTickers(2, 10)).rejects.toThrow(/fetchTopTickers companies: companies boom/);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("h11-finance-3: fetchTickerPage reports honest windows", () => {
  const NOW = "2026-09-13T12:00:00Z";
  const freeze = () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  };
  const disclosure = (index: number) => ({
    disclosure_index: index,
    published_at: new Date(Date.parse("2026-09-12T08:00:00Z") - index * 25 * 3_600_000).toISOString(),
    kap_title: "İŞ YATIRIM MENKUL DEĞERLER A.Ş.",
    stock_codes: ["ISMEN"],
    related_stocks: [] as string[],
    subject: "Özel Durum Açıklaması (Genel)",
    summary: null,
    disclosure_class: "ODA",
  });
  const articleRow = (i: number) => ({
    id: `art-${i}`,
    title: `ISMEN haberi ${i}`,
    url: `https://x/${i}`,
    published_at: `2026-09-12T${String(i % 24).padStart(2, "0")}:00:00Z`,
    category: "ekonomi",
    source_name: "Dünya",
    source_slug: "dunya",
    matched_on: "alias",
  });

  it("totalDisclosures30d comes from a head:true count read with the same or() and the same 30-day cut", async () => {
    freeze();
    fixture.kapDisclosures = Array.from({ length: 60 }, (_, i) => disclosure(i + 1));
    fixture.kapCount = 102;

    const page = await fetchTickerPage("ISMEN");

    expect(page.totalDisclosures30d).toBe(102);
    const count = fixture.lastKapCountState as BuilderState;
    expect(count.selectArgs).toEqual(["disclosure_index", { count: "exact", head: true }]);
    expect(count.or).toEqual([tickerDisclosureOr("ISMEN")]);
    expect(count.contains).toEqual([]);
    expect(count.gte).toEqual([{ col: "published_at", val: new Date(Date.parse(NOW) - 30 * 86400_000).toISOString() }]);
    // The count is not the list: no row limit, no ordering.
    expect(count.limit).toBeNull();
    // Both reads were made (list + count) and nothing else touched the table.
    expect(fixture.kapStates).toHaveLength(2);
  });

  it("totalDisclosures30d is null (with a warning) when the count read fails; the page still renders", async () => {
    freeze();
    fixture.kapDisclosures = [disclosure(1)];
    fixture.kapCountError = "canceling statement due to statement timeout";
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const page = await fetchTickerPage("ISMEN");
      expect(page.totalDisclosures30d).toBeNull();
      expect(page.disclosures).toHaveLength(1);
      expect(spy.mock.calls.some((c) => String(c[0]).includes("fetchTickerPage disclosure count ISMEN"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("totalDisclosures30d is null when the count comes back without a number", async () => {
    freeze();
    fixture.kapDisclosures = [disclosure(1)];
    fixture.kapCount = null;
    const page = await fetchTickerPage("ISMEN");
    expect(page.totalDisclosures30d).toBeNull();
  });

  it("a failing LIST read still throws even when the count would have worked", async () => {
    freeze();
    fixture.kapError = "kap boom";
    fixture.kapCount = 5;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(fetchTickerPage("ISMEN")).rejects.toThrow(/fetchTickerPage disclosures: kap boom/);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("articlesTruncated is true exactly when ticker_articles returned its full 60 rows", async () => {
    freeze();
    fixture.tickerArticlesRows = Array.from({ length: 60 }, (_, i) => articleRow(i));
    expect((await fetchTickerPage("ISMEN")).articlesTruncated).toBe(true);
    fixture.tickerArticlesRows = Array.from({ length: 59 }, (_, i) => articleRow(i));
    expect((await fetchTickerPage("ISMEN")).articlesTruncated).toBe(false);
    fixture.tickerArticlesRows = [];
    expect((await fetchTickerPage("ISMEN")).articlesTruncated).toBe(false);
  });

  it("asks ticker_articles for exactly 60 rows", async () => {
    freeze();
    await fetchTickerPage("ISMEN");
    const call = supabaseFake.calls.rpc.find((c) => c.name === "ticker_articles");
    expect(call?.args).toEqual({ p_ticker: "ISMEN", p_limit: 60 });
  });

  it("the coverage read selects article_id, so the same article is counted once per event", async () => {
    freeze();
    fixture.kapDisclosures = [disclosure(1)];
    fixture.coverageRows = [{ ticker: "ISMEN", disclosure_index: 1, lag_minutes: 30, article_id: "a1" }];
    await fetchTickerPage("ISMEN");
    expect(fixture.coverageStates[0]?.selectArgs[0]).toBe("disclosure_index,lag_minutes,article_id");
  });

  it("five same-morning filings with shared coverage are one event with one ön ilgi (the ISMEN warrant case)", async () => {
    freeze();
    const base = Date.parse("2026-09-10T08:00:00Z");
    fixture.kapDisclosures = [1, 2, 3, 4, 5].map((i) => ({
      ...disclosure(i),
      published_at: new Date(base + (i - 1) * 3_600_000).toISOString(),
    }));
    // Two press articles 300 and 200 minutes before the first filing, seen by all five.
    fixture.coverageRows = [1, 2, 3, 4, 5].flatMap((i) => [
      { ticker: "ISMEN", disclosure_index: i, lag_minutes: -300 - 60 * (i - 1), article_id: "pre-1" },
      { ticker: "ISMEN", disclosure_index: i, lag_minutes: -200 - 60 * (i - 1), article_id: "pre-2" },
    ]);

    const page = await fetchTickerPage("ISMEN");

    expect(page.coverage).toEqual({ disclosures: 5, events: 1, covered: 0, medianLagMinutes: null, pressAhead: 1 });
  });

  it("a related_stocks-only halt notice reaches the page and latestTradingHalt finds it", async () => {
    freeze();
    fixture.kapDisclosures = [
      {
        disclosure_index: 1688666,
        published_at: "2026-09-12T06:38:59Z",
        kap_title: "BORSA İSTANBUL A.Ş.",
        stock_codes: [],
        related_stocks: ["TRHOL"],
        subject: "Pay İşlem Sırası Kapatma / Açma",
        summary: "Pay Sırasının İşleme Kapatılması",
        disclosure_class: null,
      },
    ];
    const page = await fetchTickerPage("TRHOL");
    expect(page.disclosures.map((d) => d.disclosureIndex)).toEqual([1688666]);
    expect(latestTradingHalt(page.disclosures)?.disclosureIndex).toBe(1688666);
  });
});

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
