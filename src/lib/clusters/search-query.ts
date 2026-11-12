import { cacheLife, cacheTag } from "next/cache";

import { attemptCached } from "@/lib/cache-resilience";
import { createReaderClient } from "@/lib/supabase/server";
import { expandAliasQuery } from "./search-aliases";
import {
  canonicalSearchQuery,
  foldTr,
  holdsLocativeWitness,
  searchFoldedSiblingParts,
  searchSiblingQuery,
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
// A possessive or doubled-stem form ('elektrik zammı', 'emlak vergisi') also asks for its
// root ('elektrik zam', 'emlak vergi') in a SECOND call, made only when the typed call
// returned fewer than SEARCH_LIMIT ids; its new ids are appended after the typed ones
// (turkish-query.ts, h96-search-1). Every call sends at most 3 variants, and each call
// folds its own words: the typed call sends `p_folded` = the typed words, the sibling call
// the sibling's words (h124-postship-1).
// The same second call serves two more shapes (h144-search-1): a case suffix typed without
// an apostrophe ('imamoğluna', 'suriyede') is searched as its root (the sibling call, as ever), and
// a bare vowel-final noun with no root sibling ('bolu kaza', 'tarla', and a one-letter hyphen compound such as
// 'e-posta', h157-search-3) is searched with its locative ('boluda kazada', 'tarlada', 'e-postada'), because the
// stemmer cuts 'kaza' to 'kaz' and 'kazada' to 'kaza'.
// EVERY call folds its own variants: `p_folded` = foldTr(the text its variants spell). The 166
// over-stem guard reads `p_folded` only, so a call whose variants differ from its folded text
// searches stems the guard does not cover ('tarla' as variants with 'tarlada' folded stems to 'tar'
// and appended 6 rows with no 'tarl' word). The locative therefore goes to BOTH arguments, and only
// when there is no root sibling: the typed call already searched the typed stems, and on the sibling
// path a locative loses proper nouns ('boluda kazada' finds 0 where the sibling 'bolu kaza' finds 7).
// A row that ONLY the locative call found is kept only when its text holds the typed term as a word that is not
// 'term + n...' (h157-search-1): the stemmer cuts 'kazada' AND 'kazandı' to 'kaza', so '<il> kaza' used to append
// election and court rows of 'kazandı' ('tokat kaza' showed 5 such cards out of 6). The text is the embed's own
// title_tr_neutral, title_tr and summary_tr (what search_tsv holds), the RPC arguments do not change, and typed
// rows and the rows of the root-sibling call are never judged (turkish-query.ts, holdsLocativeWitness).
// An alias in the query (AKP <-> AK Parti, search-aliases.ts) is expanded into a
// two-way websearch `or` for BOTH arguments, so 'AKP' and 'AK Parti' send the
// same RPC call; the cache key below stays the canonical query.
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
  // h42-search-1: a query holding an alias is searched under both spellings. The
  // expansion is built from the canonical key, so the cost bound (6 terms, 64
  // characters, one alias, two disjuncts) holds, and a query without an alias
  // (the common case) takes exactly the arguments it always did.
  const expansion = expandAliasQuery(key);
  const base = expansion ? expansion.variantsQuery : key;
  const typed = turkishQueryVariants(base);
  if (typed.length === 0) return { bundles: [], capped: false };
  // h96-search-1: 'elektrik zammı' and 'emlak vergisi' are stored under the stems of
  // 'zam' and 'vergi', so a query holding a possessive or a doubled-stem form also asks
  // for the sibling (searchSiblingQuery). The sibling is a SECOND call, never merged into
  // the typed one: 172 ORs p_variants[1..3] with equal rank, and a merged call pushed
  // real typed hits off the page behind unrelated rows ('karasu' + 'kara'). Typed hits
  // keep their ranks and the sibling only fills empty slots of the page. A query without
  // such a form, or with websearch syntax, makes the one typed call it always made.
  // h124-postship-1: the sibling call folds the sibling (`p_folded` = foldTr(sibling)), so
  // its own 166 guard and 172 / 194 tiers read the sibling words. It used to send the typed
  // words, and the stem of an ASCII 'zammi' ('asgari ucret zammi') kept the guard and the
  // folded arm on a word no headline holds: 0 stories against 7 for 'asgari ucret zam'. The
  // sibling call only fills empty slots after the typed ids, so typed ranks never move.
  const sibling = searchSiblingQuery(base);
  // h144-search-1: with no root sibling, a bare vowel-final noun ('bolu kaza', 'tarla') still gets a
  // second call, for its locative ('boluda kazada', 'tarlada'), so the stem of the inflected headlines is
  // met. The locative is BOTH the variants and the folded text of that call: the 166 guard reads
  // `p_folded` only, so variants of another spelling ('tarla' stems to 'tar', 'tarlada' to 'tarla') would
  // run unguarded (6 of the 13 rows 'tarla' appended held no 'tarl' word). With a root sibling the locative
  // is not used at all: that call is HEAD's, the sibling folded as itself ('tarlası' -> 'tarla'). Alias and
  // operator queries give null for both helpers, so they make the one call they always made.
  // h157-search-1: `locTerms` are the folded typed terms that got a locative; the rows only that call finds are
  // checked against them below (empty on the sibling path, which is never filtered).
  const foldedParts = sibling === null ? searchFoldedSiblingParts(base) : null;
  const locTerms = foldedParts?.terms ?? [];
  const secondQuery = sibling ?? foldedParts?.query ?? null;
  const folded = foldTr(expansion ? expansion.foldedQuery : key);

  const supabase = createReaderClient();

  // One RPC call. PGRST202 = the 3-arg function is not in PostgREST's schema cache,
  // i.e. migration 129 is not applied yet. Only then fall back, once, to 083's 2-arg
  // function (same pattern as entity-hub-query.ts) and stay on it for the rest of this
  // search; any other error keeps the throw-and-retry path below.
  let threeArg = true;
  async function searchIds(variants: string[], foldedArg: string): Promise<string[]> {
    let res = threeArg
      ? await supabase.rpc("search_cluster_ids", {
          p_variants: variants,
          p_folded: foldedArg,
          p_limit: SEARCH_LIMIT,
        })
      : await supabase.rpc("search_cluster_ids", {
          p_variants: variants,
          p_limit: SEARCH_LIMIT,
        });
    if (threeArg && res.error?.code === "PGRST202") {
      threeArg = false;
      res = await supabase.rpc("search_cluster_ids", {
        p_variants: variants,
        p_limit: SEARCH_LIMIT,
      });
    }
    if (res.error) {
      throw new Error(`[clusters] search-query error: ${res.error.message}`);
    }
    return ((res.data ?? []) as SearchIdRow[]).map((r) => r.id);
  }

  const ids = await searchIds(typed, folded);
  // The typed page has room left: ask for the sibling (or the locative) and append what is new, after the
  // typed ids, up to SEARCH_LIMIT. A full typed page is never touched. Both arguments come from the same
  // text, so the call folds its own variants.
  // `locIds` = the ids that ONLY the locative call appended (h157-search-1). An id of the typed page is in `seen`
  // already, so it is never in `locIds`; the sibling path leaves it empty.
  const locIds = new Set<string>();
  // `secondMayHaveMore` = the second call can hold ids that never reached the page: it filled its own p_limit, or
  // it still had a NEW id left when the page was full. Only then may a dropped row not turn `capped` off.
  let secondMayHaveMore = false;
  if (secondQuery !== null && ids.length < SEARCH_LIMIT) {
    const seen = new Set(ids);
    const secondIds = await searchIds(turkishQueryVariants(secondQuery), foldTr(secondQuery));
    secondMayHaveMore = secondIds.length >= SEARCH_LIMIT;
    for (const id of secondIds) {
      if (seen.has(id)) continue;
      if (ids.length >= SEARCH_LIMIT) {
        secondMayHaveMore = true;
        break;
      }
      seen.add(id);
      ids.push(id);
      if (sibling === null) locIds.add(id);
    }
  }
  if (ids.length === 0) return { bundles: [], capped: false };

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
  const ranked = [...(embedRes.data ?? [])].sort(
    (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );

  // h157-search-1: a row that only the locative call found must hold every typed term that got a locative as a
  // word that is not 'term + n...' (kazada, kazayı, kazanın; not kazandı), in the text search_tsv is built from.
  // `capped` reads the page that remains, but only when the locative call was fully consumed: a dropped row turns
  // `capped` off only if the second call was neither a full page of its own nor left a new id unconsidered
  // (secondMayHaveMore false). Otherwise the list stays "capped" ("en ilgili N sonuc"), because the archive may
  // hold more rows and a plain "N sonuc" would claim a complete total. Dropped slots are not refilled.
  let dropped = 0;
  const rows =
    locIds.size === 0
      ? ranked
      : ranked.filter((row) => {
          if (!locIds.has(row.id)) return true;
          const text = foldTr(`${row.title_tr_neutral ?? ""} ${row.title_tr ?? ""} ${row.summary_tr ?? ""}`);
          if (locTerms.every((term) => holdsLocativeWitness(text, term))) return true;
          dropped++;
          return false;
        });
  const capped = ids.length >= SEARCH_LIMIT && (dropped === 0 || secondMayHaveMore);

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
