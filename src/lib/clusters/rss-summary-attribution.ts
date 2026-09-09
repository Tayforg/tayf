import { cacheLife, cacheTag } from "next/cache";

import { createServerClient } from "@/lib/supabase/server";
import type { BiasCategory } from "@/types";
import type { SummaryMember } from "./summary-attribution";

// RSS-only member projection for summary attribution. rss.xml needs the
// same seed-matching / wire-majority logic as the cluster detail page
// (summary-attribution.ts) but must not widen politics-query.ts's
// CLUSTER_EMBED_SELECT — that query is shared by every reader of the
// cached home feed. This module runs one extra, RSS-only Supabase query,
// bounded to the <=30 cluster ids the feed already chose, and selects
// only the columns SummaryMember needs (source name/bias, article
// published_at/content_hash/description) — never rss_url/url/slug/id.
//
// TODO(follow-up): this duplicates ~20 lines of the embedded-select /
// same-source-dedupe logic in cluster-detail-query.ts and politics-
// query.ts's flattenClusterMembers. Both files are out of scope for this
// pass; factoring a shared helper is follow-up debt, not silently
// copy-pasted without this note.

type EmbeddedSourceRow = { name: string; bias: BiasCategory };

type EmbeddedArticleRow = {
  source_id: string;
  published_at: string;
  content_hash: string | null;
  description: string | null;
  sources: EmbeddedSourceRow | null;
};

type Row = {
  cluster_id: string;
  articles: EmbeddedArticleRow | null;
};

/** Same-source dedupe, earliest article per source_id — mirrors politics-query.ts's flattenClusterMembers/buildClusterBundle so the wire-majority check here runs over the same member set isWireRedistribution was computed from. */
function dedupeBySource(rows: EmbeddedArticleRow[]): SummaryMember[] {
  const sorted = [...rows].sort(
    (a, b) => new Date(a.published_at).getTime() - new Date(b.published_at).getTime(),
  );
  const seen = new Set<string>();
  const members: SummaryMember[] = [];
  for (const row of sorted) {
    if (seen.has(row.source_id)) continue;
    seen.add(row.source_id);
    const source = row.sources;
    if (!source) continue;
    members.push({
      source: { name: source.name, bias: source.bias },
      article: {
        published_at: row.published_at,
        content_hash: row.content_hash,
        description: row.description,
      },
    });
  }
  return members;
}

// Internal, cached implementation. THROWS on a Supabase error/exception —
// mirroring search-query.ts's cachedSearchClusters/searchClusters split —
// because this function carries the "use cache" boundary. A caught-and-
// swallowed error here would cache an empty {} as truth for the whole
// cluster-feed window (every cluster degrading to the generic label or a
// hidden summary for minutes after one Supabase blip). The public
// `getRssSummaryMembers` below sits outside the cache and converts the
// throw into the documented never-throw, fail-closed-on-honesty contract.
async function cachedRssSummaryMembers(
  clusterIds: string[],
): Promise<Record<string, SummaryMember[]>> {
  "use cache";
  cacheLife("cluster-feed");
  cacheTag("clusters-politics");

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("cluster_articles")
    .select(
      `cluster_id, articles ( source_id, published_at, content_hash, description, sources ( name, bias ) )`,
    )
    .in("cluster_id", clusterIds)
    .returns<Row[]>();

  if (error) {
    throw new Error(`[rss-summary-attribution] query error: ${error.message}`);
  }

  const byCluster = new Map<string, EmbeddedArticleRow[]>();
  for (const row of data ?? []) {
    if (!row.articles) continue;
    const list = byCluster.get(row.cluster_id) ?? [];
    list.push(row.articles);
    byCluster.set(row.cluster_id, list);
  }

  const result: Record<string, SummaryMember[]> = {};
  for (const [clusterId, rows] of byCluster) {
    result[clusterId] = dedupeBySource(rows);
  }
  return result;
}

// Public, uncached entry point. Lives OUTSIDE the cache boundary so a
// failure is never memoised: it catches whatever `cachedRssSummaryMembers`
// throws, logs it, and returns {} for THIS request only — the next
// request gets a fresh attempt instead of a cached failure. Fail-closed on
// honesty, not availability: a degraded {} makes every caller fall back to
// summaryAttributionWithoutMembers, which can only hide or generically
// label a summary — never invent an outlet.
export async function getRssSummaryMembers(
  clusterIds: string[],
): Promise<Record<string, SummaryMember[]>> {
  if (clusterIds.length === 0) return {};

  try {
    return await cachedRssSummaryMembers(clusterIds);
  } catch (err) {
    console.warn("[rss-summary-attribution] lookup failed:", err);
    return {};
  }
}
