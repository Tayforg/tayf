import { cacheLife, cacheTag } from "next/cache";

import { attemptCached } from "@/lib/cache-resilience";
import { createReaderClient } from "@/lib/supabase/server";

// When Tayf first saw each member article (`articles.created_at`), for the
// "Kim önce yazdı?" story timeline. A separate module on purpose:
// cluster-detail-query.ts owns the page's main select, and this is the only
// extra column the timeline needs — it caps a source-supplied future
// pubDate (CNN Türk runs ~2.84 h ahead; see story-timeline.ts).
//
// Cost (checked against prod, 2026-09-28): index-only scan on
// cluster_articles_pkey + articles_pkey lookups, 1.5 ms for the 29-member
// maximum. Cluster size p99 is 22, so the 1000 cap is a guard, not a page.

type SeenAtRow = {
  article_id: string;
  // PostgREST types a to-one embed as object-or-array depending on how the
  // FK is introspected — accept both, plus a missing article.
  articles: { created_at: string | null } | Array<{ created_at: string | null }> | null;
};

function createdAtOf(row: SeenAtRow): string | null {
  const embed = Array.isArray(row.articles) ? row.articles[0] : row.articles;
  return embed?.created_at ?? null;
}

/**
 * Raw article id → created_at map for one cluster. Uncached and THROWS on a
 * Supabase error (including a 4 s reader-cap abort) so a transient failure is
 * never mistaken for an empty map. Not exported: it is only called from
 * `getMemberSeenAtCached`, which wraps it in `attemptCached`, so the throw
 * never crosses the `"use cache"` boundary (a throw there fails `next build`'s
 * prerender even when every caller catches -- see src/lib/cache-resilience.ts).
 */
async function fetchMemberSeenAtRaw(
  clusterId: string,
): Promise<Record<string, string>> {
  const { data, error } = await createReaderClient()
    .from("cluster_articles")
    .select("article_id, articles ( created_at )")
    .eq("cluster_id", clusterId)
    .limit(1000);

  if (error) {
    throw new Error(`story-timeline seenAt query failed: ${error.message}`);
  }

  const seenAt: Record<string, string> = {};
  for (const row of (data ?? []) as SeenAtRow[]) {
    const createdAt = createdAtOf(row);
    if (row.article_id && createdAt) seenAt[row.article_id] = createdAt;
  }
  return seenAt;
}

// Cache lifetime follows the outcome: a map (possibly empty -- a real answer)
// keeps the `cluster-feed` window, a failed attempt is memoised for `minutes`
// only. Exactly one `cacheLife` call per invocation, after the attempt;
// `cacheTag` first.
async function getMemberSeenAtCached(clusterId: string) {
  "use cache";
  cacheTag("clusters");
  const r = await attemptCached("story-timeline", () =>
    fetchMemberSeenAtRaw(clusterId),
  );
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("cluster-feed");
  else cacheLife("minutes");
  return r;
}

/**
 * Uncached fail-open wrapper: `null` on any error, which the timeline reads
 * as "use published times as-is". Never throws. No live retry: the timeline is
 * a nicety, and the page's own budget is better spent elsewhere.
 */
export async function getMemberSeenAt(
  clusterId: string,
): Promise<Record<string, string> | null> {
  const r = await getMemberSeenAtCached(clusterId);
  if (r.ok) return r.data;
  console.warn(
    `[story-timeline] seenAt unavailable for ${clusterId}: ${r.error}`,
  );
  return null;
}
