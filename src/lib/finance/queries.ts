import { cacheLife, cacheTag } from "next/cache";

import { createServerClient } from "@/lib/supabase/server";

// Read side of the finance substrate (migrations 049 + 050) for the
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

export interface FinanceHealth {
  lastDisclosureAt: string | null;
  disclosures24h: number;
  articleTickers24h: number;
  tickers24h: number;
  lastResolvedAt: string | null;
  companiesTraded: number;
  aliases: number;
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

const FEED_CACHE = { stale: 60, revalidate: 300, expire: 3600 } as const;

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

const ARTICLE_SELECT = "id,title,url,published_at,category,source:sources(name,slug),article_tickers!inner(ticker)";

export async function fetchEconFeed(limit = 80): Promise<FeedItem[]> {
  "use cache";
  cacheLife(FEED_CACHE);
  cacheTag("finance-feed");
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("articles")
    .select(ARTICLE_SELECT)
    .order("published_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`[finance] fetchEconFeed: ${error.message}`);
  return ((data ?? []) as unknown as ArticleRow[]).map(toFeedItem);
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

export function rankAttention(rows: AttentionRow[], titles: Map<string, string>, limit: number): TickerAttention[] {
  const acc = new Map<string, TickerAttention>();
  for (const r of rows) {
    const cur = acc.get(r.ticker) ?? { ticker: r.ticker, title: titles.get(r.ticker) ?? null, articles: 0, sources: 0 };
    cur.articles += Number(r.articles);
    cur.sources = Math.max(cur.sources, Number(r.sources));
    acc.set(r.ticker, cur);
  }
  return [...acc.values()].sort((a, b) => b.articles - a.articles || a.ticker.localeCompare(b.ticker)).slice(0, limit);
}

/** Most-mentioned tickers over the last `days` Istanbul days. */
export async function fetchTopTickers(days = 2, limit = 24): Promise<TickerAttention[]> {
  "use cache";
  cacheLife(FEED_CACHE);
  cacheTag("finance-feed");
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("ticker_attention_daily")
    .select("ticker,day,articles,sources")
    .gte("day", istDate(-(days - 1)));
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
  return rankAttention(rows, titles, limit);
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

export async function fetchRecentDisclosures(limit = 40, ticker?: string): Promise<Disclosure[]> {
  "use cache";
  cacheLife(FEED_CACHE);
  cacheTag("finance-feed");
  const supabase = createServerClient();
  let q = supabase
    .from("kap_disclosures")
    .select(DISCLOSURE_SELECT)
    .order("published_at", { ascending: false })
    .limit(limit);
  if (ticker) q = q.contains("stock_codes", [ticker]);
  const { data, error } = await q;
  if (error) throw new Error(`[finance] fetchRecentDisclosures: ${error.message}`);
  return ((data ?? []) as DisclosureRow[]).map(toDisclosure);
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
  const supabase = createServerClient();
  const since30 = new Date(Date.now() - 30 * 86400 * 1000).toISOString();

  const [companyRes, attentionRes, articlesRes, disclosuresRes, coverageRes] = await Promise.all([
    supabase.from("bist_companies").select("kap_member_oid,tickers,title,city,shares_traded").contains("tickers", [ticker]).limit(1),
    supabase.from("ticker_attention_daily").select("day,articles,sources").eq("ticker", ticker).gte("day", istDate(-29)).order("day"),
    supabase.from("articles").select(ARTICLE_SELECT).eq("article_tickers.ticker", ticker).order("published_at", { ascending: false }).limit(60),
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
    articles: ((articlesRes.data ?? []) as unknown as ArticleRow[]).map(toFeedItem),
    disclosures,
    coverage: coverageStats((coverageRes.data ?? []) as Array<{ disclosure_index: number; lag_minutes: number }>, disclosures.length),
  };
}

// --- admin ------------------------------------------------------------------

export async function fetchFinanceHealth(): Promise<FinanceHealth> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 300 });
  const supabase = createServerClient();
  const { data, error } = await supabase.from("finance_health").select("*").limit(1);
  if (error) throw new Error(`[finance] fetchFinanceHealth: ${error.message}`);
  const r = ((data ?? [])[0] ?? {}) as Record<string, unknown>;
  return {
    lastDisclosureAt: (r.last_disclosure_at as string | null) ?? null,
    disclosures24h: Number(r.disclosures_24h ?? 0),
    articleTickers24h: Number(r.article_tickers_24h ?? 0),
    tickers24h: Number(r.tickers_24h ?? 0),
    lastResolvedAt: (r.last_resolved_at as string | null) ?? null,
    companiesTraded: Number(r.companies_traded ?? 0),
    aliases: Number(r.aliases ?? 0),
  };
}

export async function fetchSignals(limit = 120): Promise<Signal[]> {
  "use cache";
  cacheLife({ stale: 30, revalidate: 60, expire: 300 });
  const supabase = createServerClient();
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
  cacheLife({ stale: 30, revalidate: 60, expire: 300 });
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("disclosure_coverage")
    .select("lag_minutes")
    .gte("disclosed_at", new Date(Date.now() - days * 86400 * 1000).toISOString())
    .limit(5000);
  if (error) throw new Error(`[finance] fetchLagHistogram: ${error.message}`);
  return bucketLags(((data ?? []) as Array<{ lag_minutes: number }>).map((r) => Number(r.lag_minutes)));
}
