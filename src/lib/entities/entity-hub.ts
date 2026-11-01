import { RISING_ENTITIES, type RisingEntity } from "@/lib/trends/rising-entities";

// Pure helpers behind the /gundem/[key] entity hubs. No I/O, no clock and no
// Next import, so the page, its metadata and the tests share one definition
// and the middleware-facing vocabulary (rising-entities.ts) stays the only
// source of truth for which hubs exist.

/** Days of coverage a hub shows. Mirrors the SQL default in migration 123. */
export const ENTITY_HUB_WINDOW_DAYS = 14;
/** Clusters listed per hub (the RPC clamps p_limit to 1..50). */
export const ENTITY_HUB_LIMIT = 20;
/** A hub with fewer clusters than this is thin and stays out of the index. */
export const ENTITY_HUB_MIN_INDEXABLE = 3;

// A Map, not an object lookup: "__proto__", "constructor" and friends must
// never resolve to something.
const ENTITY_BY_KEY: ReadonlyMap<string, RisingEntity> = new Map(
  RISING_ENTITIES.map((e) => [e.key, e]),
);

/** The curated entity for a route key, or null when the key is unknown. */
export function entityByKey(key: string): RisingEntity | null {
  return typeof key === "string" ? (ENTITY_BY_KEY.get(key) ?? null) : null;
}

export function isEntityKey(key: string): boolean {
  return typeof key === "string" && ENTITY_BY_KEY.has(key);
}

// Moved to @/lib/bias/sum-distributions (shared with /konu/[slug]); re-exported
// so the /gundem/[key] page and its tests keep importing it from here.
export { sumDistributions } from "@/lib/bias/sum-distributions";

/**
 * Robots override for a hub: noindex (but follow) when the read failed or the
 * hub is thin; undefined (inherit the site default, indexable) otherwise.
 */
export function entityHubRobots(
  result: { bundles: readonly unknown[] } | null,
): { index: false; follow: true } | undefined {
  if (result === null || result.bundles.length < ENTITY_HUB_MIN_INDEXABLE) {
    return { index: false, follow: true };
  }
  return undefined;
}

/** "Son 14 günde 422 küme · en yeni 20 tanesi listeleniyor". */
export function entityHubNote(total: number, shown: number): string {
  const base = `Son ${ENTITY_HUB_WINDOW_DAYS} günde ${total} küme`;
  return total > shown ? `${base} · en yeni ${shown} tanesi listeleniyor` : base;
}
