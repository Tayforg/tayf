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
//      p >= RECALL_MATCH_MIN_PROB with a voting source, in the LATEST check?
//   2. recallQualifiedZones: of those, which does a claim call silent (a zone
//      that is not the dominant one and has no voting member)?
// No count, share, flag or veto is derived from either: the claim list, the
// "N kör nokta" line, RSS and the v1 API do not read this module.
//
// The LATEST check (h114-postship-1). A blindspot is re-checked once per UTC day
// while it stays in the stage's window, and every check stores every answer
// (jev.ts keys an answer `<cluster>:<article>:<day>`; before that fix the second
// answer of a pair was dropped, 36% of re-check answers in 30 days).
// `blindspot_recall_suspect` is rewritten by every check, so it states the LATEST
// check's verdict: a flagged cluster's wording must read that check's answers
// only, not a union with an earlier day's matches the later check no longer
// supports. Per cluster the rows of the highest run_id are kept (one run is one
// check of that cluster: the stage asks a cluster once per UTC day). A row whose
// run was pruned (run_id null) is older than any row with a run_id; a cluster
// whose rows all lack one is read as one check, as before. Rows written before
// the fix keep their first check's answers only.
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
  /** bigint, null once the run's row is pruned (061: on delete set null). */
  run_id?: number | string | null;
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

/** The run id as a number; null when it is missing, empty or not a number. */
function runIdOf(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function fetchChunk(
  supabase: SupabaseClient,
  ids: string[],
): Promise<PredictionRow[]> {
  // Partial index jev_shadow_predictions_cluster_idx (migration 061) serves the
  // cluster_id list; task and jev_prob filter the few rows each cluster has.
  const { data, error } = await supabase
    .from("jev_shadow_predictions")
    .select("cluster_id, run_id, jev_prob, articles(sources(bias, kind))")
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
 * count in the spectrum) at p >= RECALL_MATCH_MIN_PROB, in the cluster's LATEST
 * check only (the rows of its highest run_id; see the header). Each value is a
 * sorted, de-duplicated plain array, so it can ride in a `"use cache"` payload. A
 * cluster with no match has no entry.
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
    const matchesByCluster = new Map<string, Array<{ runId: number | null; row: PredictionRow }>>();
    for (const rows of results) {
      for (const row of rows) {
        if (typeof row.cluster_id !== "string" || !wanted.has(row.cluster_id)) continue;
        // The query already filters on jev_prob; checking again keeps the
        // threshold true to this constant whatever shape the value arrives in
        // (numeric(4,3) is a JSON number, but a string must not slip under it).
        // It runs before the latest-run pick, so a below-threshold row never
        // makes its run "the latest".
        if (!(Number(row.jev_prob) >= RECALL_MATCH_MIN_PROB)) continue;
        const list = matchesByCluster.get(row.cluster_id) ?? [];
        list.push({ runId: runIdOf(row.run_id), row });
        matchesByCluster.set(row.cluster_id, list);
      }
    }

    const out = new Map<string, MediaDnaZone[]>();
    for (const [id, matches] of matchesByCluster) {
      // The latest check of this cluster: its highest run_id. null only when no
      // row has one, and then every row (all null) is read as one check.
      let latest: number | null = null;
      for (const { runId } of matches) {
        if (runId !== null && (latest === null || runId > latest)) latest = runId;
      }
      const zones = new Set<MediaDnaZone>();
      for (const { runId, row } of matches) {
        if (runId !== latest) continue;
        const source = firstOf(firstOf(row.articles)?.sources);
        if (!source || !isVotingKind(source.kind)) continue;
        const zone = zoneFromBias(source.bias);
        if (!zone) continue;
        zones.add(zone);
      }
      if (zones.size > 0) out.set(id, Array.from(zones).sort());
    }
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
