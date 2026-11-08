import { cacheLife, cacheTag } from "next/cache";

import { attemptCached } from "@/lib/cache-resilience";
import { createReaderClient } from "@/lib/supabase/server";

import { clusterDisplayTitle, type HeadlineMember } from "./display-headline";

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
  /**
   * The headline the page prints (h76-timeline-2): the stored neutral title
   * verbatim when there is one, else the headline cron's own first pick over the
   * member titles (clusterDisplayTitle, the same function the home feed and the
   * cluster page use), else `title_tr`. Never the raw outlet headline of a
   * cluster the cron is about to title.
   */
  title: string;
  article_count: number;
  first_published: string;
}

/** A `clusters` row as the row read returns it, before the display title is attached. */
type StoredClusterRow = Omit<ClusterRow, "title">;

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

/**
 * Members read per cluster that has no stored neutral title yet. A cluster the
 * headline cron has not titled is a fresh one (normally 2-5 members); the cap
 * only bounds a pathological answer.
 */
const MEMBERS_PER_CLUSTER = 50;
/** Hard ceiling on the member read, however many rows lack a title. */
const MEMBER_READ_MAX_ROWS = 1000;

// The stored column is the cron's output, so a row without one (null, or
// whitespace only) is the only kind that needs its members read.
function lacksStoredNeutral(row: StoredClusterRow): boolean {
  const neutral: unknown = row.title_tr_neutral;
  return typeof neutral !== "string" || neutral.trim().length === 0;
}

type MemberReadRow = {
  cluster_id: string;
  articles: HeadlineMember | HeadlineMember[] | null;
};

// ONE read for every row that lacks a stored neutral title: the member titles
// the headline cron itself reads (cluster_articles -> articles), grouped by
// cluster. A member title is a nicety on top of the rows, like the count: a
// returned error or a throw (including the 4 s reader-cap abort) is logged and
// yields no members at all, so those rows keep the `title_tr` they always had.
// It never throws and never fails the attempt -- the rows are the page.
async function fetchMemberTitles(
  supabase: ReaderClient,
  clusterIds: string[],
): Promise<Map<string, HeadlineMember[]>> {
  const byCluster = new Map<string, HeadlineMember[]>();
  try {
    const { data, error } = await supabase
      .from("cluster_articles")
      .select("cluster_id, articles ( title, published_at )")
      .in("cluster_id", clusterIds)
      .limit(Math.min(clusterIds.length * MEMBERS_PER_CLUSTER, MEMBER_READ_MAX_ROWS));
    if (error) {
      console.error(`[timeline] member titles unavailable: ${error.message}`);
      return new Map();
    }
    for (const r of (data ?? []) as unknown as MemberReadRow[]) {
      const article = Array.isArray(r.articles) ? r.articles[0] : r.articles;
      if (!article) continue;
      const list = byCluster.get(r.cluster_id);
      if (list) list.push(article);
      else byCluster.set(r.cluster_id, [article]);
    }
    return byCluster;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[timeline] member titles unavailable: ${message}`);
    return new Map();
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

  // Window: last 24 hours, anchored at the moment this cache entry is filled.
  // The entry revalidates after 300 s (cacheLife "cluster-feed",
  // next.config.ts) and is served stale once past that, so the window can lag
  // by minutes between fills, which is still small against a 24 h window. One
  // `since` for both reads.
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

  const stored = (data ?? []) as StoredClusterRow[];

  // h76-timeline-2: the display title. A cluster whose neutral title the
  // headline cron has not written yet (it ticks every 5 minutes) used to print
  // the seed article's raw outlet headline here, and kept printing it after the
  // cron wrote the neutral one, because this entry is cached. The reader now
  // computes the cron's own first pick (clusterDisplayTitle, pure) from ONE
  // member read over just the rows that need it (normally 0-5), inside this
  // cache scope: one small extra read per cache fill, none when every row
  // already has a stored title. Nothing is written.
  const missing = stored.filter(lacksStoredNeutral).map((r) => r.id);
  const members =
    missing.length > 0
      ? await fetchMemberTitles(supabase, missing)
      : new Map<string, HeadlineMember[]>();
  const rows: ClusterRow[] = stored.map((r) => ({
    ...r,
    title: clusterDisplayTitle(r, members.get(r.id) ?? []).title,
  }));

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
  // "timeline" is this entry's own tag: the headline cron revalidates it when it
  // writes a title (h76-timeline-2). "clusters" alone is not enough: it also tags
  // every per-cluster story-timeline entry, so revalidating it would add reads on
  // cluster pages.
  cacheTag("clusters", "timeline");
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
 * cache scope. A failed attempt falls straight back to `null`, is memoised
 * for the built-in "minutes" window (revalidate ~60 s) only, and the next
 * request after it tries again. A good result lives under "cluster-feed":
 * 300 s, served stale once after that while it regenerates, so the page copy
 * and /api/timeline/head each see this entry on their own lifecycle (see the
 * pill, src/components/timeline/new-clusters-pill.tsx). Never throws.
 */
export async function getRecentClusters(): Promise<RecentClusters | null> {
  const r = await getRecentClustersCached();
  return r.ok ? r.data : null;
}
