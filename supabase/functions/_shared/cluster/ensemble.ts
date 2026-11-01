// supabase/functions/_shared/cluster/ensemble.ts
//
// Ensemble scorer. Ported from `scripts/lib/cluster/ensemble.mjs`; the two
// must stay byte-identical (tests/functions/_shared/cluster.test.ts).
// Combines:
//   A. MinHash Jaccard lane (ceiling-raiser)
//   B. Entity ratio with `max(|A|,|B|)` denominator + noise floor of 3
//   C. TF-IDF cosine lane
//   D. Headline lane (ceiling-raiser): near-identical headlines from
//      different outlets, consistent numerals, within 6 h
// behind a strict-fingerprint auto-accept and a 48h time-window decay.
//
//   primary = 0.7*tfidf + 0.3*entityRatio
//   text floor: if the headline lane did not fire and tfidf < ENTITY_TEXT_FLOOR,
//     the primary lane is capped just under MATCH_THRESHOLD (entities alone
//     cannot join a pair that shares no text)
//   raw = max(minhashScore, primary (capped), headlineScore (when fired))
//   final = raw * timeDecay * sourcePenalty
//
// 2026-11-01: the entity denominator was `min(|A|,|B|)` (a 3-entity article
// scored 3/3 against a 10-entity seed -- prod cluster dd5535a7); it is now
// `max`. The headline lane recovers cross-outlet pairs whose tfidf is low
// because descriptions differ (Sarigul 6f4d9ac2/cffe669c, Bakirkoy). See
// constants.ts for the per-constant evidence.

import {
  ENTITY_DENOM_MIN,
  ENTITY_FRESHNESS_HOURS,
  ENTITY_TEXT_FLOOR,
  ENTITY_WEIGHT,
  HEADLINE_LANE_MAX_HOURS,
  HEADLINE_LANE_MIN_JACCARD,
  HEADLINE_LANE_MIN_SHARED,
  MATCH_THRESHOLD,
  MIN_SHARED_ENTITIES,
  MINHASH_SOFT_ACCEPT_JACCARD,
  TFIDF_WEIGHT,
  TIME_WINDOW_HOURS,
} from "./constants.ts";
import {
  type FingerprintBundle,
  headlineTokens,
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
  // Article titles for the headline lane. The lane is inert unless both are
  // non-empty.
  aTitle?: string | null;
  bTitle?: string | null;
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
  // Headline lane: stemmed-token Jaccard and intersection size of the two
  // titles (0 when a title is missing), whether the lane fired, and whether
  // the text floor capped the primary lane.
  headlineSim: number;
  headlineShared: number;
  headlineLane: boolean;
  textFloorCapped: boolean;
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
  const { aSourceSlug, bSourceSlug, aTitle, bTitle } = opts || {};
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
        headlineSim: 0,
        headlineShared: 0,
        headlineLane: false,
        textFloorCapped: false,
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

  // 3. Entity ratio — `max` denominator + noise floor of 3. (`min` let a
  // 3-entity article score 3/3 against a 10-entity seed.)
  const aEntities = asSet(aEntitiesIn);
  const bEntities = asSet(bEntitiesIn);
  const sharedCount = setIntersectSize(aEntities, bEntities);
  const denom = Math.max(
    ENTITY_DENOM_MIN,
    Math.max(aEntities.size, bEntities.size),
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

  // 5. Headline lane — only when both titles are present. Fires on a high
  // stemmed-token Jaccard with enough shared tokens, inside the lane's own
  // hour limit, and with consistent numerals (a differing numeral means a
  // different development of the story).
  let headlineSim = 0;
  let headlineShared = 0;
  let headlineLane = false;
  if (aTitle && bTitle) {
    const ha = headlineTokens(aTitle);
    const hb = headlineTokens(bTitle);
    headlineShared = setIntersectSize(ha.tokens, hb.tokens);
    const union = ha.tokens.size + hb.tokens.size - headlineShared;
    headlineSim = union === 0 ? 0 : headlineShared / union;
    const numbersOk = ha.numbers.size === 0 || hb.numbers.size === 0 ||
      (ha.numbers.size === hb.numbers.size &&
        setIntersectSize(ha.numbers, hb.numbers) === ha.numbers.size);
    headlineLane = headlineShared >= HEADLINE_LANE_MIN_SHARED &&
      headlineSim >= HEADLINE_LANE_MIN_JACCARD &&
      hoursDelta <= HEADLINE_LANE_MAX_HOURS &&
      numbersOk;
  }
  const headlineScore = headlineLane ? 0.5 + 0.5 * headlineSim : 0;

  // 6. Combine. `primary` keeps its computed value; the text floor only
  // limits what it contributes to `raw`.
  const primary = TFIDF_WEIGHT * tfidfScore + ENTITY_WEIGHT * entityRatio;
  const textFloorCapped = !headlineLane && tfidfScore < ENTITY_TEXT_FLOOR;
  const primaryForRaw = textFloorCapped
    ? Math.min(primary, MATCH_THRESHOLD - 0.01)
    : primary;
  const raw = clip01(Math.max(jaccardScore, primaryForRaw, headlineScore));

  // 7. Time decay.
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
      headlineSim,
      headlineShared,
      headlineLane,
      textFloorCapped,
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
