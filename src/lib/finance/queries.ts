import { cacheLife, cacheTag } from "next/cache";

import { createFinanceServerClient } from "@/lib/supabase/server";

// Read side of the finance substrate (migrations 049-051) for the
// /ekonomi pages and /admin/ekonomi. Every fetcher throws on a Supabase
// error so the route's error.tsx renders instead of a cached empty page
// (same rule as trends-query).

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
  disclosures: number;
  covered: number;
  medianLagMinutes: number | null;
  pressAhead: number;
}

export interface TickerPage {
  company: Company | null;
  attention: AttentionDay[];
  articles: FeedItem[];
  disclosures: Disclosure[];
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
export async function fetchEconFeed(limit = 80): Promise<FeedItem[]> {
  "use cache";
  cacheLife(FEED_CACHE);
  cacheTag("finance-feed");
  const supabase = await createFinanceServerClient();
  const { data, error } = await supabase.rpc("econ_feed", { p_limit: limit });
  if (error) throw new Error(`[finance] fetchEconFeed: ${error.message}`);
  return ((data ?? []) as EconFeedRow[]).map((r) => ({
    id: r.id,
    title: r.title,
    url: r.url,
    publishedAt: r.published_at,
    category: r.category,
    source: r.source_slug ? { name: r.source_name ?? r.source_slug, slug: r.source_slug } : null,
    tickers: [...new Set(r.tickers ?? [])].sort(),
  }));
}

function istDate(offsetDays = 0): string {
  return new Date(Date.now() + (3 * 3600 + offsetDays * 86400) * 1000).toISOString().slice(0, 10);
}

interface AttentionRow {
  ticker: string;
  day: string;
  articles: number;
  sources: number;
}

/**
 * Rank tickers by mentions on/after `splitDay`; the days before it form
 * the baseline for `ratio` (recent daily rate / baseline daily rate).
 */
export function rankAttention(
  rows: AttentionRow[],
  titles: Map<string, string>,
  limit: number,
  splitDay: string,
  recentDays: number,
  baselineDays: number,
): TickerAttention[] {
  const acc = new Map<string, TickerAttention & { baseline: number }>();
  for (const r of rows) {
    const cur = acc.get(r.ticker) ?? { ticker: r.ticker, title: titles.get(r.ticker) ?? null, articles: 0, sources: 0, ratio: null, baseline: 0 };
    if (r.day >= splitDay) {
      cur.articles += Number(r.articles);
      cur.sources = Math.max(cur.sources, Number(r.sources));
    } else {
      cur.baseline += Number(r.articles);
    }
    acc.set(r.ticker, cur);
  }
  return [...acc.values()]
    .filter((t) => t.articles > 0)
    .map(({ baseline, ...t }) => ({
      ...t,
      ratio: baseline > 0 ? (t.articles / recentDays) / (baseline / baselineDays) : null,
    }))
    .sort((a, b) => b.articles - a.articles || a.ticker.localeCompare(b.ticker))
    .slice(0, limit);
}

const BASELINE_DAYS = 6;

/** Most-mentioned tickers over the last `days` Istanbul days, with a ratio to the prior 6 days. */
export async function fetchTopTickers(days = 2, limit = 24): Promise<TickerAttention[]> {
  "use cache";
  cacheLife(FEED_CACHE);
  cacheTag("finance-feed");
  const supabase = await createFinanceServerClient();
  const splitDay = istDate(-(days - 1));
  const { data, error } = await supabase
    .from("ticker_attention_daily")
    .select("ticker,day,articles,sources")
    .gte("day", istDate(-(days - 1 + BASELINE_DAYS)));
  if (error) throw new Error(`[finance] fetchTopTickers: ${error.message}`);
  const rows = (data ?? []) as AttentionRow[];
  const tickers = [...new Set(rows.map((r) => r.ticker))];
  const titles = new Map<string, string>();
  if (tickers.length > 0) {
    const { data: comps, error: cErr } = await supabase
      .from("bist_companies")
      .select("tickers,title")
      .overlaps("tickers", tickers);
    if (cErr) throw new Error(`[finance] fetchTopTickers companies: ${cErr.message}`);
    for (const c of (comps ?? []) as Array<{ tickers: string[]; title: string }>) {
      for (const t of c.tickers) titles.set(t, c.title);
    }
  }
  return rankAttention(rows, titles, limit, splitDay, days, BASELINE_DAYS);
}

interface DisclosureRow {
  disclosure_index: number;
  published_at: string;
  kap_title: string | null;
  stock_codes: string[];
  subject: string | null;
  summary: string | null;
  disclosure_class: string | null;
}

function toDisclosure(r: DisclosureRow): Disclosure {
  return {
    disclosureIndex: r.disclosure_index,
    publishedAt: r.published_at,
    kapTitle: r.kap_title,
    stockCodes: r.stock_codes ?? [],
    subject: r.subject,
    summary: r.summary,
    disclosureClass: r.disclosure_class,
  };
}

const DISCLOSURE_SELECT = "disclosure_index,published_at,kap_title,stock_codes,subject,summary,disclosure_class";
const CIRCUIT_BREAKER = "%Devre Kesici%";

/** Latest disclosures, circuit-breaker notices excluded (they get their own strip). */
export async function fetchRecentDisclosures(limit = 40, ticker?: string): Promise<Disclosure[]> {
  "use cache";
  cacheLife(FEED_CACHE);
  cacheTag("finance-feed");
  const supabase = await createFinanceServerClient();
  // TS-06: `.not('subject','ilike',CIRCUIT_BREAKER)` compiles to
  // `subject NOT ILIKE ...`, which is NULL (not TRUE) for a NULL subject —
  // PostgREST drops those rows even though they plainly aren't circuit
  // breaker notices. subject is nullable; explicitly keep NULLs. Note the
  // `.or()` filter DSL uses `*` for a wildcard, not the `%` the `.ilike()`
  // builder method takes.
  let q = supabase
    .from("kap_disclosures")
    .select(DISCLOSURE_SELECT)
    .or("subject.is.null,subject.not.ilike.*Devre Kesici*")
    .order("published_at", { ascending: false })
    .limit(limit);
  if (ticker) q = q.contains("stock_codes", [ticker]);
  const { data, error } = await q;
  if (error) throw new Error(`[finance] fetchRecentDisclosures: ${error.message}`);
  return ((data ?? []) as DisclosureRow[]).map(toDisclosure);
}

/** Today's circuit-breaker notices (Istanbul day), newest first. */
export async function fetchCircuitBreakers(limit = 60): Promise<Disclosure[]> {
  "use cache";
  cacheLife(FEED_CACHE);
  cacheTag("finance-feed");
  const supabase = await createFinanceServerClient();
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

interface QuoteStatRow {
  ticker: string;
  last_day: string;
  last_close: number;
  prev_close: number | null;
  last_volume: number | null;
  avg_volume_20: number | null;
  rvol: number | null;
}

/** Relative volume and last settled close per ticker, from bist_quote_stats. */
export async function fetchQuoteStats(tickers: readonly string[]): Promise<Record<string, QuoteStat>> {
  "use cache";
  cacheLife(FEED_CACHE);
  cacheTag("finance-bars");
  const unique = [...new Set(tickers)].sort();
  if (unique.length === 0) return {};
  const supabase = await createFinanceServerClient();
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

export const refKey = (articleId: string, ticker: string) => `${articleId}:${ticker}`;

/** Price at each article's publish time, keyed by refKey(articleId, ticker). */
export async function fetchReferencePrices(articleIds: readonly string[]): Promise<Record<string, number>> {
  "use cache";
  cacheLife(FEED_CACHE);
  cacheTag("finance-bars");
  const ids = [...new Set(articleIds)].sort();
  if (ids.length === 0) return {};
  const supabase = await createFinanceServerClient();
  const { data, error } = await supabase.rpc("feed_reference_prices", { p_article_ids: ids });
  if (error) throw new Error(`[finance] fetchReferencePrices: ${error.message}`);
  const out: Record<string, number> = {};
  for (const r of (data ?? []) as Array<{ article_id: string; ticker: string; ref_price: number | null }>) {
    if (r.ref_price != null) out[refKey(r.article_id, r.ticker)] = Number(r.ref_price);
  }
  return out;
}

/** 5-minute bars for the ticker's most recent session that has any. */
export async function fetchIntraday(ticker: string): Promise<{ day: string | null; bars: Bar5m[] }> {
  "use cache";
  cacheLife(FEED_CACHE);
  cacheTag("finance-bars", `finance-ticker:${ticker}`);
  const supabase = await createFinanceServerClient();
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

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function coverageStats(rows: Array<{ disclosure_index: number; lag_minutes: number }>, disclosures: number): CoverageStats {
  const byDisclosure = new Map<number, number[]>();
  for (const r of rows) {
    const arr = byDisclosure.get(r.disclosure_index) ?? [];
    arr.push(Number(r.lag_minutes));
    byDisclosure.set(r.disclosure_index, arr);
  }
  const firstLags = [...byDisclosure.values()].map((lags) => Math.min(...lags));
  return {
    disclosures,
    covered: byDisclosure.size,
    medianLagMinutes: median(firstLags),
    pressAhead: firstLags.filter((l) => l < -60).length,
  };
}

export async function fetchTickerPage(ticker: string): Promise<TickerPage> {
  "use cache";
  cacheLife(FEED_CACHE);
  cacheTag("finance-feed", `finance-ticker:${ticker}`);
  const supabase = await createFinanceServerClient();
  const since30 = new Date(Date.now() - 30 * 86400 * 1000).toISOString();

  const [companyRes, attentionRes, articlesRes, disclosuresRes, coverageRes] = await Promise.all([
    supabase.from("bist_companies").select("kap_member_oid,tickers,title,city,shares_traded").contains("tickers", [ticker]).limit(1),
    supabase.from("ticker_attention_daily").select("day,articles,sources").eq("ticker", ticker).gte("day", istDate(-29)).order("day"),
    // Starts from the indexed article_tickers side (migration 054); the
    // embedded-filter form timed out in production.
    supabase.rpc("ticker_articles", { p_ticker: ticker, p_limit: 60 }),
    supabase.from("kap_disclosures").select(DISCLOSURE_SELECT).contains("stock_codes", [ticker]).gte("published_at", since30).order("published_at", { ascending: false }).limit(60),
    supabase.from("disclosure_coverage").select("disclosure_index,lag_minutes").eq("ticker", ticker).gte("disclosed_at", since30).limit(2000),
  ]);
  for (const [name, res] of [["company", companyRes], ["attention", attentionRes], ["articles", articlesRes], ["disclosures", disclosuresRes], ["coverage", coverageRes]] as const) {
    if (res.error) throw new Error(`[finance] fetchTickerPage ${name}: ${res.error.message}`);
  }

  const c = (companyRes.data ?? [])[0] as { kap_member_oid: string; tickers: string[]; title: string; city: string | null; shares_traded: boolean } | undefined;
  const disclosures = ((disclosuresRes.data ?? []) as DisclosureRow[]).map(toDisclosure);
  return {
    company: c ? { kapMemberOid: c.kap_member_oid, tickers: c.tickers, title: c.title, city: c.city, sharesTraded: c.shares_traded } : null,
    attention: ((attentionRes.data ?? []) as AttentionDay[]).map((d) => ({ day: String(d.day), articles: Number(d.articles), sources: Number(d.sources) })),
    articles: ((articlesRes.data ?? []) as TickerArticleRow[]).map((r) => ({
      id: r.id,
      title: r.title,
      url: r.url,
      publishedAt: r.published_at,
      category: r.category,
      source: r.source_slug ? { name: r.source_name ?? r.source_slug, slug: r.source_slug } : null,
      tickers: [ticker],
    })),
    disclosures,
    coverage: coverageStats((coverageRes.data ?? []) as Array<{ disclosure_index: number; lag_minutes: number }>, disclosures.length),
  };
}

// --- admin ------------------------------------------------------------------

export async function fetchFinanceHealth(): Promise<FinanceHealth> {
  "use cache";
  cacheLife(ADMIN_CACHE);
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

export async function fetchSignals(limit = 120): Promise<Signal[]> {
  "use cache";
  cacheLife(ADMIN_CACHE);
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

export async function fetchLagHistogram(days = 7): Promise<LagBucket[]> {
  "use cache";
  cacheLife(ADMIN_CACHE);
  const supabase = await createFinanceServerClient();
  const { data, error } = await supabase
    .from("disclosure_coverage")
    .select("lag_minutes")
    .gte("disclosed_at", new Date(Date.now() - days * 86400 * 1000).toISOString())
    .limit(5000);
  if (error) throw new Error(`[finance] fetchLagHistogram: ${error.message}`);
  return bucketLags(((data ?? []) as Array<{ lag_minutes: number }>).map((r) => Number(r.lag_minutes)));
}
