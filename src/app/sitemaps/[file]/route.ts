import {
  getClustersMonthXml,
  getNewsSitemapXml,
  getSourcesSitemapXml,
  getStaticSitemapXml,
  parseSitemapFile,
} from "@/lib/seo/sitemaps";
import { siteUrl } from "@/lib/site-url";

// /sitemaps/[file] — the leaf sitemaps the /sitemap.xml index points at:
// static.xml, sources.xml, news.xml, and clusters-YYYY-MM.xml. `file` is
// parsed by `parseSitemapFile`, which is also the path-traversal guard
// (fully anchored regex — no `/` or extra `.` survives it).
//
// No `Date.now()`/`new Date()` in this handler body: every date read
// (the current UTC month, the 48h news window, the month's UTC bounds)
// happens inside a `"use cache"` builder in src/lib/seo/sitemaps.ts.

interface RouteContext {
  params: Promise<{ file: string }>;
}

const NOT_FOUND_HEADERS = { "Cache-Control": "public, s-maxage=300" };
const NEWS_CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=600, stale-while-revalidate=3600",
};
const DEFAULT_CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
};
const ERROR_HEADERS = { "Cache-Control": "no-store", "Retry-After": "600" };

export async function GET(_req: Request, { params }: RouteContext): Promise<Response> {
  const { file } = await params;
  const parsed = parseSitemapFile(file);

  if (parsed === null) {
    return new Response("Not found", { status: 404, headers: NOT_FOUND_HEADERS });
  }

  const baseUrl = siteUrl();

  try {
    let xml: string;
    let cacheHeaders: Record<string, string>;

    if (parsed === "static") {
      xml = await getStaticSitemapXml(baseUrl);
      cacheHeaders = DEFAULT_CACHE_HEADERS;
    } else if (parsed === "sources") {
      xml = await getSourcesSitemapXml(baseUrl);
      cacheHeaders = DEFAULT_CACHE_HEADERS;
    } else if (parsed === "news") {
      xml = await getNewsSitemapXml(baseUrl);
      cacheHeaders = NEWS_CACHE_HEADERS;
    } else {
      xml = await getClustersMonthXml(baseUrl, parsed.month);
      cacheHeaders = DEFAULT_CACHE_HEADERS;
    }

    return new Response(xml, {
      headers: { "Content-Type": "application/xml; charset=utf-8", ...cacheHeaders },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sitemaps] ${file} failed: ${message}`);
    return new Response("Service unavailable", { status: 503, headers: ERROR_HEADERS });
  }
}
