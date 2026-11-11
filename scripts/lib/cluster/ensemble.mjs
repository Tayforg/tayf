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
//     Wave AB follow-up: when the Jaccard rule does not fire, a containment
//     variant fires for a short headline whose words (numerals excluded, >= 5)
//     are >= 85% contained in a longer one (at most 2.5x its size) with
//     identical numerals and no denial-prefixed extra word (`headlineLane()`,
//     kind "containment").
//     `headlineOnlyScore()` is the lane alone x time decay x source penalty.
//   - Text floor: unless the headline lane fired, a pair with tfidf below
//     ENTITY_TEXT_FLOOR has its primary lane capped just under
//     MATCH_THRESHOLD, so entities alone cannot join it.
//   - Incident veto (h16-precision-1): when the headline lane did not fire,
//     both headlines carry an incident word (kaza, yangin, deprem, ...) and
//     name provinces, and the two province sets are disjoint ("Duzce'de ...
//     kazada" vs "Bolu Dagi'nda ... kaza"), the primary and MinHash lanes are
//     capped at SUBJECT_VETO_CAP, like the subject veto (see provinces.mjs).
//   - Counter veto (h54-precision-1): both headlines carry ordinal counters
//     of the same recurring event ("104. duruşma" vs "105. duruşma", "2. tur",
//     "5. gün"), name the same SET of counter nouns (a "3. duruşmada 3. gün"
//     title is not compared with a bare "104. gün" one) and the numbers for a
//     noun of that set are disjoint, so the pair is two instalments of one
//     story: the same two lanes are capped at SUBJECT_VETO_CAP (see
//     counterVetoFires()).
//   - Homonym veto (h101-clustermembers-1): one headline names only a family
//     member or namesake of a surname ("Emine Erdogan'dan Karabag mesaji": every
//     Erdogan follows a given name of FAMILY_HOMONYM_GIVEN_NAMES) and the other
//     names the principal ("Cumhurbaskani Erdogan ...", "Erdogan, ...") without
//     ever naming that family member. No headline exemption: it withdraws the
//     headline lane (actorMismatchFires) and caps the primary and MinHash lanes
//     at SUBJECT_VETO_CAP, because the pair that started it joined on the
//     primary tf-idf + entity lane (see familyHomonymFires()).
//   - Template veto (h114-clusterpurity-2): two headlines share a statement or
//     budget template but name different speakers or ministries ("Bakan
//     Kurum'dan 10 Kasim ... mesaji" vs "Cumhurbaskani Erdogan'dan ...",
//     "Genclik ve Spor Bakanliginin ... butcesi" vs "Adalet Bakanligi butcesi").
//     No headline exemption: it withdraws the headline lane (actorMismatchFires)
//     and caps the primary and MinHash lanes at SUBJECT_VETO_CAP (see
//     templateActorMismatchFires()).
//   - Generic headline name conflict (h114-clusterpurity-4): when the headline
//     lane fired for two headlines of at most HEADLINE_GENERIC_MAX_TOKENS tokens
//     that name nobody and both CLEANED descriptions are given (score() opts
//     aDescription / bDescription), the lane is withdrawn like the actor veto
//     when the descriptions name different people (see
//     genericHeadlineNameConflict()).
//   - Actor veto (h70-mergequality-3): a headline-lane match must not cross
//     actors. When the lane fired but the two headlines name different actors
//     (comma subjects that are disjoint, or one comma subject against a
//     comma-less headline that leads with another named actor; see
//     actorMismatchFires()), the lane is withdrawn and the pair is judged as if
//     it had not fired: the text floor and the subject / incident vetoes apply
//     again. A role with no name ("MHP Lideri ...", "Cumhurbaskanimiz ..."), a
//     place word ("Bestepe'de ..."), a sentence-case label ("Beklenen aciklama:
//     ...") and one actor under its acronym ("AKP," vs "AK Parti,") are not
//     different actors (leadRun()). headlineOnlyScore() takes the same titles for
//     the member scan.
//
//   - Entity-sparse pairs (h19-recall-1): when either side has no whitelist
//     entity, primary = clip01(tfidf * ENTITY_SPARSE_TEXT_FACTOR) instead of
//     0.7*tfidf + 0.3*entityRatio (which could only reach 0.70 of the text
//     similarity). Applied before the text floor and the vetoes, which still
//     win.
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
  DESCRIPTION_NAME_STOP,
  MATCH_THRESHOLD,
  TIME_WINDOW_HOURS,
  MIN_SHARED_ENTITIES,
  MINHASH_SOFT_ACCEPT_JACCARD,
  TFIDF_WEIGHT,
  ENTITY_WEIGHT,
  ENTITY_DENOM_MIN,
  ENTITY_FRESHNESS_HOURS,
  ENTITY_SPARSE_TEXT_FACTOR,
  ENTITY_TEXT_FLOOR,
  HEADLINE_CONTAIN_BLOCK_PREFIXES,
  HEADLINE_CONTAIN_MIN,
  HEADLINE_CONTAIN_MIN_SIZE_RATIO,
  HEADLINE_CONTAIN_MIN_TOKENS,
  HEADLINE_GENERIC_MAX_TOKENS,
  HEADLINE_LANE_MAX_HOURS,
  HEADLINE_LANE_MIN_JACCARD,
  HEADLINE_LANE_MIN_SHARED,
  HEADLINE_LIVE_TITLE_MAX_HOURS,
  HEADLINE_SHORT_MIN_TOKENS,
  HEADLINE_TITLE_MAX_CHARS,
  FAMILY_HOMONYM_GIVEN_NAMES,
  FAMILY_HOMONYM_NOT_AFTER,
  GENERIC_ENTITIES,
  GENERIC_ENTITY_WEIGHT,
  INSTITUTION_HEAD_WORDS,
  STATEMENT_TEMPLATE_NOUNS,
  SUBJECT_SPAN_MAX_WORDS,
  SUBJECT_STOP_WORDS,
  SUBJECT_VETO_CAP,
  TEMPLATE_ACTOR_GENERIC_KEEP,
  TEMPLATE_PLACE_PHRASES,
} from "./constants.mjs";
import {
  foldTurkishWord,
  headlineTokens,
  jaccardFromSignatures,
  fingerprint as buildFingerprint,
} from "./fingerprint.mjs";
import { extractEntities } from "./entities.mjs";
import { hasIncidentWord, IL_NAMES, provincesIn } from "./provinces.mjs";

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

function sourcePenaltyFor(aSourceSlug, bSourceSlug) {
  // The smaller of the two configured multipliers wins -- if EITHER side is
  // a penalised source, the pair gets downweighted. Default 1 = no penalty.
  return Math.min(
    SOURCE_PENALTIES[aSourceSlug] ?? 1,
    SOURCE_PENALTIES[bSourceSlug] ?? 1,
  );
}

function timeDecayFor(hoursDelta) {
  return Math.max(0, 1 - Math.max(0, hoursDelta) / TIME_WINDOW_HOURS);
}

// ---------------------------------------------------------------------------
// Headline lane
// ---------------------------------------------------------------------------

// Tokens minus numerals. Returns the set itself when there are no numerals.
function wordsOf(h) {
  if (h.numbers.size === 0) return h.tokens;
  const out = new Set();
  for (const t of h.tokens) if (!h.numbers.has(t)) out.add(t);
  return out;
}

function sameSet(a, b) {
  return a.size === b.size && setIntersectSize(a, b) === a.size;
}

// True when a word that only the larger headline has starts with a denial /
// claim prefix.
function hasBlockedExtra(small, large) {
  for (const t of large) {
    if (small.has(t)) continue;
    for (const p of HEADLINE_CONTAIN_BLOCK_PREFIXES) {
      if (t.startsWith(p)) return true;
    }
  }
  return false;
}

// Numeral values with leading zeros stripped ("007" -> "7"; "0" stays "0").
function numeralValues(nums) {
  const out = new Set();
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
function numeralClassShift(a, b) {
  if (a.size === 0 || b.size === 0) return false;
  const va = numeralValues(a);
  const vb = numeralValues(b);
  const lengthsA = new Set();
  for (const v of va) {
    if (vb.has(v)) return false;
    lengthsA.add(v.length);
  }
  for (const v of vb) if (lengthsA.has(v.length)) return false;
  return true;
}

/**
 * Headline lane over two pre-tokenised headlines (`headlineTokens()` output).
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
 *
 * @param {{tokens: Set<string>, numbers: Set<string>, liveKey?: string|null}} ha
 * @param {{tokens: Set<string>, numbers: Set<string>, liveKey?: string|null}} hb
 * @param {number} hoursDelta
 * @returns {{fired: boolean, kind: "jaccard"|"containment"|"live-title"|null,
 *            sim: number, shared: number, containment: number, score: number}}
 */
export function headlineLane(ha, hb, hoursDelta) {
  const shared = setIntersectSize(ha.tokens, hb.tokens);
  const union = ha.tokens.size + hb.tokens.size - shared;
  const sim = union === 0 ? 0 : shared / union;
  const inWindow = hoursDelta <= HEADLINE_LANE_MAX_HOURS;
  const numbersOk =
    ha.numbers.size === 0 ||
    hb.numbers.size === 0 ||
    (ha.numbers.size === hb.numbers.size &&
      setIntersectSize(ha.numbers, hb.numbers) === ha.numbers.size);
  const jaccardFired =
    shared >= HEADLINE_LANE_MIN_SHARED &&
    sim >= HEADLINE_LANE_MIN_JACCARD &&
    inWindow &&
    numbersOk;

  const wa = wordsOf(ha);
  const wb = wordsOf(hb);
  const [small, large] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  const containment =
    small.size === 0 ? 0 : setIntersectSize(small, large) / small.size;
  // large.size >= small.size >= 1 whenever the token minimum below holds.
  const sizeRatio = large.size === 0 ? 0 : small.size / large.size;
  const containmentFired =
    !jaccardFired &&
    small.size >= HEADLINE_CONTAIN_MIN_TOKENS &&
    containment >= HEADLINE_CONTAIN_MIN &&
    sizeRatio >= HEADLINE_CONTAIN_MIN_SIZE_RATIO &&
    inWindow &&
    (sameSet(ha.numbers, hb.numbers) ||
      numeralClassShift(ha.numbers, hb.numbers)) &&
    !hasBlockedExtra(small, large);

  const shortFired =
    !jaccardFired &&
    !containmentFired &&
    inWindow &&
    ha.tokens.size >= HEADLINE_SHORT_MIN_TOKENS &&
    ha.tokens.size < HEADLINE_LANE_MIN_SHARED &&
    sameSet(ha.tokens, hb.tokens);

  const liveFired =
    !jaccardFired &&
    !containmentFired &&
    !shortFired &&
    ha.tokens.size === 0 &&
    hb.tokens.size === 0 &&
    ha.liveKey != null &&
    ha.liveKey === hb.liveKey &&
    hoursDelta <= HEADLINE_LIVE_TITLE_MAX_HOURS;

  const fired = jaccardFired || containmentFired || shortFired || liveFired;
  return {
    fired,
    kind:
      jaccardFired || shortFired
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
 * does not fire.
 *
 * @param {{tokens: Set<string>, numbers: Set<string>, liveKey?: string|null}} ha
 * @param {{tokens: Set<string>, numbers: Set<string>, liveKey?: string|null}} hb
 * @param {number} hoursDelta
 * @param {{aSourceSlug?: string|null, bSourceSlug?: string|null, aTitle?: string|null, bTitle?: string|null, aDescription?: string|null, bDescription?: string|null}} [opts]
 *        With both `aTitle` and `bTitle` the result is 0 when the two titles
 *        name different actors (actorMismatchFires, which includes a family
 *        member against the principal, familyHomonymFires), exactly as score()
 *        withdraws the lane for such a pair. With both `aDescription` and
 *        `bDescription` as well (the cleaned descriptions) it is also 0 for two
 *        generic headlines whose descriptions name different people
 *        (genericHeadlineNameConflict).
 * @returns {number}
 */
export function headlineOnlyScore(ha, hb, hoursDelta, opts = {}) {
  const lane = headlineLane(ha, hb, hoursDelta);
  if (!lane.fired) return 0;
  if (opts?.aTitle && opts?.bTitle) {
    if (actorMismatchFires(opts.aTitle, opts.bTitle)) return 0;
    if (
      genericHeadlineNameConflict(
        opts.aTitle,
        opts.bTitle,
        opts.aDescription,
        opts.bDescription,
      )
    ) {
      return 0;
    }
  }
  return (
    lane.score *
    timeDecayFor(hoursDelta) *
    sourcePenaltyFor(opts?.aSourceSlug, opts?.bSourceSlug)
  );
}

// ---------------------------------------------------------------------------
// Subject veto (h12-cluster-2)
// ---------------------------------------------------------------------------

const SUBJECT_STOP = new Set(SUBJECT_STOP_WORDS);
const GENERIC_ENTITY_SET = new Set(GENERIC_ENTITIES);

// ---------------------------------------------------------------------------
// Roles, names and acronyms (shared by the subject veto and the actor mismatch)
// ---------------------------------------------------------------------------

// Folded stems of role words, matched by PREFIX so possessive and derived forms
// count too ("cumhurbaskanimiz", "liderimiz", "bakanligi"). A role is never
// collected as a name.
const ROLE_PREFIXES = [
  "cumhurbaskan",
  "bakan",
  "baskan",
  "lider",
  "sozcu",
  "vali",
  "milletvekil",
  "yardimci",
];

function isRolePiece(piece) {
  for (const r of ROLE_PREFIXES) if (piece.startsWith(r)) return true;
  return false;
}

// The folded pieces collected so far from a run of capitalised words, plus the
// bookkeeping of the "terminal role" rule: the qualifier pieces before a role
// word ("MHP" in "MHP Lideri", "Saglik" in "Saglik Bakani") are dropped when no
// name follows that role. { entries: [{ piece, word }], segStart, pending }:
// `segStart` is the index into `entries` where the qualifier since the last role
// word begins; `pending` is { start, end } (entries[start, end) is the qualifier
// of the latest role phrase; revocable until a name follows it) or null.
function newNameRun() {
  return { entries: [], segStart: 0, pending: null };
}

// Feeds the folded pieces of one capitalised word (word index `word`). A role
// piece opens (or, right after another role piece, extends) a pending role
// phrase; a stop word is filler and changes nothing; any other piece is a name
// that closes the pending phrase (the qualifier stays) and is collected unless
// it is a generic entity and `skipGeneric` is set.
function feedPieces(run, pieces, word, skipGeneric) {
  for (const p of pieces) {
    if (isRolePiece(p)) {
      if (!(run.pending && run.entries.length === run.pending.end)) {
        run.pending = { start: run.segStart, end: run.entries.length };
      }
      run.segStart = run.entries.length;
    } else if (SUBJECT_STOP.has(p)) {
      // Filler ("genel", "eski", "disisleri"): neither a name nor a name after a role.
    } else {
      run.pending = null;
      if (!(skipGeneric && GENERIC_ENTITY_SET.has(p))) run.entries.push({ piece: p, word });
    }
  }
}

// Ends the run. A role still pending was terminal (nothing but the end of the
// run followed it): its qualifier pieces are dropped.
function finishRun(run) {
  if (run.pending) run.entries.splice(run.pending.start, run.pending.end - run.pending.start);
  run.pending = null;
  return run.entries;
}

// An all-caps token of 2+ letters ("MSB", "AKP", "TBMM", "AK").
function isAcronym(word) {
  let letters = 0;
  for (const ch of word) if (/\p{L}/u.test(ch)) letters++;
  return letters >= 2 && word === word.toLocaleUpperCase("tr");
}

// True when `acronym` is the concatenation, over `raws`, of each all-caps word
// whole and the first letter of every other word ("AKP" = AK + Parti, "MSB" =
// Milli Savunma Bakanligi, "TBMM" = Turkiye Buyuk Millet Meclisi).
function spellsAcronym(acronym, raws) {
  let spelled = "";
  for (const w of raws) spelled += isAcronym(w) ? w : ([...w][0] ?? "");
  return spelled.toLocaleUpperCase("tr") === acronym.toLocaleUpperCase("tr");
}

// One side's subject is a single all-caps token that spells the other side's
// capitalised words: the same actor under its short and long name.
function acronymAlias(aRaw, bRaw) {
  return (
    (aRaw.length === 1 && isAcronym(aRaw[0]) && spellsAcronym(aRaw[0], bRaw)) ||
    (bRaw.length === 1 && isAcronym(bRaw[0]) && spellsAcronym(bRaw[0], aRaw))
  );
}

// The comma that closes a subject ("Lavrov, Japon mevkidasi ..."): not the
// decimal comma between two digits ("2,5 saat"). A colon is deliberately NOT a
// break: "TBMM'de kritik hafta: ..." or "Zelenski: ..." name a venue, an
// institution or a speaker, and treating them as subjects vetoed same-story
// pairs ("TBMM'de ..." vs "Meclis'te ...", "MHP'den ..." vs "Bahceli ..."); see
// the evidence in constants.mjs.
function subjectBreakIndex(word) {
  for (let i = 0; i < word.length; i++) {
    if (word[i] !== ",") continue;
    const digitBefore = i > 0 && /\d/.test(word[i - 1]);
    const digitAfter = i + 1 < word.length && /\d/.test(word[i + 1]);
    if (digitBefore && digitAfter) continue;
    return i;
  }
  return -1;
}

// { span, words, raw }: `span` holds the folded, capitalised, non-stop words
// before the first ',' (only when that falls within the first
// SUBJECT_SPAN_MAX_WORDS words), minus the qualifier of a terminal role ("Saglik
// Bakani," names no actor: empty span); `words` every folded word of the
// (clipped) title; `raw` the raw (case kept, apostrophe suffix dropped)
// capitalised words of the subject before any stop-word or role removal, which
// the acronym-alias check spells ("AK Parti" -> AKP).
function subjectOf(title) {
  const clipped = title.slice(0, HEADLINE_TITLE_MAX_CHARS);
  const words = new Set();
  for (const w of foldTurkishWord(clipped).split(/[^a-z0-9]+/)) {
    if (w) words.add(w);
  }
  const run = newNameRun();
  const raw = [];
  const raws = clipped.split(/\s+/).filter(Boolean);
  for (let i = 0; i < raws.length && i < SUBJECT_SPAN_MAX_WORDS; i++) {
    const rawWord = raws[i];
    const brk = subjectBreakIndex(rawWord);
    // The word the break is attached to still contributes its leading part.
    const head = brk === -1 ? rawWord : rawWord.slice(0, brk);
    // Strip an apostrophe suffix ("ABD'deki" -> "ABD"), keep capitalised words.
    const stem = head.split(/['’]/)[0] ?? "";
    if (startsCapitalised(stem)) {
      raw.push(stem);
      // Same word boundaries as `words`: "Antalya-Alanya" is two words.
      feedPieces(run, foldTurkishWord(stem).split(/[^a-z0-9]+/).filter(Boolean), i, false);
    }
    if (brk !== -1) {
      // A subject whose last capitalised word is a role ("Saglik Bakani,",
      // "MHP Lideri,") names no actor: the qualifier before it is dropped.
      return { span: new Set(finishRun(run).map((e) => e.piece)), words, raw };
    }
  }
  // No ',' inside the first SUBJECT_SPAN_MAX_WORDS words: no subject.
  return { span: new Set(), words, raw: [] };
}

/**
 * True when the two headlines name different actors for the same template:
 * both have a non-empty subject span, the spans are disjoint, no subject word
 * of either side occurs anywhere in the other headline ("Lavrov, Japon
 * mevkidasi ..." vs "Fidan, Atlanta'da Japon mevkidasiyla ..."), and the two
 * subjects are not one actor under a short and a long name (a single all-caps
 * subject that spells the other side's words: "AKP," vs "AK Parti,"). A subject
 * whose last capitalised word is a role ("Saglik Bakani,", "MHP Lideri,") has an
 * empty span: a role is not a named actor. "Disisleri Bakani Fidan," keeps Fidan.
 */
function subjectVetoFires(aTitle, bTitle) {
  return subjectsDisjoint(subjectOf(aTitle), subjectOf(bTitle));
}

function subjectsDisjoint(a, b) {
  if (a.span.size === 0 || b.span.size === 0) return false;
  for (const w of a.span) if (b.words.has(w)) return false;
  for (const w of b.span) if (a.words.has(w)) return false;
  return !acronymAlias(a.raw, b.raw);
}

// ---------------------------------------------------------------------------
// Family homonym (h101-clustermembers-1)
// ---------------------------------------------------------------------------

// One title token: a run of letters and digits with its apostrophe suffix
// kept ("erdogan'dan"), or a single other non-space character, which is a
// break ("," ":" "-" quotes, emoji). Linear: the optional suffix starts at an
// apostrophe, which the run itself never contains.
const HOMONYM_TOKEN = /[\p{L}\p{N}]+(?:['\u2019\u02bc\u2018`\u00b4][\p{L}\p{N}]+)?|[^\s\p{L}\p{N}]/gu;
// The apostrophes a suffix may hang on.
const HOMONYM_APOSTROPHE = /['\u2019\u02bc\u2018`\u00b4]/;
// Invisible format characters (zero-width space / joiner, soft hyphen, BOM).
const INVISIBLE_FORMAT = /\p{Cf}/gu;
// Given name -> the words that, right before it, make it somebody's surname
// ("cevdet yilmaz"), so the surname after it is not preceded by a given name.
const HOMONYM_NOT_AFTER = new Map(
  Object.entries(FAMILY_HOMONYM_NOT_AFTER).map(([given, before]) => [given, new Set(before)]),
);

// The surnames with their given-name sets, built once (score() runs this per candidate).
const HOMONYM_SURNAMES = Object.entries(FAMILY_HOMONYM_GIVEN_NAMES).map(
  ([surname, names]) => [surname, new Set(names)],
);

// The title clipped to HEADLINE_TITLE_MAX_CHARS, composed to NFC (a decomposed "İ" is
// one letter), stripped of invisible format characters and folded.
function homonymFold(title) {
  return foldTurkishWord(
    title.slice(0, HEADLINE_TITLE_MAX_CHARS).normalize("NFC").replace(INVISIBLE_FORMAT, ""),
  );
}

// The words of a folded title, in order, an empty string standing for every
// punctuation break between them. A word keeps its apostrophe suffix; the surname
// test below drops it.
function homonymTokens(folded) {
  const out = [];
  for (const m of folded.matchAll(HOMONYM_TOKEN)) {
    const t = m[0];
    out.push(/^[\p{L}\p{N}]/u.test(t) ? t : "");
  }
  return out;
}

// How often `surname` occurs in `tokens` right after a given name of `givens`
// (the family reading) and how often it does not (the bare, principal reading:
// at the start, after a role, a comma or any other word, "Recep Tayyip Erdogan",
// "Cevdet Yilmaz Erdogan": a given name that follows HOMONYM_NOT_AFTER's word is
// a surname). `givensBefore` holds the given names that directly preceded the
// surname at its family occurrences.
function surnameReadings(tokens, surname, givens) {
  let family = 0;
  let bare = 0;
  const givensBefore = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "" || t.split(HOMONYM_APOSTROPHE, 1)[0] !== surname) continue;
    const prev = i > 0 ? tokens[i - 1] : "";
    if (givens.has(prev) && !HOMONYM_NOT_AFTER.get(prev)?.has(tokens[i - 2] ?? "")) {
      family++;
      givensBefore.add(prev);
    } else bare++;
  }
  return { family, bare, givensBefore };
}

// The given names of `givens` that `tokens` name anywhere, not only right before
// the surname ("Erdogan'in oglu Bilal ...", "Erdogan ve esi Emine Hanim ..."):
// a token's stem (apostrophe suffix dropped) is the name. A name that follows
// HOMONYM_NOT_AFTER's word is somebody's surname, not a given name ("Cevdet
// Yilmaz"), so it is skipped.
function namedGivens(tokens, givens) {
  const out = new Set();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "") continue;
    const stem = t.split(HOMONYM_APOSTROPHE, 1)[0];
    if (!givens.has(stem)) continue;
    if (HOMONYM_NOT_AFTER.get(stem)?.has(tokens[i - 1] ?? "")) continue;
    out.add(stem);
  }
  return out;
}

// True when the FAMILY side `x` and the PRINCIPAL side `y` are different people:
// no given name that preceded the surname in `x` is named anywhere in `y`.
function differentPeople(x, yTokens, givens) {
  const named = namedGivens(yTokens, givens);
  for (const g of x.givensBefore) if (named.has(g)) return false;
  return true;
}

/**
 * True when one headline names only a family member or namesake of a surname
 * and the other names the principal: "Emine Erdogan'dan Karabag mesaji" vs
 * "Cumhurbaskani Erdogan, Aliyev'in daveti uzerine ..." (prod cluster 94503853:
 * ten Emine Erdogan messages joined the President's Azerbaijan trip because the
 * two Erdogans share the surname, the whitelist entity and the subject span).
 *
 * Per surname S of FAMILY_HOMONYM_GIVEN_NAMES, over the folded words of each
 * title (clipped to HEADLINE_TITLE_MAX_CHARS, apostrophe suffixes dropped:
 * "Erdogan'dan" is erdogan; a punctuation mark between two words breaks them,
 * so "Cevdet Yilmaz, Erdogan'in ..." is not "Yilmaz Erdogan"):
 *   - FAMILY: S occurs, and every occurrence is directly preceded by a given
 *     name mapped for S ("Emine Erdogan", "Bilal Erdogan", "Yilmaz Erdogan");
 *     "Cevdet Yilmaz Erdogan" is not one (FAMILY_HOMONYM_NOT_AFTER: the
 *     Vice President's name, then the President's);
 *   - PRINCIPAL: S occurs at least once without such a name before it (bare,
 *     after a role, after "Recep Tayyip").
 * It fires when one title is FAMILY, the other is PRINCIPAL and that PRINCIPAL
 * title does not name the family member: none of the given names that preceded S
 * in the FAMILY title appears anywhere in the PRINCIPAL title, not only directly
 * before S ("Erdogan'in oglu Bilal ..." and "Erdogan ve esi Emine Hanim ..." name
 * Bilal and Emine, so "Bilal Erdogan ..." / "Emine Erdogan ..." do not fire
 * against them; a given name after a FAMILY_HOMONYM_NOT_AFTER word, "Cevdet
 * Yilmaz", is a surname and names nobody). So two FAMILY titles never fire, a
 * title naming both people ("Emine Erdogan ile Cumhurbaskani Erdogan
 * Seul'de karsilandi") never fires against either side, and a title without S
 * never fires. Pure and symmetric; false for anything that is not a string.
 *
 * @param {string} aTitle
 * @param {string} bTitle
 * @returns {boolean}
 */
export function familyHomonymFires(aTitle, bTitle) {
  if (typeof aTitle !== "string" || typeof bTitle !== "string") return false;
  if (aTitle === "" || bTitle === "") return false;
  const fa = homonymFold(aTitle);
  const fb = homonymFold(bTitle);
  let a;
  let b;
  for (const [surname, givens] of HOMONYM_SURNAMES) {
    // Both titles must hold the surname at all; tokenised only then, once.
    if (!fa.includes(surname) || !fb.includes(surname)) continue;
    a ??= homonymTokens(fa);
    b ??= homonymTokens(fb);
    const ra = surnameReadings(a, surname, givens);
    const rb = surnameReadings(b, surname, givens);
    // FAMILY side: family > 0 && bare === 0. PRINCIPAL side: bare > 0 && family === 0.
    if (ra.family > 0 && ra.bare === 0 && rb.bare > 0 && rb.family === 0 && differentPeople(ra, b, givens)) return true;
    if (rb.family > 0 && rb.bare === 0 && ra.bare > 0 && ra.family === 0 && differentPeople(rb, a, givens)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Actor mismatch (h70-mergequality-3)
// ---------------------------------------------------------------------------

// Words are compared by their first ACTOR_PREFIX_LEN folded letters, so one name
// in two inflections ("Sarigul" / "Sarigüller") is one actor.
const ACTOR_PREFIX_LEN = 5;

// Closing punctuation of a word of a title ("Celik," -> "Celik").
const TRAILING_PUNCTUATION = /[,:;!?"“”‘’'.]+$/;

function prefixesOf(words) {
  const out = new Set();
  for (const w of words) out.add(w.slice(0, ACTOR_PREFIX_LEN));
  return out;
}

// The capitalisation test subjectOf() and leadRun() apply to a word's stem.
function startsCapitalised(stem) {
  const first = [...stem][0] ?? "";
  return /\p{L}/u.test(first) && first !== first.toLocaleLowerCase("tr");
}

// A place word: the apostrophe suffix of a locative, ablative or dative
// ("Bestepe'de", "Silivri'den", "Meclis'e", "Ankara'ya"), folded: de da te ta
// den dan ten tan e a ye ya ne na.
const PLACE_SUFFIX = /^(?:[dt][ae]n?|[ny]?[ae])$/;

/**
 * The named actor a comma-less headline leads with: walks the first
 * SUBJECT_SPAN_MAX_WORDS words of `title` (clipped to HEADLINE_TITLE_MAX_CHARS)
 * and collects the folded pieces of the capitalised words that are neither a
 * role, a SUBJECT_STOP_WORDS filler word nor a GENERIC_ENTITIES word ("AK Parti
 * Sozcusu Celik Karabag ..." -> ak, parti, celik). `raw` holds the words the walk
 * passed, case kept, for the acronym-alias check.
 *
 * The walk ends, without collecting the word, at
 *   - the first word that has a piece sharing its ACTOR_PREFIX_LEN-letter prefix
 *     with `otherPrefixes` (the other headline's words: from there on the two
 *     titles agree),
 *   - the first word that is not capitalised, and
 *   - a place word: a word whose apostrophe suffix is a locative, ablative or
 *     dative ("Bestepe'de ...", "Silivri'den ...", "Meclis'e ...").
 * Three rules keep a title that merely opens with a label from naming an actor:
 *   - Roles by prefix (cumhurbaskan, bakan, baskan, lider, sozcu, vali,
 *     milletvekil, yardimci, so "Cumhurbaskanimiz" and "Liderimiz" count) are
 *     never collected, and nor are the stop words.
 *   - A terminal role drops its qualifier: when the walk ends right after a
 *     role (or runs out of words) with no name in between, the capitalised pieces
 *     before that role are discarded ("MHP Lideri CHP'nin ...", "IBB Baskani
 *     Silivri'den ...", "TC Cumhurbaskani Karabag ..." yield nothing), while a
 *     name after the role keeps them ("AK Parti Sozcusu Celik Karabag ..." ->
 *     ak, parti, celik).
 *   - A sentence-case capital is not a name: a run made only of word 0, with
 *     word 1 not capitalised ("Beklenen aciklama: ...", "Ummetin lideri ..."),
 *     counts only when word 0 is an all-caps token of 2+ letters ("MHP") or
 *     extractEntities() finds a non-generic whitelisted entity in it ("Bahceli").
 * By construction no collected piece shares a prefix with the other headline.
 * Returns { names: Set, raw: string[] }.
 */
function leadRun(title, otherPrefixes) {
  const raws = title.slice(0, HEADLINE_TITLE_MAX_CHARS).split(/\s+/).filter(Boolean);
  const stemOf = (rawWord) =>
    (rawWord ?? "").replace(TRAILING_PUNCTUATION, "").split(/['’]/)[0] ?? "";
  const run = newNameRun();
  const raw = [];
  for (let i = 0; i < raws.length && i < SUBJECT_SPAN_MAX_WORDS; i++) {
    const parts = raws[i].replace(TRAILING_PUNCTUATION, "").split(/['’]/);
    const stem = parts[0] ?? "";
    const pieces = foldTurkishWord(stem).split(/[^a-z0-9]+/).filter(Boolean);
    if (pieces.some((p) => otherPrefixes.has(p.slice(0, ACTOR_PREFIX_LEN)))) break;
    if (!startsCapitalised(stem)) break;
    if (parts.length > 1 && PLACE_SUFFIX.test(foldTurkishWord(parts[1]))) break;
    raw.push(stem);
    feedPieces(run, pieces, i, true);
  }
  const entries = finishRun(run);
  if (entries.length > 0 && entries.every((e) => e.word === 0) && !startsCapitalised(stemOf(raws[1]))) {
    // Sentence-case capital: only an acronym or a whitelisted name counts.
    const first = raw[0] ?? "";
    const named = isAcronym(first) || extractEntities(first).some((e) => !GENERIC_ENTITY_SET.has(e));
    if (!named) return { names: new Set(), raw };
  }
  return { names: new Set(entries.map((e) => e.piece)), raw };
}

// `a` has a comma subject, `b` has none, and `b` leads with a named actor that
// is not `a`'s: none of a's subject words occurs in b (by prefix), b's leading
// run of names (stopping where the titles meet) is non-empty, and it is not a's
// acronym spelled out ("AKP," vs "AK Parti ...").
function oneSidedActorMismatch(a, b, bTitle) {
  if (a.span.size === 0 || b.span.size !== 0) return false;
  const bPrefixes = prefixesOf(b.words);
  for (const w of a.span) if (bPrefixes.has(w.slice(0, ACTOR_PREFIX_LEN))) return false;
  const lead = leadRun(bTitle, prefixesOf(a.words));
  return lead.names.size > 0 && !acronymAlias(a.raw, lead.raw);
}

/**
 * True when the two headlines name different actors: the subject veto
 * (subjectVetoFires: comma subjects on both sides) or its one-sided form, where
 * only one headline has a comma subject and the other leads with a different
 * named actor (leadRun). "Cumhurbaskani Erdogan, Karabag Zaferi'nin 6. yilini
 * kutladi" and "AK Parti Sozcusu Celik Karabag Zaferi'nin 6. yilini kutladi" share
 * every word but the actor. Not an actor mismatch:
 *   - the same actor under a role: "Erdogan, Zelenskiy'i kabul etti" vs
 *     "Cumhurbaskani Erdogan Ukrayna Devlet Baskani Zelenskiy'i kabul etti";
 *   - a role with no name, with or without a qualifier: "Trump, ..." vs "ABD
 *     Baskani ...", "Bahceli, ..." vs "MHP Lideri ...", "Erdogan, ..." vs
 *     "Cumhurbaskanimiz ..." or "TC Cumhurbaskani ..." (the terminal-role rule);
 *   - a place or a sentence-case label: "Bestepe'de ...", "Beklenen aciklama: ...";
 *   - one actor under its acronym: "AKP," vs "AK Parti,", "MSB," vs "Milli Savunma
 *     Bakanligi,"; a role-only comma subject ("Saglik Bakani,") names no actor.
 * A single whitelisted name ("Erdogan, ..." vs "Bahceli ...") does count.
 * Also true for a family member against the principal that shares the surname
 * ("Emine Erdogan'dan ..." vs "Cumhurbaskani Erdogan ..."): their subject
 * spans overlap, so neither check above sees two actors (familyHomonymFires,
 * h101-clustermembers-1). Symmetric.
 */
export function actorMismatchFires(aTitle, bTitle) {
  const a = subjectOf(aTitle);
  const b = subjectOf(bTitle);
  return (
    subjectsDisjoint(a, b) ||
    oneSidedActorMismatch(a, b, bTitle) ||
    oneSidedActorMismatch(b, a, aTitle) ||
    familyHomonymFires(aTitle, bTitle) ||
    templateActorMismatchFires(aTitle, bTitle)
  );
}

// ---------------------------------------------------------------------------
// Template actor mismatch (h114-clusterpurity-2)
// ---------------------------------------------------------------------------

const PROVINCE_SET = new Set(IL_NAMES);
const TEMPLATE_KEEP_GENERIC = new Set(TEMPLATE_ACTOR_GENERIC_KEEP);
const TEMPLATE_PLACE_PHRASE_SET = new Set(TEMPLATE_PLACE_PHRASES);

// The suffix of a person's or place's ablative after an apostrophe, folded:
// dan den tan ten ("Kurum'dan", "Gurlek'ten").
const ABLATIVE_SUFFIX = /^[dt][ae]n$/;
// The same suffix behind a name that ends in a vowel takes the buffer n: ndan nden
// ("Memisoglu'ndan", "Dervisoglu'ndan"). Read by ablativeIn only after the institution
// head check, so "Bakanligi'ndan" keeps its head.
const BUFFER_ABLATIVE_SUFFIX = /^nd[ae]n$/;
const ENDS_IN_VOWEL = /[aeiou]$/;
// The end of an institution's ablative, folded: "bakanligindan", "mudurlugunden".
const INSTITUTION_ABLATIVE_END = /n?d[ae]n$/;
// A word that closes a clause: the word after it does not continue its name.
const CLAUSE_END = /[,;:!?.…]["”’')\]]*$/;

// A title word without the characters around it that are not part of it: leading
// quotes and brackets, closing punctuation. Its apostrophe suffix is kept.
function trimWord(raw) {
  return raw.replace(/^[^\p{L}\p{N}]+/u, "").replace(TRAILING_PUNCTUATION, "");
}

// The word before its first apostrophe ("Kurum'dan" -> "Kurum").
function stemOfWord(raw) {
  return trimWord(raw).split(HOMONYM_APOSTROPHE)[0] ?? "";
}

function clippedWords(title) {
  return title.slice(0, HEADLINE_TITLE_MAX_CHARS).split(/\s+/).filter(Boolean);
}

function foldedWordSet(title) {
  const words = new Set();
  for (const w of foldTurkishWord(title.slice(0, HEADLINE_TITLE_MAX_CHARS)).split(/[^a-z0-9]+/)) {
    if (w) words.add(w);
  }
  return words;
}

// True when some prefix of `a` is a prefix of `b`.
function sharePrefix(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

// The first word within the first SUBJECT_SPAN_MAX_WORDS that is an ablative: an
// apostrophe -dan/-den/-tan/-ten, or an institution head ending in -(n)dan/-(n)den.
function ablativeIn(raws) {
  const limit = Math.min(raws.length, SUBJECT_SPAN_MAX_WORDS);
  for (let i = 0; i < limit; i++) {
    const parts = trimWord(raws[i]).split(HOMONYM_APOSTROPHE);
    if ((parts[0] ?? "") === "") continue;
    if (parts.length > 1 && ABLATIVE_SUFFIX.test(foldTurkishWord(parts[1]))) return { index: i, head: null };
    const folded = foldTurkishWord(parts.join(""));
    if (!INSTITUTION_ABLATIVE_END.test(folded)) continue;
    const head = INSTITUTION_HEAD_WORDS.find((h) => folded.startsWith(h));
    if (head !== undefined) return { index: i, head };
    // A buffer-n ablative on a name ("Memisoglu'ndan"): a person, so no head.
    if (parts.length > 1 && BUFFER_ABLATIVE_SUFFIX.test(foldTurkishWord(parts[1])) &&
        ENDS_IN_VOWEL.test(foldTurkishWord(parts[0]))) {
      return { index: i, head: null };
    }
  }
  return null;
}

// True when a STATEMENT_TEMPLATE_NOUNS word (a folded prefix) occurs from word `from` on.
function hasStatementNoun(raws, from) {
  for (let i = from; i < raws.length; i++) {
    const folded = foldTurkishWord(raws[i]).replace(/[^a-z0-9]/g, "");
    for (const noun of STATEMENT_TEMPLATE_NOUNS) if (folded.startsWith(noun)) return true;
  }
  return false;
}

// The speaker of a "<actor>'dan <...> <statement noun>" headline, or null when the
// title is not one or names no actor (only roles, or a place: "Ankara'dan ...").
function templateSideOf(title) {
  const raws = clippedWords(title);
  const ablative = ablativeIn(raws);
  if (ablative === null || !hasStatementNoun(raws, ablative.index + 1)) return null;
  const key = new Set();
  const raw = [];
  let bakanRole = false;
  let hasRole = false;
  let namedWords = 0;
  for (let i = 0; i <= ablative.index; i++) {
    const stem = stemOfWord(raws[i]);
    const pieces = foldTurkishWord(stem).split(/[^a-z0-9]+/).filter(Boolean);
    // A role counts in any case ("BBP lideri Destici'den").
    if (i < ablative.index && pieces.some(isRolePiece)) hasRole = true;
    if (!startsCapitalised(stem)) continue;
    raw.push(stem);
    let named = false;
    for (const piece of pieces) {
      if (piece.startsWith("bakan") && !piece.startsWith("bakanl")) bakanRole = true;
      if (i === ablative.index && ablative.head !== null) continue; // the institution head itself
      if (isRolePiece(piece) || SUBJECT_STOP.has(piece) || PROVINCE_SET.has(piece)) continue;
      if (GENERIC_ENTITY_SET.has(piece) && !TEMPLATE_KEEP_GENERIC.has(piece)) continue;
      key.add(piece);
      named = true;
    }
    if (named) namedWords++;
  }
  if (key.size === 0) return null;
  // A party speaks through its people ("YENI Parti'den ..." is "Gokhan Gunaydin'dan ...").
  const stemFolded = foldTurkishWord(stemOfWord(raws[ablative.index]));
  if (stemFolded === "parti" || stemFolded === "partisi") return null;
  // A country or seat of power written as two words ("Kuzey Kore'den", "Beyaz
  // Saray'dan") is a bare word as well: two capitalised words, but no full name.
  if (!hasRole && ablative.head === null &&
      TEMPLATE_PLACE_PHRASE_SET.has(raw.map((w) => foldTurkishWord(w)).join(" "))) {
    return null;
  }
  // A speaker: an institution head, a role ("Bakan Kurum'dan"), a full name ("Emine
  // Erdogan'dan") or one of the persons of TEMPLATE_ACTOR_GENERIC_KEEP. A bare word
  // ("Iran'dan", "Tahran'dan", "Kremlin'den", "MHP'den", "Kalibaf'tan") is as likely a
  // country, a seat of power or a party as a person, and each of them speaks through
  // its people, so it is no actor to tell apart (nor is a TEMPLATE_PLACE_PHRASES one).
  const speaker = ablative.head !== null || hasRole || namedWords >= 2 ||
    (key.size === 1 && TEMPLATE_KEEP_GENERIC.has([...key][0]));
  if (!speaker) return null;
  return {
    keyPrefixes: prefixesOf(key),
    wordPrefixes: prefixesOf(foldedWordSet(title)),
    raw,
    bakanRole,
    bakanligHead: ablative.head !== null && ablative.head.startsWith("bakanlig"),
  };
}

// True when an all-caps word of `x` spells the capitalised words of `y` ("MSB" in
// "MSB Sozcusu Aktürk'ten" against "Milli Savunma Bakanligindan"): the same actor under
// its short and long name, where acronymAlias needs the acronym to be the whole side.
function acronymIn(x, y) {
  return x.some((w) => isAcronym(w) && spellsAcronym(w, y));
}

// R1: both titles are statements of an ablative speaker and the speakers differ.
function statementActorsDiffer(aTitle, bTitle) {
  const a = templateSideOf(aTitle);
  if (a === null) return false;
  const b = templateSideOf(bTitle);
  if (b === null) return false;
  if (sharePrefix(a.keyPrefixes, b.keyPrefixes)) return false;
  // A name of one speaker anywhere in the other title ("Emine Erdogan'dan ..." led by
  // "Ataturk'u saygiyla andi: Emine Erdogan'dan ...") is the same speaker.
  if (sharePrefix(a.keyPrefixes, b.wordPrefixes) || sharePrefix(b.keyPrefixes, a.wordPrefixes)) return false;
  if (acronymAlias(a.raw, b.raw) || acronymIn(a.raw, b.raw) || acronymIn(b.raw, a.raw)) return false;
  // A minister against a ministry is ambiguous ("Bakan Simsek'ten ..." vs "Hazine ve
  // Maliye Bakanligindan ...").
  return !((a.bakanRole && b.bakanligHead) || (b.bakanRole && a.bakanligHead));
}

// The capitalised words (and 've') directly before each word that starts with
// 'bakanlig', nearest first: the name of every ministry the title mentions. A clause
// end or a lower-case word ends a name.
function ministryNameWords(raws) {
  const out = [];
  for (let h = 0; h < raws.length; h++) {
    if (!foldTurkishWord(stemOfWord(raws[h])).startsWith("bakanlig")) continue;
    const stems = [];
    for (let k = h - 1; k >= 0; k--) {
      const word = raws[k];
      if (CLAUSE_END.test(word)) break;
      const stem = stemOfWord(word);
      if (foldTurkishWord(stem) === "ve") continue;
      if (!startsCapitalised(stem)) break;
      stems.push(stem);
    }
    out.push(stems);
  }
  return out;
}

// The ministries a title names: the capitalised words (and 've') directly before a
// word that starts with 'bakanlig', folded, without roles and the connector.
function ministryNames(title) {
  const out = new Set();
  for (const stems of ministryNameWords(clippedWords(title))) {
    for (const stem of stems) {
      for (const piece of foldTurkishWord(stem).split(/[^a-z0-9]+/)) {
        if (piece && !isRolePiece(piece)) out.add(piece);
      }
    }
  }
  return out;
}

// True when an all-caps word of `a` is the acronym of a ministry `b` names: the first
// letters of the capitalised words before its 'bakanlig' word, plus B ("Milli Egitim
// Bakanligi" = MEB, "Genclik ve Spor Bakanligi" = GSB, "Milli Savunma Bakanligi" = MSB).
function acronymNamesMinistry(a, b) {
  const tokens = new Set();
  for (const w of clippedWords(a)) {
    const stem = stemOfWord(w);
    if (isAcronym(stem)) tokens.add(stem.toLocaleUpperCase("tr"));
  }
  if (tokens.size === 0) return false;
  for (const stems of ministryNameWords(clippedWords(b))) {
    if (stems.length === 0) continue;
    let acronym = "B";
    for (const stem of stems) acronym = ([...stem][0] ?? "") + acronym;
    if (tokens.has(acronym.toLocaleUpperCase("tr"))) return true;
  }
  return false;
}

// R2: both titles name ministries, and the two sets of names are disjoint.
function ministriesDiffer(aTitle, bTitle) {
  const a = ministryNames(aTitle);
  if (a.size === 0) return false;
  const b = ministryNames(bTitle);
  if (b.size === 0) return false;
  const pa = prefixesOf(a);
  const pb = prefixesOf(b);
  if (sharePrefix(pa, pb)) return false;
  if (sharePrefix(pa, prefixesOf(foldedWordSet(bTitle))) || sharePrefix(pb, prefixesOf(foldedWordSet(aTitle)))) return false;
  // A ministry under its acronym in the other title ("MEB" for "Milli Egitim Bakanligi").
  return !(acronymNamesMinistry(aTitle, bTitle) || acronymNamesMinistry(bTitle, aTitle));
}

/**
 * True when two headlines share a statement or budget template but name different
 * speakers or ministries (h114-clusterpurity-2). Pure, symmetric, false for anything
 * that is not a non-empty string. Either rule fires it; both read the title clipped
 * to HEADLINE_TITLE_MAX_CHARS and compare words by their first ACTOR_PREFIX_LEN
 * folded letters.
 *
 * R1, ablative statement template ("Bakan Kurum'dan 10 Kasim Ataturk'u Anma Gunu
 * mesaji" vs "Cumhurbaskani Erdogan'dan ..."). Per title: the first of the first
 * SUBJECT_SPAN_MAX_WORDS words that is an ablative -- an apostrophe suffix that is
 * dan, den, tan or ten (ndan / nden behind a name that ends in a vowel:
 * "Memisoglu'ndan"), or a word that starts with an INSTITUTION_HEAD_WORDS prefix
 * and ends in -(n)dan / -(n)den ("Bakanliginden") -- with a STATEMENT_TEMPLATE_NOUNS
 * word after it. The actor key is the folded pieces of the capitalised words from
 * the title start up to and including the ablative, less roles, stop words,
 * GENERIC_ENTITIES (except the persons of TEMPLATE_ACTOR_GENERIC_KEEP), provinces
 * and the institution head itself; the qualifier before a head stays ("Milli
 * Savunma Bakanligindan" -> milli, savunma). A title with no key (only roles, or a
 * place: "Ankara'dan ...", "Bakanliktan ...") never fires, and neither does one whose
 * actor is not a speaker: a party ("YENI Parti'den ..."), a bare word that is no
 * person of TEMPLATE_ACTOR_GENERIC_KEEP ("Iran'dan", "Tahran'dan", "Kremlin'den",
 * "MHP'den", "Kalibaf'tan") and a country or seat of power written as two words
 * (TEMPLATE_PLACE_PHRASES: "Kuzey Kore'den", "Beyaz Saray'dan", unless a role comes
 * before it) speak through their people, so they are not told apart;
 * a speaker is an institution head, a role ("Bakan Kurum'dan"), a full name ("Emine
 * Erdogan'dan") or one of those persons. It fires when both keys
 * exist, share no prefix, no key piece occurs (by prefix) anywhere in the other
 * title, the two are not one actor under an acronym (a side that is the acronym
 * alone, "MSB'den" vs "Milli Savunma Bakanligindan", or an all-caps word of one side
 * that spells the other side's capitalised words, "MSB Sozcusu Aktürk'ten" vs the
 * same ministry), and it is not a minister against a ministry ("Bakan Simsek'ten"
 * vs "Hazine ve Maliye Bakanligindan": ambiguous).
 *
 * R2, named ministries ("Genclik ve Spor Bakanliginin 2027 yili butcesi ..." vs "Adalet
 * Bakanligi butcesi ..."). A title names the ministries whose 'bakanlig...' word it
 * has, by the capitalised words (and 've') directly before it. It fires when both
 * titles name a ministry, the two name sets share no prefix, no name occurs in the
 * other title and no all-caps word of one title is the acronym of a ministry the
 * other names ("MEB" for "Milli Egitim Bakanligi": the first letters of its name
 * words plus B); a title naming both ministries never fires.
 *
 * @param {string} aTitle
 * @param {string} bTitle
 * @returns {boolean}
 */
export function templateActorMismatchFires(aTitle, bTitle) {
  if (typeof aTitle !== "string" || typeof bTitle !== "string") return false;
  if (aTitle === "" || bTitle === "") return false;
  return statementActorsDiffer(aTitle, bTitle) || ministriesDiffer(aTitle, bTitle);
}

// ---------------------------------------------------------------------------
// Generic headline, different people (h114-clusterpurity-4)
// ---------------------------------------------------------------------------

// Only the first part of a description is read: the lead names who the story is about.
const DESCRIPTION_NAME_SPAN = 240;
// A word that ends a sentence ("alindi.", "mi?", "...").
const SENTENCE_END = /[.!?…]["”’')\]]*$/;

// True when a title holds a capitalised word after word 0 that is more than a role, a
// stop word or a generic entity: it names somebody (or something), so it is not generic.
function namesSomebody(title) {
  const raws = clippedWords(title);
  for (let i = 1; i < raws.length; i++) {
    const stem = stemOfWord(raws[i]);
    if (!startsCapitalised(stem)) continue;
    for (const piece of foldTurkishWord(stem).split(/[^a-z0-9]+/)) {
      if (!piece) continue;
      if (!(isRolePiece(piece) || SUBJECT_STOP.has(piece) || GENERIC_ENTITY_SET.has(piece))) return true;
    }
  }
  return false;
}

// A headline token this short ("fon", "ara") is no event word.
const EVENT_STEM_MIN_LEN = 4;

// The folded pieces of the proper-name runs in the first DESCRIPTION_NAME_SPAN
// characters of a cleaned description: maximal runs of two or more consecutive
// capitalised words (apostrophe suffixes stripped; a word that closes a clause ends
// its run), less the sentence-initial word of a run and the pieces that are roles,
// stop words, generic entities or company / board words (DESCRIPTION_NAME_STOP).
// Only a run that the headline's own event word follows directly counts ("Enver Cevik
// GOZALTINA alindi", "Murat Yonac TUTUKLANDI"): that is the person the headline is
// about. A name elsewhere in the lead ("ABD Baskani Donald Trump", "Cumhuriyet
// Bassavciligi") is another story's person at least as often as another person of
// this one -- the same-story pairs of the replay named them all -- so it is not read.
function descriptionNamePieces(description, eventStems) {
  const text = description.slice(0, DESCRIPTION_NAME_SPAN);
  const out = new Set();
  const entries = [];
  let initial = true;
  let prevEnd = 0;
  for (const m of text.matchAll(/\S+/g)) {
    const word = m[0];
    const at = m.index ?? 0;
    if (text.slice(prevEnd, at).includes("\n")) initial = true;
    const stem = stemOfWord(word);
    entries.push({ word, stem, cap: startsCapitalised(stem), initial });
    initial = SENTENCE_END.test(word);
    prevEnd = at + word.length;
  }
  let i = 0;
  while (i < entries.length) {
    if (!entries[i].cap) {
      i++;
      continue;
    }
    let j = i;
    while (!CLAUSE_END.test(entries[j].word) && j + 1 < entries.length && entries[j + 1].cap) j++;
    const closed = CLAUSE_END.test(entries[j].word);
    const next = entries[j + 1];
    if (j > i && !closed && next !== undefined) {
      const folded = foldTurkishWord(next.word).replace(/[^a-z0-9]/g, "");
      if (eventStems.some((stem) => folded.startsWith(stem))) {
        for (let k = i; k <= j; k++) {
          const w = entries[k];
          if (w.initial) continue;
          for (const piece of foldTurkishWord(w.stem).split(/[^a-z0-9]+/)) {
            if (!piece || isRolePiece(piece) || SUBJECT_STOP.has(piece) || GENERIC_ENTITY_SET.has(piece)) continue;
            if (DESCRIPTION_NAME_STOP.some((p) => piece.startsWith(p))) continue;
            out.add(piece);
          }
        }
      }
    }
    i = j + 1;
  }
  return out;
}

/**
 * True when two GENERIC headlines that matched on the headline lane are about
 * different people, which only their descriptions say (h114-clusterpurity-4: 'Fon
 * sorusturmasinda yeni gozalti' for Enver Cevik's detention and for Omer Murat
 * Gulkan's). The caller applies it to a pair the lane fired for, with the CLEANED
 * descriptions (cleanDescription). Pure, symmetric, false for anything that is not a
 * non-empty string.
 *
 * It applies only when the shorter title has at most HEADLINE_GENERIC_MAX_TOKENS
 * headline tokens and neither title holds a capitalised word after word 0 that is not
 * a role, a SUBJECT_STOP_WORDS word or a GENERIC_ENTITIES word (a title that names the
 * person is judged by the actor rules, not by this one). Then, from the first 240
 * characters of each description it reads the proper-name runs -- maximal runs of 2+
 * consecutive capitalised words, apostrophe suffixes stripped -- drops the
 * sentence-initial word and the pieces matching ROLE_PREFIXES, DESCRIPTION_NAME_STOP,
 * SUBJECT_STOP_WORDS and GENERIC_ENTITIES, and folds what remains. It fires when both
 * piece sets are non-empty and share no ACTOR_PREFIX_LEN prefix.
 *
 * Tightening over the first draft (h115 replay): of the runs only those that are
 * directly followed by a word starting with a headline token of 4+ letters count (the
 * person the headline's own event word is about: "Enver Cevik gozaltina alindi" for
 * 'gozalti'). Without it 12 of the 13 conflicts the 7-day replay found were the same
 * story told with different names in the lead (a BDDK deputy chairman and the
 * Istanbul prosecutor's office on the same arrests, 'Resmi Gazete' against the
 * President on the same rector appointments, KEPCO against Seoul's companies on the
 * same audience); with it exactly one fires, the cgtn-turk / cumhuriyet pair.
 *
 * @param {string} aTitle
 * @param {string} bTitle
 * @param {string|null|undefined} aDescription
 * @param {string|null|undefined} bDescription
 * @returns {boolean}
 */
export function genericHeadlineNameConflict(aTitle, bTitle, aDescription, bDescription) {
  if (typeof aTitle !== "string" || typeof bTitle !== "string") return false;
  if (typeof aDescription !== "string" || typeof bDescription !== "string") return false;
  if (aTitle === "" || bTitle === "" || aDescription === "" || bDescription === "") return false;
  const shorter = Math.min(headlineTokens(aTitle).tokens.size, headlineTokens(bTitle).tokens.size);
  if (shorter > HEADLINE_GENERIC_MAX_TOKENS) return false;
  if (namesSomebody(aTitle) || namesSomebody(bTitle)) return false;
  const eventStems = new Set();
  for (const title of [aTitle, bTitle]) {
    for (const token of headlineTokens(title).tokens) {
      if (token.length >= EVENT_STEM_MIN_LEN && !/^\d+$/.test(token)) eventStems.add(token);
    }
  }
  const stems = [...eventStems];
  const a = descriptionNamePieces(aDescription, stems);
  if (a.size === 0) return false;
  const b = descriptionNamePieces(bDescription, stems);
  if (b.size === 0) return false;
  return !sharePrefix(prefixesOf(a), prefixesOf(b));
}

// ---------------------------------------------------------------------------
// Incident province veto (h16-precision-1)
// ---------------------------------------------------------------------------

/**
 * True when the two headlines report incidents in different provinces: both
 * (clipped to HEADLINE_TITLE_MAX_CHARS) carry an incident word, both name at
 * least one province, and the two province sets are disjoint. A side that
 * names no province ("Anadolu Otoyolu'nda ... kaza") never vetoes, and a side
 * that names two provinces vetoes only when neither is the other side's.
 */
function incidentVetoFires(aTitle, bTitle) {
  const a = aTitle.slice(0, HEADLINE_TITLE_MAX_CHARS);
  const b = bTitle.slice(0, HEADLINE_TITLE_MAX_CHARS);
  if (!hasIncidentWord(a) || !hasIncidentWord(b)) return false;
  const pa = provincesIn(a);
  const pb = provincesIn(b);
  if (pa.size === 0 || pb.size === 0) return false;
  for (const p of pa) if (pb.has(p)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Ordinal counter veto (h54-precision-1)
// ---------------------------------------------------------------------------

// The words that carry an ordinal counter, folded the way foldTurkishWord folds
// a title ("duruşması" -> "durusmasi"), each with the noun it counts. A closed
// list of whole inflected words, not a prefix: on 30 days of prod titles a
// "tur" prefix also read "N. Türk..." (39 hits) and "N. Türkiye..." (11) as
// a round counter, and "gün" read "N. günlük". An inflection that is missing
// here only means no veto for that pair.
const COUNTER_FORMS = {
  durusma: [
    "durusma", "durusmasi", "durusmasinda", "durusmasindan", "durusmasina",
    "durusmasini", "durusmasinin", "durusmasindaki", "durusmanin", "durusmada",
    "durusmadan", "durusmaya", "durusmayi", "durusmalar", "durusmalarda",
  ],
  oturum: [
    "oturum", "oturumu", "oturumun", "oturumunda", "oturumundan", "oturumuna",
    "oturumunu", "oturumda", "oturumdan", "oturuma", "oturumlar", "oturumlarda",
  ],
  celse: [
    "celse", "celsesi", "celsesinde", "celsesinden", "celsesine", "celsesini",
    "celsesinin", "celsenin", "celsede", "celseden", "celseye", "celseyi",
    "celseler", "celselerde",
  ],
  gun: [
    "gun", "gunu", "gunun", "gununde", "gununden", "gunune", "gununu", "gunde",
    "gunden", "gune", "gundeki", "gunler", "gunlerde",
  ],
  tur: [
    "tur", "turu", "turun", "turunda", "turundan", "turuna", "turunu", "turda",
    "turdan", "tura", "turlar", "turlarda",
  ],
  hafta: [
    "hafta", "haftanin", "haftasi", "haftasinda", "haftasindan", "haftasina",
    "haftasini", "haftasinin", "haftasindaki", "haftada", "haftadan", "haftadaki",
    "haftaya", "haftayi", "haftalar", "haftalarda",
  ],
};

const COUNTER_NOUN_OF = new Map(
  Object.entries(COUNTER_FORMS).flatMap(([noun, forms]) =>
    forms.map((form) => [form, noun]),
  ),
);

// "12345. gün" is not an ordinal; the longest counter is "9999. gün".
const COUNTER_MAX_DIGITS = 4;

function isDigitCode(c) {
  return c >= 48 && c <= 57;
}

// Exactly the characters of JavaScript's /\s/ class.
function isSpaceCode(c) {
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

// A letter of a folded title: a-z, or any other Unicode letter (so "tur" +
// "ñ" is not read as the word "tur").
function isLetterAt(s, i) {
  const c = s.charCodeAt(i);
  if (c >= 97 && c <= 122) return true;
  return c > 127 && /\p{L}/u.test(s[i]);
}

/**
 * The ordinal counters a headline names: counter noun -> the numbers written as
 * "<1-4 digits> <optional spaces> . <optional spaces> <counter word>"
 * ("104. duruşması", "2 . turunda", "5.gün"). One left-to-right pass: every
 * character is scanned a constant number of times, so the cost is linear in the
 * (already clipped) title, and there is no regular expression to backtrack.
 * @param {string} title
 * @returns {Map<string, Set<number>>}
 */
function countersOf(title) {
  const out = new Map();
  const s = foldTurkishWord(title.slice(0, HEADLINE_TITLE_MAX_CHARS));
  const n = s.length;
  let i = 0;
  while (i < n) {
    if (!isDigitCode(s.charCodeAt(i))) {
      i++;
      continue;
    }
    const start = i;
    while (i < n && isDigitCode(s.charCodeAt(i))) i++;
    if (i - start > COUNTER_MAX_DIGITS) continue;
    let j = i;
    while (j < n && isSpaceCode(s.charCodeAt(j))) j++;
    if (j >= n || s.charCodeAt(j) !== 46) continue; // "."
    j++;
    while (j < n && isSpaceCode(s.charCodeAt(j))) j++;
    let k = j;
    while (k < n && isLetterAt(s, k)) k++;
    const noun = COUNTER_NOUN_OF.get(s.slice(j, k));
    if (noun === undefined) continue;
    const value = Number(s.slice(start, i)); // "05" and "5" are the same counter
    const seen = out.get(noun);
    if (seen) seen.add(value);
    else out.set(noun, new Set([value]));
  }
  return out;
}

/**
 * True when the two headlines count the same recurring event on different
 * instalments: both (clipped to HEADLINE_TITLE_MAX_CHARS) name the SAME SET of
 * counter nouns -- duruşma, oturum, celse, gün, tur or hafta -- and the numbers
 * written for some noun of that set share no value ("104. duruşması sona erdi"
 * vs "105. duruşması başladı"). A title without any counter, a different counter
 * noun ("104. duruşma" vs "3. gün"), a bare count ("5 gün") and the same number
 * on both sides never veto.
 *
 * Same noun set (correctness-2): a title that nests scopes ("3. duruşmada 3. gün",
 * the hearing, then its day) is not compared with one that names only the outer
 * count ("104. gün", the day of the whole trial). The two "gün" numbers are on
 * different scales, so a disjoint pair is no evidence of two instalments (prod
 * cluster 5893d4e5, odatv vs medyascope). Accepted trade-off: a title that names
 * a scope noun the other lacks ("104. duruşma" vs "105. duruşmanın 2. günü") no
 * longer vetoes; the pair is left to the other lanes.
 * @param {string} aTitle
 * @param {string} bTitle
 * @returns {boolean}
 */
function counterVetoFires(aTitle, bTitle) {
  if (typeof aTitle !== "string" || typeof bTitle !== "string") return false;
  const a = countersOf(aTitle);
  if (a.size === 0) return false;
  const b = countersOf(bTitle);
  if (a.size !== b.size) return false;
  for (const noun of a.keys()) if (!b.has(noun)) return false;
  for (const [noun, na] of a) {
    const nb = b.get(noun);
    if (nb === undefined) continue;
    let shared = false;
    for (const v of na) {
      if (nb.has(v)) {
        shared = true;
        break;
      }
    }
    if (!shared) return true;
  }
  return false;
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
  const { aSourceSlug, bSourceSlug, aTitle, bTitle, aDescription, bDescription } =
    opts || {};
  const sourcePenalty = sourcePenaltyFor(aSourceSlug, bSourceSlug);

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
        headlineKind: null,
        headlineContainment: 0,
        textFloorCapped: false,
        subjectVeto: false,
        incidentVeto: false,
        counterVeto: false,
        homonymVeto: false,
        templateVeto: false,
        actorVeto: false,
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
  // `min` let a 3-entity article score 3/3 against a 10-entity seed. Generic
  // whitelist entities (bakan, fidan, abd, ...) weigh GENERIC_ENTITY_WEIGHT
  // each, with a floor of one so a single shared generic entity keeps its old
  // value.
  const aEntities = asSet(aEntitiesIn);
  const bEntities = asSet(bEntitiesIn);
  const sharedCount = setIntersectSize(aEntities, bEntities);
  let sharedWeight = 0;
  if (sharedCount > 0) {
    const [smallE, bigE] =
      aEntities.size <= bEntities.size
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
  // 5. Headline lane -- only when both titles are present (see headlineLane()
  //    for the two variants and their guards).
  // -----------------------------------------------------------------------
  let headlineSim = 0;
  let headlineShared = 0;
  let headlineContainment = 0;
  let headlineKind = null;
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
  // Actor veto (h70-mergequality-3): a headline-lane match must not cross
  // actors. When the lane fired but the titles name different actors it is
  // withdrawn: its score is dropped, and the pair is judged as if the lane had
  // not fired, so the text floor and the subject / incident vetoes below
  // apply to it again. Evaluated only for a pair the lane fired for (the
  // subject veto already covers the other pairs).
  // The same withdrawal for two generic headlines whose descriptions name different
  // people (h114-clusterpurity-4, genericHeadlineNameConflict); it needs both
  // descriptions.
  const actorVeto =
    headlineFired &&
    !!aTitle &&
    !!bTitle &&
    (actorMismatchFires(aTitle, bTitle) ||
      genericHeadlineNameConflict(aTitle, bTitle, aDescription, bDescription));
  const headlineEffective = headlineFired && !actorVeto;
  if (!headlineEffective) headlineScore = 0;

  // -----------------------------------------------------------------------
  // 6. Combine.
  // -----------------------------------------------------------------------
  // Primary lane is the weighted sum (tfidf heavy, entity tiebreaker). The
  // MinHash and headline lanes are parallel ceilings — whichever is largest
  // wins. `primary` keeps its computed value; the text floor only limits
  // what it contributes to `raw`. A pair where either side has no whitelist
  // entity cannot earn anything on the entity lane (nothing can be shared), so
  // it is scored on text alone at ENTITY_SPARSE_TEXT_FACTOR instead of being
  // capped at 0.70 of its tf-idf (h19-recall-1). This comes BEFORE the text
  // floor and the vetoes below, which still win.
  const entitySparse = Math.min(aEntities.size, bEntities.size) === 0;
  const primary = entitySparse
    ? clip01(tfidfScore * ENTITY_SPARSE_TEXT_FACTOR)
    : TFIDF_WEIGHT * tfidfScore + ENTITY_WEIGHT * entityRatio;
  const textFloorCapped = !headlineEffective && tfidfScore < ENTITY_TEXT_FLOOR;
  let primaryForRaw = textFloorCapped
    ? Math.min(primary, MATCH_THRESHOLD - 0.01)
    : primary;
  // Subject veto: different actors, same template. Never overrides a headline
  // lane that is in effect (the headlines already agree on the actor).
  const subjectVeto =
    !headlineEffective && !!aTitle && !!bTitle && subjectVetoFires(aTitle, bTitle);
  // Incident veto: the same incident template in different provinces. Same
  // exemption as the subject veto, same cap.
  const incidentVeto =
    !headlineEffective && !!aTitle && !!bTitle && incidentVetoFires(aTitle, bTitle);
  // Counter veto: the same recurring event on a different instalment ("104."
  // vs "105. duruşma"). It caps the MinHash and primary lanes, which cannot see
  // numerals, and has no headline exemption: the headline lane refuses
  // different numerals itself. Known gap: its containment variant accepts a
  // numeral that changes digit length ("9." -> "10. duruşma", numeralClassShift),
  // so such a pair still matches on the headline lane with counterVeto true;
  // headlineOnlyScore() (member headlines in attach.ts / the consumer) never
  // sees titles either, so closing it needs those callers too.
  const counterVeto = !!aTitle && !!bTitle && counterVetoFires(aTitle, bTitle);
  // Homonym veto (h101-clustermembers-1): "Emine Erdoğan'dan ..." against
  // "Cumhurbaşkanı Erdoğan ...". Placed with the counter veto because it too has
  // no headline exemption, and for a stronger reason: the first stray into
  // prod cluster 94503853 did not take the headline lane at all (primary 0.49 =
  // 0.7 * tf-idf 0.58 + 0.3 * entity ratio 0.29, lane false), so withdrawing the
  // lane through actorMismatchFires() is not enough. It caps the two lanes the
  // other vetoes cap, at the same SUBJECT_VETO_CAP.
  const homonymVeto = !!aTitle && !!bTitle && familyHomonymFires(aTitle, bTitle);
  // Template veto (h114-clusterpurity-2): the same statement or budget template
  // under different speakers or ministries. Like the homonym veto it has no
  // headline exemption: the intruders of 04e8fdce, c0436da0 and c9525327 joined on
  // MinHash and the primary lane as well, so withdrawing the headline lane
  // (actorMismatchFires) is not enough.
  const templateVeto = !!aTitle && !!bTitle && templateActorMismatchFires(aTitle, bTitle);
  let jaccardForRaw = jaccardScore;
  if (subjectVeto || incidentVeto || counterVeto || homonymVeto || templateVeto) {
    primaryForRaw = Math.min(primaryForRaw, SUBJECT_VETO_CAP);
    jaccardForRaw = Math.min(jaccardScore, SUBJECT_VETO_CAP);
  }
  const raw = clip01(Math.max(jaccardForRaw, primaryForRaw, headlineScore));

  // -----------------------------------------------------------------------
  // 7. Time decay.
  // -----------------------------------------------------------------------
  const timeDecay = timeDecayFor(hoursDelta);
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
      headlineLane: headlineEffective,
      headlineKind,
      headlineContainment,
      textFloorCapped,
      subjectVeto,
      incidentVeto,
      counterVeto,
      homonymVeto,
      templateVeto,
      actorVeto,
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
