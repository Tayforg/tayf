// View-model for one /saved row: turns the loosely-typed `bias_distribution`
// and `is_blindspot` that saved_clusters_v2 (migration 124) returns into what
// the list renders. Pure and client-safe: no network, no storage, no React.
//
// The row comes from jsonb, so nothing about it is trusted. A hand-edited or
// legacy distribution must never reach <BiasSpectrum> as NaN, a negative or a
// string (that would draw a broken bar), so every category is normalised here
// and an unusable distribution becomes `null` (the row then shows no bar).
//
// `is_blindspot` is absent on rows from the v1 fallback (saved_clusters, used
// while migration 124 is not applied yet); absent means "not flagged".
import { BIAS_ORDER } from "@/lib/bias/config";
import type { BiasDistribution } from "@/types";

export interface SavedRowView {
  /** Every bias category present, as a finite count >= 0; null when unusable or empty. */
  distribution: BiasDistribution | null;
  /** True only for a real boolean `true` (never the string "true" or 1). */
  isBlindspot: boolean;
}

export function toSavedRowView(row: { bias_distribution: unknown; is_blindspot?: unknown }): SavedRowView {
  return {
    distribution: toDistribution(row.bias_distribution),
    isBlindspot: row.is_blindspot === true,
  };
}

function toDistribution(value: unknown): BiasDistribution | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const out = {} as BiasDistribution;
  let total = 0;
  // Only the known categories are read, so unknown keys are dropped.
  for (const key of BIAS_ORDER) {
    const v = raw[key];
    const n = typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
    out[key] = n;
    total += n;
  }
  return total > 0 ? out : null;
}
