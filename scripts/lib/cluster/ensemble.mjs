// scripts/lib/cluster/ensemble.mjs
//
// Ensemble scorer — W2-D3 rewrite.
//
// The old ensemble was a flat `0.5*tfidf + 0.5*entity` pair with a strict
// fingerprint auto-accept on top. R3's precision-audit
// (`team/logs/precision-audit.md`) showed that held recall to ~23% because:
//
//   1. Strict (4-gram shingle SHA-1) fingerprints are binary — 70/71
//      MHP-fesh articles hashed to distinct values, killing auto-accept.
//   2. The entity denominator used `max(|A|,|B|)`, so well-tagged long
//      articles were penalised (`shared/8 = 0.25` instead of
//      `shared/3 = 0.67`) — R2's `duplicate-audit.md` note.
//   3. At MATCH_THRESHOLD=0.55, every fragment scoring in the 0.45-0.55
//      band stayed split.
//
// This rewrite implements R3's top-three fixes as a single scorer that takes
// the D1-rewritten fingerprint bundles directly:
//
//   A. **MinHash Jaccard lane** (from D1's fingerprint.mjs). The bundled
//      fingerprint carries `signature: Uint32Array(64)`, and
//      `jaccardFromSignatures` gives us an unbiased Jaccard estimate. The
//      lane is shaped as a *ceiling-raiser*, not a hard auto-accept:
//
//          jaccardScore = J >= 0.6  ?  0.6 + 0.4*J  :  0.5*J
//
//      So J=0.6 contributes 0.84, J=1.0 contributes 1.0, and sub-0.6 values
//      fall back to a half-weighted background signal so near-misses still
//      nudge the primary lane.
//
//   B. **Entity denominator fix**: `shared / max(3, min(|A|,|B|))`. Using
//      `min` rewards small-but-tight overlap (R2 `duplicate-audit.md`); the
//      `max(3, ...)` noise floor stops a 2-entity ∩ 2-entity pair from
//      scoring 1.0 for free.
//
//   C. **Primary lane weights**: `0.35*tfidf + 0.65*entity` — entity-heavy
//      per R3 §4, because entity overlap is the single most discriminating
//      signal for Turkish political news.
//
// Final combination — the MinHash lane is a parallel ceiling, not a
// weighted third lane:
//
//     raw = max(jaccardScore, 0.35*tfidfScore + 0.65*entityRatio)
//     final = raw * max(0, 1 - hoursDelta/48)
//
// Either path can push a pair across threshold; neither dilutes the other.
//
// The strict-fingerprint auto-accept still sits on top and returns score=1.0
// unconditionally — identical 4-gram shingle sets mean "same wire copy,"
// which is the one signal we still trust unconditionally.
//
// 2026-11-01 recall wave (mirrors supabase/functions/_shared/cluster/ensemble.ts;
// tests/functions/_shared/cluster.test.ts pins the two byte-identical):
//
//   - The entity denominator is now `max(3, max(|A|,|B|))` (was `min`): a
//     3-entity article scored 3/3 against a 10-entity ceremony seed (prod
//     cluster dd5535a7). Section B above describes the original W2 design.
//   - D. Headline lane (ceiling-raiser): when both titles are passed via
//     opts.aTitle / opts.bTitle, near-identical headlines (>= 4 shared
//     stemmed tokens, token Jaccard >= 0.7, <= 6 h apart, numerals consistent)
//     score 0.5 + 0.5 * Jaccard regardless of tfidf / entities. Recovers
//     cross-outlet pairs whose descriptions differ (Sarigul, Bakirkoy).
//   - Text floor: unless the headline lane fired, a pair with tfidf below
//     ENTITY_TEXT_FLOOR has its primary lane capped just under
//     MATCH_THRESHOLD, so entities alone cannot join it.
//
//     raw = max(jaccardScore, primary (text-floor capped), headlineScore)
//
// Usage:
//
//   import { score } from "./ensemble.mjs";
//   const r = score(
//     newFingerprint,   // { strict, shingles, signature } from fingerprint()
//     candFingerprint,  // same shape
//     newEntities,      // Set<string> | Iterable<string>
//     candEntities,     // Set<string> | Iterable<string>
//     tfidfCosine,      // number ∈ [0,1]
//     hoursDelta,       // number ≥ 0 (|Δ| hours between publish times)
//   );
//   // r.score ∈ [0,1], r.components has the per-lane breakdown
//
// The `components` bag is intentionally verbose so `cluster-worker.mjs` can
// log it verbatim for per-pair explainability when MATCH_DEBUG=1.
//
// W2-D4 is the caller — `scripts/cluster-worker.mjs` is being adapted in
// parallel to build the fingerprint bundles and entity sets up-front and
// pass them into `score()` with the new 6-arg shape.

import {
  MATCH_THRESHOLD,
  TIME_WINDOW_HOURS,
  MIN_SHARED_ENTITIES,
  MINHASH_SOFT_ACCEPT_JACCARD,
  TFIDF_WEIGHT,
  ENTITY_WEIGHT,
  ENTITY_DENOM_MIN,
  ENTITY_FRESHNESS_HOURS,
  ENTITY_TEXT_FLOOR,
  HEADLINE_LANE_MAX_HOURS,
  HEADLINE_LANE_MIN_JACCARD,
  HEADLINE_LANE_MIN_SHARED,
} from "./constants.mjs";
import {
  headlineTokens,
  jaccardFromSignatures,
  fingerprint as buildFingerprint,
} from "./fingerprint.mjs";

// ---------------------------------------------------------------------------
// Per-source clustering penalties
// ---------------------------------------------------------------------------
//
// A8's source-diversity audit (`team/logs/quality/08-source-diversity.md`)
// found that `haberler-com` is a content-aggregator firehose: it produces
// 20.5% of the entire 24h corpus on its own (3,303 / 16,081 articles, 8x
// the #2 source) and dominates 16 of the top 30 homepage clusters. Because
// it reprints from many other outlets, its articles act as gravity wells —
// they collect entity overlap with everyone, so when they get picked as
// cluster seeds they drag otherwise-unrelated stories into the same cluster.
//
// R3 already shipped a homepage RANKING penalty for haberler-com. This is
// the complementary clustering-time fix: a small (15%) downweight on any
// pair score where either side is haberler-com. That makes haberler-com
// articles slightly less likely to be picked as a seed AND slightly less
// likely to drag other articles into existing clusters, without removing
// them from the corpus entirely.
//
// The map is keyed by `sources.slug` and is intentionally tiny — if other
// aggregator firehoses emerge, they get added here with their own multiplier.
const SOURCE_PENALTIES = {
  // A8 found haberler-com is a 20% firehose that distorts every metric.
  // Slight scoring penalty makes it less of a gravity well during clustering
  // without removing it from the corpus entirely. Tunable per-source if
  // other aggregators emerge.
  "haberler-com": 0.85,
};

// ---------------------------------------------------------------------------
// Entity freshness decay
// ---------------------------------------------------------------------------
//
// A1's cluster-glue audit found that otherwise-unrelated stories get merged
// when they happen to share a hot political entity (Erdoğan, MHP, …) that's
// being mentioned across many unrelated stories the same day. The time-window
// decay on the *final* score is too coarse to fix this: at 6h apart the
// 1 - Δt/48 decay only knocks ~12% off, which isn't enough to split a pair
// whose entity ratio carried them over threshold in the first place.
//
// Fix: decay the entity contribution itself on a tighter window. The
// ENTITY_FRESHNESS_HOURS constant (imported from constants.mjs) controls
// how quickly the entity signal decays. The 0.5 floor keeps late follow-ups
// reachable via a strong TF-IDF + MinHash lane; entity alone just stops
// carrying the pair across the 0.48 threshold after the floor engages.
//
// Formula (applied inside `score()`):
//
//     entityFreshness = max(0.5, 1 - hoursDelta / ENTITY_FRESHNESS_HOURS)
//     entityRatio    *= entityFreshness
//
// Tabulated (at ENTITY_FRESHNESS_HOURS = 6):
//       0h → max(0.5, 1 - 0/6)  = max(0.5, 1.000) = 1.000  (no decay)
//       1h → max(0.5, 1 - 1/6)  = max(0.5, 0.833) = 0.833
//       2h → max(0.5, 1 - 2/6)  = max(0.5, 0.667) = 0.667
//       3h → max(0.5, 1 - 3/6)  = max(0.5, 0.500) = 0.500  (floor engages)
//       6h → max(0.5, 1 - 6/6)  = max(0.5, 0.000) = 0.500  (floor holds)
//
// Previously 4h — the floor engaged at just 2h, halving the entity signal
// too aggressively for multi-hour developing stories. At 6h the floor
// engages at 3h: still tight enough to split unrelated hot-entity pairs
// while giving genuine follow-ups more room to merge.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clip01(x) {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function asSet(v) {
  if (v instanceof Set) return v;
  if (!v) return new Set();
  return new Set(v);
}

function setIntersectSize(a, b) {
  // Iterate the smaller set for speed.
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const x of small) if (big.has(x)) n++;
  return n;
}

// ---------------------------------------------------------------------------
// score()
// ---------------------------------------------------------------------------

/**
 * Score a (newArticle, candidate) pair using the W2-D3 ensemble.
 *
 * @param {{strict: string|null, shingles: Set<string>, signature: Uint32Array}} a
 *        New article fingerprint bundle from `fingerprint()` in fingerprint.mjs.
 * @param {{strict: string|null, shingles: Set<string>, signature: Uint32Array}} b
 *        Candidate fingerprint bundle.
 * @param {Iterable<string>|Set<string>} aEntitiesIn  New-article entity set.
 * @param {Iterable<string>|Set<string>} bEntitiesIn  Candidate entity set.
 * @param {number} tfidfCosine  TF-IDF cosine similarity (clipped to [0,1]).
 * @param {number} hoursDelta   |Δt| in hours between publication times.
 * @param {{aSourceSlug?: string, bSourceSlug?: string, aTitle?: string, bTitle?: string}} [opts]
 *        Optional per-side `sources.slug` strings. `aTitle` / `bTitle` feed
 *        the headline lane (inert unless both are non-empty). When either side is
 *        listed in `SOURCE_PENALTIES`, the smaller multiplier is applied to
 *        the final score (see A8 source-diversity audit, above). Callers
 *        that don't pass this opts bag get the legacy unpenalised behavior,
 *        so the existing 6-arg signature stays backwards-compatible.
 * @returns {{ score: number, components: object }}
 */
export function score(
  a,
  b,
  aEntitiesIn,
  bEntitiesIn,
  tfidfCosine,
  hoursDelta,
  opts = {},
) {
  const { aSourceSlug, bSourceSlug, aTitle, bTitle } = opts || {};
  // The smaller of the two configured multipliers wins — if EITHER side is
  // a penalised source, the pair gets downweighted. Default 1 = no penalty.
  const sourcePenalty = Math.min(
    SOURCE_PENALTIES[aSourceSlug] ?? 1,
    SOURCE_PENALTIES[bSourceSlug] ?? 1,
  );

  // -----------------------------------------------------------------------
  // 1. Strict fingerprint auto-accept.
  // -----------------------------------------------------------------------
  // Strongest signal we have: identical 4-gram shingle set after Turkish
  // normalization means the two articles are wire-copy of each other.
  // Per the W2-D3 brief, strict match → score = 1.0 unconditionally.
  // We still apply the per-source penalty here so a haberler-com wire-copy
  // pair doesn't get the full 1.0 free pass either — that's the whole point
  // of treating it as a firehose.
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

  // -----------------------------------------------------------------------
  // 2. MinHash Jaccard lane — ceiling-raiser.
  // -----------------------------------------------------------------------
  const jaccard =
    a && b && a.signature && b.signature
      ? clip01(jaccardFromSignatures(a.signature, b.signature))
      : 0;

  // Soft-accept shape: ≥0.6 → `0.6 + 0.4*J` (so 0.6 → 0.84, 1.0 → 1.0).
  // Below 0.6 → `0.5*J` as a background signal so near-misses still nudge
  // the primary lane through `max()`.
  const jaccardScore =
    jaccard >= MINHASH_SOFT_ACCEPT_JACCARD
      ? 0.6 + 0.4 * jaccard
      : 0.5 * jaccard;

  // -----------------------------------------------------------------------
  // 3. Entity ratio — `max` denominator + noise floor of 3.
  // -----------------------------------------------------------------------
  // `min` let a 3-entity article score 3/3 against a 10-entity seed.
  const aEntities = asSet(aEntitiesIn);
  const bEntities = asSet(bEntitiesIn);
  const sharedCount = setIntersectSize(aEntities, bEntities);
  const denom = Math.max(
    ENTITY_DENOM_MIN,
    Math.max(aEntities.size, bEntities.size),
  );
  const entityRatioRaw = denom === 0 ? 0 : clip01(sharedCount / denom);

  // A1 cluster-glue fix: decay the entity contribution on a 6h window so
  // the same hot entity (Erdoğan, MHP, …) mentioned hours apart in two
  // unrelated stories can't carry the pair over threshold on its own. See
  // the ENTITY_FRESHNESS_HOURS block at the top of this file for rationale.
  const entityFreshness = Math.max(
    0.5,
    1 - Math.max(0, hoursDelta) / ENTITY_FRESHNESS_HOURS,
  );
  const entityRatio = clip01(entityRatioRaw * entityFreshness);

  // -----------------------------------------------------------------------
  // 4. TF-IDF lane — clipped.
  // -----------------------------------------------------------------------
  const tfidfScore = clip01(tfidfCosine);

  // -----------------------------------------------------------------------
  // 5. Headline lane — only when both titles are present. Fires on a high
  //    stemmed-token Jaccard with enough shared tokens, inside the lane's own
  //    hour limit, and with consistent numerals (a differing numeral means a
  //    different development of the story).
  // -----------------------------------------------------------------------
  let headlineSim = 0;
  let headlineShared = 0;
  let headlineLane = false;
  if (aTitle && bTitle) {
    const ha = headlineTokens(aTitle);
    const hb = headlineTokens(bTitle);
    headlineShared = setIntersectSize(ha.tokens, hb.tokens);
    const union = ha.tokens.size + hb.tokens.size - headlineShared;
    headlineSim = union === 0 ? 0 : headlineShared / union;
    const numbersOk =
      ha.numbers.size === 0 ||
      hb.numbers.size === 0 ||
      (ha.numbers.size === hb.numbers.size &&
        setIntersectSize(ha.numbers, hb.numbers) === ha.numbers.size);
    headlineLane =
      headlineShared >= HEADLINE_LANE_MIN_SHARED &&
      headlineSim >= HEADLINE_LANE_MIN_JACCARD &&
      hoursDelta <= HEADLINE_LANE_MAX_HOURS &&
      numbersOk;
  }
  const headlineScore = headlineLane ? 0.5 + 0.5 * headlineSim : 0;

  // -----------------------------------------------------------------------
  // 6. Combine.
  // -----------------------------------------------------------------------
  // Primary lane is the weighted sum (tfidf heavy, entity tiebreaker). The
  // MinHash and headline lanes are parallel ceilings — whichever is largest
  // wins. `primary` keeps its computed value; the text floor only limits
  // what it contributes to `raw`.
  const primary = TFIDF_WEIGHT * tfidfScore + ENTITY_WEIGHT * entityRatio;
  const textFloorCapped = !headlineLane && tfidfScore < ENTITY_TEXT_FLOOR;
  const primaryForRaw = textFloorCapped
    ? Math.min(primary, MATCH_THRESHOLD - 0.01)
    : primary;
  const raw = clip01(Math.max(jaccardScore, primaryForRaw, headlineScore));

  // -----------------------------------------------------------------------
  // 7. Time decay.
  // -----------------------------------------------------------------------
  const timeDecay = Math.max(
    0,
    1 - Math.max(0, hoursDelta) / TIME_WINDOW_HOURS,
  );
  // Apply the per-source penalty (defaults to 1 = no-op when neither side
  // is in SOURCE_PENALTIES, so legacy callers see no change in behavior).
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

/**
 * Convenience predicate — does this pair clear the configured threshold?
 * Accepts either a raw score number or a `score()` result object.
 */
export function isMatch(scoreOrResult) {
  const n =
    typeof scoreOrResult === "number"
      ? scoreOrResult
      : scoreOrResult && typeof scoreOrResult.score === "number"
        ? scoreOrResult.score
        : -Infinity;
  return n >= MATCH_THRESHOLD;
}

export {
  MATCH_THRESHOLD,
  MIN_SHARED_ENTITIES,
  MINHASH_SOFT_ACCEPT_JACCARD,
  TFIDF_WEIGHT,
  ENTITY_WEIGHT,
};

// ---------------------------------------------------------------------------
// Self-test — `node scripts/lib/cluster/ensemble.mjs`
// ---------------------------------------------------------------------------
//
// Mission-brief tests (W2-D3):
//   1. Identical strict fingerprints → score = 1.0
//   2. MHP-fesh rewrites: different strict fp, Jaccard ≈ 0.75, entity
//      ratio ≈ 0.67, tfidf ≈ 0.3 → final score ≥ 0.48 (crosses threshold)
//   3. Completely unrelated (Jaccard 0, entity ratio 0, tfidf 0.1) → < 0.1
//   4. Time decay at 24 h → multiplier = 0.5

if (process.argv[1] === import.meta.url.replace("file://", "")) {
  let failed = 0;
  const assert = (cond, msg) => {
    if (!cond) {
      console.error("FAIL -", msg);
      failed++;
      return;
    }
    console.log("ok   -", msg);
  };

  // -------------------------------------------------------------------
  // Test 1: Identical strict fingerprints → score = 1.0
  // -------------------------------------------------------------------
  {
    const fpA = buildFingerprint(
      "Erdoğan açıklama yaptı",
      "Cumhurbaşkanı Erdoğan bugün kabine toplantısı sonrası açıklama yaptı",
    );
    const fpB = buildFingerprint(
      "Erdoğan açıklama yaptı",
      "Cumhurbaşkanı Erdoğan bugün kabine toplantısı sonrası açıklama yaptı",
    );
    const r = score(
      fpA,
      fpB,
      ["erdogan", "kabine"],
      ["erdogan", "kabine"],
      0.9,
      1.0,
    );
    assert(
      r.score === 1.0 && r.components.autoAccept === true,
      `Test 1 (strict auto-accept) → score=${r.score.toFixed(3)} (expect 1.000)`,
    );
  }

  // -------------------------------------------------------------------
  // Test 2: MHP-fesh rewrites — different strict fp, Jaccard ≈ 0.75,
  //         entity ratio ≈ 0.67, tfidf ≈ 0.3 → crosses 0.48.
  // -------------------------------------------------------------------
  //
  // We drive the ensemble with synthetic signatures (hand-built so Jaccard
  // is exactly 48/64 = 0.75) and hand-picked entity sets so the raw ratio
  // is 2 / max(3, min(3,3)) = 0.667. That reproduces the brief's fixture
  // numbers exactly without relying on a specific MinHash landing on
  // a specific Jaccard value for a specific pair of rewrites.
  //
  // Expected math (post-A1 entity freshness decay, ENTITY_FRESHNESS_HOURS=6):
  //   jaccardScore    = 0.6 + 0.4*0.75 = 0.9
  //   entityRatioRaw  = 2/3 ≈ 0.667
  //   entityFreshness @ 0.5h = max(0.5, 1 - 0.5/6) ≈ 0.9167
  //   entityRatio     = 0.667 * 0.9167 ≈ 0.6111
  //   primary         = 0.40*0.3 + 0.60*0.6111 = 0.12 + 0.3667 = 0.4867
  //   raw             = max(0.9, 0.4867) = 0.9
  //   timeDecay       = 1 - 0.5/48 ≈ 0.9896
  //   final           ≈ 0.8906  (well above 0.48)
  //
  // The MinHash lane carries this pair; the entity freshness trim drops
  // the primary lane below threshold on its own, which is the intended
  // A1 behavior — but the Jaccard ceiling-raiser still wins.
  {
    const sigA = new Uint32Array(64);
    const sigB = new Uint32Array(64);
    for (let i = 0; i < 64; i++) {
      sigA[i] = 1000 + i;
      sigB[i] = i < 48 ? sigA[i] : 9000 + i; // 48/64 match → J=0.75
    }
    const fpA = { strict: "mhp_a_hash", shingles: new Set(), signature: sigA };
    const fpB = { strict: "mhp_b_hash", shingles: new Set(), signature: sigB };

    // shared = 2 ("mhp", "istanbul"), each set has 3 entities → min = 3,
    // denom = max(3, 3) = 3, ratio = 2/3 ≈ 0.667.
    const aEnts = ["mhp", "istanbul", "teskilat"];
    const bEnts = ["mhp", "istanbul", "semih_yalcin"];
    const tfidfCosine = 0.3;
    const hoursDelta = 0.5;

    const r = score(fpA, fpB, aEnts, bEnts, tfidfCosine, hoursDelta);

    assert(
      Math.abs(r.components.jaccard - 0.75) < 1e-9,
      `Test 2 jaccard = ${r.components.jaccard.toFixed(3)} (expect 0.750)`,
    );
    assert(
      Math.abs(r.components.jaccardScore - 0.9) < 1e-9,
      `Test 2 jaccardScore = ${r.components.jaccardScore.toFixed(3)} (expect 0.900 = 0.6 + 0.4*0.75)`,
    );
    assert(
      Math.abs(r.components.entityRatioRaw - 2 / 3) < 1e-9,
      `Test 2 entityRatioRaw = ${r.components.entityRatioRaw.toFixed(3)} (expect 0.667 = 2/max(3,min(3,3)))`,
    );
    // ENTITY_FRESHNESS_HOURS = 6: freshness @ 0.5h = max(0.5, 1 - 0.5/6) ≈ 0.9167
    const expectedFreshness = 1 - 0.5 / ENTITY_FRESHNESS_HOURS;
    assert(
      Math.abs(r.components.entityFreshness - expectedFreshness) < 1e-9,
      `Test 2 entityFreshness @ 0.5h = ${r.components.entityFreshness.toFixed(4)} (expect ${expectedFreshness.toFixed(4)} = 1 - 0.5/${ENTITY_FRESHNESS_HOURS})`,
    );
    assert(
      Math.abs(r.components.entityRatio - (2 / 3) * expectedFreshness) < 1e-9,
      `Test 2 entityRatio (post-A1 decay) = ${r.components.entityRatio.toFixed(4)} (expect ${((2 / 3) * expectedFreshness).toFixed(4)} = 0.667*${expectedFreshness.toFixed(4)})`,
    );
    assert(
      r.score >= MATCH_THRESHOLD,
      `Test 2 final score = ${r.score.toFixed(3)} ≥ MATCH_THRESHOLD (${MATCH_THRESHOLD})`,
    );
    assert(
      isMatch(r),
      `Test 2 isMatch() → true`,
    );
  }

  // -------------------------------------------------------------------
  // Test 3: Completely unrelated. Jaccard 0, entity ratio 0, tfidf 0.1
  //         → final score < 0.1.
  // -------------------------------------------------------------------
  //
  // Expected math:
  //   jaccardScore = 0.5*0 = 0
  //   entityRatio  = 0/max(3, min(2,2)) = 0
  //   primary      = 0.35*0.1 + 0.65*0 = 0.035
  //   raw          = max(0, 0.035) = 0.035
  //   timeDecay    = 1 - 2/48 ≈ 0.9583
  //   final        ≈ 0.0335  (< 0.1)
  {
    const sigA = new Uint32Array(64);
    const sigB = new Uint32Array(64);
    for (let i = 0; i < 64; i++) {
      sigA[i] = 3000 + i;
      sigB[i] = 4000 + i; // 0 matching slots → Jaccard = 0
    }
    const fpA = { strict: "u_a", shingles: new Set(), signature: sigA };
    const fpB = { strict: "u_b", shingles: new Set(), signature: sigB };

    const aEnts = ["galatasaray", "fenerbahce"];
    const bEnts = ["bitcoin", "nasdaq"];
    const tfidfCosine = 0.1;
    const hoursDelta = 2;

    const r = score(fpA, fpB, aEnts, bEnts, tfidfCosine, hoursDelta);

    assert(
      r.components.jaccard === 0,
      `Test 3 jaccard = ${r.components.jaccard.toFixed(3)} (expect 0.000)`,
    );
    assert(
      r.components.entityRatio === 0,
      `Test 3 entityRatio = ${r.components.entityRatio.toFixed(3)} (expect 0.000)`,
    );
    assert(
      r.score < 0.1,
      `Test 3 final score = ${r.score.toFixed(4)} < 0.100`,
    );
  }

  // -------------------------------------------------------------------
  // Test 4: Time decay at 24 h → multiplier = 0.5.
  // -------------------------------------------------------------------
  {
    const sigA = new Uint32Array(64);
    const sigB = new Uint32Array(64);
    for (let i = 0; i < 64; i++) {
      sigA[i] = 5000 + i;
      sigB[i] = 6000 + i;
    }
    const fpA = { strict: "td_a", shingles: new Set(), signature: sigA };
    const fpB = { strict: "td_b", shingles: new Set(), signature: sigB };

    const r = score(fpA, fpB, ["x"], ["y"], 0.5, 24);
    assert(
      Math.abs(r.components.timeDecay - 0.5) < 1e-9,
      `Test 4 timeDecay @ 24h = ${r.components.timeDecay.toFixed(3)} (expect 0.500)`,
    );
  }

  if (failed > 0) {
    console.error(`\n${failed} test(s) FAILED`);
    process.exit(1);
  }
  console.log("\nensemble.mjs OK — all tests PASSED");
  process.exit(0);
}
