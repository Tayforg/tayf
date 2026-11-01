import { cacheLife, cacheTag } from "next/cache";

import { attemptCached, resolveCachedOrThrow } from "@/lib/cache-resilience";
import { READER_TIMEOUT_MS, createFinanceServerClient } from "@/lib/supabase/server";
import {
  aggregateAttention,
  fetchLegalNoticeIdsSince,
  fetchLowRelevanceSince,
  fetchRelevanceScores,
  filterFeedTickers,
  isHiddenMatch,
  isLegalNotice,
  relevanceKey,
  type AttentionRawRow,
  type AttentionRow,
} from "@/lib/finance/ticker-relevance";
import { readAllPages } from "@/lib/finance/paging";
import {
  CIRCUIT_BREAKER_TEXT,
  NOT_CIRCUIT_BREAKER_OR,
  tickerDisclosureOr,
} from "@/lib/finance/disclosure-filter";

// Read side of the finance substrate (migrations 049-051) for the
// /ekonomi pages and /admin/ekonomi. Every fetcher still THROWS on a Supabase
// error so the route's error.tsx renders instead of a cached empty page, but
// the throw now happens OUTSIDE the cache, after one live retry. A throw inside
// a `"use cache"` body fails `next build`'s prerender and fixes the entry's
// lifetime before the outcome is known, so each fetcher is three pieces:
//
//   readX         the raw, uncached read. THROWS on a Supabase error.
//   fetchXCached  the `"use cache"` body: `cacheTag`, then `attemptCached`
//                 around readX (never rejects), THEN one `cacheLife` -- the
//                 success profile (FEED_CACHE / ADMIN_CACHE), or `minutes`
//                 for a failed attempt so a blip cannot park an `{ ok: false }`
//                 sentinel for 5-10 minutes.
//   fetchX        the exported, uncached function: `resolveCachedOrThrow`.
//                 A cache hit returns the data; a failed attempt awaits the
//                 request scope (the retry reads the clock via istDate), runs
//                 readX live once, and lets that error propagate to error.tsx.
//
// tests/guards/cache-life-after-attempt.test.ts pins the order inside the
// cache body; tests/guards/cache-retry-prerender.test.ts pins the call shape.
// Input normalisation and empty-input short-circuits (fetchQuoteStats,
// fetchReferencePrices) live in the exported function, so the cached function
// only ever sees the normalised argument and an empty request makes no cache
// entry at all.
//
// reader-data (§4(b)): the relevance LOOKUPS in this file
// (fetchRelevanceScores / fetchLowRelevanceSince / fetchLegalNoticeIdsSince,
// all in ticker-relevance.ts) are the one deliberate exception to "every
// fetcher throws" — they fail open (warn + return a partial/empty result) so
// a broken Jev shadow table, or a notice table that is missing or too slow
// on a cold database, degrades to "show/count everything" instead of taking
// down /ekonomi. Every other query in this file, including the
// article_tickers reads in fetchTopTickers/fetchTickerPage, still throws on
// error exactly as before.
//
// ticker-legal-notices (migration 107): the attention totals in
// fetchTopTickers / fetchTickerPage are summed in JS over article_tickers
// rows, which carry no title. BİK court / official notices that string-match a
// ticker would inflate them, so both fetchers also read the small id set in
// `legal_notice_articles` for their window (in parallel with the main reads)
// and drop those rows before aggregating. The /ekonomi feed and the
// per-ticker article list keep their `isLegalNotice` title filter as well; the
// per-ticker list additionally drops the id set.
//
// ekonomi-coverage: PostgREST truncates EVERY response at 1,000 rows whatever
// `.limit()` asks for, so any read here that can exceed that pages through
// `readAllPages` (./paging.ts) with a deterministic order -- the per-ticker
// coverage and attention reads do. tests/guards/postgrest-row-cap.test.ts
// fails on a `.limit(N)` above 1,000 in this directory. The coverage section
// is computed over the same disclosures the page lists: circuit-breaker
// notices are excluded here exactly as in `fetchRecentDisclosures`.
//
// h11-finance-1: a per-ticker disclosure read matches `stock_codes` OR
// `related_stocks` through ONE `.or()` string (./disclosure-filter.ts), never
// `.contains("stock_codes", ...)`; 6.9 % of disclosures (trading halts, SPK
// bans, insider trades) are tagged only in related_stocks.
//
// h11-finance-3: the one more deliberate exception to "every fetcher throws" is
// `totalDisclosures30d` in fetchTickerPage -- a head:true count of the ticker's
// 30-day disclosures, behind the "son 60 bildirim (30 günde N)" label. It fails
// open (warn + null): a label that loses its "(30 günde N)" suffix is a far
// smaller problem than a ticker page that errors because a count timed out. The
// disclosure LIST itself still throws.

export interface FeedSource {
  name: string;
  slug: string;
}

export interface FeedItem {
  id: string;
  title: string;
  url: string;
  publishedAt: string;
  category: string;
  source: FeedSource | null;
  tickers: string[];
}

export interface TickerAttention {
  ticker: string;
  title: string | null;
  articles: number;
  sources: number;
  /** Recent daily rate over the prior baseline rate; null without a baseline. */
  ratio: number | null;
}

export interface Disclosure {
  disclosureIndex: number;
  publishedAt: string;
  kapTitle: string | null;
  /** The notice's tickers: `stock_codes`, or `related_stocks` when the notice is tagged only there. */
  stockCodes: string[];
  subject: string | null;
  summary: string | null;
  disclosureClass: string | null;
}

export interface Company {
  kapMemberOid: string;
  tickers: string[];
  title: string;
  city: string | null;
  sharesTraded: boolean;
}

export interface AttentionDay {
  day: string;
  articles: number;
  sources: number;
}

export interface CoverageStats {
  /**
   * The ticker's OWN filings among the listed ones (the 60 newest of the last 30 days):
   * notices that name it only in related_stocks are listed but not counted here.
   */
  disclosures: number;
  /** Events: filings within 24 h of an event's first filing are one event. */
  events: number;
  /** Events with at least one article at or after the event's first filing. */
  covered: number;
  medianLagMinutes: number | null;
  /** Events with abnormal press attention in the 24 h before. */
  pressAhead: number;
}

export interface TickerPage {
  company: Company | null;
  attention: AttentionDay[];
  articles: FeedItem[];
  /** True when ticker_articles returned its full page, so older articles exist. */
  articlesTruncated: boolean;
  disclosures: Disclosure[];
  /** All of the ticker's disclosures in the last 30 days (breakers excluded); null when the count failed. */
  totalDisclosures30d: number | null;
  coverage: CoverageStats;
}

export interface QuoteStat {
  ticker: string;
  lastDay: string;
  lastClose: number;
  prevClose: number | null;
  lastVolume: number | null;
  avgVolume20: number | null;
  rvol: number | null;
}

export interface Bar5m {
  ts: string;
  close: number;
  volume: number | null;
}

export interface FinanceHealth {
  lastDisclosureAt: string | null;
  disclosures24h: number;
  articleTickers24h: number;
  tickers24h: number;
  lastResolvedAt: string | null;
  companiesTraded: number;
  aliases: number;
  dailyBarTickers: number;
  lastDailyBarDay: string | null;
  intradayTickers24h: number;
  last5mBarAt: string | null;
}

export interface Signal {
  kind: "attention_spike" | "silent_disclosure" | "press_ahead" | string;
  ticker: string;
  score: number;
  evidence: Record<string, unknown>;
  observedAt: string;
}

export interface LagBucket {
  label: string;
  count: number;
}

// News and KAP change by the minute; a 60 s window is the freshness the
// tape promises. Quote-derived tables move with the 5-minute bar job.
const FEED_CACHE = { stale: 30, revalidate: 60, expire: 600 } as const;
const ADMIN_CACHE = { stale: 30, revalidate: 60, expire: 300 } as const;

// PostgREST embeds come back as an object for a to-one FK and an array for
// the reverse side; the fake client in tests may hand either. Normalise.
function one<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

interface ArticleRow {
  id: string;
  title: string;
  url: string;
  published_at: string;
  category: string;
  source: FeedSource | FeedSource[] | null;
  article_tickers: Array<{ ticker: string }> | null;
}

export function toFeedItem(row: ArticleRow): FeedItem {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    publishedAt: row.published_at,
    category: row.category,
    source: one(row.source),
    tickers: [...new Set((row.article_tickers ?? []).map((t) => t.ticker))].sort(),
  };
}

interface TickerArticleRow {
  id: string;
  title: string;
  url: string;
  published_at: string;
  category: string;
  source_name: string | null;
  source_slug: string | null;
  matched_on: string;
}

interface EconFeedRow {
  id: string;
  title: string;
  url: string;
  published_at: string;
  category: string;
  source_name: string | null;
  source_slug: string | null;
  tickers: string[] | null;
}

// DB-02: the previous `.from('articles').select(ARTICLE_SELECT)` embed
// drove the query newest-first over `articles` via `article_tickers!inner`
// — "the wrong direction" (see 054's header). `econ_feed` (migration 058)
// starts from the indexed article_tickers side instead, the same fix
// `ticker_articles` (migration 054) applied to the per-ticker page below.
async function readEconFeed(limit: number): Promise<FeedItem[]> {
  const supabase = await createFinanceServerClient({ timeoutMs: READER_TIMEOUT_MS });
  // reader-data (§4b): over-fetch 25% so the ~20% of items a hidden-ticker
  // drop can remove still leave close to `limit` items on screen.
  const { data, error } = await supabase.rpc("econ_feed", { p_limit: Math.ceil(limit * 1.25) });
  if (error) throw new Error(`[finance] fetchEconFeed: ${error.message}`);
  const items = ((data ?? []) as EconFeedRow[]).map((r) => ({
    id: r.id,
    title: r.title,
    url: r.url,
    publishedAt: r.published_at,
    category: r.category,
    source: r.source_slug ? { name: r.source_name ?? r.source_slug, slug: r.source_slug } : null,
    tickers: [...new Set(r.tickers ?? [])].sort(),
  }));
  const keys = items.flatMap((i) => i.tickers.map((t) => relevanceKey(i.id, t)));
  const scores = await fetchRelevanceScores(supabase, keys);
  return filterFeedTickers(items, scores).slice(0, limit);
}

async function fetchEconFeedCached(limit: number) {
  "use cache";
  cacheTag("finance-feed");
  const r = await attemptCached("finance-econ-feed", () => readEconFeed(limit));
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife(FEED_CACHE);
  else cacheLife("minutes");
  return r;
}

export async function fetchEconFeed(limit = 80): Promise<FeedItem[]> {
  return resolveCachedOrThrow(
    "finance-econ-feed",
    () => fetchEconFeedCached(limit),
    () => readEconFeed(limit),
  );
}

function istDate(offsetDays = 0): string {
  return new Date(Date.now() + (3 * 3600 + offsetDays * 86400) * 1000).toISOString().slice(0, 10);
}

/**
 * h11-finance-4: a `ratio` ("ilgi 6,0x") is a rate over a rate. With two
 * recent articles against one old one it is arithmetic noise ("BOYNR 2 haber,
 * ilgi 6,0x"), so it needs a real count on BOTH sides.
 */
export const RATIO_MIN_RECENT_ARTICLES = 3;
export const RATIO_MIN_BASELINE_ARTICLES = 3;

/**
 * Rank tickers by mentions on/after `splitDay`; the days before it form
 * the baseline for `ratio` (recent daily rate / baseline daily rate), which is
 * null unless both sides have at least RATIO_MIN_* articles.
 * `sources` is the number of DISTINCT sources across all of a ticker's recent
 * days (the union of each day's `sourceIds`), not the busiest single day.
 * Only tickers in `traded` (companies with shares_traded = true) are ranked:
 * passive and delisted codes have no price and nothing to trade on the tape.
 */
export function rankAttention(
  rows: readonly AttentionRow[],
  titles: Map<string, string>,
  limit: number,
  splitDay: string,
  recentDays: number,
  baselineDays: number,
  traded: ReadonlySet<string>,
): TickerAttention[] {
  const acc = new Map<string, TickerAttention & { baseline: number }>();
  const recentSources = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!traded.has(r.ticker)) continue;
    const cur = acc.get(r.ticker) ?? { ticker: r.ticker, title: titles.get(r.ticker) ?? null, articles: 0, sources: 0, ratio: null, baseline: 0 };
    if (r.day >= splitDay) {
      cur.articles += Number(r.articles);
      const seen = recentSources.get(r.ticker) ?? new Set<string>();
      for (const id of r.sourceIds) seen.add(id);
      recentSources.set(r.ticker, seen);
      cur.sources = seen.size;
    } else {
      cur.baseline += Number(r.articles);
    }
    acc.set(r.ticker, cur);
  }
  return [...acc.values()]
    .filter((t) => t.articles > 0)
    .map(({ baseline, ...t }) => ({
      ...t,
      ratio:
        t.articles >= RATIO_MIN_RECENT_ARTICLES && baseline >= RATIO_MIN_BASELINE_ARTICLES
          ? (t.articles / recentDays) / (baseline / baselineDays)
          : null,
    }))
    .sort((a, b) => b.articles - a.articles || a.ticker.localeCompare(b.ticker))
    .slice(0, limit);
}

const BASELINE_DAYS = 6;
const ARTICLE_TICKERS_PAGE_SIZE = 1000;
const ARTICLE_TICKERS_MAX_PAGES = 20;

/**
 * Page over `article_tickers` for everything published on/after `sinceIso`,
 * ordered deterministically (published_at, article_id, ticker) so paging
 * with `.range()` never skips or duplicates a row. PostgREST caps a single
 * response at 1,000 rows, so this always pages rather than trusting one
 * `.limit()` call — the same rule `ticker_articles`/`fetchTickerPage`
 * already followed via its RPC. Throws on error (this is page content, not
 * a fail-open relevance lookup).
 */
async function fetchArticleTickersSince(
  supabase: Awaited<ReturnType<typeof createFinanceServerClient>>,
  sinceIso: string,
): Promise<AttentionRawRow[]> {
  const out: AttentionRawRow[] = [];
  for (let page = 0; page < ARTICLE_TICKERS_MAX_PAGES; page++) {
    const from = page * ARTICLE_TICKERS_PAGE_SIZE;
    const to = from + ARTICLE_TICKERS_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from("article_tickers")
      .select("ticker,article_id,published_at,source_id")
      .gte("published_at", sinceIso)
      .order("published_at")
      .order("article_id")
      .order("ticker")
      .range(from, to);
    if (error) throw new Error(`[finance] fetchTopTickers article_tickers: ${error.message}`);
    const rows = (data ?? []) as AttentionRawRow[];
    out.push(...rows);
    if (rows.length < ARTICLE_TICKERS_PAGE_SIZE) break;
  }
  return out;
}

function scoreMapFromLowRows(rows: Array<{ subject_id: string; jev_prob: unknown }>): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) {
    const n = Number(r.jev_prob);
    if (Number.isFinite(n)) map.set(r.subject_id, n);
  }
  return map;
}

/** Most-mentioned tickers over the last `days` Istanbul days, with a ratio to the prior 6 days. */
async function readTopTickers(days: number, limit: number): Promise<TickerAttention[]> {
  const supabase = await createFinanceServerClient({ timeoutMs: READER_TIMEOUT_MS });
  const splitDay = istDate(-(days - 1));
  const sinceIso = `${istDate(-(days - 1 + BASELINE_DAYS))}T00:00:00+03:00`;
  // Notice ids are fetched in parallel with the main read; the lookup is
  // fail-open (empty set), so it can never turn into a thrown error here.
  const [raw, legalIds] = await Promise.all([
    fetchArticleTickersSince(supabase, sinceIso),
    fetchLegalNoticeIdsSince(supabase, sinceIso),
  ]);
  const lowSinceIso = new Date(Date.parse(sinceIso) - 86400_000).toISOString();
  const low = await fetchLowRelevanceSince(supabase, lowSinceIso);
  const scores = scoreMapFromLowRows(low);
  const rows = aggregateAttention(raw, scores, legalIds);
  const tickers = [...new Set(rows.map((r) => r.ticker))];
  const titles = new Map<string, string>();
  // h11-finance-4: the tape ranks companies that trade. A ticker with no company
  // row, or only a shares_traded = false one (kap_state P: BOYNR, KILER, DENIZ ...),
  // is not in this set and rankAttention drops it.
  const traded = new Set<string>();
  if (tickers.length > 0) {
    const { data: comps, error: cErr } = await supabase
      .from("bist_companies")
      .select("tickers,title,shares_traded")
      .overlaps("tickers", tickers);
    if (cErr) throw new Error(`[finance] fetchTopTickers companies: ${cErr.message}`);
    for (const c of (comps ?? []) as Array<{ tickers: string[]; title: string; shares_traded: boolean | null }>) {
      for (const t of c.tickers) {
        titles.set(t, c.title);
        if (c.shares_traded === true) traded.add(t);
      }
    }
  }
  return rankAttention(rows, titles, limit, splitDay, days, BASELINE_DAYS, traded);
}

async function fetchTopTickersCached(days: number, limit: number) {
  "use cache";
  cacheTag("finance-feed");
  const r = await attemptCached("finance-top-tickers", () => readTopTickers(days, limit));
  if (r.ok) cacheLife(FEED_CACHE);
  else cacheLife("minutes");
  return r;
}

export async function fetchTopTickers(days = 2, limit = 24): Promise<TickerAttention[]> {
  return resolveCachedOrThrow(
    "finance-top-tickers",
    () => fetchTopTickersCached(days, limit),
    () => readTopTickers(days, limit),
  );
}

interface DisclosureRow {
  disclosure_index: number;
  published_at: string;
  kap_title: string | null;
  stock_codes: string[] | null;
  /** Tickers a notice names without being filed by them (halts, bans, insider trades). */
  related_stocks?: string[] | null;
  subject: string | null;
  summary: string | null;
  disclosure_class: string | null;
}

function toDisclosure(r: DisclosureRow): Disclosure {
  const codes = r.stock_codes ?? [];
  return {
    disclosureIndex: r.disclosure_index,
    publishedAt: r.published_at,
    kapTitle: r.kap_title,
    // h11-finance-1: a notice tagged only in related_stocks shows those as its chips.
    stockCodes: codes.length > 0 ? codes : (r.related_stocks ?? []),
    subject: r.subject,
    summary: r.summary,
    disclosureClass: r.disclosure_class,
  };
}

/**
 * h11-finance-1: the disclosures whose ISSUER is `ticker` (stock_codes has it).
 * The disclosure_coverage view joins on `d.stock_codes @> array[t.ticker]`, so
 * a notice that names the ticker only in related_stocks (a halt, a ban, an
 * insider trade, or another company's filing) can never get an article row
 * there. Counting such a notice in the coverage section would show an
 * uncovered event even when articles about it exist, so the coverage read and
 * coverageStats take this set and nothing else. The page still LISTS the others.
 */
function issuerDisclosureIndexes(rows: readonly DisclosureRow[], ticker: string): number[] {
  return rows.filter((r) => (r.stock_codes ?? []).includes(ticker)).map((r) => r.disclosure_index);
}

const DISCLOSURE_SELECT = "disclosure_index,published_at,kap_title,stock_codes,related_stocks,subject,summary,disclosure_class";
/** `.ilike()` pattern (the builder method takes `%`). */
const CIRCUIT_BREAKER = `%${CIRCUIT_BREAKER_TEXT}%`;

const lowerTr = (s: string | null | undefined): string => (s ?? "").toLocaleLowerCase("tr-TR");

/**
 * h11-finance-1: the ticker's trading halt, when it is still in force as far as
 * the disclosures say. Borsa Istanbul files the same subject for both ends,
 * "Pay İşlem Sırası Kapatma / Açma"; only the summary tells them apart --
 *   "Pay Sırasının İşleme Kapatılması"                 closing (also the plural
 *   "Pay Sıralarının ..." and "... Geçici Olarak İşleme Kapatılması")
 *   "Pay Sırasının İşleme Açılması"                    reopening
 *   "Pay Sırasının İşleme Kapatılması ve Açılması"     both in one filing: not a halt.
 * Takes the NEWEST notice with that subject (by publishedAt, whatever the
 * list order) and returns it only when it is a closing. The match is on Turkish
 * lower case, so "İŞLEM SIRASI" and "İşlem Sırası" both count.
 */
export function latestTradingHalt(disclosures: readonly Disclosure[]): Disclosure | null {
  let newest: Disclosure | null = null;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const d of disclosures) {
    if (!lowerTr(d.subject).includes("işlem sırası")) continue;
    const ms = Date.parse(d.publishedAt);
    if (!Number.isFinite(ms)) continue;
    if (ms > newestMs) {
      newest = d;
      newestMs = ms;
    }
  }
  if (!newest) return null;
  const summary = lowerTr(newest.summary);
  return summary.includes("kapatılması") && !summary.includes("açılması") ? newest : null;
}

/**
 * The halt notice worth showing beside the price: `halt` only while it is newer
 * than the quote's last trade (or there is no quote), because a trade after the
 * notice means the share is trading again. An unreadable `quoteAsOf` cannot
 * prove a later trade, so it keeps the notice.
 */
export function haltNoticeToShow(halt: Disclosure | null, quoteAsOf: string | null | undefined): Disclosure | null {
  if (!halt) return null;
  if (!quoteAsOf) return halt;
  const tradeMs = Date.parse(quoteAsOf);
  const haltMs = Date.parse(halt.publishedAt);
  return Number.isFinite(tradeMs) && tradeMs >= haltMs ? null : halt;
}

async function readRecentDisclosures(limit: number, ticker: string | undefined): Promise<Disclosure[]> {
  const supabase = await createFinanceServerClient({ timeoutMs: READER_TIMEOUT_MS });
  // TS-06: NULL subjects are kept explicitly -- see NOT_CIRCUIT_BREAKER_OR.
  // h11-finance-1: with a ticker, ONE combined or() (stock_codes OR related_stocks,
  // and not a breaker) replaces `.or(NOT_CIRCUIT_BREAKER_OR)` + `.contains(...)`.
  const { data, error } = await supabase
    .from("kap_disclosures")
    .select(DISCLOSURE_SELECT)
    .or(ticker ? tickerDisclosureOr(ticker) : NOT_CIRCUIT_BREAKER_OR)
    .order("published_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`[finance] fetchRecentDisclosures: ${error.message}`);
  return ((data ?? []) as DisclosureRow[]).map(toDisclosure);
}

async function fetchRecentDisclosuresCached(limit: number, ticker: string | undefined) {
  "use cache";
  cacheTag("finance-feed");
  const r = await attemptCached("finance-recent-disclosures", () => readRecentDisclosures(limit, ticker));
  if (r.ok) cacheLife(FEED_CACHE);
  else cacheLife("minutes");
  return r;
}

/** Latest disclosures, circuit-breaker notices excluded (they get their own strip). */
export async function fetchRecentDisclosures(limit = 40, ticker?: string): Promise<Disclosure[]> {
  return resolveCachedOrThrow(
    "finance-recent-disclosures",
    () => fetchRecentDisclosuresCached(limit, ticker),
    () => readRecentDisclosures(limit, ticker),
  );
}

async function readCircuitBreakers(limit: number): Promise<Disclosure[]> {
  const supabase = await createFinanceServerClient({ timeoutMs: READER_TIMEOUT_MS });
  const { data, error } = await supabase
    .from("kap_disclosures")
    .select(DISCLOSURE_SELECT)
    .ilike("subject", CIRCUIT_BREAKER)
    .gte("published_at", `${istDate()}T00:00:00+03:00`)
    .order("published_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`[finance] fetchCircuitBreakers: ${error.message}`);
  return ((data ?? []) as DisclosureRow[]).map(toDisclosure);
}

async function fetchCircuitBreakersCached(limit: number) {
  "use cache";
  cacheTag("finance-feed");
  const r = await attemptCached("finance-circuit-breakers", () => readCircuitBreakers(limit));
  if (r.ok) cacheLife(FEED_CACHE);
  else cacheLife("minutes");
  return r;
}

/** Today's circuit-breaker notices (Istanbul day), newest first. */
export async function fetchCircuitBreakers(limit = 60): Promise<Disclosure[]> {
  return resolveCachedOrThrow(
    "finance-circuit-breakers",
    () => fetchCircuitBreakersCached(limit),
    () => readCircuitBreakers(limit),
  );
}

interface QuoteStatRow {
  ticker: string;
  last_day: string;
  last_close: number;
  prev_close: number | null;
  last_volume: number | null;
  avg_volume_20: number | null;
  rvol: number | null;
}

async function readQuoteStats(unique: string[]): Promise<Record<string, QuoteStat>> {
  const supabase = await createFinanceServerClient({ timeoutMs: READER_TIMEOUT_MS });
  const { data, error } = await supabase.from("bist_quote_stats").select("*").in("ticker", unique);
  if (error) throw new Error(`[finance] fetchQuoteStats: ${error.message}`);
  const out: Record<string, QuoteStat> = {};
  for (const r of (data ?? []) as QuoteStatRow[]) {
    out[r.ticker] = {
      ticker: r.ticker,
      lastDay: String(r.last_day),
      lastClose: Number(r.last_close),
      prevClose: r.prev_close == null ? null : Number(r.prev_close),
      lastVolume: r.last_volume == null ? null : Number(r.last_volume),
      avgVolume20: r.avg_volume_20 == null ? null : Number(r.avg_volume_20),
      rvol: r.rvol == null ? null : Number(r.rvol),
    };
  }
  return out;
}

async function fetchQuoteStatsCached(unique: string[]) {
  "use cache";
  cacheTag("finance-bars");
  const r = await attemptCached("finance-quote-stats", () => readQuoteStats(unique));
  if (r.ok) cacheLife(FEED_CACHE);
  else cacheLife("minutes");
  return r;
}

/** Relative volume and last settled close per ticker, from bist_quote_stats. */
export async function fetchQuoteStats(tickers: readonly string[]): Promise<Record<string, QuoteStat>> {
  const unique = [...new Set(tickers)].sort();
  if (unique.length === 0) return {};
  return resolveCachedOrThrow(
    "finance-quote-stats",
    () => fetchQuoteStatsCached(unique),
    () => readQuoteStats(unique),
  );
}

export const refKey = (articleId: string, ticker: string) => `${articleId}:${ticker}`;

async function readReferencePrices(ids: string[]): Promise<Record<string, number>> {
  const supabase = await createFinanceServerClient({ timeoutMs: READER_TIMEOUT_MS });
  const { data, error } = await supabase.rpc("feed_reference_prices", { p_article_ids: ids });
  if (error) throw new Error(`[finance] fetchReferencePrices: ${error.message}`);
  const out: Record<string, number> = {};
  for (const r of (data ?? []) as Array<{ article_id: string; ticker: string; ref_price: number | null }>) {
    if (r.ref_price != null) out[refKey(r.article_id, r.ticker)] = Number(r.ref_price);
  }
  return out;
}

async function fetchReferencePricesCached(ids: string[]) {
  "use cache";
  cacheTag("finance-bars");
  const r = await attemptCached("finance-reference-prices", () => readReferencePrices(ids));
  if (r.ok) cacheLife(FEED_CACHE);
  else cacheLife("minutes");
  return r;
}

/** Price at each article's publish time, keyed by refKey(articleId, ticker). */
export async function fetchReferencePrices(articleIds: readonly string[]): Promise<Record<string, number>> {
  const ids = [...new Set(articleIds)].sort();
  if (ids.length === 0) return {};
  return resolveCachedOrThrow(
    "finance-reference-prices",
    () => fetchReferencePricesCached(ids),
    () => readReferencePrices(ids),
  );
}

async function readIntraday(ticker: string): Promise<{ day: string | null; bars: Bar5m[] }> {
  const supabase = await createFinanceServerClient({ timeoutMs: READER_TIMEOUT_MS });
  const { data: last, error: lErr } = await supabase
    .from("bist_bars_5m")
    .select("ts")
    .eq("ticker", ticker)
    .order("ts", { ascending: false })
    .limit(1);
  if (lErr) throw new Error(`[finance] fetchIntraday last: ${lErr.message}`);
  const lastTs = (last ?? [])[0]?.ts as string | undefined;
  if (!lastTs) return { day: null, bars: [] };
  const day = new Date(new Date(lastTs).getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("bist_bars_5m")
    .select("ts,close,volume")
    .eq("ticker", ticker)
    .gte("ts", `${day}T00:00:00+03:00`)
    .order("ts")
    .limit(200);
  if (error) throw new Error(`[finance] fetchIntraday: ${error.message}`);
  return {
    day,
    bars: ((data ?? []) as Array<{ ts: string; close: number; volume: number | null }>).map((b) => ({
      ts: b.ts,
      close: Number(b.close),
      volume: b.volume == null ? null : Number(b.volume),
    })),
  };
}

async function fetchIntradayCached(ticker: string) {
  "use cache";
  cacheTag("finance-bars", `finance-ticker:${ticker}`);
  const r = await attemptCached("finance-intraday", () => readIntraday(ticker));
  if (r.ok) cacheLife(FEED_CACHE);
  else cacheLife("minutes");
  return r;
}

/** 5-minute bars for the ticker's most recent session that has any. */
export async function fetchIntraday(ticker: string): Promise<{ day: string | null; bars: Bar5m[] }> {
  return resolveCachedOrThrow(
    "finance-intraday",
    () => fetchIntradayCached(ticker),
    () => readIntraday(ticker),
  );
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const EVENT_WINDOW_MS = 24 * 3_600_000;

/**
 * Coverage of a ticker's disclosures, counted per EVENT.
 *
 * h11-finance-3: the disclosure_coverage view joins every disclosure to every
 * article within [-2 d, +5 d], so one pair of articles was counted again for
 * each same-day warrant or market-maker filing ("ISMEN: 60 bildirim, 55 basında
 * yer bulan, 14 olağandışı ön ilgi" from 13 articles in a month). Filings of one
 * ticker are therefore grouped into events: sorted oldest first, a filing more
 * than 24 h after the CURRENT event's first filing starts a new event. Each
 * article is measured against the event's first filing,
 *     lag_e = lag_minutes + (publishedAt - eventStart) / 60000
 * (lag_minutes is relative to the filing the view joined it to), and an article
 * seen under several filings of the event is one article.
 *   events           event count (<= disclosures).
 *   covered          events with at least one article at or after the event
 *                    start (lag_e >= 0); so `covered <= events` always.
 *   medianLagMinutes median, over covered events, of the first such article's lag_e.
 *   pressAhead       events with abnormal attention in the 24 h before:
 *                    >= 2 DISTINCT articles with lag_e in [-1440, 0) and >= 3x
 *                    the ticker's usual daily rate (floored at 0.5 a day).
 * A mention before the filing is not leakage by itself; a ticker that is in
 * the news every day always has one.
 *
 * `disclosures` is the list the page shows (fetchTickerPage passes the
 * disclosures it lists, which are already free of circuit-breaker notices, so
 * the section agrees with "Medyada yankı" and /ekonomi). Rows of any other
 * disclosure are skipped: an allowlist, because the coverage table does not
 * know a disclosure's subject. A disclosure whose date cannot be read counts in
 * `disclosures` but cannot anchor or join an event.
 */
export function coverageStats(
  rows: ReadonlyArray<{ disclosure_index: number; lag_minutes: number; article_id: string }>,
  disclosures: ReadonlyArray<{ disclosureIndex: number; publishedAt: string }>,
  baselineDaily: number,
): CoverageStats {
  const dated = disclosures
    .map((d) => ({ index: d.disclosureIndex, ms: Date.parse(d.publishedAt) }))
    .filter((d) => Number.isFinite(d.ms))
    .sort((a, b) => a.ms - b.ms || a.index - b.index);

  const events: Array<{ startMs: number; indexes: Map<number, number> }> = [];
  for (const d of dated) {
    const current = events[events.length - 1];
    if (current && d.ms - current.startMs <= EVENT_WINDOW_MS) {
      current.indexes.set(d.index, d.ms);
    } else {
      events.push({ startMs: d.ms, indexes: new Map([[d.index, d.ms]]) });
    }
  }

  const eventOf = new Map<number, number>();
  events.forEach((e, k) => {
    for (const index of e.indexes.keys()) eventOf.set(index, k);
  });

  // Per event: article id -> its lag from the event's first filing.
  const lagByArticle: Array<Map<string, number>> = events.map(() => new Map());
  for (const r of rows) {
    const k = eventOf.get(r.disclosure_index);
    if (k === undefined) continue;
    const e = events[k]!;
    const lagE = Number(r.lag_minutes) + (e.indexes.get(r.disclosure_index)! - e.startMs) / 60_000;
    if (!Number.isFinite(lagE)) continue;
    lagByArticle[k]!.set(r.article_id, lagE);
  }

  const firstAfter: number[] = [];
  let pressAhead = 0;
  for (const lags of lagByArticle) {
    let first = Number.POSITIVE_INFINITY;
    let pre24 = 0;
    for (const lag of lags.values()) {
      if (lag >= 0) first = Math.min(first, lag);
      else if (lag >= -1440) pre24++;
    }
    if (first !== Number.POSITIVE_INFINITY) firstAfter.push(first);
    if (pre24 >= 2 && pre24 >= 3 * Math.max(baselineDaily, 0.5)) pressAhead++;
  }
  return {
    disclosures: disclosures.length,
    events: events.length,
    covered: firstAfter.length,
    medianLagMinutes: median(firstAfter),
    pressAhead,
  };
}

/** 10 pages x 1,000 rows: far above any real ticker's 30 days, and bounded under the 4 s reader cap. */
const TICKER_PAGE_MAX_PAGES = 10;

/** The coverage read's result when there is nothing to read (no listed disclosure, or the list failed). */
function noCoverage(): { rows: CoverageRow[]; truncated: boolean } {
  return { rows: [], truncated: false };
}

interface CoverageRow {
  disclosure_index: number;
  lag_minutes: number;
  article_id: string;
}

/** ticker_articles' page size; a full page means older articles exist. */
const TICKER_ARTICLES_LIMIT = 60;
/** Display cap of the per-ticker disclosure list (and of the "Medyada yankı" panel). */
const TICKER_DISCLOSURES_LIMIT = 60;

/**
 * The ticker's disclosures in the last 30 days (breakers excluded), counted in
 * the database with the SAME or() and cut-off as the list. Fails OPEN to null
 * (warn): see the header note on totalDisclosures30d. Never rejects.
 */
async function readDisclosureCount(
  supabase: Awaited<ReturnType<typeof createFinanceServerClient>>,
  ticker: string,
  sinceIso: string,
): Promise<number | null> {
  try {
    const { count, error } = await supabase
      .from("kap_disclosures")
      .select("disclosure_index", { count: "exact", head: true })
      .or(tickerDisclosureOr(ticker))
      .gte("published_at", sinceIso);
    if (error) {
      console.warn(`[finance] fetchTickerPage disclosure count ${ticker} unavailable: ${error.message}`);
      return null;
    }
    return typeof count === "number" ? count : null;
  } catch (err) {
    console.warn(
      `[finance] fetchTickerPage disclosure count ${ticker} unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function readTickerPage(ticker: string): Promise<TickerPage> {
  const supabase = await createFinanceServerClient({ timeoutMs: READER_TIMEOUT_MS });
  const since30 = new Date(Date.now() - 30 * 86400 * 1000).toISOString();

  // The attention window is 30 Istanbul days; the notice-id lookup covers the same span.
  const attentionSinceIso = `${istDate(-29)}T00:00:00+03:00`;

  const [companyRes, attentionRes, articlesRes, { disclosuresRes, coverageRes, totalDisclosures30d }, legalIds] = await Promise.all([
    supabase.from("bist_companies").select("kap_member_oid,tickers,title,city,shares_traded").contains("tickers", [ticker]).limit(1),
    // reader-data (§4b): reads article_tickers directly (the
    // ticker_attention_daily materialized view stays unfiltered for its
    // other SQL consumers — see the header note above) so the relevance
    // gate can be applied at query time without a migration.
    // ekonomi-coverage: paged -- a busy ticker has more than the 1,000 rows a
    // single response can hold in 30 days. (article_id, ticker) is unique, so
    // (published_at, article_id) is a total order for one ticker.
    readAllPages<{ article_id: string; published_at: string; source_id: string }>(
      (from, to) =>
        supabase
          .from("article_tickers")
          .select("article_id,published_at,source_id")
          .eq("ticker", ticker)
          .gte("published_at", attentionSinceIso)
          .order("published_at")
          .order("article_id")
          .range(from, to),
      { label: `fetchTickerPage attention ${ticker}`, maxPages: TICKER_PAGE_MAX_PAGES },
    ),
    // Starts from the indexed article_tickers side (migration 054); the
    // embedded-filter form timed out in production.
    supabase.rpc("ticker_articles", { p_ticker: ticker, p_limit: TICKER_ARTICLES_LIMIT }),
    // The disclosure list, then the coverage of exactly those disclosures. The
    // two are chained inside ONE branch so the other reads above still run in
    // parallel with them. The 30-day total (fail-open) runs in parallel with
    // the list.
    (async () => {
      const countPromise = readDisclosureCount(supabase, ticker, since30);
      // h11-finance-1: stock_codes OR related_stocks, breakers excluded, as ONE or().
      const disclosuresRes = await supabase
        .from("kap_disclosures")
        .select(DISCLOSURE_SELECT)
        .or(tickerDisclosureOr(ticker))
        .gte("published_at", since30)
        .order("published_at", { ascending: false })
        .limit(TICKER_DISCLOSURES_LIMIT);
      const totalDisclosures30d = await countPromise;
      // The caller throws on a disclosure error; do not spend the coverage read.
      if (disclosuresRes.error) return { disclosuresRes, coverageRes: noCoverage(), totalDisclosures30d };
      // Only the issuer's own filings: see issuerDisclosureIndexes.
      const indexes = issuerDisclosureIndexes((disclosuresRes.data ?? []) as DisclosureRow[], ticker);
      // ekonomi-coverage: the coverage rows of the LISTED disclosures only, paged.
      // disclosure_coverage is a join view (kap_disclosures x article_tickers x
      // articles): an unrestricted read of a busy ticker pays the whole join and
      // sort once per OFFSET page and sat next to the 4 s reader timeout. The
      // `.in` pushes the allowlist (circuit-breaker notices are not listed) into
      // the database, so the rows that transfer are the rows that count, and
      // it usually fits one page. A single `.limit(2000)` is not an option:
      // PostgREST clamps one response at 1,000 rows. (disclosure_index,
      // lag_minutes, article_id) is a total order for one ticker. article_id is
      // selected too: coverageStats counts one article once per event.
      const coverageRes =
        indexes.length === 0
          ? noCoverage()
          : await readAllPages<CoverageRow>(
              (from, to) =>
                supabase
                  .from("disclosure_coverage")
                  .select("disclosure_index,lag_minutes,article_id")
                  .eq("ticker", ticker)
                  .in("disclosure_index", indexes)
                  .gte("disclosed_at", since30)
                  .order("disclosure_index")
                  .order("lag_minutes")
                  .order("article_id")
                  .range(from, to),
              { label: `fetchTickerPage coverage ${ticker}`, maxPages: TICKER_PAGE_MAX_PAGES },
            );
      return { disclosuresRes, coverageRes, totalDisclosures30d };
    })(),
    // ticker-legal-notices (107): fail-open, so it stays out of the throwing loop below.
    fetchLegalNoticeIdsSince(supabase, attentionSinceIso),
  ]);
  // attention and coverage are paged through readAllPages, which throws by itself.
  for (const [name, res] of [["company", companyRes], ["articles", articlesRes], ["disclosures", disclosuresRes]] as const) {
    if (res.error) throw new Error(`[finance] fetchTickerPage ${name}: ${res.error.message}`);
  }

  const c = (companyRes.data ?? [])[0] as { kap_member_oid: string; tickers: string[]; title: string; city: string | null; shares_traded: boolean } | undefined;
  const disclosureRows = (disclosuresRes.data ?? []) as DisclosureRow[];
  const disclosures = disclosureRows.map(toDisclosure);
  const issuerIndexes = new Set(issuerDisclosureIndexes(disclosureRows, ticker));
  const attentionRaw = attentionRes.rows.map((r) => ({
    ticker,
    article_id: r.article_id,
    published_at: r.published_at,
    source_id: r.source_id,
  }));
  const articleRows = (articlesRes.data ?? []) as TickerArticleRow[];
  const relevanceKeys = [
    ...attentionRaw.map((r) => relevanceKey(r.article_id, ticker)),
    ...articleRows.map((r) => relevanceKey(r.id, ticker)),
  ];
  const scores = await fetchRelevanceScores(supabase, relevanceKeys);
  const attention = aggregateAttention(attentionRaw, scores, legalIds).map((d) => ({ day: d.day, articles: d.articles, sources: d.sources }));
  attention.sort((a, b) => a.day.localeCompare(b.day));
  const baselineDaily = attention.reduce((s, d) => s + d.articles, 0) / 30;
  return {
    company: c ? { kapMemberOid: c.kap_member_oid, tickers: c.tickers, title: c.title, city: c.city, sharesTraded: c.shares_traded } : null,
    attention,
    articles: articleRows
      .filter(
        (r) =>
          !legalIds.has(r.id) &&
          !isLegalNotice(r.title, r.url) &&
          !isHiddenMatch(scores.get(relevanceKey(r.id, ticker))),
      )
      .map((r) => ({
        id: r.id,
        title: r.title,
        url: r.url,
        publishedAt: r.published_at,
        category: r.category,
        source: r.source_slug ? { name: r.source_name ?? r.source_slug, slug: r.source_slug } : null,
        tickers: [ticker],
      })),
    articlesTruncated: articleRows.length >= TICKER_ARTICLES_LIMIT,
    disclosures,
    totalDisclosures30d,
    coverage: coverageStats(
      coverageRes.rows,
      disclosures.filter((d) => issuerIndexes.has(d.disclosureIndex)),
      baselineDaily,
    ),
  };
}

async function fetchTickerPageCached(ticker: string) {
  "use cache";
  cacheTag("finance-feed", `finance-ticker:${ticker}`);
  const r = await attemptCached("finance-ticker-page", () => readTickerPage(ticker));
  if (r.ok) cacheLife(FEED_CACHE);
  else cacheLife("minutes");
  return r;
}

export async function fetchTickerPage(ticker: string): Promise<TickerPage> {
  return resolveCachedOrThrow(
    "finance-ticker-page",
    () => fetchTickerPageCached(ticker),
    () => readTickerPage(ticker),
  );
}

// --- admin ------------------------------------------------------------------

async function readFinanceHealth(): Promise<FinanceHealth> {
  const supabase = await createFinanceServerClient();
  const { data, error } = await supabase.from("finance_health").select("*").limit(1);
  if (error) throw new Error(`[finance] fetchFinanceHealth: ${error.message}`);
  const r = ((data ?? [])[0] ?? {}) as Record<string, unknown>;
  const str = (k: string) => (r[k] == null ? null : String(r[k]));
  return {
    lastDisclosureAt: str("last_disclosure_at"),
    disclosures24h: Number(r.disclosures_24h ?? 0),
    articleTickers24h: Number(r.article_tickers_24h ?? 0),
    tickers24h: Number(r.tickers_24h ?? 0),
    lastResolvedAt: str("last_resolved_at"),
    companiesTraded: Number(r.companies_traded ?? 0),
    aliases: Number(r.aliases ?? 0),
    dailyBarTickers: Number(r.daily_bar_tickers ?? 0),
    lastDailyBarDay: str("last_daily_bar_day"),
    intradayTickers24h: Number(r.intraday_tickers_24h ?? 0),
    last5mBarAt: str("last_5m_bar_at"),
  };
}

async function fetchFinanceHealthCached() {
  "use cache";
  const r = await attemptCached("finance-health", readFinanceHealth);
  if (r.ok) cacheLife(ADMIN_CACHE);
  else cacheLife("minutes");
  return r;
}

export async function fetchFinanceHealth(): Promise<FinanceHealth> {
  return resolveCachedOrThrow("finance-health", fetchFinanceHealthCached, readFinanceHealth);
}

async function readSignals(limit: number): Promise<Signal[]> {
  const supabase = await createFinanceServerClient();
  const { data, error } = await supabase
    .from("finance_signals")
    .select("kind,ticker,score,evidence,observed_at")
    .order("score", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`[finance] fetchSignals: ${error.message}`);
  return ((data ?? []) as Array<{ kind: string; ticker: string; score: number; evidence: Record<string, unknown>; observed_at: string }>).map((s) => ({
    kind: s.kind,
    ticker: s.ticker,
    score: Number(s.score),
    evidence: s.evidence ?? {},
    observedAt: s.observed_at,
  }));
}

async function fetchSignalsCached(limit: number) {
  "use cache";
  const r = await attemptCached("finance-signals", () => readSignals(limit));
  if (r.ok) cacheLife(ADMIN_CACHE);
  else cacheLife("minutes");
  return r;
}

export async function fetchSignals(limit = 120): Promise<Signal[]> {
  return resolveCachedOrThrow(
    "finance-signals",
    () => fetchSignalsCached(limit),
    () => readSignals(limit),
  );
}

export const LAG_BUCKETS: ReadonlyArray<{ label: string; min: number; max: number }> = [
  { label: "> 1 gün önce", min: -Infinity, max: -1440 },
  { label: "1 gün – 1 saat önce", min: -1440, max: -60 },
  { label: "son 1 saat önce", min: -60, max: 0 },
  { label: "ilk 1 saat", min: 0, max: 60 },
  { label: "1–6 saat", min: 60, max: 360 },
  { label: "6–24 saat", min: 360, max: 1440 },
  { label: "> 1 gün sonra", min: 1440, max: Infinity },
];

export function bucketLags(lags: number[]): LagBucket[] {
  return LAG_BUCKETS.map((b) => ({
    label: b.label,
    count: lags.filter((l) => l >= b.min && l < b.max).length,
  }));
}

export interface KapBreakerState {
  blockedUntil: string | null;
  lastStatus: number | null;
  lastError: string | null;
  updatedAt: string;
}

interface KapFetchStateRow {
  blocked_until: string | null;
  last_status: number | null;
  last_error: string | null;
  updated_at: string;
}

/**
 * SEC-07 follow-up: the kap-ingest circuit breaker's single row (migration
 * 059), read for the /admin/ekonomi badge (kap-breaker-badge.tsx).
 *
 * Deliberately NOT "use cache" -- the admin operator wants the live row,
 * not a stale cached one -- and deliberately returns null instead of
 * throwing on any Supabase error or a missing row, unlike every other
 * fetcher in this file (see the header comment): a badge that can't read
 * its own state is a much smaller problem than an admin page that 500s
 * because of it.
 */
export async function fetchKapBreakerState(): Promise<KapBreakerState | null> {
  const supabase = await createFinanceServerClient();
  const { data, error } = await supabase
    .from("kap_fetch_state")
    .select("blocked_until,last_status,last_error,updated_at")
    .eq("id", 1)
    .maybeSingle();
  if (error || !data) return null;
  const r = data as KapFetchStateRow;
  return {
    blockedUntil: r.blocked_until,
    lastStatus: r.last_status,
    lastError: r.last_error,
    updatedAt: r.updated_at,
  };
}

async function readLagHistogram(days: number): Promise<LagBucket[]> {
  const supabase = await createFinanceServerClient();
  const { data, error } = await supabase
    .from("disclosure_coverage")
    .select("lag_minutes")
    .gte("disclosed_at", new Date(Date.now() - days * 86400 * 1000).toISOString())
    // postgrest-cap-ok: admin histogram, clamped to 1,000 rows; follow-up
    .limit(5000);
  if (error) throw new Error(`[finance] fetchLagHistogram: ${error.message}`);
  return bucketLags(((data ?? []) as Array<{ lag_minutes: number }>).map((r) => Number(r.lag_minutes)));
}

async function fetchLagHistogramCached(days: number) {
  "use cache";
  const r = await attemptCached("finance-lag-histogram", () => readLagHistogram(days));
  if (r.ok) cacheLife(ADMIN_CACHE);
  else cacheLife("minutes");
  return r;
}

export async function fetchLagHistogram(days = 7): Promise<LagBucket[]> {
  return resolveCachedOrThrow(
    "finance-lag-histogram",
    () => fetchLagHistogramCached(days),
    () => readLagHistogram(days),
  );
}
