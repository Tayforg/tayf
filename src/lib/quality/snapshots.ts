import { cacheLife, cacheTag } from "next/cache";

import { createServerClient } from "@/lib/supabase/server";

// Fetcher for /kalite (M-09) — reads the nightly `cluster_quality_snapshots`
// rows written by `node scripts/audit-clusters.mjs --json --persist`
// (.github/workflows/cluster-audit.yml, daily 03:00 UTC + manual dispatch).
// The flat columns mirror computeReport()'s return value
// (scripts/lib/audit/report.mjs) 1:1 — see that file for the exact
// meaning/units of each number this module shapes:
//
//   - singleton_rate: share of in-window clusters with exactly ONE
//     article — i.e. the clusterer found no other source's coverage
//     similar enough to merge. It reads high by design: many outlets
//     republish agency (AA/DHA/İHA) copy under their own URL, and the
//     clusterer only merges on strong similarity, so most articles start
//     — and often stay — alone until a near-duplicate from a second
//     outlet lands in the same time window.
//   - source_diversity.avg_sources_per_multi_cluster: mean count of
//     DISTINCT sources across clusters with >= 2 members only —
//     singletons are excluded (they have exactly one source, always).
//   - blindspot_flip_rate: among clusters with >= 5 members, the share
//     where the stored `is_blindspot` flag disagrees with
//     detectBlindspot(bias_distribution) recomputed live from the
//     current data — i.e. the contract has drifted (recompute_blindspot_
//     flags() hasn't re-run since the flag or the data changed).
//
// Every column besides id/taken_at/window_hours is nullable (migration
// 039), and numeric(6,4) columns can round-trip as either a JSON number or
// a numeric string depending on the PostgREST/pg-driver path — shapeRow
// below defends against both, plus a totally missing/errored query.
//
// Never throws: a throw inside "use cache" during prerender fails the
// Vercel build (same discipline as src/lib/sources/active-count.ts and
// src/lib/headline/status.ts). A Supabase error, a missing table (migration
// pending), or missing env resolves to null; the page renders that as an
// honest "unavailable" state instead of fabricating zeros.

export type QualitySizeHistogram = {
  "1": number;
  "2-3": number;
  "4-7": number;
  "8+": number;
};

export type QualitySourceDiversity = {
  avg_sources_per_multi_cluster: number;
  max_sources_per_cluster: number;
  duplicate_source_clusters: number;
};

export type QualitySnapshot = {
  id: number;
  takenAt: string;
  windowHours: number;
  articleCount: number;
  clusterCount: number;
  /** Fraction in [0,1] — singleton clusters / all in-window clusters. */
  singletonRate: number;
  sizeHistogram: QualitySizeHistogram;
  sourceDiversity: QualitySourceDiversity;
  precisionProbeCount: number;
  recallProbeCount: number;
  /** Fraction in [0,1] — blindspot-eligible clusters whose stored flag disagrees with a live recompute. */
  blindspotFlipRate: number;
};

/**
 * Raw `cluster_quality_snapshots` row, straight off PostgREST. Every field
 * is `unknown` on purpose — see the file header for why (nullable columns,
 * numeric(6,4) string/number ambiguity) — `shapeQualitySnapshots` is the
 * single place that trusts a shape out of it.
 */
export type QualitySnapshotRawRow = {
  id?: unknown;
  taken_at?: unknown;
  window_hours?: unknown;
  article_count?: unknown;
  cluster_count?: unknown;
  singleton_rate?: unknown;
  size_histogram?: unknown;
  source_diversity?: unknown;
  precision_probe_count?: unknown;
  recall_probe_count?: unknown;
  blindspot_flip_rate?: unknown;
};

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

function toIsoString(value: unknown): string {
  if (typeof value === "string" && value.trim() !== "") return value;
  return new Date(0).toISOString();
}

function toHistogram(value: unknown): QualitySizeHistogram {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    "1": toNumber(v["1"]),
    "2-3": toNumber(v["2-3"]),
    "4-7": toNumber(v["4-7"]),
    "8+": toNumber(v["8+"]),
  };
}

function toSourceDiversity(value: unknown): QualitySourceDiversity {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    avg_sources_per_multi_cluster: toNumber(v.avg_sources_per_multi_cluster),
    max_sources_per_cluster: toNumber(v.max_sources_per_cluster),
    duplicate_source_clusters: toNumber(v.duplicate_source_clusters),
  };
}

function shapeRow(row: QualitySnapshotRawRow): QualitySnapshot {
  return {
    id: toNumber(row.id),
    takenAt: toIsoString(row.taken_at),
    windowHours: toNumber(row.window_hours),
    articleCount: toNumber(row.article_count),
    clusterCount: toNumber(row.cluster_count),
    singletonRate: toNumber(row.singleton_rate),
    sizeHistogram: toHistogram(row.size_histogram),
    sourceDiversity: toSourceDiversity(row.source_diversity),
    precisionProbeCount: toNumber(row.precision_probe_count),
    recallProbeCount: toNumber(row.recall_probe_count),
    blindspotFlipRate: toNumber(row.blindspot_flip_rate),
  };
}

/**
 * Shape raw PostgREST rows into the page's display type: numbers coerced
 * (string or number in, finite number out, 0 fallback) and null-safe
 * (missing/null object columns default to their all-zero shape), then
 * sorted newest-first by takenAt regardless of input order — defensive:
 * the live query already orders `taken_at desc`, but a caller or test
 * passing unsorted rows should still get a correctly-ordered series.
 */
export function shapeQualitySnapshots(
  rows: readonly QualitySnapshotRawRow[] | null | undefined,
): QualitySnapshot[] {
  const shaped = (rows ?? []).map(shapeRow);
  return shaped.sort(
    (a, b) => new Date(b.takenAt).getTime() - new Date(a.takenAt).getTime(),
  );
}

const SNAPSHOT_LIMIT = 30;

export async function getQualitySnapshots(): Promise<QualitySnapshot[] | null> {
  "use cache";
  cacheLife("source-directory");
  cacheTag("quality");

  try {
    const supabase = createServerClient();

    const { data, error } = await supabase
      .from("cluster_quality_snapshots")
      .select(
        "id, taken_at, window_hours, article_count, cluster_count, singleton_rate, size_histogram, source_diversity, precision_probe_count, recall_probe_count, blindspot_flip_rate",
      )
      .order("taken_at", { ascending: false })
      .limit(SNAPSHOT_LIMIT)
      .returns<QualitySnapshotRawRow[]>();

    if (error) {
      // Never throw — see the file header. Swallow and return null so the
      // "use cache" prerender never fails the build on a Supabase hiccup
      // (or on migration 059 landing before/after this branch deploys).
      console.error(`[quality] snapshots unavailable: ${error.message}`);
      return null;
    }

    return shapeQualitySnapshots(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[quality] snapshots unavailable: ${message}`);
    return null;
  }
}
