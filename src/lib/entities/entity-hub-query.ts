import type { SupabaseClient } from "@supabase/supabase-js";
import { cacheLife, cacheTag } from "next/cache";

import { attemptCached, resolveCachedOrRetry } from "@/lib/cache-resilience";
import { getZoneFeedHealth } from "@/lib/clusters/feed-health";
import {
  buildClusterBundle,
  CLUSTER_EMBED_SELECT,
  flattenClusterMembers,
  type ClusterBundle,
  type EmbeddedClusterRow,
} from "@/lib/clusters/politics-query";
import { turkishQueryVariants } from "@/lib/clusters/turkish-query";
import { createReaderClient } from "@/lib/supabase/server";
import { currentTimeMs } from "@/lib/time";
import type { RisingEntity } from "@/lib/trends/rising-entities";
import {
  ENTITY_HUB_LIMIT,
  entityByKey,
  entityHubHeadlineOnly,
  entityHubPatterns,
  entityHubQueries,
} from "./entity-hub";

// /gundem/[key] entity hub data. Mirrors src/lib/clusters/search-query.ts: the
// entity's curated spellings are resolved to ids by migration 170's
// `entity_cluster_ids_v3` RPC (125's v2 plus a headline-only switch), then ONE
// `.in('id', ids)` embed select renders just those ids (see 083's header for
// why ids-first beats an embedded select).
//
// Precision: a stemmed tsquery alone lists "devam" under DEVA and "domuz" under
// Dolar (the Turkish stemmer collapses them), so v2 and v3 take two inputs.
// `p_queries` (entityHubQueries) are the Turkish lexeme spellings of EVERY
// curated form ("AK Parti" and "AKP", four spellings of Zelenski) and give
// recall on the GIN index; `p_patterns` (entityHubPatterns) are word-boundary
// regexes the RPC runs on folded title and summary text, so only stories that
// literally name the entity stay. Both lists are built from rising-entities.ts,
// never from request input.
//
// `p_headline_only` (migration 170, h56-entities-2) is the hub spec's
// `headlineOnly`: true for akp alone, false for every other hub. True makes the
// RPC run the regex on title_tr and title_tr_neutral only, ignoring the first
// line of the summary, where akp's matches are mostly an epithet ("eski AK Parti
// milletvekili ...") and not the party. The flag is a function of the hub key, and
// it is also part of both cache keys: the `"use cache"` argument list and the
// single-flight / last-good key of the resolver.
//
// Fallback chain, on PGRST202 only ("function not in the schema cache"): v3
// (170) -> v2 (125/156, the same call without the flag, so akp's lead counts
// again) -> migration 123's v1 `entity_cluster_ids` (label variants, stemmed
// only). Deploying the app before a migration cannot break a hub, it just keeps
// the older list. Any other error keeps the throw-and-retry path.
//
// Unlike the archive search this is a RECENCY list: the RPC windows on
// updated_at (SQL default 14 days, never wider than 30) and orders by
// first_published, newest first, because the cards print the first_published
// age: ordering by updated_at made those ages read 9, 3, 4, 4, 11 hours. It
// returns the full match count next to every id, so the page can say
// "Son 14 günde 422 küme · en yeni 20 tanesi listeleniyor".
//
// The app never passes `p_since`: the window lives in SQL, so no clock is read
// here and the page prerenders under cacheComponents.
//
// The route key reaches this module only after `entityByKey` accepts it, so
// the text that goes into the RPC is always one of the curated labels or
// aliases in rising-entities.ts, never request-controlled.
//
// Two readers share the id step (`readEntityIds`: the RPC, its PGRST202 fallbacks
// and the total):
//   * getEntityHub: the full hub of /gundem/[key], ids, then the embed.
//   * getEntityHubSummary (h94-slowroutes-1): what the /gundem index and
//     /sitemaps/hubs.xml need, and nothing more. The index prints only `total`;
//     the sitemap needs only whether the full page would be indexable
//     (entityHubRobots over the bundles) and the newest first_published. Both
//     used to build all 62 full hubs. The summary replaces the embed by ONE lean
//     `clusters(id, first_published, cluster_articles!inner(article_id))` read of
//     the same ids, so it reads no articles, no sources and no feed health.

export interface EntityHub {
  bundles: ClusterBundle[];
  /** Full match count in the window (>= bundles.length). */
  total: number;
  /**
   * When this result was read (epoch ms). Stamped inside fetchEntityHub, which
   * only ever runs inside the "use cache" scope or after the request scope on
   * the live retry, so the clock read is allowed in both. The page renders
   * relative times against it instead of reading the clock itself: /gundem/[key]
   * is fully static (generateStaticParams, no searchParams), and a Date.now()
   * in its render body fails `next build` once the cached read succeeds.
   */
  asOfMs: number;
}

interface EntityIdRow {
  id: string;
  // bigint: PostgREST returns a number, but a driver may hand back a string.
  total: number | string | null;
}

/**
 * The light read of one hub (h94-slowroutes-1): the figures the /gundem index
 * and the hubs sitemap take from a full {@link EntityHub}, and nothing else.
 */
export interface EntityHubSummary {
  /** Same as EntityHub.total: the full match count in the window. */
  total: number;
  /**
   * Listed clusters that have at least one member article: equals
   * `getEntityHub(key).bundles.length` (a bundle exists exactly for those), so
   * `entityHubRobots({ bundles: <that many> })` answers as the full page does.
   */
  indexableCount: number;
  /**
   * The newest `first_published` among those clusters, compared by Date.parse and
   * returned as the original string; null when none parses. The sitemap's
   * lastmod.
   */
  newestFirstPublished: string | null;
  /** When this result was read (epoch ms); see EntityHub.asOfMs. */
  asOfMs: number;
}

/** The lean read of {@link EntityHubSummary}: no CLUSTER_EMBED_SELECT. `!inner`
 *  keeps only clusters with a member row, which is what a bundle needs. */
export const ENTITY_HUB_SUMMARY_SELECT =
  "id, first_published, cluster_articles!inner(article_id)";

interface EntitySummaryRow {
  id: string;
  first_published?: unknown;
  cluster_articles?: unknown[] | null;
}

interface EntityIdRead {
  ids: string[];
  /** Full match count, never below ids.length; 0 when there are no ids. */
  total: number;
}

// The id step both readers share, so the RPC arguments, the PGRST202 fallbacks
// and the total can never drift between the full hub and its summary. THROWS on a
// Supabase error.
async function readEntityIds(
  supabase: SupabaseClient,
  entity: RisingEntity,
  queries: string[],
  patterns: string[],
  headlineOnly: boolean,
): Promise<EntityIdRead> {
  let res = await supabase.rpc("entity_cluster_ids_v3", {
    p_queries: queries,
    p_patterns: patterns,
    p_limit: ENTITY_HUB_LIMIT,
    p_headline_only: headlineOnly,
  });
  // PGRST202 = the function is not in PostgREST's schema cache, i.e. migration
  // 170 is not applied yet. Retry v2 with its old four arguments (the summary
  // lead counts again for akp); any other error keeps the throw-and-retry path
  // below.
  if (res.error?.code === "PGRST202") {
    res = await supabase.rpc("entity_cluster_ids_v2", {
      p_queries: queries,
      p_patterns: patterns,
      p_limit: ENTITY_HUB_LIMIT,
    });
  }
  // PGRST202 again = migration 125 is not applied either. Only then fall back
  // to v1 (label variants, no precision guard).
  if (res.error?.code === "PGRST202") {
    const variants = turkishQueryVariants(entity.label);
    res = await supabase.rpc("entity_cluster_ids", {
      p_variants: variants,
      p_limit: ENTITY_HUB_LIMIT,
    });
  }
  const { data, error } = res;

  if (error) {
    throw new Error(`[clusters] entity-hub error: ${error.message}`);
  }

  const rows = (data ?? []) as EntityIdRow[];
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { ids, total: 0 };

  // `count(*) over ()` repeats the full match count on every row, so the first
  // row's value is the total. A missing / non-numeric / impossibly small value
  // (below the number of rows actually returned) falls back to the row count so
  // the note can never read "0 küme" above a list of cards.
  const reported = Number(rows[0]?.total);
  const total =
    Number.isFinite(reported) && reported >= ids.length ? reported : ids.length;
  return { ids, total };
}

// Internal, UNCACHED implementation. THROWS on a Supabase error/exception —
// mirroring search-query.ts's fetch/cache split. Kept free of the "use cache"
// directive so it can run twice: once (wrapped by `attemptCached`) inside the
// cache boundary below, and once more, live, as `getEntityHub`'s retry.
async function fetchEntityHub(key: string, headlineOnly: boolean): Promise<EntityHub> {
  const asOfMs = currentTimeMs();
  const entity = entityByKey(key);
  if (entity === null) return { bundles: [], total: 0, asOfMs };

  const queries = entityHubQueries(entity);
  const patterns = entityHubPatterns(entity);
  if (queries.length === 0 || patterns.length === 0) {
    return { bundles: [], total: 0, asOfMs };
  }

  const supabase = createReaderClient();
  const { ids, total } = await readEntityIds(supabase, entity, queries, patterns, headlineOnly);
  if (ids.length === 0) return { bundles: [], total: 0, asOfMs };

  // Same feed-health gate as the home feed and the search results, fetched
  // once per hub and in parallel with the embed read: neither depends on the
  // other.
  const [health, embedRes] = await Promise.all([
    getZoneFeedHealth(),
    supabase
      .from("clusters")
      .select(CLUSTER_EMBED_SELECT)
      .in("id", ids)
      .returns<EmbeddedClusterRow[]>(),
  ]);

  if (embedRes.error) {
    throw new Error(`[clusters] entity-hub error: ${embedRes.error.message}`);
  }

  // `.in('id', ids)` does not preserve the IN-list order — re-sort into the
  // RPC's order (first_published desc on v2) before building bundles.
  const order = new Map(ids.map((id, i) => [id, i]));
  const sorted = [...(embedRes.data ?? [])].sort(
    (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );

  const bundles: ClusterBundle[] = [];
  for (const row of sorted) {
    const members = flattenClusterMembers(row);
    if (members.length === 0) continue;
    bundles.push(buildClusterBundle(row, members, health, asOfMs).bundle);
  }
  return { bundles, total, asOfMs };
}

// Build-safety: `attemptCached` swallows whatever `fetchEntityHub` throws
// instead of letting it cross the `"use cache"` boundary (a throw inside fails
// `next build`'s prerender even when every caller catches; see
// src/lib/cache-resilience.ts).
//
// Plain `"use cache"` (not remote): 62 keys, each tiny; an in-memory
// per-instance entry is the right fit, same call as search-query.ts. The
// headline-only flag is an argument, so it is part of the cache key.
//
// Cache lifetime follows the outcome: a read keeps the `cluster-feed` window,
// a failed attempt ({ ok: false }) is memoised for `minutes` only. Exactly one
// `cacheLife` call per invocation, after the attempt, with one literal per call
// (tests/guards/cache-life-literal.test.ts); `cacheTag` stays first.
//
// The one piece of logic after that: the `at` stamp on a successful read (the
// epoch ms of the database read, which fetchEntityHub already took), so a cache
// HIT can be remembered as a last-good value without reading the clock on the
// hit path (cache-resilience.ts, section 4). A failed attempt carries no stamp.
async function cachedEntityHub(key: string, headlineOnly: boolean) {
  "use cache";
  cacheTag("clusters-entity");
  const r = await attemptCached("clusters-entity", () => fetchEntityHub(key, headlineOnly));
  if (r.ok) cacheLife("cluster-feed");
  else cacheLife("minutes");
  return r.ok ? { ...r, at: r.data.asOfMs } : r;
}

/**
 * Public entry point for the hub page AND its generateMetadata (both call it
 * with the same key, so they share one cache entry). An unknown key resolves
 * to null without touching Supabase or the cache. On a cache-attempt failure
 * it retries live once (bypassing the cache boundary, never memoising a
 * failure) and, if that fails too, logs and serves the last good read of that
 * hub this instance saw (under 60 min old) before resolving to null — the
 * page's honest "unavailable" state. Concurrent live retries for one hub share
 * one read and a failed one backs off for a few seconds (key
 * `clusters-entity:<key>:<headline|lead>`: one of the 62 curated hub keys plus
 * its headline-only flag, so the key space is bounded). That matters because /trends reads up
 * to 8 hubs per request (the /gundem index and the hubs sitemap read the lighter
 * getEntityHubSummary below), and without it every visitor would start its own
 * retries against a struggling reader. Never throws.
 */
export async function getEntityHub(key: string): Promise<EntityHub | null> {
  const entity = entityByKey(key);
  if (entity === null) return null;

  // The hub's headline-only flag, read once and carried into every cache key.
  const headlineOnly = entityHubHeadlineOnly(entity);
  return resolveCachedOrRetry<EntityHub | null>(
    {
      label: "clusters-entity",
      key: `clusters-entity:${key}:${headlineOnly ? "headline" : "lead"}`,
    },
    () => cachedEntityHub(key, headlineOnly),
    () => fetchEntityHub(key, headlineOnly),
    null,
  );
}

// ---------------------------------------------------------------------------
// The summary reader (h94-slowroutes-1), same layering as the full hub above:
// an uncached THROWING fetch, a "use cache" attempt, and a never-throwing getter
// whose live retry runs outside any cache body.
// ---------------------------------------------------------------------------

// Internal, UNCACHED implementation; THROWS on a Supabase error/exception, like
// fetchEntityHub. The embed is replaced by one lean read of the same ids; the
// feed-health read is not made (a summary carries no blindspot badge).
async function fetchEntityHubSummary(
  key: string,
  headlineOnly: boolean,
): Promise<EntityHubSummary> {
  const asOfMs = currentTimeMs();
  const empty: EntityHubSummary = {
    total: 0,
    indexableCount: 0,
    newestFirstPublished: null,
    asOfMs,
  };
  const entity = entityByKey(key);
  if (entity === null) return empty;

  const queries = entityHubQueries(entity);
  const patterns = entityHubPatterns(entity);
  if (queries.length === 0 || patterns.length === 0) return empty;

  const supabase = createReaderClient();
  const { ids, total } = await readEntityIds(supabase, entity, queries, patterns, headlineOnly);
  if (ids.length === 0) return empty;

  const { data, error } = await supabase
    .from("clusters")
    .select(ENTITY_HUB_SUMMARY_SELECT)
    .in("id", ids)
    .returns<EntitySummaryRow[]>();

  if (error) {
    throw new Error(`[clusters] entity-hub summary error: ${error.message}`);
  }

  // A cluster counts when it has at least one member row: exactly the clusters
  // the full read turns into a bundle (flattenClusterMembers drops only a null
  // article join, which the cluster_articles.article_id foreign key rules out).
  // `!inner` already filters, the length check keeps the rule in code too.
  let indexableCount = 0;
  let newest: { ms: number; raw: string } | null = null;
  for (const row of data ?? []) {
    if (!Array.isArray(row.cluster_articles) || row.cluster_articles.length === 0) continue;
    indexableCount += 1;

    const raw = row.first_published;
    if (typeof raw !== "string") continue;
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) continue;
    if (newest === null || ms > newest.ms) newest = { ms, raw };
  }

  return {
    total,
    indexableCount,
    newestFirstPublished: newest === null ? null : newest.raw,
    asOfMs,
  };
}

// Same build-safety and lifetime rules as cachedEntityHub: plain `"use cache"`
// (never remote: 62 tiny keys, an in-memory per-instance entry fits, and a remote
// write of this read was rejected, h83-rejected-1), `attemptCached` so a throw
// never crosses the cache boundary, `cacheTag("clusters-entity")` first (the
// membership mutations that revalidate the full hub revalidate this too), and
// exactly one literal `cacheLife` per invocation AFTER the attempt
// (tests/guards/cache-life-literal.test.ts, cache-life-after-attempt.test.ts).
// The `at` stamp makes a cache HIT eligible as a last-good value without a clock
// read on the hit path.
async function cachedEntityHubSummary(key: string, headlineOnly: boolean) {
  "use cache";
  cacheTag("clusters-entity");
  const r = await attemptCached("clusters-entity-summary", () =>
    fetchEntityHubSummary(key, headlineOnly),
  );
  if (r.ok) cacheLife("cluster-feed");
  else cacheLife("minutes");
  return r.ok ? { ...r, at: r.data.asOfMs } : r;
}

/**
 * The light read of one hub for the /gundem index and /sitemaps/hubs.xml. Same
 * contract as {@link getEntityHub}: an unknown key resolves to null without
 * touching Supabase or the cache; a failed cached attempt retries live once
 * (single-flight per key), then serves the last good summary (under 60 min old),
 * then resolves to null. Never throws. The key space is its own
 * (`clusters-entity-summary:<key>:<headline|lead>`), so a summary and a full hub
 * never serve each other's last-good value.
 */
export async function getEntityHubSummary(key: string): Promise<EntityHubSummary | null> {
  const entity = entityByKey(key);
  if (entity === null) return null;

  const headlineOnly = entityHubHeadlineOnly(entity);
  return resolveCachedOrRetry<EntityHubSummary | null>(
    {
      label: "clusters-entity-summary",
      key: `clusters-entity-summary:${key}:${headlineOnly ? "headline" : "lead"}`,
    },
    () => cachedEntityHubSummary(key, headlineOnly),
    () => fetchEntityHubSummary(key, headlineOnly),
    null,
  );
}
