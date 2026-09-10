import { cacheLife } from "next/cache";
import type { MetadataRoute } from "next";
import { createServerClient } from "@/lib/supabase/server";

// No Google "image:image" extension here (removed — deck TOP-3 / finding
// LEG-04). This sitemap used to embed each cluster's hero photo — one of
// the outlet articles' `image_url`s — as an `images: string[]` entry, which
// Next.js turns into an `<image:image><image:loc>` child of the cluster
// `<url>` (plus the xmlns:image namespace at the urlset root). Tayf
// re-hosts (proxies/serves) outlet photographs it does not own; advertising
// them as the image of a tayfhaber.com URL in Google Images associates
// other outlets' photos with tayfhaber.com and is the first aggravator a
// rights holder would cite. Cluster URLs stay in the sitemap for crawl
// discovery — only the image extension goes. The embedded
// `cluster_articles → articles` join was dropped along with it: nothing
// else in this file used it.

const CLUSTER_LIMIT = 1000;

type SitemapClusterRow = {
  id: string;
  updated_at: string;
};

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  "use cache";
  cacheLife({ revalidate: 3600 });

  const supabase = createServerClient();
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  // Static routes
  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${baseUrl}/`, lastModified: new Date(), changeFrequency: "hourly", priority: 1 },
    { url: `${baseUrl}/blindspots`, lastModified: new Date(), changeFrequency: "hourly", priority: 0.9 },
    { url: `${baseUrl}/sources`, lastModified: new Date(), changeFrequency: "daily", priority: 0.7 },
    { url: `${baseUrl}/metodoloji`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.5 },
  ];

  // Dynamic cluster routes — top 1000 by updated_at.
  const { data: clusters, error } = await supabase
    .from("clusters")
    .select("id, updated_at")
    // Archived clusters stay reachable by direct link but are deliberately
    // withdrawn from crawler discovery, so a soft-deleted story stops
    // competing for index budget without any URL starting to 404.
    .eq("is_archived", false)
    .gte("article_count", 2)
    .order("updated_at", { ascending: false })
    .limit(CLUSTER_LIMIT)
    .returns<SitemapClusterRow[]>();

  if (error) {
    console.error("[sitemap] cluster query error", error.message);
  }

  const clusterRoutes: MetadataRoute.Sitemap = (clusters ?? []).map((c) => ({
    url: `${baseUrl}/cluster/${c.id}`,
    lastModified: new Date(c.updated_at),
    changeFrequency: "hourly" as const,
    priority: 0.8,
  }));

  return [...staticRoutes, ...clusterRoutes];
}
