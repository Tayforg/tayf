import { getEntityHub } from "@/lib/entities/entity-hub-query";
import { MAX_ITEMS, withHubLinks, type RisingResult } from "@/lib/trends/rising";

// Settles the href of each rising row against its /gundem hub (h43-entities-3). Moved out of
// src/app/trends/page.tsx unchanged (h170-roadmap-3) so /trends and the home "Yükselen konular"
// rail link a row the same way: the hub when it is indexable, the home search otherwise.
//
// The hubs are read HERE, at page level and after getRisingEntities resolved, for at most MAX_ITEMS
// rows, and never inside a cache function: getEntityHub is a resolveCachedOrRetry getter, and its
// live retry awaits connection(), which throws inside a cache body and fails `next build`
// (tests/guards/cache-retry-prerender.test.ts). Each read is one of the 62 per-key cache entries
// /gundem/[key] and the hubs sitemap already share, so a warm page costs no extra query. A rejected
// hub read rejects this call: the caller decides what that means (/trends lets its error boundary
// have it, the home rail renders nothing).

/**
 * The rising result with each row's href settled against its hub. A result
 * without rows (failed read, thin history, nothing rising) is returned as is
 * and reads no hub. Rows past MAX_ITEMS are dropped (computeRising never
 * returns more) so the reads stay bounded.
 */
export async function linkRisingHubs(rising: RisingResult | null): Promise<RisingResult | null> {
  if (rising === null || rising.status !== "ok" || rising.items.length === 0) {
    return rising;
  }
  const items = rising.items.slice(0, MAX_ITEMS);
  const reads = await Promise.all(items.map((item) => getEntityHub(item.key)));
  const hubs = new Map(items.map((item, i) => [item.key, reads[i] ?? null] as const));
  return { ...rising, items: withHubLinks(items, hubs) };
}
