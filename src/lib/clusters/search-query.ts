import { cacheLife, cacheTag } from "next/cache";

import { attemptCached } from "@/lib/cache-resilience";
import { createServerClient } from "@/lib/supabase/server";
import { turkishQueryVariants } from "./turkish-query";
import { getZoneFeedHealth } from "./feed-health";
import {
  buildClusterBundle,
  CLUSTER_EMBED_SELECT,
  flattenClusterMembers,
  type ClusterBundle,
  type EmbeddedClusterRow,
} from "./politics-query";

// Full-text archive search over ALL clusters (migration 035's `search_tsv`
// generated tsvector column). Reader-typed queries are Turkish-aware: the
// query text is turned into up to 3 candidate lexeme spellings
// (turkish-query.ts) and resolved against the GIN index through the 083
// migration's `search_cluster_ids` RPC, which returns matching ids ONLY —
// no per-candidate lateral embed runs before the sort/limit (see 083's
// header for why an ids-first two-step beats the single embedded-select
// shape the audit measured at up to 11s).
//
// Deliberately no R1 importance ranking here (no scoring, no politics-
// majority gate) — a plain "most-corroborated, most-recent" ordering
// (delegated to the RPC's ORDER BY) is enough for an archive search. Rows
// are turned into bundles via politics-query's shared `buildClusterBundle`
// so ClusterCard renders them identically to the main feed.
const SEARCH_LIMIT = 12;
const MIN_QUERY_LENGTH = 2;
// Bounds the cache key: a per-query cache entry compounds with
// search-as-you-type prefixes, so an unbounded query string would let a
// pathological/malicious input balloon the cache-key space.
const MAX_QUERY_LENGTH = 200;

export type SearchResult =
  | { ok: true; bundles: ClusterBundle[] }
  | { ok: false };

interface SearchIdRow {
  id: string;
}

// Internal, UNCACHED implementation. THROWS on a Supabase error/exception
// — mirroring politics-query.ts's fetch/cache split. Kept free of the
// "use cache" directive so it can be called twice: once (wrapped by
// `attemptCached`) inside the cache boundary below, and once more, live,
// as `searchClusters`' retry on a cache-attempt failure. `trimmed` is
// already length-checked by `searchClusters` before this is ever called.
async function fetchSearchClusters(trimmed: string): Promise<ClusterBundle[]> {
  const variants = turkishQueryVariants(trimmed);
  if (variants.length === 0) return [];

  const supabase = createServerClient();

  const { data, error } = await supabase.rpc("search_cluster_ids", {
    p_variants: variants,
    p_limit: SEARCH_LIMIT,
  });

  if (error) {
    throw new Error(`[clusters] search-query error: ${error.message}`);
  }

  const idRows = (data ?? []) as SearchIdRow[];
  const ids = idRows.map((r) => r.id);
  if (ids.length === 0) return [];

  // Same feed-health gate as politics-query.ts's fetchPoliticsClusters,
  // fetched once per search — so search-result cards (which render the
  // identical ClusterCard blindspot badge) never disagree with the home
  // feed about a suppressed cluster. Run in parallel with the embed fetch:
  // neither depends on the other.
  const [health, embedRes] = await Promise.all([
    getZoneFeedHealth(),
    supabase
      .from("clusters")
      .select(CLUSTER_EMBED_SELECT)
      .in("id", ids)
      .returns<EmbeddedClusterRow[]>(),
  ]);

  if (embedRes.error) {
    throw new Error(`[clusters] search-query error: ${embedRes.error.message}`);
  }

  // The embed's row order is not guaranteed to match the RPC's ranked
  // order (ids-first: `.in('id', ids)` does not preserve the `IN (...)`
  // list order) — re-sort by the RPC's id order before building bundles.
  const order = new Map(ids.map((id, i) => [id, i]));
  const rows = [...(embedRes.data ?? [])].sort(
    (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );

  const bundles: ClusterBundle[] = [];
  for (const row of rows) {
    const members = flattenClusterMembers(row);
    if (members.length === 0) continue;
    bundles.push(buildClusterBundle(row, members, health).bundle);
  }
  return bundles;
}

// Build-safety: `attemptCached` swallows whatever `fetchSearchClusters`
// throws instead of letting it cross the `"use cache"` boundary — a throw
// here fails `next build`'s prerender even when every caller catches (see
// src/lib/cache-resilience.ts; catching OUTSIDE the boundary, which is
// what this file used to do, does not by itself prevent that).
//
// Kept on plain `"use cache"` (NOT `"use cache: remote"`): per-query keys
// plus search-as-you-type prefixes give a near-zero hit rate for a shared
// remote cache handler (see next/dist/docs' use-cache-remote.md, "When to
// avoid remote caching") — an in-memory per-instance cache is the right
// fit here, unlike the hot fetchers in E1.
async function cachedSearchClusters(trimmed: string) {
  "use cache";
  cacheLife("cluster-feed");
  cacheTag("clusters-search");
  return attemptCached("clusters-search", () => fetchSearchClusters(trimmed));
}

// Public entry point. `q` becomes part of the cached function's key
// automatically, so each distinct search term gets its own cache entry
// under the same `cluster-feed` TTL as the main feed. On a cache-attempt
// failure this retries the query live once (bypassing the cache boundary
// entirely, never memoising a failure) before giving up — distinguishing
// "no results" (`{ ok: true, bundles: [] }`) from "still failing"
// (`{ ok: false }`, never logging `q` itself — it's reader-typed input) so
// HomeFeed only shows a retry affordance on a genuine, still-failing
// outage. Never throws.
export async function searchClusters(q: string): Promise<SearchResult> {
  const trimmed = q.trim().slice(0, MAX_QUERY_LENGTH);
  if (trimmed.length < MIN_QUERY_LENGTH) {
    return { ok: true, bundles: [] };
  }

  const attempt = await cachedSearchClusters(trimmed);
  if (attempt.ok) return { ok: true, bundles: attempt.data };

  try {
    const bundles = await fetchSearchClusters(trimmed);
    return { ok: true, bundles };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[clusters] search-query failed: ${message}`);
    return { ok: false };
  }
}
