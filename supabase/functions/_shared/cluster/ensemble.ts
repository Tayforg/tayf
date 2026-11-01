// supabase/functions/_shared/cluster/ensemble.ts
//
// Ensemble scorer. Ported from `scripts/lib/cluster/ensemble.mjs`; the two
// must stay byte-identical (tests/functions/_shared/cluster.test.ts).
// Combines:
//   A. MinHash Jaccard lane (ceiling-raiser)
//   B. Entity ratio with `max(|A|,|B|)` denominator + noise floor of 3
//   C. TF-IDF cosine lane
//   D. Headline lane (ceiling-raiser): near-identical headlines from
//      different outlets, consistent numerals, within 6 h. Two variants:
//      Jaccard over the full token sets, and (when Jaccard does not fire)
//      containment of a short headline's words in a longer one (at most 2.5x
//      its size, so a roundup headline cannot swallow unrelated short ones)
// behind a strict-fingerprint auto-accept and a 48h time-window decay.
//
//   primary = 0.7*tfidf + 0.3*entityRatio
//   entityRatio numerator: generic whitelist entities (bakan, fidan, abd, ...)
//     weigh GENERIC_ENTITY_WEIGHT each, with a floor of one when anything is
//     shared (h12-cluster-2)
//   subject veto: when the headline lane did not fire and the two headlines'
//     subjects ("Lavrov," vs "Fidan,") are disjoint, primary and the MinHash
//     lane are capped at SUBJECT_VETO_CAP (h12-cluster-2)
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
  GENERIC_ENTITIES,
  GENERIC_ENTITY_WEIGHT,
  HEADLINE_CONTAIN_BLOCK_PREFIXES,
  HEADLINE_CONTAIN_MIN,
  HEADLINE_CONTAIN_MIN_SIZE_RATIO,
  HEADLINE_CONTAIN_MIN_TOKENS,
  HEADLINE_LANE_MAX_HOURS,
  HEADLINE_LANE_MIN_JACCARD,
  HEADLINE_LANE_MIN_SHARED,
  HEADLINE_LIVE_TITLE_MAX_HOURS,
  HEADLINE_SHORT_MIN_TOKENS,
  HEADLINE_TITLE_MAX_CHARS,
  MATCH_THRESHOLD,
  MIN_SHARED_ENTITIES,
  MINHASH_SOFT_ACCEPT_JACCARD,
  SUBJECT_SPAN_MAX_WORDS,
  SUBJECT_STOP_WORDS,
  SUBJECT_VETO_CAP,
  TFIDF_WEIGHT,
  TIME_WINDOW_HOURS,
} from "./constants.ts";
import {
  type FingerprintBundle,
  foldTurkishWord,
  type HeadlineTokens,
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
  // Entity numerator after weighting generic entities (>= 1 when anything is
  // shared); sharedEntities stays the raw count.
  sharedEntitiesWeighted?: number;
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
  // Which variant fired the headline lane (null when it did not), and the
  // share of the smaller headline's words (numerals excluded) that occur in
  // the larger one (0 without titles). Reported even when the lane did not
  // fire, so a near miss is visible in the components.
  headlineKind: HeadlineKind | null;
  headlineContainment: number;
  textFloorCapped: boolean;
  // True when the subject veto capped the pair (different actors, same
  // template); see subjectVetoFires().
  subjectVeto: boolean;
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

function sourcePenaltyFor(
  aSourceSlug: string | null | undefined,
  bSourceSlug: string | null | undefined,
): number {
  return Math.min(
    aSourceSlug ? SOURCE_PENALTIES[aSourceSlug] ?? 1 : 1,
    bSourceSlug ? SOURCE_PENALTIES[bSourceSlug] ?? 1 : 1,
  );
}

function timeDecayFor(hoursDelta: number): number {
  return Math.max(0, 1 - Math.max(0, hoursDelta) / TIME_WINDOW_HOURS);
}

// ---------------------------------------------------------------------------
// Headline lane
// ---------------------------------------------------------------------------

export type HeadlineKind = "jaccard" | "containment" | "live-title";

export interface HeadlineLaneResult {
  fired: boolean;
  kind: HeadlineKind | null;
  // Jaccard and intersection size over the FULL token sets (numerals included).
  sim: number;
  shared: number;
  // |S n L| / |S| over the word sets (numerals removed), S the smaller set.
  containment: number;
  // 0.5 + 0.5 * sim when fired, else 0.
  score: number;
}

// Tokens minus numerals. Returns the set itself when there are no numerals.
function wordsOf(h: HeadlineTokens): Set<string> {
  if (h.numbers.size === 0) return h.tokens;
  const out = new Set<string>();
  for (const t of h.tokens) if (!h.numbers.has(t)) out.add(t);
  return out;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && setIntersectSize(a, b) === a.size;
}

// True when a word that only the larger headline has starts with a denial /
// claim prefix.
function hasBlockedExtra(small: Set<string>, large: Set<string>): boolean {
  for (const t of large) {
    if (small.has(t)) continue;
    for (const p of HEADLINE_CONTAIN_BLOCK_PREFIXES) {
      if (t.startsWith(p)) return true;
    }
  }
  return false;
}

// Numeral values with leading zeros stripped ("007" -> "7"; "0" stays "0").
function numeralValues(nums: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const n of nums) out.add(n.replace(/^0+(?=\d)/, ""));
  return out;
}

/**
 * A numeral class shift: both headlines carry numerals, they share no value
 * and the numerals' digit lengths are disjoint -- {100, 1000} vs {19, 78}
 * ("100 il 1000 ilce" vs "19 yeni il ve 78 ilce"): two counts of one story,
 * not one count changing. A changed single slot (39 vs 40, 61 vs 39) keeps its
 * digit length and stays blocked.
 */
function numeralClassShift(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  const va = numeralValues(a);
  const vb = numeralValues(b);
  const lengthsA = new Set<number>();
  for (const v of va) {
    if (vb.has(v)) return false;
    lengthsA.add(v.length);
  }
  for (const v of vb) if (lengthsA.has(v.length)) return false;
  return true;
}

/**
 * Headline lane over two pre-tokenised headlines.
 *
 * Jaccard variant (unchanged since the 2026-11-01 recall wave): at least
 * HEADLINE_LANE_MIN_SHARED shared tokens, Jaccard >= HEADLINE_LANE_MIN_JACCARD
 * over the full token sets, within HEADLINE_LANE_MAX_HOURS, and consistent
 * numerals (either side without numerals, or identical numeral sets).
 *
 * Containment variant, evaluated only when the Jaccard variant did not fire:
 * with numerals removed, S the smaller word set and L the larger (a tie takes
 * `ha` as S; a tie cannot reach this branch, because 85% containment of equal
 * sets of >= 5 words already implies Jaccard >= 0.73), it fires iff |S| >=
 * HEADLINE_CONTAIN_MIN_TOKENS, |S n L| / |S| >= HEADLINE_CONTAIN_MIN,
 * |S| / |L| >= HEADLINE_CONTAIN_MIN_SIZE_RATIO (size guard: a roundup or
 * keyword-stuffed headline must not be "contained" by every unrelated short
 * headline), the numeral sets are equal (both empty is fine) or shifted to
 * another digit-length class (numeralClassShift), the pair is inside
 * HEADLINE_LANE_MAX_HOURS, and no word of L \ S starts with one of
 * HEADLINE_CONTAIN_BLOCK_PREFIXES.
 *
 * Short-identical variant, when neither of the above fired: the two token
 * sets are identical, have the same size in [HEADLINE_SHORT_MIN_TOKENS,
 * HEADLINE_LANE_MIN_SHARED), and the pair is inside HEADLINE_LANE_MAX_HOURS
 * ("Erdogan, Zelenskiy'i kabul etti" twice). Reported as kind 'jaccard'.
 *
 * Live-title variant: both headlines reduce to no tokens, carry the same
 * non-null liveKey (their normalised title) and are at most
 * HEADLINE_LIVE_TITLE_MAX_HOURS apart.
 *
 * score = 0.5 + 0.5 * sim for every variant.
 */
export function headlineLane(
  ha: HeadlineTokens,
  hb: HeadlineTokens,
  hoursDelta: number,
): HeadlineLaneResult {
  const shared = setIntersectSize(ha.tokens, hb.tokens);
  const union = ha.tokens.size + hb.tokens.size - shared;
  const sim = union === 0 ? 0 : shared / union;
  const inWindow = hoursDelta <= HEADLINE_LANE_MAX_HOURS;
  const numbersOk = ha.numbers.size === 0 || hb.numbers.size === 0 ||
    (ha.numbers.size === hb.numbers.size &&
      setIntersectSize(ha.numbers, hb.numbers) === ha.numbers.size);
  const jaccardFired = shared >= HEADLINE_LANE_MIN_SHARED &&
    sim >= HEADLINE_LANE_MIN_JACCARD &&
    inWindow &&
    numbersOk;

  const wa = wordsOf(ha);
  const wb = wordsOf(hb);
  const [small, large] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  const containment = small.size === 0
    ? 0
    : setIntersectSize(small, large) / small.size;
  // large.size >= small.size >= 1 whenever the token minimum below holds.
  const sizeRatio = large.size === 0 ? 0 : small.size / large.size;
  const containmentFired = !jaccardFired &&
    small.size >= HEADLINE_CONTAIN_MIN_TOKENS &&
    containment >= HEADLINE_CONTAIN_MIN &&
    sizeRatio >= HEADLINE_CONTAIN_MIN_SIZE_RATIO &&
    inWindow &&
    (sameSet(ha.numbers, hb.numbers) ||
      numeralClassShift(ha.numbers, hb.numbers)) &&
    !hasBlockedExtra(small, large);

  const shortFired = !jaccardFired && !containmentFired &&
    inWindow &&
    ha.tokens.size >= HEADLINE_SHORT_MIN_TOKENS &&
    ha.tokens.size < HEADLINE_LANE_MIN_SHARED &&
    sameSet(ha.tokens, hb.tokens);

  const liveFired = !jaccardFired && !containmentFired && !shortFired &&
    ha.tokens.size === 0 && hb.tokens.size === 0 &&
    ha.liveKey != null && ha.liveKey === hb.liveKey &&
    hoursDelta <= HEADLINE_LIVE_TITLE_MAX_HOURS;

  const fired = jaccardFired || containmentFired || shortFired || liveFired;
  return {
    fired,
    kind: jaccardFired || shortFired
      ? "jaccard"
      : containmentFired
      ? "containment"
      : liveFired
      ? "live-title"
      : null,
    sim,
    shared,
    containment,
    score: fired ? 0.5 + 0.5 * sim : 0,
  };
}

/**
 * The score a pair earns from the headline lane alone: the lane's score times
 * the same time decay and source penalty score() applies, or 0 when the lane
 * does not fire. Used to compare an incoming article with member headlines
 * that carry no fingerprint / entity / tfidf data in the consumer's context.
 */
export function headlineOnlyScore(
  ha: HeadlineTokens,
  hb: HeadlineTokens,
  hoursDelta: number,
  opts: { aSourceSlug?: string | null; bSourceSlug?: string | null } = {},
): number {
  const lane = headlineLane(ha, hb, hoursDelta);
  if (!lane.fired) return 0;
  return lane.score * timeDecayFor(hoursDelta) *
    sourcePenaltyFor(opts?.aSourceSlug, opts?.bSourceSlug);
}

// ---------------------------------------------------------------------------
// Subject veto (h12-cluster-2)
// ---------------------------------------------------------------------------

const SUBJECT_STOP: ReadonlySet<string> = new Set(SUBJECT_STOP_WORDS);
const GENERIC_ENTITY_SET: ReadonlySet<string> = new Set(GENERIC_ENTITIES);

interface HeadlineSubject {
  // Folded, capitalised, non-stop words before the first ',' (only when that
  // falls within the first SUBJECT_SPAN_MAX_WORDS words).
  span: Set<string>;
  // Every folded word of the (clipped) title.
  words: Set<string>;
}

// The comma that closes a subject ("Lavrov, Japon mevkidasi ..."): not the
// decimal comma between two digits ("2,5 saat"). A colon is deliberately NOT a
// break: "TBMM'de kritik hafta: ..." or "Zelenski: ..." name a venue, an
// institution or a speaker, and treating them as subjects vetoed same-story
// pairs ("TBMM'de ..." vs "Meclis'te ...", "MHP'den ..." vs "Bahceli ..."); see
// the evidence in constants.ts.
function subjectBreakIndex(word: string): number {
  for (let i = 0; i < word.length; i++) {
    if (word[i] !== ",") continue;
    const digitBefore = i > 0 && /\d/.test(word[i - 1]!);
    const digitAfter = i + 1 < word.length && /\d/.test(word[i + 1]!);
    if (digitBefore && digitAfter) continue;
    return i;
  }
  return -1;
}

function subjectOf(title: string): HeadlineSubject {
  const clipped = title.slice(0, HEADLINE_TITLE_MAX_CHARS);
  const words = new Set<string>();
  for (const w of foldTurkishWord(clipped).split(/[^a-z0-9]+/)) {
    if (w) words.add(w);
  }
  const span = new Set<string>();
  const raws = clipped.split(/\s+/).filter(Boolean);
  for (let i = 0; i < raws.length && i < SUBJECT_SPAN_MAX_WORDS; i++) {
    const raw = raws[i]!;
    const brk = subjectBreakIndex(raw);
    // The word the break is attached to still contributes its leading part.
    const head = brk === -1 ? raw : raw.slice(0, brk);
    // Strip an apostrophe suffix ("ABD'deki" -> "ABD"), keep capitalised words.
    const stem = head.split(/['’]/)[0] ?? "";
    const first = [...stem][0] ?? "";
    if (/\p{L}/u.test(first) && first !== first.toLocaleLowerCase("tr")) {
      // Same word boundaries as `words`: "Antalya-Alanya" is two words.
      for (const piece of foldTurkishWord(stem).split(/[^a-z0-9]+/)) {
        if (piece && !SUBJECT_STOP.has(piece)) span.add(piece);
      }
    }
    if (brk !== -1) return { span, words };
  }
  // No ',' inside the first SUBJECT_SPAN_MAX_WORDS words: no subject.
  return { span: new Set<string>(), words };
}

/**
 * True when the two headlines name different actors for the same template:
 * both have a non-empty subject span, the spans are disjoint, and no subject
 * word of either side occurs anywhere in the other headline ("Lavrov, Japon
 * mevkidasi ..." vs "Fidan, Atlanta'da Japon mevkidasiyla ...").
 */
function subjectVetoFires(aTitle: string, bTitle: string): boolean {
  const a = subjectOf(aTitle);
  const b = subjectOf(bTitle);
  if (a.span.size === 0 || b.span.size === 0) return false;
  for (const w of a.span) if (b.words.has(w)) return false;
  for (const w of b.span) if (a.words.has(w)) return false;
  return true;
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
  const sourcePenalty = sourcePenaltyFor(aSourceSlug, bSourceSlug);

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
        headlineKind: null,
        headlineContainment: 0,
        textFloorCapped: false,
        subjectVeto: false,
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
  // 3-entity article score 3/3 against a 10-entity seed.) Generic whitelist
  // entities (bakan, fidan, abd, ...) weigh GENERIC_ENTITY_WEIGHT each, with a
  // floor of one so a single shared generic entity keeps its old value.
  const aEntities = asSet(aEntitiesIn);
  const bEntities = asSet(bEntitiesIn);
  const sharedCount = setIntersectSize(aEntities, bEntities);
  let sharedWeight = 0;
  if (sharedCount > 0) {
    const [smallE, bigE] = aEntities.size <= bEntities.size
      ? [aEntities, bEntities]
      : [bEntities, aEntities];
    for (const e of smallE) {
      if (bigE.has(e)) {
        sharedWeight += GENERIC_ENTITY_SET.has(e) ? GENERIC_ENTITY_WEIGHT : 1;
      }
    }
  }
  const sharedEffective = Math.max(Math.min(sharedCount, 1), sharedWeight);
  const denom = Math.max(
    ENTITY_DENOM_MIN,
    Math.max(aEntities.size, bEntities.size),
  );
  const entityRatioRaw = denom === 0 ? 0 : clip01(sharedEffective / denom);

  // A1 cluster-glue fix: decay entity contribution on a 6h freshness window.
  const entityFreshness = Math.max(
    0.5,
    1 - Math.max(0, hoursDelta) / ENTITY_FRESHNESS_HOURS,
  );
  const entityRatio = clip01(entityRatioRaw * entityFreshness);

  // 4. TF-IDF lane — clipped.
  const tfidfScore = clip01(tfidfCosine);

  // 5. Headline lane -- only when both titles are present (see headlineLane()
  // for the two variants and their guards).
  let headlineSim = 0;
  let headlineShared = 0;
  let headlineContainment = 0;
  let headlineKind: HeadlineKind | null = null;
  let headlineFired = false;
  let headlineScore = 0;
  if (aTitle && bTitle) {
    const lane = headlineLane(
      headlineTokens(aTitle),
      headlineTokens(bTitle),
      hoursDelta,
    );
    headlineSim = lane.sim;
    headlineShared = lane.shared;
    headlineContainment = lane.containment;
    headlineKind = lane.kind;
    headlineFired = lane.fired;
    headlineScore = lane.score;
  }

  // 6. Combine. `primary` keeps its computed value; the text floor only
  // limits what it contributes to `raw`.
  const primary = TFIDF_WEIGHT * tfidfScore + ENTITY_WEIGHT * entityRatio;
  const textFloorCapped = !headlineFired && tfidfScore < ENTITY_TEXT_FLOOR;
  let primaryForRaw = textFloorCapped
    ? Math.min(primary, MATCH_THRESHOLD - 0.01)
    : primary;
  // Subject veto: different actors, same template. Never overrides a headline
  // lane that fired (the headlines already agree).
  const subjectVeto = !headlineFired && !!aTitle && !!bTitle &&
    subjectVetoFires(aTitle, bTitle);
  let jaccardForRaw = jaccardScore;
  if (subjectVeto) {
    primaryForRaw = Math.min(primaryForRaw, SUBJECT_VETO_CAP);
    jaccardForRaw = Math.min(jaccardScore, SUBJECT_VETO_CAP);
  }
  const raw = clip01(Math.max(jaccardForRaw, primaryForRaw, headlineScore));

  // 7. Time decay.
  const timeDecay = timeDecayFor(hoursDelta);
  const finalScore = raw * timeDecay * sourcePenalty;

  return {
    score: finalScore,
    components: {
      autoAccept: false,
      jaccard,
      jaccardScore,
      sharedEntities: sharedCount,
      sharedEntitiesWeighted: sharedEffective,
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
      headlineLane: headlineFired,
      headlineKind,
      headlineContainment,
      textFloorCapped,
      subjectVeto,
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
