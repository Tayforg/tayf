import type { SupabaseClient } from "@supabase/supabase-js";

import { isVotingKind, zoneOf } from "@/lib/bias/config";
import type { BiasCategory, MediaDnaZone } from "@/types";

// Recall-matched zones: READ PATH, WORDING ONLY.
//
// Jev's `blindspot_recall` stage (migration 064) looks, for every blindspot, for
// articles of the SILENT side that cover the same event; when any candidate
// scores at or above JEV_BLINDSPOT_SUSPECT_PROB it marks the cluster
// `clusters.blindspot_recall_suspect`. The recall VETO (migration 071, p >= 0.85,
// and only when adding the matches breaks the dominance threshold) withdraws a
// claim; a suspect claim that survives the veto stays public by design. What it
// must not do is state ABSOLUTE one-sidedness for a zone Jev found a likely
// match in ("Sadece İktidar yazdı", "— bu tarafta sessizlik —", "Muhalefete yakın
// kaynaklar N hikâyeye yer vermedi"): on 2026-11-10, 8 of the 44 listed claims
// were such cases (h106-blindspotbadges-1).
//
// This module answers two questions, and nothing else:
//   1. fetchRecallMatchedZones: for these clusters, which zones did Jev match at
//      p >= RECALL_MATCH_MIN_PROB with a voting source?
//   2. recallQualifiedZones: of those, which does a claim call silent (a zone
//      that is not the dominant one and has no voting member)?
// No count, share, flag or veto is derived from either: the claim list, the
// "N kör nokta" line, RSS and the v1 API do not read this module.
//
// Fail-open: when the lookup errors, `fetchRecallMatchedZones` warns and returns
// an empty Map, so every surface renders today's wording.

/**
 * The Jev probability at or above which a candidate counts as a match. It is
 * JEV_BLINDSPOT_SUSPECT_PROB of supabase/functions/_shared/jev.ts, the number
 * that sets `blindspot_recall_suspect` (so the wording and the flag always agree
 * about what a match is); kept as its own constant because that module is the
 * Deno Edge Function's whole Jev core and must not be bundled into a page.
 * Parity is pinned by recall-matched-zones.test.ts. Below the 0.85 of the veto
 * (RECALL_VETO_MIN_PROB) on purpose: the veto withdraws a claim, this only
 * softens its wording.
 */
export const RECALL_MATCH_MIN_PROB = 0.7;

/** Cluster ids per request, so an `in (...)` list stays a short URL. */
export const RECALL_MATCH_CHUNK_SIZE = 100;

/** The qualifier every surface appends, so the wording cannot drift between them. */
export const RECALL_MATCH_NOTE = "benzer haber başka kümede olabilir";

/**
 * The framing comparison's empty-column line for a zone Jev matched (bare: the
 * column adds its own dashes).
 */
export const RECALL_MATCH_EMPTY_COLUMN = `bu kümede yok · ${RECALL_MATCH_NOTE}`;

// Alphabetical, which is also the order `Array.prototype.sort()` gives, so
// every array this module returns is sorted the same way.
const ZONES_SORTED: readonly MediaDnaZone[] = ["bagimsiz", "iktidar", "muhalefet"];

type OneOrMany<T> = T | T[] | null | undefined;

/** The columns selected below; the embeds are objects (or one-element arrays). */
interface PredictionRow {
  cluster_id: string | null;
  jev_prob: number | string | null;
  articles: OneOrMany<{
    sources: OneOrMany<{ bias: string | null; kind: string | null }>;
  }>;
}

function firstOf<T>(value: OneOrMany<T>): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** The zone of a bias key, or null for anything that is not one of the three zones. */
function zoneFromBias(bias: string | null | undefined): MediaDnaZone | null {
  if (typeof bias !== "string") return null;
  const zone: unknown = zoneOf(bias as BiasCategory);
  return ZONES_SORTED.find((z) => z === zone) ?? null;
}

async function fetchChunk(
  supabase: SupabaseClient,
  ids: string[],
): Promise<PredictionRow[]> {
  // Partial index jev_shadow_predictions_cluster_idx (migration 061) serves the
  // cluster_id list; task and jev_prob filter the few rows each cluster has.
  const { data, error } = await supabase
    .from("jev_shadow_predictions")
    .select("cluster_id, jev_prob, articles(sources(bias, kind))")
    .eq("task", "blindspot_recall")
    .in("cluster_id", ids)
    .gte("jev_prob", RECALL_MATCH_MIN_PROB)
    .returns<PredictionRow[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Per cluster, the zones in which Jev's blindspot_recall stage matched a VOTING
 * source (outlet or wire; a toplayıcı / niş match never counts, as they never
 * count in the spectrum) at p >= RECALL_MATCH_MIN_PROB. Each value is a sorted,
 * de-duplicated plain array, so it can ride in a `"use cache"` payload. A cluster
 * with no match has no entry.
 *
 * Never throws: on ANY error (a failed chunk, a client that throws) it warns and
 * returns an EMPTY Map, so the caller prints today's wording; one failed chunk
 * empties the whole answer rather than qualifying only some of a page.
 */
export async function fetchRecallMatchedZones(
  supabase: SupabaseClient,
  clusterIds: readonly string[],
): Promise<Map<string, MediaDnaZone[]>> {
  const ids = Array.from(new Set(clusterIds));
  if (ids.length === 0) return new Map();

  try {
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += RECALL_MATCH_CHUNK_SIZE) {
      chunks.push(ids.slice(i, i + RECALL_MATCH_CHUNK_SIZE));
    }
    const results = await Promise.all(chunks.map((chunk) => fetchChunk(supabase, chunk)));

    const wanted = new Set(ids);
    const zonesByCluster = new Map<string, Set<MediaDnaZone>>();
    for (const rows of results) {
      for (const row of rows) {
        if (typeof row.cluster_id !== "string" || !wanted.has(row.cluster_id)) continue;
        // The query already filters on jev_prob; checking again keeps the
        // threshold true to this constant whatever shape the value arrives in
        // (numeric(4,3) is a JSON number, but a string must not slip under it).
        if (!(Number(row.jev_prob) >= RECALL_MATCH_MIN_PROB)) continue;
        const source = firstOf(firstOf(row.articles)?.sources);
        if (!source || !isVotingKind(source.kind)) continue;
        const zone = zoneFromBias(source.bias);
        if (!zone) continue;
        const zones = zonesByCluster.get(row.cluster_id) ?? new Set<MediaDnaZone>();
        zones.add(zone);
        zonesByCluster.set(row.cluster_id, zones);
      }
    }

    const out = new Map<string, MediaDnaZone[]>();
    for (const [id, zones] of zonesByCluster) out.set(id, Array.from(zones).sort());
    return out;
  } catch (err) {
    // No cluster id, headline or count in the line (tests/guards/no-pii-logging).
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[recall-matched-zones] lookup failed, the unqualified wording stays: ${message}`,
    );
    return new Map();
  }
}

/**
 * The zones a claim calls silent that Jev matched: not the dominant zone, no
 * voting member (strict zero, as the silence digest counts it), and listed in
 * `matched`. These are the only zones whose absolute wording is softened; a
 * silent zone Jev did not match keeps it. `matched` undefined (no lookup, a
 * failed one, an entry written before the field existed) gives []. A null
 * `dominantZone` (a cluster with no voting member at all) excludes no zone.
 *
 * Returns a new sorted array and never modifies its inputs.
 */
export function recallQualifiedZones(
  votingZoneCounts: Record<MediaDnaZone, number>,
  dominantZone: MediaDnaZone | null,
  matched: readonly MediaDnaZone[] | undefined,
): MediaDnaZone[] {
  if (!matched || matched.length === 0) return [];
  const matchedSet = new Set(matched);
  return ZONES_SORTED.filter(
    (zone) =>
      zone !== dominantZone &&
      votingZoneCounts[zone] === 0 &&
      matchedSet.has(zone),
  );
}
