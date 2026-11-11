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
//   entity-sparse pairs (either side has no whitelist entity, h19-recall-1):
//     primary = clip01(tfidf * ENTITY_SPARSE_TEXT_FACTOR) -- scored on text
//     alone instead of at most 0.70 of it; the caps below still apply
//   entityRatio numerator: generic whitelist entities (bakan, fidan, abd, ...)
//     weigh GENERIC_ENTITY_WEIGHT each, with a floor of one when anything is
//     shared (h12-cluster-2)
//   subject veto: when the headline lane did not fire and the two headlines'
//     subjects ("Lavrov," vs "Fidan,") are disjoint, primary and the MinHash
//     lane are capped at SUBJECT_VETO_CAP (h12-cluster-2)
//   incident veto: when the headline lane did not fire, both headlines carry an
//     incident word (kaza, yangin, deprem, ...) and name provinces, and the two
//     province sets are disjoint ("Duzce'de ... kazada" vs "Bolu Dagi'nda ...
//     kaza"), the same two lanes are capped at SUBJECT_VETO_CAP
//     (h16-precision-1; see provinces.ts)
//   counter veto: both headlines carry ordinal counters of the same recurring
//     event ("104. duruşma" vs "105. duruşma", "2. tur", "5. gün"), name the
//     same SET of counter nouns (a "3. duruşmada 3. gün" title is not compared
//     with a bare "104. gün" one) and the numbers for a noun of that set are
//     disjoint, so the pair is two instalments of one story, not one story: the
//     same two lanes are capped at SUBJECT_VETO_CAP (h54-precision-1; see
//     counterVetoFires())
//   homonym veto: one headline names only a family member or namesake of a
//     surname ("Emine Erdogan'dan Karabag mesaji": every Erdogan follows a given
//     name of FAMILY_HOMONYM_GIVEN_NAMES) and the other names the principal
//     ("Cumhurbaskani Erdogan ...", "Erdogan, ...") without ever naming that
//     family member: two actors the surname makes one. Unlike the vetoes above it
//     has no headline exemption and withdraws the headline lane (actorMismatchFires),
//     and it caps the same two lanes at SUBJECT_VETO_CAP, because the pair that
//     started it (trt-haber against bha, prod cluster 94503853) joined on the
//     primary tf-idf + entity lane (h101-clustermembers-1; see
//     familyHomonymFires())
//   template veto: two headlines share a statement or budget template but name
//     different speakers or ministries ("Bakan Kurum'dan 10 Kasim ... mesaji" vs
//     "Cumhurbaskani Erdogan'dan ...", "Genclik ve Spor Bakanliginin ... butcesi"
//     vs "Adalet Bakanligi butcesi"). No headline exemption, like the homonym
//     veto: it withdraws the headline lane (actorMismatchFires) and caps the
//     primary and MinHash lanes at SUBJECT_VETO_CAP, because the intruders of
//     five prod clusters joined on those lanes too (h114-clusterpurity-2; see
//     templateActorMismatchFires())
//   generic headline name conflict: when the headline lane fired for two headlines
//     of at most HEADLINE_GENERIC_MAX_TOKENS tokens that name nobody ("Fon
//     sorusturmasinda yeni gozalti") and both CLEANED descriptions are given
//     (ScoreOpts.aDescription / bDescription, headlineOnlyScore opts), the lane is
//     withdrawn like actorVeto when the descriptions name different people
//     (h114-clusterpurity-4; see genericHeadlineNameConflict())
//   actor veto: a headline-lane match must not cross actors (h70-mergequality-3;
//     see actorMismatchFires()). When the lane fired but the two headlines name
//     different actors -- comma subjects that are disjoint, or one comma subject
//     against a comma-less headline that leads with another named actor
//     ("Cumhurbaskani Erdogan, Karabag Zaferi'nin 6. yilini kutladi" vs "AK Parti
//     Sozcusu Celik Karabag Zaferi'nin 6. yilini kutladi") -- the lane is withdrawn
//     and the pair is judged as if it had not fired: the text floor and the
//     subject / incident vetoes below apply again. A role with no name ("MHP
//     Lideri ...", "Cumhurbaskanimiz ..."), a place word ("Bestepe'de ..."), a
//     sentence-case label ("Beklenen aciklama: ...") and one actor under its
//     acronym ("AKP," vs "AK Parti,") are not different actors (leadRun()).
//     headlineOnlyScore() takes the same titles for the member-headline scan
//   text floor: if the headline lane did not fire and tfidf < ENTITY_TEXT_FLOOR,
//     the primary lane is capped just under MATCH_THRESHOLD (entities alone
//     cannot join a pair that shares no text)
//   raw = max(minhashScore, primary (capped), headlineScore (when in effect))
//   final = raw * timeDecay * sourcePenalty
//
// 2026-11-01: the entity denominator was `min(|A|,|B|)` (a 3-entity article
// scored 3/3 against a 10-entity seed -- prod cluster dd5535a7); it is now
// `max`. The headline lane recovers cross-outlet pairs whose tfidf is low
// because descriptions differ (Sarigul 6f4d9ac2/cffe669c, Bakirkoy). See
// constants.ts for the per-constant evidence.

import {
  DESCRIPTION_NAME_STOP,
  ENTITY_DENOM_MIN,
  ENTITY_FRESHNESS_HOURS,
  ENTITY_SPARSE_TEXT_FACTOR,
  ENTITY_TEXT_FLOOR,
  ENTITY_WEIGHT,
  FAMILY_HOMONYM_GIVEN_NAMES,
  FAMILY_HOMONYM_NOT_AFTER,
  GENERIC_ENTITIES,
  GENERIC_ENTITY_WEIGHT,
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
  INSTITUTION_HEAD_WORDS,
  MATCH_THRESHOLD,
  MIN_SHARED_ENTITIES,
  MINHASH_SOFT_ACCEPT_JACCARD,
  STATEMENT_TEMPLATE_NOUNS,
  SUBJECT_SPAN_MAX_WORDS,
  SUBJECT_STOP_WORDS,
  SUBJECT_VETO_CAP,
  TEMPLATE_ACTOR_GENERIC_KEEP,
  TEMPLATE_PLACE_PHRASES,
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
import { extractEntities } from "./entities.ts";
import { hasIncidentWord, IL_NAMES, provincesIn } from "./provinces.ts";

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
  // The cleaned descriptions (cleanDescription) of the two articles. Read only for a
  // pair the headline lane fired for, and only when both are given: generic
  // headlines whose descriptions name different people withdraw the lane (see
  // genericHeadlineNameConflict()).
  aDescription?: string | null;
  bDescription?: string | null;
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
  // True when the incident province-conflict veto capped the pair (same
  // incident template, different provinces); see incidentVetoFires().
  incidentVeto: boolean;
  // True when the ordinal-counter veto capped the pair (the same recurring
  // event on a different instalment, "104. duruşma" vs "105. duruşma"); see
  // counterVetoFires().
  counterVeto: boolean;
  // True when one headline names only a family member or namesake of a surname
  // and the other names the principal ("Emine Erdoğan'dan ..." vs "Cumhurbaşkanı
  // Erdoğan ..."), so the primary and MinHash lanes were capped at
  // SUBJECT_VETO_CAP (the headline lane is withdrawn through actorVeto); see
  // familyHomonymFires().
  homonymVeto: boolean;
  // True when the two headlines share a statement or budget template but name
  // different speakers or ministries ("Bakan Kurum'dan ... mesajı" vs
  // "Cumhurbaşkanı Erdoğan'dan ... mesajı", "Gençlik ve Spor Bakanlığının ...
  // bütçesi" vs "Adalet Bakanlığı bütçesi"), so the primary and MinHash lanes
  // were capped at SUBJECT_VETO_CAP (the headline lane is withdrawn through
  // actorVeto); see templateActorMismatchFires().
  templateVeto: boolean;
  // True when the headline lane fired but the two headlines name different
  // actors, so the lane was withdrawn (headlineLane is then false and the
  // lane's score is dropped); see actorMismatchFires(). Also true when the lane
  // fired for two generic headlines whose descriptions name different people
  // (genericHeadlineNameConflict). Only evaluated for a pair the lane fired for.
  actorVeto: boolean;
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
 *
 * With both `aTitle` and `bTitle` given it returns 0 when the two titles name
 * different actors (actorMismatchFires, which includes a family member against
 * the principal, familyHomonymFires), exactly as score() withdraws the lane
 * for such a pair; without titles the result is the lane's alone. With both
 * `aDescription` and `bDescription` as well (the cleaned descriptions) it also
 * returns 0 for two generic headlines whose descriptions name different people
 * (genericHeadlineNameConflict); without them, or with only one, nothing changes.
 */
export function headlineOnlyScore(
  ha: HeadlineTokens,
  hb: HeadlineTokens,
  hoursDelta: number,
  opts: {
    aSourceSlug?: string | null;
    bSourceSlug?: string | null;
    aTitle?: string | null;
    bTitle?: string | null;
    aDescription?: string | null;
    bDescription?: string | null;
  } = {},
): number {
  const lane = headlineLane(ha, hb, hoursDelta);
  if (!lane.fired) return 0;
  if (opts?.aTitle && opts?.bTitle) {
    if (actorMismatchFires(opts.aTitle, opts.bTitle)) return 0;
    if (genericHeadlineNameConflict(opts.aTitle, opts.bTitle, opts.aDescription, opts.bDescription)) return 0;
  }
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
  // falls within the first SUBJECT_SPAN_MAX_WORDS words), minus the qualifier
  // of a terminal role ("Saglik Bakani," names no actor: empty span).
  span: Set<string>;
  // Every folded word of the (clipped) title.
  words: Set<string>;
  // The raw (case kept, apostrophe suffix dropped) capitalised words of the
  // subject, before any stop-word or role removal: the acronym-alias check
  // spells them ("AK Parti" -> AKP).
  raw: string[];
}

// ---------------------------------------------------------------------------
// Roles, names and acronyms (shared by the subject veto and the actor mismatch)
// ---------------------------------------------------------------------------

// Folded stems of role words, matched by PREFIX so possessive and derived forms
// count too ("cumhurbaskanimiz", "liderimiz", "bakanligi"). A role is never
// collected as a name.
const ROLE_PREFIXES: readonly string[] = [
  "cumhurbaskan",
  "bakan",
  "baskan",
  "lider",
  "sozcu",
  "vali",
  "milletvekil",
  "yardimci",
];

function isRolePiece(piece: string): boolean {
  for (const r of ROLE_PREFIXES) if (piece.startsWith(r)) return true;
  return false;
}

// The folded pieces collected so far from a run of capitalised words, plus the
// bookkeeping of the "terminal role" rule: the qualifier pieces before a role
// word ("MHP" in "MHP Lideri", "Saglik" in "Saglik Bakani") are dropped when no
// name follows that role.
interface NameRun {
  entries: Array<{ piece: string; word: number }>;
  // Index into `entries` where the qualifier since the last role word begins.
  segStart: number;
  // entries[start, end) is the qualifier of the latest role phrase; revocable
  // until a name follows it. null when a name already followed.
  pending: { start: number; end: number } | null;
}

function newNameRun(): NameRun {
  return { entries: [], segStart: 0, pending: null };
}

// Feeds the folded pieces of one capitalised word (word index `word`). A role
// piece opens (or, right after another role piece, extends) a pending role
// phrase; a stop word is filler and changes nothing; any other piece is a name
// that closes the pending phrase (the qualifier stays) and is collected unless
// it is a generic entity and `skipGeneric` is set.
function feedPieces(
  run: NameRun,
  pieces: readonly string[],
  word: number,
  skipGeneric: boolean,
): void {
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
function finishRun(run: NameRun): Array<{ piece: string; word: number }> {
  if (run.pending) run.entries.splice(run.pending.start, run.pending.end - run.pending.start);
  run.pending = null;
  return run.entries;
}

// An all-caps token of 2+ letters ("MSB", "AKP", "TBMM", "AK").
function isAcronym(word: string): boolean {
  let letters = 0;
  for (const ch of word) if (/\p{L}/u.test(ch)) letters++;
  return letters >= 2 && word === word.toLocaleUpperCase("tr");
}

// True when `acronym` is the concatenation, over `raws`, of each all-caps word
// whole and the first letter of every other word ("AKP" = AK + Parti, "MSB" =
// Milli Savunma Bakanligi, "TBMM" = Turkiye Buyuk Millet Meclisi).
function spellsAcronym(acronym: string, raws: readonly string[]): boolean {
  let spelled = "";
  for (const w of raws) spelled += isAcronym(w) ? w : ([...w][0] ?? "");
  return spelled.toLocaleUpperCase("tr") === acronym.toLocaleUpperCase("tr");
}

// One side's subject is a single all-caps token that spells the other side's
// capitalised words: the same actor under its short and long name.
function acronymAlias(aRaw: readonly string[], bRaw: readonly string[]): boolean {
  return (aRaw.length === 1 && isAcronym(aRaw[0]!) && spellsAcronym(aRaw[0]!, bRaw)) ||
    (bRaw.length === 1 && isAcronym(bRaw[0]!) && spellsAcronym(bRaw[0]!, aRaw));
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
  const run = newNameRun();
  const raw: string[] = [];
  const raws = clipped.split(/\s+/).filter(Boolean);
  for (let i = 0; i < raws.length && i < SUBJECT_SPAN_MAX_WORDS; i++) {
    const rawWord = raws[i]!;
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
  return { span: new Set<string>(), words, raw: [] };
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
export function subjectVetoFires(aTitle: string, bTitle: string): boolean {
  return subjectsDisjoint(subjectOf(aTitle), subjectOf(bTitle));
}

function subjectsDisjoint(a: HeadlineSubject, b: HeadlineSubject): boolean {
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
const HOMONYM_NOT_AFTER: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(FAMILY_HOMONYM_NOT_AFTER).map(([given, before]): [string, Set<string>] => [given, new Set(before)]),
);

// The surnames with their given-name sets, built once (score() runs this per candidate).
const HOMONYM_SURNAMES: ReadonlyArray<readonly [string, ReadonlySet<string>]> = Object.entries(
  FAMILY_HOMONYM_GIVEN_NAMES,
).map(([surname, names]): [string, Set<string>] => [surname, new Set(names)]);

// The title clipped to HEADLINE_TITLE_MAX_CHARS, composed to NFC (a decomposed "İ" is
// one letter), stripped of invisible format characters and folded.
function homonymFold(title: string): string {
  return foldTurkishWord(
    title.slice(0, HEADLINE_TITLE_MAX_CHARS).normalize("NFC").replace(INVISIBLE_FORMAT, ""),
  );
}

// The words of a folded title, in order, an empty string standing for every
// punctuation break between them. A word keeps its apostrophe suffix; the surname
// test below drops it.
function homonymTokens(folded: string): string[] {
  const out: string[] = [];
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
function surnameReadings(
  tokens: readonly string[],
  surname: string,
  givens: ReadonlySet<string>,
): { family: number; bare: number; givensBefore: Set<string> } {
  let family = 0;
  let bare = 0;
  const givensBefore = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "" || t.split(HOMONYM_APOSTROPHE, 1)[0] !== surname) continue;
    const prev = i > 0 ? tokens[i - 1]! : "";
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
function namedGivens(tokens: readonly string[], givens: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "") continue;
    const stem = t.split(HOMONYM_APOSTROPHE, 1)[0]!;
    if (!givens.has(stem)) continue;
    if (HOMONYM_NOT_AFTER.get(stem)?.has(tokens[i - 1] ?? "")) continue;
    out.add(stem);
  }
  return out;
}

// True when the FAMILY side `x` and the PRINCIPAL side `y` are different people:
// no given name that preceded the surname in `x` is named anywhere in `y`.
function differentPeople(
  x: { givensBefore: ReadonlySet<string> },
  yTokens: readonly string[],
  givens: ReadonlySet<string>,
): boolean {
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
 */
export function familyHomonymFires(aTitle: string, bTitle: string): boolean {
  if (typeof aTitle !== "string" || typeof bTitle !== "string") return false;
  if (aTitle === "" || bTitle === "") return false;
  const fa = homonymFold(aTitle);
  const fb = homonymFold(bTitle);
  let a: string[] | undefined;
  let b: string[] | undefined;
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

function prefixesOf(words: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const w of words) out.add(w.slice(0, ACTOR_PREFIX_LEN));
  return out;
}

// The capitalisation test subjectOf() and leadRun() apply to a word's stem.
function startsCapitalised(stem: string): boolean {
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
 */
function leadRun(
  title: string,
  otherPrefixes: ReadonlySet<string>,
): { names: Set<string>; raw: string[] } {
  const raws = title.slice(0, HEADLINE_TITLE_MAX_CHARS).split(/\s+/).filter(Boolean);
  const stemOf = (rawWord: string | undefined): string =>
    (rawWord ?? "").replace(TRAILING_PUNCTUATION, "").split(/['’]/)[0] ?? "";
  const run = newNameRun();
  const raw: string[] = [];
  for (let i = 0; i < raws.length && i < SUBJECT_SPAN_MAX_WORDS; i++) {
    const parts = raws[i]!.replace(TRAILING_PUNCTUATION, "").split(/['’]/);
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
    if (!named) return { names: new Set<string>(), raw };
  }
  return { names: new Set(entries.map((e) => e.piece)), raw };
}

// `a` has a comma subject, `b` has none, and `b` leads with a named actor that
// is not `a`'s: none of a's subject words occurs in b (by prefix), b's leading
// run of names (stopping where the titles meet) is non-empty, and it is not a's
// acronym spelled out ("AKP," vs "AK Parti ...").
function oneSidedActorMismatch(a: HeadlineSubject, b: HeadlineSubject, bTitle: string): boolean {
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
export function actorMismatchFires(aTitle: string, bTitle: string): boolean {
  const a = subjectOf(aTitle);
  const b = subjectOf(bTitle);
  return subjectsDisjoint(a, b) ||
    oneSidedActorMismatch(a, b, bTitle) ||
    oneSidedActorMismatch(b, a, aTitle) ||
    familyHomonymFires(aTitle, bTitle) ||
    templateActorMismatchFires(aTitle, bTitle);
}

// ---------------------------------------------------------------------------
// Template actor mismatch (h114-clusterpurity-2)
// ---------------------------------------------------------------------------

const PROVINCE_SET: ReadonlySet<string> = new Set(IL_NAMES);
const TEMPLATE_KEEP_GENERIC: ReadonlySet<string> = new Set(TEMPLATE_ACTOR_GENERIC_KEEP);
const TEMPLATE_PLACE_PHRASE_SET: ReadonlySet<string> = new Set(TEMPLATE_PLACE_PHRASES);

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
function trimWord(raw: string): string {
  return raw.replace(/^[^\p{L}\p{N}]+/u, "").replace(TRAILING_PUNCTUATION, "");
}

// The word before its first apostrophe ("Kurum'dan" -> "Kurum").
function stemOfWord(raw: string): string {
  return trimWord(raw).split(HOMONYM_APOSTROPHE)[0] ?? "";
}

function clippedWords(title: string): string[] {
  return title.slice(0, HEADLINE_TITLE_MAX_CHARS).split(/\s+/).filter(Boolean);
}

function foldedWordSet(title: string): Set<string> {
  const words = new Set<string>();
  for (const w of foldTurkishWord(title.slice(0, HEADLINE_TITLE_MAX_CHARS)).split(/[^a-z0-9]+/)) {
    if (w) words.add(w);
  }
  return words;
}

// True when some prefix of `a` is a prefix of `b`.
function sharePrefix(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

interface TemplateSide {
  // ACTOR_PREFIX_LEN prefixes of the actor key's folded pieces.
  keyPrefixes: Set<string>;
  // ACTOR_PREFIX_LEN prefixes of every folded word of the (clipped) title.
  wordPrefixes: Set<string>;
  // The capitalised words up to and including the ablative, case kept.
  raw: string[];
  // A minister ("Bakan Kurum'dan"): a capitalised 'bakan...' word that is not a ministry.
  bakanRole: boolean;
  // The ablative is a ministry ("Milli Savunma Bakanligindan").
  bakanligHead: boolean;
}

// The first word within the first SUBJECT_SPAN_MAX_WORDS that is an ablative: an
// apostrophe -dan/-den/-tan/-ten, or an institution head ending in -(n)dan/-(n)den.
function ablativeIn(raws: readonly string[]): { index: number; head: string | null } | null {
  const limit = Math.min(raws.length, SUBJECT_SPAN_MAX_WORDS);
  for (let i = 0; i < limit; i++) {
    const parts = trimWord(raws[i]!).split(HOMONYM_APOSTROPHE);
    if ((parts[0] ?? "") === "") continue;
    if (parts.length > 1 && ABLATIVE_SUFFIX.test(foldTurkishWord(parts[1]))) return { index: i, head: null };
    const folded = foldTurkishWord(parts.join(""));
    if (!INSTITUTION_ABLATIVE_END.test(folded)) continue;
    const head = INSTITUTION_HEAD_WORDS.find((h) => folded.startsWith(h));
    if (head !== undefined) return { index: i, head };
    // A buffer-n ablative on a name ("Memisoglu'ndan"): a person, so no head.
    if (parts.length > 1 && BUFFER_ABLATIVE_SUFFIX.test(foldTurkishWord(parts[1]!)) &&
        ENDS_IN_VOWEL.test(foldTurkishWord(parts[0]!))) {
      return { index: i, head: null };
    }
  }
  return null;
}

// True when a STATEMENT_TEMPLATE_NOUNS word (a folded prefix) occurs from word `from` on.
function hasStatementNoun(raws: readonly string[], from: number): boolean {
  for (let i = from; i < raws.length; i++) {
    const folded = foldTurkishWord(raws[i]!).replace(/[^a-z0-9]/g, "");
    for (const noun of STATEMENT_TEMPLATE_NOUNS) if (folded.startsWith(noun)) return true;
  }
  return false;
}

// The speaker of a "<actor>'dan <...> <statement noun>" headline, or null when the
// title is not one or names no actor (only roles, or a place: "Ankara'dan ...").
function templateSideOf(title: string): TemplateSide | null {
  const raws = clippedWords(title);
  const ablative = ablativeIn(raws);
  if (ablative === null || !hasStatementNoun(raws, ablative.index + 1)) return null;
  const key = new Set<string>();
  const raw: string[] = [];
  let bakanRole = false;
  let hasRole = false;
  let namedWords = 0;
  for (let i = 0; i <= ablative.index; i++) {
    const stem = stemOfWord(raws[i]!);
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
  const stemFolded = foldTurkishWord(stemOfWord(raws[ablative.index]!));
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
    (key.size === 1 && TEMPLATE_KEEP_GENERIC.has([...key][0]!));
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
function acronymIn(x: readonly string[], y: readonly string[]): boolean {
  return x.some((w) => isAcronym(w) && spellsAcronym(w, y));
}

// R1: both titles are statements of an ablative speaker and the speakers differ.
function statementActorsDiffer(aTitle: string, bTitle: string): boolean {
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
function ministryNameWords(raws: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let h = 0; h < raws.length; h++) {
    if (!foldTurkishWord(stemOfWord(raws[h]!)).startsWith("bakanlig")) continue;
    const stems: string[] = [];
    for (let k = h - 1; k >= 0; k--) {
      const word = raws[k]!;
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
function ministryNames(title: string): Set<string> {
  const out = new Set<string>();
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
function acronymNamesMinistry(a: string, b: string): boolean {
  const tokens = new Set<string>();
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
function ministriesDiffer(aTitle: string, bTitle: string): boolean {
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
 */
export function templateActorMismatchFires(aTitle: string, bTitle: string): boolean {
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
function namesSomebody(title: string): boolean {
  const raws = clippedWords(title);
  for (let i = 1; i < raws.length; i++) {
    const stem = stemOfWord(raws[i]!);
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
function descriptionNamePieces(description: string, eventStems: readonly string[]): Set<string> {
  const text = description.slice(0, DESCRIPTION_NAME_SPAN);
  const out = new Set<string>();
  const entries: Array<{ word: string; stem: string; cap: boolean; initial: boolean }> = [];
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
    if (!entries[i]!.cap) {
      i++;
      continue;
    }
    let j = i;
    while (!CLAUSE_END.test(entries[j]!.word) && j + 1 < entries.length && entries[j + 1]!.cap) j++;
    const closed = CLAUSE_END.test(entries[j]!.word);
    const next = entries[j + 1];
    if (j > i && !closed && next !== undefined) {
      const folded = foldTurkishWord(next.word).replace(/[^a-z0-9]/g, "");
      if (eventStems.some((stem) => folded.startsWith(stem))) {
        for (let k = i; k <= j; k++) {
          const w = entries[k]!;
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
 */
export function genericHeadlineNameConflict(
  aTitle: string,
  bTitle: string,
  aDescription: string | null | undefined,
  bDescription: string | null | undefined,
): boolean {
  if (typeof aTitle !== "string" || typeof bTitle !== "string") return false;
  if (typeof aDescription !== "string" || typeof bDescription !== "string") return false;
  if (aTitle === "" || bTitle === "" || aDescription === "" || bDescription === "") return false;
  const shorter = Math.min(headlineTokens(aTitle).tokens.size, headlineTokens(bTitle).tokens.size);
  if (shorter > HEADLINE_GENERIC_MAX_TOKENS) return false;
  if (namesSomebody(aTitle) || namesSomebody(bTitle)) return false;
  const eventStems = new Set<string>();
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
export function incidentVetoFires(aTitle: string, bTitle: string): boolean {
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
const COUNTER_FORMS: Readonly<Record<string, readonly string[]>> = {
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

const COUNTER_NOUN_OF: ReadonlyMap<string, string> = new Map(
  Object.entries(COUNTER_FORMS).flatMap(([noun, forms]) =>
    forms.map((form): [string, string] => [form, noun])
  ),
);

// "12345. gün" is not an ordinal; the longest counter is "9999. gün".
const COUNTER_MAX_DIGITS = 4;

function isDigitCode(c: number): boolean {
  return c >= 48 && c <= 57;
}

// Exactly the characters of JavaScript's /\s/ class.
function isSpaceCode(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 ||
    c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

// A letter of a folded title: a-z, or any other Unicode letter (so "tur" +
// "ñ" is not read as the word "tur").
function isLetterAt(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  if (c >= 97 && c <= 122) return true;
  return c > 127 && /\p{L}/u.test(s[i]!);
}

/**
 * The ordinal counters a headline names: counter noun -> the numbers written as
 * "<1-4 digits> <optional spaces> . <optional spaces> <counter word>"
 * ("104. duruşması", "2 . turunda", "5.gün"). One left-to-right pass: every
 * character is scanned a constant number of times, so the cost is linear in the
 * (already clipped) title, and there is no regular expression to backtrack.
 */
function countersOf(title: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
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
 * different scales, so a disjoint pair is no evidence of two instalments: prod
 * cluster 5893d4e5 holds odatv "İBB davası 104. gün: ..." and medyascope "İBB
 * davasında 3. duruşmada 3. gün: ..." one hour apart, and the veto would have
 * capped the pair in both directions. Accepted trade-off: a title that names a
 * scope noun the other lacks ("104. duruşma" vs "105. duruşmanın 2. günü") no
 * longer vetoes; the pair is left to the other lanes.
 */
export function counterVetoFires(aTitle: string, bTitle: string): boolean {
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

export function score(
  a: ScoringFingerprint | FingerprintBundle | null | undefined,
  b: ScoringFingerprint | FingerprintBundle | null | undefined,
  aEntitiesIn: Iterable<string> | Set<string> | null | undefined,
  bEntitiesIn: Iterable<string> | Set<string> | null | undefined,
  tfidfCosine: number,
  hoursDelta: number,
  opts: ScoreOpts = {},
): ScoreResult {
  const { aSourceSlug, bSourceSlug, aTitle, bTitle, aDescription, bDescription } = opts || {};
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
        incidentVeto: false,
        counterVeto: false,
        homonymVeto: false,
        templateVeto: false,
        actorVeto: false,
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
  // Actor veto (h70-mergequality-3): a headline-lane match must not cross
  // actors. When the lane fired but the titles name different actors it is
  // withdrawn: its score is dropped, and the pair is judged as if the lane had
  // not fired, so the text floor and the subject / incident vetoes below
  // apply to it again. Evaluated only for a pair the lane fired for (the
  // subject veto already covers the other pairs).
  // The same withdrawal for two generic headlines whose descriptions name different
  // people (h114-clusterpurity-4, genericHeadlineNameConflict); it needs both
  // descriptions.
  const actorVeto = headlineFired && !!aTitle && !!bTitle &&
    (actorMismatchFires(aTitle, bTitle) ||
      genericHeadlineNameConflict(aTitle, bTitle, aDescription, bDescription));
  const headlineEffective = headlineFired && !actorVeto;
  if (!headlineEffective) headlineScore = 0;

  // 6. Combine. `primary` keeps its computed value; the text floor only
  // limits what it contributes to `raw`. A pair where either side has no
  // whitelist entity cannot earn anything on the entity lane (nothing can be
  // shared), so it is scored on text alone at ENTITY_SPARSE_TEXT_FACTOR
  // instead of being capped at 0.70 of its tf-idf (h19-recall-1). This comes
  // BEFORE the text floor and the vetoes below, which still win.
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
  const subjectVeto = !headlineEffective && !!aTitle && !!bTitle &&
    subjectVetoFires(aTitle, bTitle);
  // Incident veto: the same incident template in different provinces. Same
  // exemption as the subject veto, same cap.
  const incidentVeto = !headlineEffective && !!aTitle && !!bTitle &&
    incidentVetoFires(aTitle, bTitle);
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
