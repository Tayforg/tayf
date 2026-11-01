import { entityHubRobots } from "@/lib/entities/entity-hub";
import { getEntityHub } from "@/lib/entities/entity-hub-query";
import { RISING_ENTITIES } from "@/lib/trends/rising-entities";

import { renderUrlset, type SitemapUrlEntry } from "./sitemaps";

// /sitemaps/hubs.xml -- the /gundem/<key> entity hubs that are worth indexing.
//
// A hub is listed exactly when its own page leaves it indexable:
// entityHubRobots(result) === undefined (>= ENTITY_HUB_MIN_INDEXABLE bundles).
// The page's generateMetadata and this builder read the same getEntityHub(key),
// so they share one cache entry per key and cannot disagree. A sitemap must not
// submit a URL the page itself asks crawlers to skip.
//
// This module is deliberately PLAIN and UNCACHED. getEntityHub is a
// resolveCachedOrRetry getter: on a failed cached attempt it awaits the request
// scope (connection()) and reads live, which throws inside a cached-function
// body and fails `next build` (tests/guards/cache-retry-prerender.test.ts). So
// this module carries no cache directive and no cacheLife. The load is carried
// by the 62 per-key cache entries behind getEntityHub plus the route's CDN
// Cache-Control (s-maxage=3600), not by a cache of this module's own.
//
// getEntityHub resolves to null on a failed read (it never throws). Treating
// null as "thin, skip it" would publish a short urlset for as long as the CDN
// holds it, silently de-indexing hubs. So ANY null makes the whole builder
// throw, and the route handler turns that into a 503 + Retry-After. The same
// rule as every other DB-backed sitemap builder in sitemaps.ts. The throw is
// immediate: the first batch with a null ends the build, so a request during a
// reader outage starts at most HUB_SITEMAP_CONCURRENCY live retries instead of
// one per key (hub-sitemap.test.ts pins the call counts).

/** Hub reads in flight at once. 62 sequential reads would be slow on a cold
 *  cache; 62 at once would open a burst of RPCs against the reader. */
export const HUB_SITEMAP_CONCURRENCY = 8;

/** The newest first_published among the bundles, compared by Date.parse and
 *  returned as the original string; null when none parses. */
function newestFirstPublished(
  bundles: ReadonlyArray<{ cluster: { first_published?: unknown } }>,
): string | null {
  let best: { ms: number; raw: string } | null = null;
  for (const b of bundles) {
    const raw = b.cluster.first_published;
    if (typeof raw !== "string") continue;
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) continue;
    if (best === null || ms > best.ms) best = { ms, raw };
  }
  return best === null ? null : best.raw;
}

export async function getHubsSitemapXml(baseUrl: string): Promise<string> {
  const results: Array<Awaited<ReturnType<typeof getEntityHub>>> = [];

  for (let i = 0; i < RISING_ENTITIES.length; i += HUB_SITEMAP_CONCURRENCY) {
    const chunk = RISING_ENTITIES.slice(i, i + HUB_SITEMAP_CONCURRENCY);
    const settled = await Promise.all(chunk.map((e) => getEntityHub(e.key)));

    // Fail fast: a null is a read that already failed twice (the cached attempt
    // and a live retry), so the answer is decided. Starting the remaining
    // batches would only send more live retries at a reader that is struggling
    // (the 503 is no-store, so the CDN does not absorb repeat hits). The first
    // batch with a failure is the last batch started: an outage costs at most
    // HUB_SITEMAP_CONCURRENCY retry chains per request, not RISING_ENTITIES.length.
    const failed = settled.filter((r) => r === null).length;
    if (failed > 0) {
      throw new Error(
        `hubs sitemap: hub read failed (${failed} of ${chunk.length} in the batch at ${i})`,
      );
    }
    results.push(...settled);
  }

  const entries: SitemapUrlEntry[] = [];
  RISING_ENTITIES.forEach((entity, i) => {
    const result = results[i];
    if (result === undefined || result === null) return;
    if (entityHubRobots(result) !== undefined) return;

    const lastmod = newestFirstPublished(result.bundles);
    entries.push({
      loc: `${baseUrl}/gundem/${entity.key}`,
      ...(lastmod !== null ? { lastmod } : {}),
    });
  });

  return renderUrlset(entries);
}
