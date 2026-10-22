import { cacheLife, cacheTag } from "next/cache";

import { attemptCached } from "@/lib/cache-resilience";
import { createReaderClient } from "@/lib/supabase/server";

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
 * Uncached implementation: the two head counts under the 4 s reader cap
 * (`/source/[slug]` is user-facing). THROWS on either count error so the
 * cached wrapper below can tell "unavailable" from "fewer than
 * AGREEMENT_MIN_GUESSES guesses" (a legitimate `null`). Both counts share one
 * client.
 */
async function fetchAgreement(
  sourceId: string,
): Promise<ReaderAgreement | null> {
  const supabase = createReaderClient();

  const { count: total, error } = await supabase
    .from("zone_guesses")
    .select("correct", { count: "exact", head: true })
    .eq("source_id", sourceId);

  if (error) {
    throw new Error(error.message);
  }
  if (typeof total !== "number" || total < AGREEMENT_MIN_GUESSES) return null;

  const { count: correct, error: correctError } = await supabase
    .from("zone_guesses")
    .select("correct", { count: "exact", head: true })
    .eq("source_id", sourceId)
    .eq("correct", true);

  if (correctError) {
    throw new Error(correctError.message);
  }

  return summariseCounts(total, correct ?? 0);
}

// Cached entry. Never throws (`attemptCached`), so nothing crosses the
// "use cache" boundary. Exactly ONE `cacheLife` per invocation, chosen after
// the attempt: a failure (typically the 4 s reader abort on a cold database)
// is memoised for `minutes` only, a success - including the legitimate
// "too few guesses" `null` - keeps `source-directory`.
async function getSourceAgreementAttemptCached(sourceId: string) {
  "use cache";
  cacheTag("sources");
  const r = await attemptCached("agreement", () => fetchAgreement(sourceId));
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("source-directory");
  else cacheLife("minutes");
  return r;
}

/**
 * Reader agreement for one source. Never throws - a missing table, a broken
 * Supabase call, a timeout or a missing env var renders as "not enough
 * guesses yet" rather than taking the source profile down. Deliberately NO
 * live retry: the number is decoration on the profile, and a second 4 s wait
 * inside the request is worse than the label card's empty state for a minute.
 */
export async function getSourceAgreement(
  sourceId: string,
): Promise<ReaderAgreement | null> {
  if (!sourceId) return null;
  const r = await getSourceAgreementAttemptCached(sourceId);
  return r.ok ? r.data : null;
}
