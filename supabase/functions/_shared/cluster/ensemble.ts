// supabase/functions/_shared/cluster/ensemble.ts
//
// Ensemble scorer. Ported from `scripts/lib/cluster/ensemble.mjs`.
// Combines:
//   A. MinHash Jaccard lane (ceiling-raiser)
//   B. Entity ratio with `min(|A|,|B|)` denominator + noise floor
//   C. TF-IDF cosine lane
// behind a strict-fingerprint auto-accept and a 48h time-window decay.

import {
  ENTITY_DENOM_MIN,
  ENTITY_FRESHNESS_HOURS,
  ENTITY_WEIGHT,
  MATCH_THRESHOLD,
  MIN_SHARED_ENTITIES,
  MINHASH_SOFT_ACCEPT_JACCARD,
  TFIDF_WEIGHT,
  TIME_WINDOW_HOURS,
} from "./constants.ts";
import {
  type FingerprintBundle,
  jaccardFromSignatures,
} from "./fingerprint.ts";

// ---------------------------------------------------------------------------
// Per-source clustering penalties.
// ---------------------------------------------------------------------------
//
// A8's source-diversity audit found `haberler-com` is a content-aggregator
// firehose dominating clustering. A small 15% downweight on any pair score
// where either side is haberler-com prevents it from acting as a seed magnet.
const SOURCE_PENALTIES: Record<string, number> = {
  "haberler-com": 0.85,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScoreOpts {
  aSourceSlug?: string | null;
  bSourceSlug?: string | null;
}

export interface ScoreComponents {
  autoAccept: boolean;
  jaccard: number;
  jaccardScore: number;
  sharedEntities?: number;
  entityRatioRaw?: number;
  entityFreshness?: number;
  entityRatio: number;
  tfidfScore: number;
  primary: number;
  raw: number;
  timeDecay: number;
  sourcePenalty: number;
}

export interface ScoreResult {
  score: number;
  components: ScoreComponents;
}

// Lighter shape than FingerprintBundle for callers that only carry the
// strict hash + signature (the scorer never reads `.shingles`).
export interface ScoringFingerprint {
  strict: string | null;
  signature: Uint32Array | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clip01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function asSet(v: Iterable<string> | Set<string> | null | undefined): Set<string> {
  if (v instanceof Set) return v;
  if (!v) return new Set();
  return new Set(v);
}

function setIntersectSize(a: Set<string>, b: Set<string>): number {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const x of small) if (big.has(x)) n++;
  return n;
}

// ---------------------------------------------------------------------------
// score()
// ---------------------------------------------------------------------------

export function score(
  a: ScoringFingerprint | FingerprintBundle | null | undefined,
  b: ScoringFingerprint | FingerprintBundle | null | undefined,
  aEntitiesIn: Iterable<string> | Set<string> | null | undefined,
  bEntitiesIn: Iterable<string> | Set<string> | null | undefined,
  tfidfCosine: number,
  hoursDelta: number,
  opts: ScoreOpts = {},
): ScoreResult {
  const { aSourceSlug, bSourceSlug } = opts || {};
  const sourcePenalty = Math.min(
    aSourceSlug ? SOURCE_PENALTIES[aSourceSlug] ?? 1 : 1,
    bSourceSlug ? SOURCE_PENALTIES[bSourceSlug] ?? 1 : 1,
  );

  // 1. Strict fingerprint auto-accept.
  if (a && b && a.strict && b.strict && a.strict === b.strict) {
    return {
      score: 1.0 * sourcePenalty,
      components: {
        autoAccept: true,
        jaccard: 1,
        jaccardScore: 1,
        entityRatio: 1,
        tfidfScore: clip01(tfidfCosine),
        primary: 1,
        raw: 1,
        timeDecay: 1,
        sourcePenalty,
      },
    };
  }

  // 2. MinHash Jaccard lane — ceiling-raiser.
  const jaccard = a && b && a.signature && b.signature
    ? clip01(jaccardFromSignatures(a.signature, b.signature))
    : 0;

  const jaccardScore = jaccard >= MINHASH_SOFT_ACCEPT_JACCARD
    ? 0.6 + 0.4 * jaccard
    : 0.5 * jaccard;

  // 3. Entity ratio — `min` denominator + noise floor of 3.
  const aEntities = asSet(aEntitiesIn);
  const bEntities = asSet(bEntitiesIn);
  const sharedCount = setIntersectSize(aEntities, bEntities);
  const denom = Math.max(
    ENTITY_DENOM_MIN,
    Math.min(aEntities.size, bEntities.size),
  );
  const entityRatioRaw = denom === 0 ? 0 : clip01(sharedCount / denom);

  // A1 cluster-glue fix: decay entity contribution on a 6h freshness window.
  const entityFreshness = Math.max(
    0.5,
    1 - Math.max(0, hoursDelta) / ENTITY_FRESHNESS_HOURS,
  );
  const entityRatio = clip01(entityRatioRaw * entityFreshness);

  // 4. TF-IDF lane — clipped.
  const tfidfScore = clip01(tfidfCosine);

  // 5. Combine.
  const primary = TFIDF_WEIGHT * tfidfScore + ENTITY_WEIGHT * entityRatio;
  const raw = clip01(Math.max(jaccardScore, primary));

  // 6. Time decay.
  const timeDecay = Math.max(
    0,
    1 - Math.max(0, hoursDelta) / TIME_WINDOW_HOURS,
  );
  const finalScore = raw * timeDecay * sourcePenalty;

  return {
    score: finalScore,
    components: {
      autoAccept: false,
      jaccard,
      jaccardScore,
      sharedEntities: sharedCount,
      entityRatioRaw,
      entityFreshness,
      entityRatio,
      tfidfScore,
      primary,
      raw,
      timeDecay,
      sourcePenalty,
    },
  };
}

export function isMatch(scoreOrResult: number | ScoreResult | null | undefined): boolean {
  const n = typeof scoreOrResult === "number"
    ? scoreOrResult
    : scoreOrResult && typeof scoreOrResult.score === "number"
      ? scoreOrResult.score
      : -Infinity;
  return n >= MATCH_THRESHOLD;
}

export {
  ENTITY_WEIGHT,
  MATCH_THRESHOLD,
  MIN_SHARED_ENTITIES,
  MINHASH_SOFT_ACCEPT_JACCARD,
  TFIDF_WEIGHT,
};
