import { cacheLife, cacheTag } from "next/cache";

import { createServerClient } from "@/lib/supabase/server";

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
 * Cached article id → created_at map for one cluster. Throws on a Supabase
 * error so "use cache" never stores an empty map for a transient failure;
 * callers go through `getMemberSeenAt`, which fails open.
 */
export async function fetchMemberSeenAt(
  clusterId: string,
): Promise<Record<string, string>> {
  "use cache";
  cacheLife("cluster-feed");
  cacheTag("clusters");

  const { data, error } = await createServerClient()
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

/**
 * Uncached fail-open wrapper: `null` on any error, which the timeline reads
 * as "use published times as-is".
 */
export async function getMemberSeenAt(
  clusterId: string,
): Promise<Record<string, string> | null> {
  try {
    return await fetchMemberSeenAt(clusterId);
  } catch (err) {
    console.warn(
      `[story-timeline] seenAt unavailable for ${clusterId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
