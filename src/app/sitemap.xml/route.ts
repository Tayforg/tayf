import { getSitemapIndexXml } from "@/lib/seo/sitemaps";
import { siteUrl } from "@/lib/site-url";

// /sitemap.xml — sitemap INDEX, not a leaf sitemap. Points crawlers at
// /sitemaps/static.xml, /sitemaps/sources.xml, /sitemaps/news.xml and one
// /sitemaps/clusters-YYYY-MM.xml per month. Replaces the old
// `src/app/sitemap.ts` MetadataRoute export (CLUSTER_LIMIT = 1000, top 5
// days of clusters only) — that file is deleted in this same change so the
// two conventions can never both resolve to /sitemap.xml at build.
//
// Prerendered at build (cacheComponents): `getSitemapIndexXml` is a
// `"use cache"` function with no request-scoped input, and this handler
// itself touches no dynamic API (no headers()/cookies()/Date), so the
// route stays static.

export async function GET(): Promise<Response> {
  const xml = await getSitemapIndexXml(siteUrl());

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
