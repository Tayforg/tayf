import { cacheLife, cacheTag } from "next/cache";

import { attemptCached } from "@/lib/cache-resilience";
import { createReaderClient } from "@/lib/supabase/server";

import {
  entityByKey,
  entityHubHeadlineOnly,
  entityHubPatterns,
  entityHubQueries,
} from "./entity-hub";
import { parseHubTrendRows, type HubTrend } from "./hub-trend";

// Reader of the daily chart on /gundem/[key] (h154-hub-trend): ONE call of migration 206's `entity_cluster_days` with the
// hub's own arrays (entityHubQueries and entityHubPatterns of a curated entity, never request input) and its headline-only
// flag, the same three inputs the hub's id read passes to entity_cluster_ids_v3 / v4. The RPC counts the hub's matched
// clusters per Istanbul day of first_published, so the bars and the hub's "Son 14 günde N küme" line count the same thing.
// The window lives in SQL, so no clock is read here and the page stays prerenderable under cacheComponents.
//
// Same layering as src/lib/trends/rising-query.ts, and no live retry (a retry would put a request-scope wait next to a
// cached body, and the chart is optional):
//   * fetchHubTrend is uncached and THROWS on a failure;
//   * cachedHubTrend runs it inside attemptCached, because a throw crossing the cache boundary fails `next build`'s
//     prerender, and chooses its lifetime AFTER the outcome with one literal cacheLife per invocation
//     (tests/guards/cache-life-literal.test.ts, cache-life-after-attempt.test.ts): "cluster-feed" for a drawn trend,
//     "minutes" for a failure or an unavailable function, so a blip or an unapplied migration heals within minutes;
//   * getHubTrend never throws: a failure is null, an unapplied migration is { status: "unavailable" }, and the page draws
//     no chart for either.
//
// PGRST202 (the function is not in PostgREST's schema cache, i.e. migration 206 is not applied yet) is "chart
// unavailable", not an error: deploying the app before the migration costs only the chart.
//
// `createReaderClient()` is the 4 s fail-fast client (tests/guards/public-reader-cap.test.ts pins it for this file).

async function fetchHubTrend(key: string, headlineOnly: boolean): Promise<HubTrend> {
  const entity = entityByKey(key);
  if (entity === null) throw new Error("[hub-trend] error: unknown hub key");
  const queries = entityHubQueries(entity);
  const patterns = entityHubPatterns(entity);
  if (queries.length === 0 || patterns.length === 0) {
    throw new Error("[hub-trend] error: the hub has no search terms");
  }

  const supabase = createReaderClient();
  const { data, error } = await supabase.rpc("entity_cluster_days", {
    p_queries: queries,
    p_patterns: patterns,
    p_headline_only: headlineOnly,
  });

  if (error?.code === "PGRST202") return { status: "unavailable" };
  if (error) throw new Error(`[hub-trend] error: ${error.message}`);

  const parsed = parseHubTrendRows(data);
  if (parsed === null) throw new Error("[hub-trend] error: unexpected rows");
  return { status: "ok", ...parsed };
}

// The plain cache directive (not remote): at most 62 keys, each a few hundred bytes. The tag is the hub's own, so the membership
// mutations that revalidate a hub revalidate its chart too.
async function cachedHubTrend(key: string, headlineOnly: boolean) {
  "use cache";
  cacheTag("clusters-entity");
  const r = await attemptCached("hub-trend", () => fetchHubTrend(key, headlineOnly));
  if (r.ok && r.data.status === "ok") cacheLife("cluster-feed");
  else cacheLife("minutes");
  return r;
}

/**
 * The daily trend of one hub, or `null` when it could not be read; `{ status: "unavailable" }` while migration 206 is not
 * applied. An unknown key resolves to null without creating a client or touching the cache. Never throws.
 */
export async function getHubTrend(key: string): Promise<HubTrend | null> {
  const entity = entityByKey(key);
  if (entity === null) return null;

  const r = await cachedHubTrend(key, entityHubHeadlineOnly(entity));
  return r.ok ? r.data : null;
}
