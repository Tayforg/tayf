import { cacheLife, cacheTag } from "next/cache";

import { createServerClient } from "@/lib/supabase/server";
import {
  buildClusterBundle,
  CLUSTER_EMBED_SELECT,
  flattenClusterMembers,
  type ClusterBundle,
  type EmbeddedClusterRow,
} from "./politics-query";

// Full-text archive search over ALL clusters (migration 035's
// `search_tsv` generated tsvector column + GIN index). page.tsx calls
// this only as a fallback: the homepage's in-memory title filter only
// sees the CANDIDATE_LIMIT top-ranked clusters politics-query already
// fetched, so a query matching an older/lower-ranked story finds nothing
// there. This runs a real Postgres full-text query across the whole
// table instead.
//
// Deliberately no R1 importance ranking here (no scoring, no politics-
// majority gate) — a plain "most-corroborated, most-recent" ordering is
// enough for an archive search that only runs once the primary filter
// has already come up empty. Rows are turned into bundles via
// politics-query's shared `buildClusterBundle` so ClusterCard renders
// them identically to the main feed.
const SEARCH_LIMIT = 12;
const MIN_QUERY_LENGTH = 2;

// Internal, cached implementation. THROWS on a Supabase error/exception —
// mirroring politics-query.ts's fetch/cache split — because this function
// carries the "use cache" boundary. A caught-and-swallowed error here
// would cache an empty result as truth for the whole cluster-feed window
// (empty archive search for minutes after one Supabase blip). The public
// `searchClusters` below sits outside the cache and converts the throw
// into the documented never-throw contract.
async function cachedSearchClusters(q: string): Promise<ClusterBundle[]> {
  "use cache";
  cacheLife("cluster-feed");
  cacheTag("clusters-search");

  const trimmed = q.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) return [];

  const supabase = createServerClient();

  const { data, error } = await supabase
    .from("clusters")
    .select(CLUSTER_EMBED_SELECT)
    // Archived (migration 037) clusters are excluded from every reader-facing
    // surface; the detail page still resolves them so shared links never 404.
    .eq("is_archived", false)
    .textSearch("search_tsv", trimmed, {
      config: "turkish",
      type: "websearch",
    })
    .gte("article_count", 2)
    .order("article_count", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(SEARCH_LIMIT)
    .returns<EmbeddedClusterRow[]>();

  if (error) {
    throw new Error(`[clusters] search-query error: ${error.message}`);
  }

  const bundles: ClusterBundle[] = [];
  for (const row of data ?? []) {
    const members = flattenClusterMembers(row);
    if (members.length === 0) continue;
    bundles.push(buildClusterBundle(row, members).bundle);
  }
  return bundles;
}

// Public entry point. `q` becomes part of the cached function's key
// automatically, so each distinct search term gets its own cache entry
// under the same `cluster-feed` TTL as the main feed. This wrapper lives
// OUTSIDE the cache boundary so a failure is never memoised: it catches
// whatever `cachedSearchClusters` throws, logs it, and returns [] — the
// home page's existing empty state renders instead of a 500, and the next
// request gets a fresh attempt instead of a cached failure.
export async function searchClusters(q: string): Promise<ClusterBundle[]> {
  try {
    return await cachedSearchClusters(q);
  } catch (err) {
    console.warn("[clusters] search-query failed:", err);
    return [];
  }
}
