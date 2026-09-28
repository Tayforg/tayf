// Blindspot recall veto (migration 071) — READ PATH ONLY.
//
// Tayf's clusterer sometimes splits one event into two clusters, so a
// "kör nokta" can be a matching gap rather than real silence. Jev's
// `blindspot_recall` stage (migration 064) looks for same-event articles
// from the silent side; `public.blindspot_recall_veto_refresh()` adds every
// matched silent-zone voting source (p >= 0.85, not already a member) to
// the cluster's tally and re-applies the BLINDSPOT contract. When the
// dominant zone no longer holds >= BLINDSPOT.dominantShare, it sets
// `clusters.blindspot_recall_veto = true`.
//
// Every reader-facing surface treats `is_blindspot AND NOT
// blindspot_recall_veto` as the public claim. This module is the one place
// that rule lives in TypeScript. It never writes anything: the DB flags
// `is_blindspot` / `blindspot_side` stay exactly as migration 032 computed
// them.
//
// Missing data never hides anything: `undefined` (fixtures, rows fetched
// before 071 was applied) and `null` are pass-through. Only a literal
// `true` vetoes.

/**
 * Minimum Jev `blindspot_recall` probability for a silent-side article to
 * count toward the veto — the default of `p_min_prob` in migration 071's
 * `blindspot_recall_veto_refresh()` (parity-tested in
 * tests/migrations/071-blindspot-recall-veto.test.ts) and the number
 * /metodoloji#kor-nokta shows readers.
 */
export const RECALL_VETO_MIN_PROB = 0.85;

export interface RecallVetoRow<S> {
  is_blindspot: boolean;
  blindspot_side: S | null;
  blindspot_recall_veto?: boolean | null;
}

export interface RecallVetoResult<S> {
  isBlindspot: boolean;
  blindspotSide: S | null;
  /** True only when a real blindspot claim was withdrawn by the veto. */
  vetoed: boolean;
}

export function applyRecallVeto<S>(row: RecallVetoRow<S>): RecallVetoResult<S> {
  if (row.is_blindspot && row.blindspot_recall_veto === true) {
    // Mirrors the migration-032 invariant the feed-health gate also keeps:
    // no blindspot => no side.
    return { isBlindspot: false, blindspotSide: null, vetoed: true };
  }
  return {
    isBlindspot: row.is_blindspot,
    blindspotSide: row.blindspot_side,
    vetoed: false,
  };
}

/** Same shape as the feed-health suppression log line. */
export function logRecallVeto(clusterId: string): void {
  console.info(`[recall-veto] withdrew blindspot for cluster ${clusterId}`);
}
