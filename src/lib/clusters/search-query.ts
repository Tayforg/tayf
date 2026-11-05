import { cacheLife, cacheTag } from "next/cache";

import { attemptCached } from "@/lib/cache-resilience";
import { createReaderClient } from "@/lib/supabase/server";
import {
  canonicalSearchQuery,
  foldTr,
  turkishQueryVariants,
} from "./turkish-query";
import { getZoneFeedHealth } from "./feed-health";
import {
  buildClusterBundle,
  CLUSTER_EMBED_SELECT,
  flattenClusterMembers,
  type ClusterBundle,
  type EmbeddedClusterRow,
} from "./politics-query";

// Full-text archive search over ALL clusters (migration 035's `search_tsv`
// generated tsvector column plus migration 129's folded GIN index). The
// reader-typed query is reduced to its canonical form first
// (`canonicalSearchQuery`: control characters out, an apostrophe suffix like
// Erdoğan'ın dropped, Turkish lower-case, edge punctuation cut, at most 6 terms
// and 64 characters), then sent to the `search_cluster_ids` RPC twice over:
//   - `p_variants`: up to 3 Turkish-aware lexeme spellings (turkish-query.ts)
//     matched against `search_tsv`, the spellings the en_US lower() can store;
//   - `p_folded`: the ASCII-folded query (`foldTr`, the twin of 129's
//     `tayf_search_fold`) matched against the folded index, so 'sisli' finds
//     Şişli and 'cumhurbaskani' finds Cumhurbaşkanı.
// The RPC returns matching ids ONLY — no per-candidate lateral embed runs
// before the sort/limit (see 083's header for why an ids-first two-step beats
// the single embedded-select shape the audit measured at up to 11s).
//
// The archive is ranked, not "most-corroborated": clusters whose folded title
// contains the query as a word-start literal come first, then relevance plus
// recency; article_count is only a tie-break (129's header has the weights).
// The cost of one call is bounded in the database (129's header, BOUNDED WORK):
// the folded match carries no phrase operator, and only the 1000 most recently
// updated matches are scored, so an anonymous reader cannot make a broad or
// quoted query expensive.
// There is still no R1 importance ranking here (no politics-majority gate).
// Rows are turned into bundles via politics-query's shared
// `buildClusterBundle` so ClusterCard renders them identically to the main
// feed.
//
// Deploy order: if the app ships before migration 129, PostgREST answers
// PGRST202 for the 3-arg call and `fetchSearchClusters` falls back once to
// 083's 2-arg function (no folding, no ranking), so there is no outage.
//
// Load shape (h30-abuse-1). One search is a 0.4-0.5 s security-definer RPC on
// a Micro database, and an anonymous caller picks the query. Three layers keep
// a burst of unique `q` values from piling those RPCs up:
//   1. ONE KEY PER FAMILY. The cache key is `canonicalSearchQuery(q)`, so
//      'Erdoğan', 'ERDOĞAN!', ' erdoğan ' and 'erdoğan.' are one entry and one
//      RPC. The key is Turkish-lower-cased but NOT folded (turkish-query.ts
//      says why: the RPC arguments stay byte-identical, so no result changes).
//   2. BOUNDED SIZE. At most 6 terms and 64 characters reach the key and the
//      RPC, so a 500-character query is not a bigger query than a short one.
//   3. SINGLE-FLIGHT + IN-FLIGHT CAP, per instance. Concurrent calls for one
//      key share one promise (a news-spike burst on one term runs once and is
//      never refused). A new key while MAX_IN_FLIGHT_SEARCHES searches are
//      already running is shed at once: { ok: false }, no RPC, and it never
//      enters the cache boundary so the refusal is never memoised. A shed
//      search therefore reads as "temporarily unavailable" (HomeFeed's retry
//      affordance, /api/takip's 503 + Retry-After). The cap only bounds ONE
//      instance; the Vercel WAF rate rule is the fleet-wide layer.
// A cache hit also takes a slot, for microseconds. The side effect is that
// while 4 searches are in flight, a 5th distinct query is refused even if it
// would have been a cache hit.
export const SEARCH_LIMIT = 24;
const MIN_QUERY_LENGTH = 2;
export const MAX_IN_FLIGHT_SEARCHES = 4;

// `capped` = the RPC filled its page (SEARCH_LIMIT ids), so the archive may
// hold more matches than were returned. Optional so callers and mocks that
// predate it still compile; `composeSearchView` reads it as `=== true`.
export type SearchResult =
  | { ok: true; bundles: ClusterBundle[]; capped?: boolean }
  | { ok: false };

interface SearchIdRow {
  id: string;
}

interface SearchFetch {
  bundles: ClusterBundle[];
  capped: boolean;
}

// Internal, UNCACHED implementation. THROWS on a Supabase error/exception
// — mirroring politics-query.ts's fetch/cache split. Kept free of the
// "use cache" directive so it can be called twice: once (wrapped by
// `attemptCached`) inside the cache boundary below, and once more, live,
// as `searchClusters`' retry on a cache-attempt failure. `key` is already
// canonical and length-checked by `searchClusters` before this is ever called.
async function fetchSearchClusters(key: string): Promise<SearchFetch> {
  const variants = turkishQueryVariants(key);
  if (variants.length === 0) return { bundles: [], capped: false };

  const supabase = createReaderClient();

  let res = await supabase.rpc("search_cluster_ids", {
    p_variants: variants,
    p_folded: foldTr(key),
    p_limit: SEARCH_LIMIT,
  });
  // PGRST202 = the 3-arg function is not in PostgREST's schema cache, i.e.
  // migration 129 is not applied yet. Only then fall back, once, to 083's
  // 2-arg function (same pattern as entity-hub-query.ts); any other error
  // keeps the throw-and-retry path below.
  if (res.error?.code === "PGRST202") {
    res = await supabase.rpc("search_cluster_ids", {
      p_variants: variants,
      p_limit: SEARCH_LIMIT,
    });
  }
  const { data, error } = res;

  if (error) {
    throw new Error(`[clusters] search-query error: ${error.message}`);
  }

  const idRows = (data ?? []) as SearchIdRow[];
  const ids = idRows.map((r) => r.id);
  if (ids.length === 0) return { bundles: [], capped: false };
  const capped = ids.length >= SEARCH_LIMIT;

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

  // One clock read for the whole result: it ages every row's blindspot claim
  // (this body only runs inside the "use cache" attempt or after the request
  // scope on the live retry, so the read is allowed).
  const nowMs = Date.now();
  const bundles: ClusterBundle[] = [];
  for (const row of rows) {
    const members = flattenClusterMembers(row);
    if (members.length === 0) continue;
    bundles.push(buildClusterBundle(row, members, health, nowMs).bundle);
  }
  return { bundles, capped };
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
//
// Cache lifetime follows the outcome (same rule as topic-query.ts): a read
// keeps the `cluster-feed` window, a failed attempt ({ ok: false }) is
// memoised for `minutes` only. `cacheLife` used to run BEFORE the attempt, so
// one cold-read timeout was pinned for the whole feed window and every later
// hit for that query bypassed the cache's answer and went live to the DB.
// Exactly one `cacheLife` call per invocation, after the attempt, with one
// literal per call (Next 16.4 types cacheLife as single-literal overloads;
// tests/guards/cache-life-literal.test.ts); `cacheTag` stays first.
async function cachedSearchClusters(key: string) {
  "use cache";
  cacheTag("clusters-search");
  const r = await attemptCached("clusters-search", () =>
    fetchSearchClusters(key),
  );
  if (r.ok) cacheLife("cluster-feed");
  else cacheLife("minutes");
  return r;
}

// Per-instance load state (module scope: shared by every request this instance
// serves). `pending` holds the one in-flight search per canonical key;
// `inFlight` counts the searches running, which equals `pending.size` and is
// kept as a number only to make the cap check read plainly.
const pending = new Map<string, Promise<SearchResult>>();
let inFlight = 0;

// The cached attempt, then (if it failed and the instance has room) one live
// retry. `inFlight` already counts this search's own slot.
async function runSearch(key: string): Promise<SearchResult> {
  const attempt = await cachedSearchClusters(key);
  if (attempt.ok) {
    return { ok: true, bundles: attempt.data.bundles, capped: attempt.data.capped };
  }

  // A live retry doubles the database work of a failing search. When the
  // instance is already at its cap the database is the likely problem, so the
  // retry is skipped rather than piling more onto it.
  if (inFlight >= MAX_IN_FLIGHT_SEARCHES) {
    console.warn("[clusters] search-query retry skipped: saturated");
    return { ok: false };
  }

  try {
    const { bundles, capped } = await fetchSearchClusters(key);
    return { ok: true, bundles, capped };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[clusters] search-query failed: ${message}`);
    return { ok: false };
  }
}

// Public entry point. The canonical query becomes part of the cached function's
// key automatically, so each distinct search family gets one cache entry under
// the same `cluster-feed` TTL as the main feed ("Erdoğan'ın", "Erdoğan",
// "ERDOĞAN!" and "erdoğan." share one). A query that is only control characters
// or punctuation, or shorter than MIN_QUERY_LENGTH once canonical, is "too
// short": { ok: true, bundles: [] } with no RPC call and no slot — never
// { ok: false }, which HomeFeed shows as a false "zaman aşımı". On a
// cache-attempt failure this retries the query live once (bypassing the cache
// boundary entirely, never memoising a failure) unless the instance is
// saturated, before giving up — distinguishing "no results" ({ ok: true,
// bundles: [] }) from "still failing" or shed ({ ok: false }, never logging `q`
// itself — it's reader-typed input) so HomeFeed only shows a retry affordance
// on a genuine, still-failing outage. Never throws.
export async function searchClusters(q: string): Promise<SearchResult> {
  const key = canonicalSearchQuery(q);
  if (key.length < MIN_QUERY_LENGTH) {
    return { ok: true, bundles: [] };
  }

  // Single-flight: the check and the registration below run in one synchronous
  // stretch, so two callers can never both start the same key.
  const running = pending.get(key);
  if (running) return running;

  if (inFlight >= MAX_IN_FLIGHT_SEARCHES) {
    console.warn("[clusters] search-query shed: saturated");
    return { ok: false };
  }

  inFlight++;
  const search = runSearch(key).finally(() => {
    inFlight--;
    pending.delete(key);
  });
  pending.set(key, search);
  return search;
}
