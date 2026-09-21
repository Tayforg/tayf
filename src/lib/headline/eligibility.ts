import type { SupabaseClient } from "@supabase/supabase-js";

// Migration 069, B7 — the LLM eligibility pre-gate for /api/cron/headline.
//
// A cluster only burns LLM budget on a neutral-headline rewrite when it is
// "political enough" (>= 2 members with Jev's task='politics' jev_prob >=
// 0.7, OR a single-source cluster whose one member scores >= 0.9) AND is
// not clickbait-heavy (fewer than half of the CLICKBAIT-SCORED members at
// jev_prob >= 0.5 — absence of a clickbait score is never treated as
// evidence of clickbait). decideEligibility() below is the pure TypeScript
// mirror of the SQL function `public.headline_llm_eligible` (migration
// 069) and must agree with it on all four thresholds; the two are pinned
// together by tests/migrations/069-parity.test.ts.
//
// FAIL-SAFE BY DESIGN: fetchHeadlineEligibility() returns an EMPTY Map on
// ANY rpc error (network failure, missing migration, a cluster id the
// function can't resolve). The cron route treats "no row in this map" as
// ineligible, so a coverage gap or a transient Supabase error can only
// ever push the route toward the free extractive path, never toward
// spending money it can't account for. Never loosen this default toward
// "eligible" — see pack.md's "the eligibility gate can silently zero the
// LLM branch" risk note: that is the intended, safe failure mode, not a
// bug to work around by defaulting open.

export const HEADLINE_ELIGIBILITY_POLITICS_MIN_PROB = 0.7;
export const HEADLINE_ELIGIBILITY_POLITICS_SOLO_MIN_PROB = 0.9;
export const HEADLINE_ELIGIBILITY_POLITICS_MIN_MEMBERS = 2;
export const HEADLINE_ELIGIBILITY_CLICKBAIT_MIN_PROB = 0.5;
export const HEADLINE_ELIGIBILITY_CLICKBAIT_MAX_SHARE = 0.5;

// Matches the SQL function's own `limit 200` clamp on `p_cluster_ids` — the
// caller chunks at this size so a batch never relies on the SQL-side clamp
// silently dropping ids past 200.
export const HEADLINE_ELIGIBILITY_CHUNK = 200;

export interface HeadlineEligibilityRow {
  cluster_id: string;
  eligible: boolean;
  politics_n: number;
  clickbait_share: number;
}

export interface HeadlineMemberScore {
  politicsProb: number | null;
  clickbaitProb: number | null;
}

/**
 * Pure TypeScript mirror of `public.headline_llm_eligible`'s per-cluster
 * CASE logic. No I/O — used both by the parity test (thresholds must
 * match the SQL) and available for the route to reason about a cluster
 * without a round trip when it already has the member scores in hand.
 */
export function decideEligibility(input: {
  articleCount: number;
  members: HeadlineMemberScore[];
}): { eligible: boolean; politicsN: number; clickbaitShare: number } {
  const { articleCount, members } = input;

  const politicsN = members.filter(
    (m) =>
      m.politicsProb !== null &&
      m.politicsProb >= HEADLINE_ELIGIBILITY_POLITICS_MIN_PROB,
  ).length;

  const soloStrong = members.some(
    (m) =>
      m.politicsProb !== null &&
      m.politicsProb >= HEADLINE_ELIGIBILITY_POLITICS_SOLO_MIN_PROB,
  );

  const politicalEnough =
    politicsN >= HEADLINE_ELIGIBILITY_POLITICS_MIN_MEMBERS ||
    (articleCount === 1 && soloStrong);

  const clickbaitScored = members.filter((m) => m.clickbaitProb !== null);
  const clickbaitHits = clickbaitScored.filter(
    (m) =>
      (m.clickbaitProb as number) >= HEADLINE_ELIGIBILITY_CLICKBAIT_MIN_PROB,
  ).length;

  const rawShare =
    clickbaitScored.length === 0 ? 0 : clickbaitHits / clickbaitScored.length;
  // Same 3-decimal rounding as the SQL's `round(..., 3)`.
  const clickbaitShare = Math.round(rawShare * 1000) / 1000;

  const notClickbaitHeavy =
    clickbaitShare < HEADLINE_ELIGIBILITY_CLICKBAIT_MAX_SHARE;

  return {
    eligible: politicalEnough && notClickbaitHeavy,
    politicsN,
    clickbaitShare,
  };
}

/** Splits `ids` into chunks of at most `size` (default HEADLINE_ELIGIBILITY_CHUNK). Never emits an empty chunk. */
export function chunkClusterIds(
  ids: string[],
  size: number = HEADLINE_ELIGIBILITY_CHUNK,
): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

interface RawHeadlineEligibilityRow {
  cluster_id: string;
  eligible: boolean;
  politics_n: number | string;
  clickbait_share: number | string;
}

/**
 * Chunked `rpc("headline_llm_eligible", { p_cluster_ids })` caller. Issues
 * one rpc per HEADLINE_ELIGIBILITY_CHUNK-sized chunk and merges the
 * returned rows into a single Map keyed by cluster_id.
 *
 * FAIL-SAFE: on ANY rpc error (any chunk), logs
 * `console.error("[headline-cron] eligibility rpc failed", err)` and
 * returns an EMPTY Map immediately — never a partial map from chunks that
 * happened to succeed before the failing one, so the caller's per-cluster
 * lookup degrades uniformly to "ineligible" for the whole batch rather
 * than a confusing mix.
 */
export async function fetchHeadlineEligibility(
  supabase: SupabaseClient,
  clusterIds: string[],
): Promise<Map<string, HeadlineEligibilityRow>> {
  const result = new Map<string, HeadlineEligibilityRow>();
  if (clusterIds.length === 0) return result;

  for (const chunk of chunkClusterIds(clusterIds)) {
    const { data, error } = await supabase.rpc("headline_llm_eligible", {
      p_cluster_ids: chunk,
    });

    if (error) {
      console.error("[headline-cron] eligibility rpc failed", error);
      return new Map();
    }

    const rows = Array.isArray(data) ? (data as RawHeadlineEligibilityRow[]) : [];
    for (const row of rows) {
      result.set(row.cluster_id, {
        cluster_id: row.cluster_id,
        eligible: Boolean(row.eligible),
        politics_n: Number(row.politics_n),
        clickbait_share: Number(row.clickbait_share),
      });
    }
  }

  return result;
}
