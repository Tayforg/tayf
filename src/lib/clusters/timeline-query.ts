import { cacheLife, cacheTag } from "next/cache";

import { attemptCached } from "@/lib/cache-resilience";
import { createReaderClient } from "@/lib/supabase/server";

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

// Raw read: THROWS on a Supabase error (including a 4 s reader-cap abort) so
// a failure can never be mistaken for "no clusters in the last 24 h". Called
// only from `getRecentClustersCached`, i.e. from inside the cache scope,
// which is why the clock read below is allowed: /timeline is a static route,
// and Next 16 prerender (cacheComponents) rejects `Date.now()` in the
// uncached render path (same rule as /trends, see trends/daily-zones.ts).
async function fetchRecentClusters(): Promise<ClusterRow[]> {
  const supabase = createReaderClient();

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

// Build-safety: `attemptCached` swallows whatever `fetchRecentClusters` throws
// instead of letting it cross the `"use cache"` boundary (a throw there fails
// `next build`'s prerender -- see src/lib/cache-resilience.ts). Cache lifetime
// follows the outcome: rows keep the `cluster-feed` window, a failed attempt
// is memoised for `minutes` only. Exactly one `cacheLife` call per invocation,
// after the attempt; `cacheTag` first.
async function getRecentClustersCached() {
  "use cache";
  cacheTag("clusters");
  const r = await attemptCached("timeline", fetchRecentClusters);
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("cluster-feed");
  else cacheLife("minutes");
  return r;
}

/**
 * Clusters minted in the last 24 hours, newest first. `null` = the read
 * failed (the page renders an honest "unavailable" state); `[]` = it read
 * fine and nothing was minted.
 *
 * There is deliberately NO live retry (unlike getClusterDetail or
 * getTopicClusters): the route is static and the raw fetch reads
 * `Date.now()`, so a bypass-retry would put that clock read outside any
 * cache scope. A failed attempt falls straight back to `null` and the next
 * revalidation (~60 s) tries again. Never throws.
 */
export async function getRecentClusters(): Promise<ClusterRow[] | null> {
  const r = await getRecentClustersCached();
  return r.ok ? r.data : null;
}
