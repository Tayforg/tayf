import { entityHubRobots } from "@/lib/entities/entity-hub";
import {
  getEntityHubSummary,
  type EntityHubSummary,
} from "@/lib/entities/entity-hub-query";
import { RISING_ENTITIES } from "@/lib/trends/rising-entities";

import { renderUrlset, type SitemapUrlEntry } from "./sitemaps";

// /sitemaps/hubs.xml -- the /gundem/<key> entity hubs that are worth indexing.
//
// A hub is listed exactly when its own page leaves it indexable:
// entityHubRobots(result) === undefined (>= ENTITY_HUB_MIN_INDEXABLE bundles).
// The page's generateMetadata reads the full hub (getEntityHub); this builder
// reads its light twin, getEntityHubSummary (h94-slowroutes-1), because it needs
// only two figures of the 62 hubs: how many bundles the full page would list
// (`indexableCount`, equal to the full read's bundles.length) and the newest
// first_published among them (`newestFirstPublished`, the lastmod). The full read
// embeds up to 20 clusters of articles and sources per hub; 62 of them behind one
// sitemap request took 1.5-1.6 s on a miss (h94 measurement). The summary runs the same
// entity_cluster_ids_v3 RPC and one lean member-count read instead, so the urlset
// and every lastmod are the ones the full read gave (entity-hub-query.test.ts
// pins the parity on one fixture, this file's tests the bytes of the urlset). A
// sitemap must not submit a URL the page itself asks crawlers to skip.
//
// This module is deliberately PLAIN and UNCACHED. getEntityHubSummary is a
// resolveCachedOrRetry getter: on a failed cached attempt it awaits the request
// scope (connection()) and reads live, which throws inside a cached-function
// body and fails `next build` (tests/guards/cache-retry-prerender.test.ts). So
// this module carries no cache directive and no cacheLife. The load is carried
// by the 62 per-key cache entries behind getEntityHubSummary plus the route's CDN
// Cache-Control (s-maxage=3600), not by a cache of this module's own.
//
// getEntityHubSummary resolves to null on a failed read (it never throws).
// Treating null as "thin, skip it" would publish a short urlset for as long as
// the CDN holds it, silently de-indexing hubs. So ANY null makes the whole
// builder throw, and the route handler turns that into a 503 + Retry-After. The
// same rule as every other DB-backed sitemap builder in sitemaps.ts. The throw is
// immediate: the first batch with a null ends the build, so a request during a
// reader outage starts at most HUB_SITEMAP_CONCURRENCY live retries instead of
// one per key (hub-sitemap.test.ts pins the call counts). The chunked read
// itself is readAllEntityHubSummaries, which the /gundem index shares (it fails
// open to its static list on a null instead of throwing).

/** Hub reads in flight at once. 62 sequential reads would be slow on a cold
 *  cache; 62 at once would open a burst of RPCs against the reader. */
export const HUB_SITEMAP_CONCURRENCY = 8;

/**
 * Reads every curated hub's summary through getEntityHubSummary,
 * HUB_SITEMAP_CONCURRENCY at a time, and returns key -> read in RISING_ENTITIES
 * order. Shared by the hubs sitemap (below) and the /gundem index
 * (h43-entities-3); the policy for a failed read stays with the caller: the
 * sitemap throws, the index fails open to its static list.
 *
 * A null is a read that already failed twice (the cached attempt and a live
 * retry), so the answer is decided. This stops after the first batch that
 * holds one: starting the remaining batches would only send more live retries
 * at a reader that is struggling (the sitemap's 503 is no-store, so the CDN
 * does not absorb repeat hits). The returned map therefore holds the keys of
 * every batch that was started, the failed ones as null, and no later key. An
 * outage costs at most HUB_SITEMAP_CONCURRENCY retry chains per call, not
 * RISING_ENTITIES.length. A rejected read rejects the call.
 */
export async function readAllEntityHubSummaries(): Promise<
  Map<string, EntityHubSummary | null>
> {
  const hubs = new Map<string, EntityHubSummary | null>();

  for (let i = 0; i < RISING_ENTITIES.length; i += HUB_SITEMAP_CONCURRENCY) {
    const chunk = RISING_ENTITIES.slice(i, i + HUB_SITEMAP_CONCURRENCY);
    const settled = await Promise.all(chunk.map((e) => getEntityHubSummary(e.key)));
    chunk.forEach((e, j) => hubs.set(e.key, settled[j] ?? null));
    if (settled.some((r) => r === null)) break;
  }

  return hubs;
}

/**
 * The page's own robots predicate over the summary: entityHubRobots reads only
 * `bundles.length`, and `indexableCount` is that length of the full read, so the
 * sitemap and /gundem/<key> share one rule and one threshold
 * (ENTITY_HUB_MIN_INDEXABLE) and cannot drift. At most ENTITY_HUB_LIMIT (20)
 * slots, so the stand-in array is tiny.
 */
function isIndexable(summary: EntityHubSummary): boolean {
  return (
    entityHubRobots({ bundles: Array.from({ length: summary.indexableCount }) }) ===
    undefined
  );
}

export async function getHubsSitemapXml(baseUrl: string): Promise<string> {
  const hubs = await readAllEntityHubSummaries();

  // A null (or a key the reader never got to) means a read that failed: throw
  // for the first batch that holds one, never publish a partial urlset.
  for (let i = 0; i < RISING_ENTITIES.length; i += HUB_SITEMAP_CONCURRENCY) {
    const chunk = RISING_ENTITIES.slice(i, i + HUB_SITEMAP_CONCURRENCY);
    const failed = chunk.filter((e) => (hubs.get(e.key) ?? null) === null).length;
    if (failed > 0) {
      throw new Error(
        `hubs sitemap: hub read failed (${failed} of ${chunk.length} in the batch at ${i})`,
      );
    }
  }

  const entries: SitemapUrlEntry[] = [];
  RISING_ENTITIES.forEach((entity) => {
    const summary = hubs.get(entity.key);
    if (summary === undefined || summary === null) return;
    if (!isIndexable(summary)) return;

    const lastmod = summary.newestFirstPublished;
    entries.push({
      loc: `${baseUrl}/gundem/${entity.key}`,
      ...(lastmod !== null ? { lastmod } : {}),
    });
  });

  return renderUrlset(entries);
}
