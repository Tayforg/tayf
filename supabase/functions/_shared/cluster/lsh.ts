// supabase/functions/_shared/cluster/lsh.ts
//
// LSH banding over the MinHash signatures that `fingerprint()` already
// produces. This exists to give `findCandidateClusters` a third route into
// the candidate set.
//
// The problem it solves: candidates were admitted only by an exact strict
// fingerprint match or by >=2 shared whitelist entities. The ensemble scorer
// (MinHash jaccard + TF-IDF cosine) runs only on candidates that already
// cleared that gate, so the strongest signals could never rescue a pair the
// weakest one rejected. Measured on 24h of production politics (n=948),
// 50.5% of articles carry fewer than 2 entities, making the >=2-shared gate
// arithmetically unreachable for half the corpus; the singleton rate was
// 91.8%. Two headlines from the same outlet, minutes apart, estimating 0.98
// jaccard, sat in different clusters because "londra" is not in the ~80-term
// entity whitelist.
//
// Banding does NOT decide merges. It only widens who gets scored; the
// existing ensemble still rules on the merits, so precision stays owned by
// MATCH_THRESHOLD.
//
// Geometry: with b bands of r rows, two items sharing at least one band has
// probability 1 - (1 - s^r)^b for jaccard s. At b=16, r=4:
//
//     s=0.3 -> 0.12    s=0.5 -> 0.64    s=0.7 -> 0.99    s=0.9 -> ~1.00
//
// That is deliberately shaped around MINHASH_SOFT_ACCEPT_JACCARD (0.5): near
// duplicates are admitted almost always, loosely-related pairs rarely. Raising
// LSH_BANDS admits more (better recall, more scoring work per article and more
// pressure on MAX_CANDIDATE_CLUSTERS); lowering it admits less.

import { MINHASH_SIG_K } from "./constants.ts";

// Must divide MINHASH_SIG_K exactly, or the trailing slots stop contributing
// to candidate generation and recall silently degrades.
export const LSH_BANDS = 16;
export const LSH_ROWS = MINHASH_SIG_K / LSH_BANDS;

// minhashSignature fills an all-0xFFFFFFFF signature for an empty shingle set
// and documents it as "not comparable". Banding those would collide every
// contentless article with every other one and flood the candidate set, so
// they are dropped here rather than at the call site.
const EMPTY_SLOT = 0xFFFFFFFF;

/**
 * Band a MinHash signature into `LSH_BANDS` keys. Two signatures sharing any
 * key are near-duplicate candidates worth scoring.
 *
 * Returns an empty array when the signature is missing, the wrong length, or
 * uncomparable — callers get "no candidates from this route" rather than a
 * throw, matching how the entity route degrades.
 */
export function bandKeys(
  signature: Uint32Array | null | undefined,
): string[] {
  if (!signature || signature.length !== MINHASH_SIG_K) return [];

  // All-empty signature => no content to compare.
  let hasContent = false;
  for (let i = 0; i < signature.length; i++) {
    if (signature[i] !== EMPTY_SLOT) {
      hasContent = true;
      break;
    }
  }
  if (!hasContent) return [];

  const keys: string[] = new Array(LSH_BANDS);
  for (let b = 0; b < LSH_BANDS; b++) {
    const start = b * LSH_ROWS;
    let key = `${b}:`;
    for (let r = 0; r < LSH_ROWS; r++) {
      // Band index is part of the key so identical row values occurring in a
      // different band do not collide.
      key += (r === 0 ? "" : ",") + signature[start + r];
    }
    keys[b] = key;
  }
  return keys;
}
