import { cacheLife } from "next/cache";
import type { MetadataRoute } from "next";
import { createServerClient } from "@/lib/supabase/server";

// Sitemap with Google "image:image" extension for cluster pages.
//
// Next.js 16's `MetadataRoute.Sitemap` supports an `images: string[]`
// field on each entry — Next emits the matching <image:image><image:loc>
// children inside <url> automatically (and adds the
// xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" namespace
// at the urlset root). See:
//   node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/sitemap.md
//
// We surface the cluster hero image (the first member article's
// `image_url`) so cluster pages show up in Google Image Search keyed to
// their hero photo.

const CLUSTER_LIMIT = 1000;

// Shape of the embedded PostgREST select used below. We pull each
// cluster row plus its joined `cluster_articles → articles` so we can
// pick the first non-null `image_url` as the hero. Members come back in
// undefined order from PostgREST, so we sort by published_at DESC in
// JS to match how the cluster detail page picks its hero.
type EmbeddedArticle = {
  image_url: string | null;
  published_at: string;
};

type EmbeddedClusterArticle = {
  articles: EmbeddedArticle | null;
};

type SitemapClusterRow = {
  id: string;
  updated_at: string;
  cluster_articles: EmbeddedClusterArticle[] | null;
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

  // Dynamic cluster routes — top 1000 by updated_at, with hero image
  // for the Google image-sitemap extension. Single embedded round-trip:
  // clusters → cluster_articles → articles.
  const { data: clusters, error } = await supabase
    .from("clusters")
    .select(
      `id, updated_at,
       cluster_articles (
         articles ( image_url, published_at )
       )`
    )
    .gte("article_count", 2)
    .order("updated_at", { ascending: false })
    .limit(CLUSTER_LIMIT)
    .returns<SitemapClusterRow[]>();

  if (error) {
    console.error("[sitemap] cluster query error", error.message);
  }

  const clusterRoutes: MetadataRoute.Sitemap = (clusters ?? []).map((c) => {
    // Pick the hero image: newest member article that actually has one.
    // Sorting in JS keeps this independent of PostgREST's join order.
    const members = (c.cluster_articles ?? [])
      .map((ca) => ca.articles)
      .filter((a): a is EmbeddedArticle => a !== null)
      .sort(
        (a, b) =>
          new Date(b.published_at).getTime() -
          new Date(a.published_at).getTime()
      );
    const hero = members.find((m) => m.image_url && m.image_url.length > 0);

    const entry: MetadataRoute.Sitemap[number] = {
      url: `${baseUrl}/cluster/${c.id}`,
      lastModified: new Date(c.updated_at),
      changeFrequency: "hourly" as const,
      priority: 0.8,
    };
    if (hero?.image_url) {
      entry.images = [hero.image_url];
    }
    return entry;
  });

  return [...staticRoutes, ...clusterRoutes];
}
