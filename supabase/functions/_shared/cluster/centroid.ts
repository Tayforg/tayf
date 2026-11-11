// supabase/functions/_shared/cluster/centroid.ts
//
// The pure core of the consumer's centroid guard (h70-mergequality-2). No I/O, no
// clock, no randomness; the TF-IDF index is only read.
//
// WHY. The consumer scores a candidate cluster against its seed and its latest
// member with the full ensemble, and against its other recent members through the
// headline lane only. An article that shares a person's name with the seed or the
// latest therefore joined a big cluster with no check against the cluster as a
// whole (Kilicdaroglu's CHP group speech in the Bahceli condolence cluster, a TRT
// forum remark in the Friday-prayer cluster). centroidCosine() is that check: the
// cosine of the article's tf-idf vector with the centroid of the members' vectors.
// centroidGuard() is the decision made from it (CENTROID_FLOOR, CENTROID_MIN_MEMBERS,
// the exemptions); cluster-consumer/index.ts gathers its inputs, builds the member
// texts lazily and acts on the verdict (a candidate that is blocked is skipped).
// A candidate the headline lane carried is checked too, against the lower
// HEADLINE_CENTROID_FLOOR (h114-clusterpurity-3: a multi-topic bridge member lets the
// lane glue another story onto a big cluster).
//
// The Edge runtime and tsc both compile it; relative .ts imports, same discipline as
// ensemble.ts.

import { CENTROID_FLOOR, CENTROID_MIN_MEMBERS, HEADLINE_CENTROID_FLOOR } from "./constants.ts";
import type { TfidfIndex } from "./tfidf.ts";

// The unit-length tf-idf vector of a free text, weighed like the consumer's own
// incoming-article query (TfidfIndex.queryWeights). null for a text without a
// single weighted term (empty, blank, symbols only).
function unitVector(tfidf: TfidfIndex, text: string): Map<string, number> | null {
  const weights = tfidf.queryWeights(tfidf.query(text));
  let sumSq = 0;
  for (const w of weights.values()) sumSq += w * w;
  const norm = Math.sqrt(sumSq);
  if (!(norm > 0)) return null;
  const unit = new Map<string, number>();
  for (const [term, w] of weights) unit.set(term, w / norm);
  return unit;
}

/**
 * Cosine of the article's tf-idf vector with the centroid of the members' vectors:
 * each text becomes the weights of `tfidf.query(text)`, normalised to a unit vector;
 * the centroid is the unit-normalised sum of the member unit vectors; the result is
 * the dot product of the article's unit vector with it, in [0, 1].
 *
 * Members without a weighted term are ignored (a blank text is not an average of
 * nothing). 0 when the article has no weighted term, when no member has one, or
 * when the sum cancels out (it cannot: weights are positive). The order of the
 * members does not matter, and `tfidf` is not modified.
 */
export function centroidCosine(
  articleText: string,
  memberTexts: readonly string[],
  tfidf: TfidfIndex,
): number {
  const article = unitVector(tfidf, articleText);
  if (article === null) return 0;

  const sum = new Map<string, number>();
  let used = 0;
  for (const text of memberTexts) {
    const unit = unitVector(tfidf, text);
    if (unit === null) continue;
    used += 1;
    for (const [term, w] of unit) sum.set(term, (sum.get(term) ?? 0) + w);
  }
  if (used === 0) return 0;

  let sumSq = 0;
  for (const w of sum.values()) sumSq += w * w;
  const norm = Math.sqrt(sumSq);
  if (!(norm > 0)) return 0;

  let dot = 0;
  for (const [term, w] of article) {
    const c = sum.get(term);
    if (c !== undefined) dot += w * c;
  }
  const cosine = dot / norm;
  // Float rounding can land a hair outside [0, 1].
  return cosine > 1 ? 1 : cosine < 0 ? 0 : cosine;
}

/**
 * The CLUSTER_CENTROID_GUARD switch: the guard is on unless the secret is the string
 * "off" (any case, surrounding whitespace ignored). Unset, empty or any other value
 * keeps it on.
 */
export function centroidGuardEnabled(raw: string | null | undefined): boolean {
  return (raw ?? "").trim().toLowerCase() !== "off";
}

export interface CentroidGuardInput {
  /** centroidGuardEnabled(...) of the secret. */
  enabled: boolean;
  /** max(article_count, sources loaded for the cluster). */
  memberCount: number;
  /**
   * The headline lane carried the candidate (the full scorer's lane, or a member headline of
   * the scan). Not an exemption: such a candidate clears HEADLINE_CENTROID_FLOOR.
   */
  headlineHit: boolean;
  /** The candidate came from the exact-title probe. */
  exactTitleProbeHit: boolean;
  /** The article's strict fingerprint equals one of the cluster's members'. */
  strictFingerprintMatch: boolean;
  /** The article is already a member (a re-delivered message). */
  alreadyMember: boolean;
  /** Evaluated lazily, only for a candidate that reaches the check. */
  cosine: () => number;
}

export interface CentroidGuardResult {
  blocked: boolean;
  /** The cosine that decided it; null when an exemption applied and none was computed. */
  cosine: number | null;
}

/**
 * Whether the consumer passes a candidate cluster over instead of joining it
 * (h70-mergequality-2). It does so when the guard is on, the cluster has at least
 * CENTROID_MIN_MEMBERS members, nothing exempts the article (an exact-title probe hit,
 * an equal strict fingerprint, already being a member) and the article's cosine with the
 * cluster's centroid is under the floor: CENTROID_FLOOR, or the lower
 * HEADLINE_CENTROID_FLOOR when the headline lane carried the candidate (it used to be an
 * exemption; h114-clusterpurity-3). Every exemption short-circuits before `cosine()`
 * runs, so the cost is paid only for the candidates that need it. Fails open: a
 * non-finite member count or cosine never blocks.
 */
export function centroidGuard(input: CentroidGuardInput): CentroidGuardResult {
  if (
    !input.enabled ||
    input.exactTitleProbeHit ||
    input.strictFingerprintMatch ||
    input.alreadyMember ||
    !(input.memberCount >= CENTROID_MIN_MEMBERS)
  ) {
    return { blocked: false, cosine: null };
  }
  const floor = input.headlineHit ? HEADLINE_CENTROID_FLOOR : CENTROID_FLOOR;
  const cosine = input.cosine();
  return { blocked: Number.isFinite(cosine) && cosine < floor, cosine };
}
