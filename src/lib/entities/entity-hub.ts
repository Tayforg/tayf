import { BIAS_ORDER } from "@/lib/bias/config";
import { RISING_ENTITIES, type RisingEntity } from "@/lib/trends/rising-entities";
import type { BiasDistribution } from "@/types";

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

function addBucket(
  total: BiasDistribution,
  distribution: unknown,
): void {
  if (
    distribution === null ||
    typeof distribution !== "object" ||
    Array.isArray(distribution)
  ) {
    return;
  }
  for (const key of BIAS_ORDER) {
    if (!Object.prototype.hasOwnProperty.call(distribution, key)) continue;
    const n = (distribution as Record<string, unknown>)[key];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) total[key] += n;
  }
}

/**
 * Sum the per-cluster `bias_distribution` jsonb of the listed bundles into one
 * spectrum. Every BIAS_ORDER key is present (0 when nothing contributes); only
 * finite numbers >= 0 are added, and anything else (null, arrays, strings,
 * unknown keys, a malformed bundle) is ignored rather than thrown on.
 */
export function sumDistributions(
  bundles: ReadonlyArray<{ cluster: { bias_distribution: unknown } }>,
): BiasDistribution {
  const total = Object.fromEntries(
    BIAS_ORDER.map((key) => [key, 0]),
  ) as BiasDistribution;
  for (const bundle of bundles) {
    addBucket(total, bundle?.cluster?.bias_distribution);
  }
  return total;
}

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
