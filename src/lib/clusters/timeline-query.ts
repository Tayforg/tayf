import { cacheLife, cacheTag } from "next/cache";

import { createServerClient } from "@/lib/supabase/server";

// Fetcher for /timeline — extracted out of the page component so the unit
// tests can exercise it without rendering JSX (mirrors blindspots-query.ts).
// Behaviour is unchanged from the inline version this replaced, aside from
// the added is_archived filter.

export interface ClusterRow {
  id: string;
  title_tr: string;
  title_tr_neutral: string | null;
  article_count: number;
  first_published: string;
}

export async function getRecentClusters(): Promise<ClusterRow[]> {
  "use cache";
  cacheLife("cluster-feed");
  cacheTag("clusters");

  const supabase = createServerClient();

  // Window: last 24 hours, anchored at request time. The 60-second segment
  // revalidate means the window can drift by ~1 minute between cache fills,
  // which is well below the hour-bucket resolution.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("clusters")
    .select("id, title_tr, title_tr_neutral, article_count, first_published")
    // Archived (migration 037) clusters are excluded from every reader-facing
    // surface; the detail page still resolves them so shared links never 404.
    .eq("is_archived", false)
    .gt("first_published", since)
    .order("first_published", { ascending: false })
    .limit(100);

  if (error) {
    throw new Error(`timeline query failed: ${error.message}`);
  }

  return (data ?? []) as ClusterRow[];
}
