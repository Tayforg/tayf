import { cacheLife, cacheTag } from "next/cache";

import { attemptCached } from "@/lib/cache-resilience";
import { createReaderClient } from "@/lib/supabase/server";

// Fetcher for /timeline — extracted out of the page component so the unit
// tests can exercise it without rendering JSX (mirrors blindspots-query.ts).

/**
 * Row cap for the feed. Measured 2026-10-24: ~234 clusters with
 * article_count >= 2 are minted per 24 h, so 100 covered only the newest
 * ~10 h; 200 covers ~20 h and the page copy names the real total for the
 * remainder. ~200 rows x 5 small columns is ~50 KB of HTML on a static
 * cached route.
 */
export const TIMELINE_LIMIT = 200;

export interface ClusterRow {
  id: string;
  title_tr: string;
  title_tr_neutral: string | null;
  article_count: number;
  first_published: string;
}

export interface RecentClusters {
  rows: ClusterRow[];
  /**
   * Real number of qualifying clusters minted in the window (>= rows.length),
   * or null when the count read failed. The page must never present
   * `rows.length` as the day's total when `total` is null.
   */
  total: number | null;
}

type ReaderClient = ReturnType<typeof createReaderClient>;

// Head/exact count over the SAME filters and the SAME `since` bound as the row
// read, so "N of M" can never describe two different windows. A count is a
// nicety: a returned error, a null count (no Content-Range total) or a
// rejection (including the 4 s reader-cap abort) yields null and never fails
// the attempt — the rows are the page.
async function countRecentClusters(
  supabase: ReaderClient,
  since: string,
): Promise<number | null> {
  try {
    const { count, error } = await supabase
      .from("clusters")
      .select("id", { count: "exact", head: true })
      .eq("is_archived", false)
      .gte("article_count", 2)
      .gt("first_published", since);
    if (error) {
      console.error(`[timeline] total unavailable: ${error.message}`);
      return null;
    }
    return count ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[timeline] total unavailable: ${message}`);
    return null;
  }
}

// Raw read: THROWS on a Supabase error in the ROW read (including a 4 s
// reader-cap abort) so a failure can never be mistaken for "no clusters in the
// last 24 h". Called only from `getRecentClustersCached`, i.e. from inside the
// cache scope, which is why the clock read below is allowed: /timeline is a
// static route, and Next 16 prerender (cacheComponents) rejects `Date.now()`
// in the uncached render path (same rule as /trends, see
// trends/daily-zones.ts).
async function fetchRecentClusters(): Promise<RecentClusters> {
  const supabase = createReaderClient();

  // Window: last 24 hours, anchored at request time. The 60-second segment
  // revalidate means the window can drift by ~1 minute between cache fills,
  // which is well below the hour-bucket resolution. One `since` for both
  // reads.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [{ data, error }, count] = await Promise.all([
    supabase
      .from("clusters")
      .select("id, title_tr, title_tr_neutral, article_count, first_published")
      // Archived (migration 037) clusters are excluded from every reader-facing
      // surface; the detail page still resolves them so shared links never 404.
      .eq("is_archived", false)
      // The site's own cluster definition: a story needs at least two
      // articles. Singletons are not clusters (see /clusters, /konu).
      .gte("article_count", 2)
      .gt("first_published", since)
      .order("first_published", { ascending: false })
      .limit(TIMELINE_LIMIT),
    countRecentClusters(supabase, since),
  ]);

  if (error) {
    throw new Error(`timeline query failed: ${error.message}`);
  }

  const rows = (data ?? []) as ClusterRow[];
  // The two reads are not one snapshot: a cluster archived between them could
  // make the count smaller than what was listed. Never claim fewer than shown.
  const total = count === null ? null : Math.max(count, rows.length);
  return { rows, total };
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
 * Clusters (article_count >= 2) minted in the last 24 hours, newest first,
 * capped at TIMELINE_LIMIT, plus the real total. `null` = the row read failed
 * (the page renders an honest "unavailable" state); `{ rows: [] }` = it read
 * fine and nothing was minted; `total: null` = only the count failed.
 *
 * There is deliberately NO live retry (unlike getClusterDetail or
 * getTopicClusters): the route is static and the raw fetch reads
 * `Date.now()`, so a bypass-retry would put that clock read outside any
 * cache scope. A failed attempt falls straight back to `null` and the next
 * revalidation (~60 s) tries again. Never throws.
 */
export async function getRecentClusters(): Promise<RecentClusters | null> {
  const r = await getRecentClustersCached();
  return r.ok ? r.data : null;
}
