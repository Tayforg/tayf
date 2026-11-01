import { cacheLife } from "next/cache";

import { attemptCached, resolveCachedOrThrow } from "@/lib/cache-resilience";
import { escapeXml } from "@/lib/feeds/rss-builder";
import { createReaderClient } from "@/lib/supabase/server";
import { TOPIC_SLUGS } from "@/lib/clusters/topic-query";

// seo-share — sitemap index + monthly cluster sitemaps + Google News
// sitemap. Replaces the single-file `src/app/sitemap.ts` (CLUSTER_LIMIT =
// 1000, ~5 days of coverage) with a sitemap index fanning out to one
// /sitemaps/clusters-YYYY-MM.xml per calendar month, a /sitemaps/news.xml
// (Google News sitemap: article_count >= 3, published within the last
// 48h), and /sitemaps/sources.xml for the ~118 active /source/<slug>
// pages, none of which were reachable from any sitemap before, and
// /sitemaps/hubs.xml for the indexable entity hubs (built in hub-sitemap.ts,
// which this file deliberately does not import).
//
// Every DB-backed builder below THROWS on a Supabase error instead of
// returning an empty result — an empty-but-cached sitemap would silently
// de-index a whole month or the entire news feed for as long as the cache
// entry lives. The route handler (src/app/sitemaps/[file]/route.ts) turns
// that throw into a 503 + Retry-After instead of a 200 with zero <url>s.
//
// The throw happens OUTSIDE the cache (a throw inside a "use cache" body fails
// `next build`'s prerender, and the lifetime must be chosen after the read's
// outcome is known). Each DB builder is three pieces:
//   readXSitemapXml          the raw read. THROWS on a Supabase error.
//   getXSitemapXmlCached     the "use cache" body: attemptCached around the
//                            read, then ONE cacheLife -- the revalidate window
//                            on success, "minutes" for a failed attempt, so the
//                            failure sentinel lives for minutes, not an hour.
//   getXSitemapXml           exported, uncached: resolveCachedOrThrow. A hit
//                            returns the XML; a failed attempt awaits the
//                            request scope and reads live once more; a
//                            still-failing read rejects (the route sends 503).
// getCurrentSitemapMonth / getSitemapIndexXml / getStaticSitemapXml read
// nothing from the outside world (a clock and a pure render), so they stay
// plain cached bodies, exempt by name in tests/guards/cache-life-after-attempt.

/** First calendar month with any non-archived, article_count >= 2 cluster.
 *  V1 (SBQ, 2026-09-28): min(first_published) among those rows is
 *  2026-04, with 0 nulls — so there is no "unknown month" bucket to fold
 *  into the current month. */
export const SITEMAP_FIRST_MONTH = "2026-04";

export const NEWS_WINDOW_HOURS = 48;
export const NEWS_MIN_ARTICLES = 3;
export const NEWS_LIMIT = 1000;

/** PostgREST's per-request row cap; `.range()` pages in chunks of this size. */
export const PAGE_SIZE = 1000;

/** Sitemap protocol caps a single file at 50,000 <url> entries. */
export const MAX_PAGES = 50;

// Verified at implementation time (2026-09-28) by reading each page's own
// `metadata`/`generateMetadata`: none of these three set `robots: noindex`,
// so all three are eligible for the static sitemap. /oyun and
// /ekonomi/[ticker] are deliberately EXCLUDED regardless of their metadata
// — the ticker page sets `robots: { index: false, follow: false }`, and
// /oyun is a game surface that never belongs in crawl discovery. If any of
// these five pages' robots metadata changes, re-check this list by hand;
// it is intentionally not derived at build/runtime to keep this file
// DB-free and import-side-effect-free (the candidate pages pull in
// finance/game query modules that should not run at sitemap build time).
const STATIC_OPTIONAL_ROUTES: readonly string[] = ["/trends", "/timeline", "/ekonomi"];

// "Today's" static route list, unchanged from the old src/app/sitemap.ts
// (minus the dynamic cluster rows, which now live in the monthly files).
const BASE_STATIC_ROUTES: ReadonlyArray<{
  path: string;
  changefreq: string;
  priority: number;
}> = [
  { path: "/", changefreq: "hourly", priority: 1 },
  { path: "/blindspots", changefreq: "hourly", priority: 0.9 },
  { path: "/sources", changefreq: "daily", priority: 0.7 },
  { path: "/kaynaklar/durum", changefreq: "hourly", priority: 0.6 },
  { path: "/durum", changefreq: "hourly", priority: 0.4 },
  { path: "/metodoloji", changefreq: "monthly", priority: 0.5 },
  { path: "/kalite", changefreq: "daily", priority: 0.5 },
  { path: "/duzeltmeler", changefreq: "daily", priority: 0.4 },
  { path: "/hafta", changefreq: "daily", priority: 0.6 },
  // Pack C ("Konu"): /konu index + the six hub slugs (TOPIC_SLUGS).
  // politika is deliberately absent — it 308s to "/" and is not a hub.
  { path: "/konu", changefreq: "daily", priority: 0.6 },
  // Entity hubs (roadmap G2): the /gundem index only. The indexable
  // /gundem/<key> hubs are listed in /sitemaps/hubs.xml (hub-sitemap.ts), which
  // applies the page's own thin-hub rule so a sitemap never submits a URL the
  // page itself asks crawlers to skip. This file keeps no entity code.
  { path: "/gundem", changefreq: "daily", priority: 0.5 },
];

export type ParsedSitemapFile =
  | "static"
  | "sources"
  | "news"
  | "hubs"
  | { month: string };

export interface SitemapUrlEntry {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
}

export interface NewsUrlEntry {
  loc: string;
  title: string;
  publishedAt: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// One XML escaper for the whole repo: it lives in the RSS builder and strips
// everything XML 1.0 forbids (C0 controls, U+FFFE/U+FFFF, lone surrogates)
// before escaping the five entities. A raw illegal character anywhere in a
// feed-sourced title would otherwise produce a document no XML parser accepts.
// tests/guards/xml-escaper-single-source.test.ts forbids a second definition.
export { escapeXml };

function urlEntryXml(entry: SitemapUrlEntry): string {
  const parts = [`<loc>${escapeXml(entry.loc)}</loc>`];
  if (entry.lastmod) parts.push(`<lastmod>${escapeXml(entry.lastmod)}</lastmod>`);
  if (entry.changefreq) parts.push(`<changefreq>${escapeXml(entry.changefreq)}</changefreq>`);
  if (entry.priority !== undefined) parts.push(`<priority>${entry.priority}</priority>`);
  return `<url>${parts.join("")}</url>`;
}

export function renderUrlset(entries: SitemapUrlEntry[]): string {
  const body = entries.map(urlEntryXml).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`;
}

export function renderNewsUrlset(entries: NewsUrlEntry[]): string {
  const body = entries
    .map((entry) => {
      const news =
        `<news:news>` +
        `<news:publication><news:name>Tayf</news:name><news:language>tr</news:language></news:publication>` +
        `<news:publication_date>${escapeXml(entry.publishedAt)}</news:publication_date>` +
        `<news:title>${escapeXml(entry.title)}</news:title>` +
        `</news:news>`;
      return `<url><loc>${escapeXml(entry.loc)}</loc>${news}</url>`;
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">` +
    `${body}</urlset>`
  );
}

export function renderSitemapIndex(locs: string[]): string {
  const body = locs.map((loc) => `<sitemap><loc>${escapeXml(loc)}</loc></sitemap>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</sitemapindex>`;
}

/** Parses a 'YYYY-MM' string into its numeric parts. Callers own validating
 *  the string shape (this file only ever builds/consumes it internally). */
function parseYearMonth(yearMonth: string): { year: number; month: number } {
  const parts = yearMonth.split("-");
  const year = Number(parts[0] ?? NaN);
  const month = Number(parts[1] ?? NaN);
  return { year, month };
}

/** Inclusive list of 'YYYY-MM' strings from `first` through `last`. */
export function monthsBetween(first: string, last: string): string[] {
  const { year: firstYear, month: firstMonth } = parseYearMonth(first);
  const { year: lastYear, month: lastMonth } = parseYearMonth(last);

  const months: string[] = [];
  let year = firstYear;
  let month = firstMonth;

  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return months;
}

const MONTH_FILE_RE = /^clusters-(\d{4})-(\d{2})\.xml$/;

/** Last calendar year a month file is accepted for. The route handler maps a
 *  parse failure to 404 but a valid month to a DB read, so without a ceiling
 *  /sitemaps/clusters-9999-12.xml is "valid", reads nothing and (when the
 *  read hiccups) answers 503. 2100 stays far beyond any real month while
 *  keeping the parser pure (no clock): 2099-01 and 2100-12 still parse. */
export const SITEMAP_LAST_YEAR = 2100;

/** Parses a `/sitemaps/[file]` path segment. Returns `null` for anything
 *  that is not exactly one of the fixed files or a valid month file — this
 *  is also the path-traversal guard, since the regex is fully anchored and
 *  admits no `/` or `.` beyond the one before `xml`. */
export function parseSitemapFile(file: string): ParsedSitemapFile | null {
  if (file === "static.xml") return "static";
  if (file === "sources.xml") return "sources";
  if (file === "news.xml") return "news";
  if (file === "hubs.xml") return "hubs";

  const match = MONTH_FILE_RE.exec(file);
  if (!match) return null;

  const [, yearStr, monthStr] = match;
  const monthNum = Number(monthStr);
  if (monthNum < 1 || monthNum > 12) return null;
  if (Number(yearStr) > SITEMAP_LAST_YEAR) return null;

  const month = `${yearStr}-${monthStr}`;
  // No clock-based upper bound: a future month up to SITEMAP_LAST_YEAR renders
  // an empty urlset (keeps Date out of this pure, synchronous parser).
  if (month < SITEMAP_FIRST_MONTH) return null;

  return { month };
}

function monthRangeUtc(month: string): { start: string; end: string } {
  const { year, month: monthNum } = parseYearMonth(month);
  const start = new Date(Date.UTC(year, monthNum - 1, 1));
  const nextMonthYear = monthNum === 12 ? year + 1 : year;
  const nextMonthNum = monthNum === 12 ? 1 : monthNum + 1;
  const end = new Date(Date.UTC(nextMonthYear, nextMonthNum - 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

// ---------------------------------------------------------------------------
// Cached builders
// ---------------------------------------------------------------------------

/** The UTC `YYYY-MM` key of an instant. Sitemap months are UTC, matching
 *  `monthRangeUtc` below. */
export function utcMonthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The current UTC month, as the route handler needs it to tell a CLOSED
 *  month (long CDN cache) from the current one. The handler itself must not
 *  read the clock (Next 16 prerender rule), so the read lives in this
 *  `"use cache"` function. The hour of cache lag is harmless and errs on the
 *  safe side: for up to an hour after a month boundary the just-closed
 *  month still looks "current" and keeps the short cache header, never the
 *  other way round. */
export async function getCurrentSitemapMonth(): Promise<string> {
  "use cache";
  cacheLife({ revalidate: 3600 });

  return utcMonthKey(Date.now());
}

/** No DB. Lists the 4 fixed files plus one clusters-YYYY-MM.xml per month
 *  from SITEMAP_FIRST_MONTH through the current UTC month. The index route
 *  awaits `connection()` first, so this runs per request (not frozen at
 *  build) and a new month appears within the hour its cache entry lives. */
export async function getSitemapIndexXml(baseUrl: string): Promise<string> {
  "use cache";
  cacheLife({ revalidate: 3600 });

  const currentMonth = utcMonthKey(Date.now());
  const months = monthsBetween(SITEMAP_FIRST_MONTH, currentMonth);

  const locs = [
    `${baseUrl}/sitemaps/static.xml`,
    `${baseUrl}/sitemaps/sources.xml`,
    `${baseUrl}/sitemaps/hubs.xml`,
    `${baseUrl}/sitemaps/news.xml`,
    ...months.map((month) => `${baseUrl}/sitemaps/clusters-${month}.xml`),
  ];

  return renderSitemapIndex(locs);
}

/** Today's static routes + the six /konu hubs + the eligible optional pages.
 *  No DB access. */
export async function getStaticSitemapXml(baseUrl: string): Promise<string> {
  "use cache";
  cacheLife({ revalidate: 3600 });

  const entries: SitemapUrlEntry[] = [
    ...BASE_STATIC_ROUTES.map((route) => ({
      loc: `${baseUrl}${route.path}`,
      changefreq: route.changefreq,
      priority: route.priority,
    })),
    ...TOPIC_SLUGS.map((slug) => ({
      loc: `${baseUrl}/konu/${slug}`,
      changefreq: "hourly",
      priority: 0.6,
    })),
    ...STATIC_OPTIONAL_ROUTES.map((path) => ({ loc: `${baseUrl}${path}` })),
  ];

  return renderUrlset(entries);
}

interface SourceRow {
  slug: string;
}

async function readSourcesSitemapXml(baseUrl: string): Promise<string> {
  const supabase = createReaderClient();
  const { data, error } = await supabase
    .from("sources")
    .select("slug")
    .eq("active", true)
    .returns<SourceRow[]>();

  if (error) {
    throw new Error(`sources sitemap query failed: ${error.message}`);
  }

  const entries: SitemapUrlEntry[] = (data ?? []).map((row) => ({
    loc: `${baseUrl}/source/${row.slug}`,
  }));

  return renderUrlset(entries);
}

async function getSourcesSitemapXmlCached(baseUrl: string) {
  "use cache";
  const r = await attemptCached("sources-sitemap", () => readSourcesSitemapXml(baseUrl));
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife({ revalidate: 3600 });
  else cacheLife("minutes");
  return r;
}

export async function getSourcesSitemapXml(baseUrl: string): Promise<string> {
  return resolveCachedOrThrow(
    "sources-sitemap",
    () => getSourcesSitemapXmlCached(baseUrl),
    () => readSourcesSitemapXml(baseUrl),
  );
}

interface NewsClusterRow {
  id: string;
  title_tr: string;
  title_tr_neutral: string | null;
  first_published: string;
}

async function readNewsSitemapXml(baseUrl: string): Promise<string> {
  const now = new Date();
  const since = new Date(now.getTime() - NEWS_WINDOW_HOURS * 3600 * 1000);

  const supabase = createReaderClient();
  const { data, error } = await supabase
    .from("clusters")
    .select("id, title_tr, title_tr_neutral, first_published")
    .eq("is_archived", false)
    .gte("article_count", NEWS_MIN_ARTICLES)
    .gte("first_published", since.toISOString())
    .lte("first_published", now.toISOString())
    .order("first_published", { ascending: false })
    .limit(NEWS_LIMIT)
    .returns<NewsClusterRow[]>();

  if (error) {
    throw new Error(`news sitemap query failed: ${error.message}`);
  }

  const entries: NewsUrlEntry[] = (data ?? []).map((row) => {
    const neutral = row.title_tr_neutral?.trim();
    return {
      loc: `${baseUrl}/cluster/${row.id}`,
      title: neutral ? neutral : row.title_tr,
      publishedAt: row.first_published,
    };
  });

  return renderNewsUrlset(entries);
}

async function getNewsSitemapXmlCached(baseUrl: string) {
  "use cache";
  const r = await attemptCached("news-sitemap", () => readNewsSitemapXml(baseUrl));
  if (r.ok) cacheLife({ revalidate: 600 });
  else cacheLife("minutes");
  return r;
}

export async function getNewsSitemapXml(baseUrl: string): Promise<string> {
  return resolveCachedOrThrow(
    "news-sitemap",
    () => getNewsSitemapXmlCached(baseUrl),
    () => readNewsSitemapXml(baseUrl),
  );
}

interface MonthClusterRow {
  id: string;
  updated_at: string;
}

async function readClustersMonthXml(baseUrl: string, month: string): Promise<string> {
  const { start, end } = monthRangeUtc(month);
  const supabase = createReaderClient();

  const entries: SitemapUrlEntry[] = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    const { data, error } = await supabase
      .from("clusters")
      .select("id, updated_at")
      .eq("is_archived", false)
      .gte("article_count", 2)
      .gte("first_published", start)
      .lt("first_published", end)
      .order("first_published", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to)
      .returns<MonthClusterRow[]>();

    if (error) {
      throw new Error(`clusters-${month} sitemap query failed: ${error.message}`);
    }

    const rows = data ?? [];
    for (const row of rows) {
      entries.push({ loc: `${baseUrl}/cluster/${row.id}`, lastmod: row.updated_at });
    }

    if (rows.length < PAGE_SIZE) break;
  }

  return renderUrlset(entries);
}

async function getClustersMonthXmlCached(baseUrl: string, month: string) {
  "use cache";
  const r = await attemptCached("clusters-month-sitemap", () => readClustersMonthXml(baseUrl, month));
  if (r.ok) cacheLife({ revalidate: 3600 });
  else cacheLife("minutes");
  return r;
}

export async function getClustersMonthXml(baseUrl: string, month: string): Promise<string> {
  return resolveCachedOrThrow(
    "clusters-month-sitemap",
    () => getClustersMonthXmlCached(baseUrl, month),
    () => readClustersMonthXml(baseUrl, month),
  );
}
