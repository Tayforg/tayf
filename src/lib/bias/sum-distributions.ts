import { BIAS_ORDER } from "@/lib/bias/config";
import type { BiasDistribution } from "@/types";

// Pure aggregation behind the /gundem/[key] and /konu/[slug] source-mix bars.
// No I/O and no clock, so the pages and the tests share one definition.
//
// VOTING-ONLY by construction: `clusters.bias_distribution` is written by
// cluster-consumer from VOTING_SOURCE_KINDS (outlet, wire) only, so summing it
// already follows the zone-line rule. Do NOT add a source-kind filter here.

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
 * Total count across the BIAS_ORDER keys (finite values >= 0 only). Zero means
 * there is nothing to draw, so callers show an honest empty state instead of a
 * bar of nothing.
 */
export function distributionTotal(d: BiasDistribution): number {
  let sum = 0;
  for (const key of BIAS_ORDER) {
    const n = d[key];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) sum += n;
  }
  return sum;
}
