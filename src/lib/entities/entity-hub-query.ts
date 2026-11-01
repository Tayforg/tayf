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
import { ENTITY_HUB_LIMIT, entityByKey } from "./entity-hub";

// /gundem/[key] entity hub data. Mirrors src/lib/clusters/search-query.ts: the
// entity's label is turned into up to 3 Turkish lexeme spellings
// (turkishQueryVariants) and resolved to ids by migration 123's
// `entity_cluster_ids` RPC, then ONE `.in('id', ids)` embed select renders just
// those ids (see 083's header for why ids-first beats an embedded select).
//
// Unlike the archive search this is a RECENCY list: the RPC windows on
// updated_at (SQL default 14 days, never wider than 30), orders newest first
// and returns the full match count next to every id, so the page can say
// "Son 14 günde 422 küme · en yeni 20 tanesi listeleniyor".
//
// The app never passes `p_since`: the window lives in SQL, so no clock is read
// here and the page prerenders under cacheComponents.
//
// The route key reaches this module only after `entityByKey` accepts it, so
// the text that goes into the RPC is always one of the curated labels in
// rising-entities.ts, never request-controlled.

export interface EntityHub {
  bundles: ClusterBundle[];
  /** Full match count in the window (>= bundles.length). */
  total: number;
}

interface EntityIdRow {
  id: string;
  // bigint: PostgREST returns a number, but a driver may hand back a string.
  total: number | string | null;
}

// Internal, UNCACHED implementation. THROWS on a Supabase error/exception —
// mirroring search-query.ts's fetch/cache split. Kept free of the "use cache"
// directive so it can run twice: once (wrapped by `attemptCached`) inside the
// cache boundary below, and once more, live, as `getEntityHub`'s retry.
async function fetchEntityHub(key: string): Promise<EntityHub> {
  const entity = entityByKey(key);
  if (entity === null) return { bundles: [], total: 0 };

  const variants = turkishQueryVariants(entity.label);
  if (variants.length === 0) return { bundles: [], total: 0 };

  const supabase = createReaderClient();

  const { data, error } = await supabase.rpc("entity_cluster_ids", {
    p_variants: variants,
    p_limit: ENTITY_HUB_LIMIT,
  });

  if (error) {
    throw new Error(`[clusters] entity-hub error: ${error.message}`);
  }

  const rows = (data ?? []) as EntityIdRow[];
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { bundles: [], total: 0 };

  // `count(*) over ()` repeats the full match count on every row, so the first
  // row's value is the total. A missing / non-numeric / impossibly small value
  // (below the number of rows actually returned) falls back to the row count so
  // the note can never read "0 küme" above a list of cards.
  const reported = Number(rows[0]?.total);
  const total =
    Number.isFinite(reported) && reported >= ids.length ? reported : ids.length;

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
  // RPC's newest-first order before building bundles.
  const order = new Map(ids.map((id, i) => [id, i]));
  const sorted = [...(embedRes.data ?? [])].sort(
    (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );

  const bundles: ClusterBundle[] = [];
  for (const row of sorted) {
    const members = flattenClusterMembers(row);
    if (members.length === 0) continue;
    bundles.push(buildClusterBundle(row, members, health).bundle);
  }
  return { bundles, total };
}

// Build-safety: `attemptCached` swallows whatever `fetchEntityHub` throws
// instead of letting it cross the `"use cache"` boundary (a throw inside fails
// `next build`'s prerender even when every caller catches; see
// src/lib/cache-resilience.ts).
//
// Plain `"use cache"` (not remote): 62 keys, each tiny; an in-memory
// per-instance entry is the right fit, same call as search-query.ts.
//
// Cache lifetime follows the outcome: a read keeps the `cluster-feed` window,
// a failed attempt ({ ok: false }) is memoised for `minutes` only. Exactly one
// `cacheLife` call per invocation, after the attempt, with one literal per call
// (tests/guards/cache-life-literal.test.ts); `cacheTag` stays first.
async function cachedEntityHub(key: string) {
  "use cache";
  cacheTag("clusters-entity");
  const r = await attemptCached("clusters-entity", () => fetchEntityHub(key));
  if (r.ok) cacheLife("cluster-feed");
  else cacheLife("minutes");
  return r;
}

/**
 * Public entry point for the hub page AND its generateMetadata (both call it
 * with the same key, so they share one cache entry). An unknown key resolves
 * to null without touching Supabase or the cache. On a cache-attempt failure
 * it retries live once (bypassing the cache boundary, never memoising a
 * failure) and, if that fails too, logs and resolves to null — the page's
 * honest "unavailable" state. Never throws.
 */
export async function getEntityHub(key: string): Promise<EntityHub | null> {
  if (entityByKey(key) === null) return null;

  return resolveCachedOrRetry<EntityHub | null>(
    "clusters-entity",
    () => cachedEntityHub(key),
    () => fetchEntityHub(key),
    null,
  );
}
