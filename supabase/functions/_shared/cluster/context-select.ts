// supabase/functions/_shared/cluster/context-select.ts
//
// Pure selection of the clusters the cluster-consumer keeps in its rolling
// match context. No imports: unit-tested from vitest and used from Deno.
//
// The context used to be the CAP most recently updated clusters. At peak
// those CAP clusters span only ~2 h, so a busy story (20 articles) that went
// quiet for 3 h fell out of the window and its next follow-up opened a
// duplicate cluster. This adds a bounded "sticky" tail: clusters beyond the
// newest-CAP window that are still well covered (>= stickyMinArticles) and
// were updated within stickyHours.
//
//   context = newest `cap` clusters (any state, exactly as before)
//           + up to `stickyMax` non-archived, non-merged, recent, large ones
//
// The result is therefore at most cap + stickyMax ids, so memory and the
// per-invocation fingerprint work stay bounded.

export interface ContextClusterRow {
  id: string;
  updated_at: string;
  article_count: number;
  is_archived?: boolean | null;
  merged_into?: string | null;
}

export interface ContextSelectOpts {
  /** Size of the newest-clusters window (CONTEXT_CLUSTER_CAP). */
  cap: number;
  /** A sticky cluster needs at least this many articles. */
  stickyMinArticles: number;
  /** A sticky cluster must have been updated within this many hours. */
  stickyHours: number;
  /** Maximum number of sticky clusters added on top of the window. */
  stickyMax: number;
  /** Reference time: epoch milliseconds or a Date. */
  now: number | Date;
}

const HOUR_MS = 3_600_000;

function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * Ids of the clusters to load, base window first, sticky tail after it.
 * Input may be in any order and may contain duplicate ids (the first
 * occurrence in updated_at-desc order wins).
 */
export function selectContextClusterIds(
  rows: readonly ContextClusterRow[],
  opts: ContextSelectOpts,
): string[] {
  const nowMs = typeof opts.now === "number" ? opts.now : opts.now.getTime();
  const cutoff = nowMs - opts.stickyHours * HOUR_MS;

  // Array.prototype.sort is stable, so equal timestamps keep input order.
  const newestFirst = [...rows].sort((a, b) => ms(b.updated_at) - ms(a.updated_at));

  const seen = new Set<string>();
  const base: string[] = [];
  const rest: ContextClusterRow[] = [];
  for (const row of newestFirst) {
    if (seen.has(row.id)) continue;
    if (base.length < opts.cap) {
      seen.add(row.id);
      base.push(row.id);
    } else {
      rest.push(row);
    }
  }

  const sticky = rest
    .filter(
      (r) =>
        r.article_count >= opts.stickyMinArticles &&
        ms(r.updated_at) >= cutoff &&
        !r.is_archived &&
        (r.merged_into === null || r.merged_into === undefined),
    )
    .sort((a, b) =>
      (b.article_count - a.article_count) || (ms(b.updated_at) - ms(a.updated_at))
    );

  const out = base;
  let added = 0;
  for (const row of sticky) {
    if (added >= opts.stickyMax) break;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row.id);
    added++;
  }
  return out;
}

/**
 * Exclusive upper bound for the sticky query: the updated_at of the cap-th
 * newest cluster, or null while the window is not full (then there is nothing
 * beyond it to be sticky about). `newestRows` must be ordered newest first.
 */
export function stickyUpperBound(
  newestRows: readonly { updated_at: string }[],
  cap: number,
): string | null {
  if (cap < 1 || newestRows.length < cap) return null;
  return newestRows[cap - 1]!.updated_at;
}

// ---------------------------------------------------------------------------
// h12-cluster-1 (hunt 12): twin clusters. Two more pure helpers for the
// consumer's candidate handling.
// ---------------------------------------------------------------------------

/**
 * Candidates within this score distance of the best one are ordered by
 * cluster size before score (see rankCandidates). Antalya-Alanya otoyolu:
 * sozcu scored 0.87 against the 7-article twin and 0.83 against the
 * 18-article original, and joined the twin.
 */
export const CANDIDATE_SIZE_TIEBREAK_MARGIN = 0.10;

/** Most exact-title probe hits that are put in front of the candidate list. */
export const MAX_TITLE_PROBE_CLUSTERS = 3;

// 0.87 - 0.10 is 0.7699999999999999 in binary floating point; the margin is
// inclusive, so compare with a little slack.
const SCORE_EPSILON = 1e-9;

/**
 * Orders scored candidates for the consumer's join loop.
 *
 *   - best score below `threshold`: plain score order (a larger cluster never
 *     outranks a better candidate that is itself not a match);
 *   - otherwise G = { score >= threshold and score >= best - margin } goes
 *     first, ordered size desc, score desc, clusterId asc; every other
 *     candidate follows by score desc.
 *
 * Stable and non-mutating; extra fields on the rows are carried through.
 * `sizeOf` returning a non-finite value counts as 0.
 */
export function rankCandidates<T extends { clusterId: string; score: number }>(
  scored: readonly T[],
  sizeOf: (clusterId: string) => number,
  opts: { margin: number; threshold: number },
): T[] {
  // Array.prototype.sort is stable, so equal scores keep input order.
  const byScore = [...scored].sort((a, b) => b.score - a.score);
  const top = byScore[0];
  if (top === undefined || top.score < opts.threshold) return byScore;

  const floor = Math.max(opts.threshold, top.score - opts.margin - SCORE_EPSILON);
  const size = new Map<string, number>();
  const group: T[] = [];
  const rest: T[] = [];
  for (const c of byScore) {
    if (c.score >= floor) {
      const n = sizeOf(c.clusterId);
      size.set(c.clusterId, Number.isFinite(n) ? n : 0);
      group.push(c);
    } else {
      rest.push(c);
    }
  }
  group.sort(
    (a, b) =>
      (size.get(b.clusterId) ?? 0) - (size.get(a.clusterId) ?? 0) ||
      b.score - a.score ||
      (a.clusterId < b.clusterId ? -1 : a.clusterId > b.clusterId ? 1 : 0),
  );
  return [...group, ...rest];
}

/**
 * Candidate ids for the scorer: the exact-title probe hits first (at most
 * MAX_TITLE_PROBE_CLUSTERS, order kept), then the index candidates, each id
 * once. The probe ids are added on top of the candidate list, so they are not
 * counted against MAX_CANDIDATE_CLUSTERS.
 */
export function mergeProbeIds(
  probeIds: readonly string[],
  candidateIds: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of probeIds) {
    if (out.length >= MAX_TITLE_PROBE_CLUSTERS) break;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const id of candidateIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
