import { connection } from "next/server";

import { getSitemapIndexXml } from "@/lib/seo/sitemaps";
import { siteUrl } from "@/lib/site-url";

// /sitemap.xml — sitemap INDEX, not a leaf sitemap. Points crawlers at
// /sitemaps/static.xml, /sitemaps/sources.xml, /sitemaps/news.xml and one
// /sitemaps/clusters-YYYY-MM.xml per month. Replaces the old
// `src/app/sitemap.ts` MetadataRoute export (CLUSTER_LIMIT = 1000, top 5
// days of clusters only) — that file is deleted in this same change so the
// two conventions can never both resolve to /sitemap.xml at build.
//
// Runs per request, NOT prerendered at build: `await connection()` opts the
// handler out of static generation. The index lists one file per calendar
// month through the CURRENT one, so a copy frozen at build time would not
// gain next month's entry until the next deploy. `getSitemapIndexXml` is
// still a `"use cache"` function (revalidate 3600), so the per-request cost
// is a cache read and a new month shows up within about an hour of the UTC
// boundary. This handler reads no clock itself.

export async function GET(): Promise<Response> {
  await connection();

  const xml = await getSitemapIndexXml(siteUrl());

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
