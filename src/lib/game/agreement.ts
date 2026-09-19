import { cacheLife, cacheTag } from "next/cache";

import { createServerClient } from "@/lib/supabase/server";

// U-03 follow-through — per-outlet *reader agreement*, aggregated from the
// `zone_guesses` ledger written by /oyun (migration 057).
//
// Three deliberate constraints, all of them editorial rather than technical:
//
//   1. Aggregate only. Individual guesses never leave this module: the query
//      selects a single boolean column (`correct`) and nothing that could
//      identify a guess, an article or a reader.
//   2. Threshold. Nothing is published below AGREEMENT_MIN_GUESSES guesses —
//      a handful of guesses is noise, and a noisy number next to an outlet's
//      name reads as a verdict.
//   3. Wording. The share is "okur tahmini" (what readers guessed), never
//      "doğruluk" (accuracy). It measures how often readers guessed the zone
//      Tayf assigned — agreement with Tayf, not correctness of either.
//
// Gameability: repeated guesses can move the number, which is why /api/oyun
// is rate limited and why the n is always shown next to the share.
//
// Counting: `n` is the *total* number of guesses for the source, taken from
// two `count: "exact", head: true` queries (all guesses, and the ones with
// `correct = true`). Head requests return no rows at all, so this is both
// strictly aggregate and strictly cheaper than pulling a row window — and
// the published n can never claim to be a total it is not.

export const AGREEMENT_MIN_GUESSES = 30;

export interface ReaderAgreement {
  /** Total number of guesses recorded for the source. */
  n: number;
  /** correct / n, rounded to 3 decimals (0.633 renders as %63,3). */
  share: number;
}

/**
 * Collapse the two head counts into the publishable aggregate, or `null`
 * when there are too few guesses to publish (or the counts are unusable).
 * Pure: no I/O.
 */
export function summariseCounts(
  total: number,
  correct: number,
): ReaderAgreement | null {
  if (!Number.isFinite(total) || total < AGREEMENT_MIN_GUESSES) return null;

  // A NULL `correct` (unscored guess) is counted by the total but not by the
  // `correct = true` count, so `correct` can never exceed `total`; clamp
  // anyway so a surprising pair can never publish a share above 1.
  const hits = Number.isFinite(correct) ? Math.min(Math.max(correct, 0), total) : 0;

  return { n: total, share: Math.round((hits / total) * 1000) / 1000 };
}

/**
 * Reader agreement for one source. Never throws — a missing table, a broken
 * Supabase call or a missing env var renders as "not enough guesses yet"
 * rather than taking the source profile down.
 */
export async function getSourceAgreement(
  sourceId: string,
): Promise<ReaderAgreement | null> {
  "use cache";
  cacheLife("source-directory");
  cacheTag("sources");

  if (!sourceId) return null;

  try {
    const supabase = createServerClient();

    const { count: total, error } = await supabase
      .from("zone_guesses")
      .select("correct", { count: "exact", head: true })
      .eq("source_id", sourceId);

    if (error) {
      console.error(
        `[agreement] reader agreement unavailable: ${error.message}`,
      );
      return null;
    }
    if (typeof total !== "number" || total < AGREEMENT_MIN_GUESSES) return null;

    const { count: correct, error: correctError } = await supabase
      .from("zone_guesses")
      .select("correct", { count: "exact", head: true })
      .eq("source_id", sourceId)
      .eq("correct", true);

    if (correctError) {
      console.error(
        `[agreement] reader agreement unavailable: ${correctError.message}`,
      );
      return null;
    }

    return summariseCounts(total, correct ?? 0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[agreement] reader agreement unavailable: ${message}`);
    return null;
  }
}
