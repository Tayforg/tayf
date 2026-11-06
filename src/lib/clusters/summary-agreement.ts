import { repairEntityResidue } from "../../../supabase/functions/_shared/rss/entities";
import { tidySummaryText } from "@/lib/articles/summary-tidy";
import { normalizeSourceKind } from "@/lib/bias/config";
import { sourceLang } from "@/lib/sources/source-language";
import type { SummaryMember } from "./summary-attribution";

// h31-reader-3 v2: the cluster page's summary is the SEED article's description,
// written once when the cluster is created. On a developing story it can
// contradict the headline on the same page (6e19dd5a: the neutral title says El
// Sayed was elected, the summary says "seçimi önde götürüyor"). The first try,
// "show the newest eligible member", changed 19 of 39 live summaries and 8 of
// them for the worse (a feed-cut stub, a teaser question, a dateline, a glued
// run-on, loaded framing, a round-up that is not about the headline, a dropped
// fact, a contradiction), so this rule is the narrow one: keep the seed UNLESS it
// disagrees with the cluster's current neutral title, and then swap in the member
// that agrees best, if there is one that is clearly better and well formed.
//
// "Agrees" is a linear, deterministic token overlap: the share of the title's
// content tokens that the description carries (`titleAgreement`). It measures
// topical coverage, not meaning. It cannot see that a text which covers the
// headline's words says the opposite, which is why a seed that already covers the
// title (>= AGREEMENT_LOW) is never replaced, and why a replacement must cover it
// almost completely (>= AGREEMENT_HIGH) and far better than the seed
// (>= AGREEMENT_MIN_GAIN). No clock, no I/O.
//
// A replacement is never an agency's copy, exact or near: the neutral title echoes
// the wire lead's wording, so the score favours lightly edited wire text, and a
// candidate that carries 85% or more of a wire or aggregator member's stems (and
// the other way round) is dropped (`textOverlap`, AGENCY_COPY_OVERLAP).
//
// What it does NOT catch: tone and meaning, with one narrow exception (the stage
// rule, h54-editorial-1, below). A text that uses the headline's own
// words but frames the story in loaded terms (2441793c, 0.875) or says something
// else (97589454, 1.0) is clean to every check here. On a healthy cluster the
// seed-agrees gate keeps those out; behind a seed that disagrees with the
// headline they win when they are the best-agreeing member. The other six of the
// eight shapes are kept out lexically (the 0.75 line, the quality predicates).
// summary-attribution.test.ts, section 9, pins both halves, so a change to this
// limit has to be a decision.
//
// h34-reader-4: the gate above reads the seed's WORDS, never its FORM. 78e56dca's
// seed is a Sözcü feed cut ("... düşmanca yaklaşımını…", 18 kaynak) that covers
// half the headline's words and never says what Hamaney said; b6fe7960's seed has
// three opening “ and one closing ”. Both were kept. A seed whose tidied text is a
// feed-cut stub or has unbalanced quotes (`seedDisqualified`) now counts as
// disagreeing even when it covers the headline, and for such a seed the gain over
// it (AGREEMENT_MIN_GAIN) is waived: any member that clears everything else
// replaces it. "Everything else" is unchanged: AGREEMENT_HIGH, the rights, kind,
// language, wire-hash, length, defect (`summaryDefect`) and agency-copy checks, plus
// two that only matter here: a replacement is itself free of unbalanced quotes and
// is not the seed's own text under another outlet's name (before, a copy scored
// what the seed scored and could not pass the gain). With no qualifying member the
// seed stays, never blank. A stub is judged on what the reader would see: the
// tidied text ends in "..." or "…" AND either the raw text is a known feed-cap
// cut (123, 183, 202 or 203 characters, as summary-tidy.ts) or the last sentence
// holds no finite verb (`hasFiniteVerb`, a suffix check with no dictionary: a form
// it misses only flags more, a noun it takes for a verb only keeps the seed). The
// 500-character ingest clamp that the tidy step already cut back to a sentence end
// is not a stub. A clean seed that covers half of the headline is still never
// replaced, whatever the members say. RSS, the digest and the cards pass no title
// and keep the seed, by design (summary-attribution.ts).
//
// h54-editorial-1: the same blindness, one level up. b34a5fe0 (21 kaynak) has the
// headline "Fon soruşturmasında Fatma Betül Sayan Kaya tutuklandı" over the seed
// "... tutuklama talebiyle mahkemeye sevk edildi": the story moved on and the seed
// did not. "tutuklama" and "tutuklandı" are both the stem "tutuk", so the seed
// covers 6 of the 7 title stems and was kept. `stageBehindTitle` reads the one
// thing the stems fold away: three families of "this happened" against "this was
// asked for or had just begun". A family is an OUTCOME the headline can state and
// the EARLIER stages that lead up to it:
//   - arrest:  "tutuklan..." over "tutuklama talebi/istemi", "tutuklanması talep
//              edil.../istendi", "sevk edil...", "gözaltına alın...";
//   - release: "serbest bırakıl...", "tahliye edil...", "tahliyesine karar" over
//              "tahliye talebi/istemi", "tahliye edilmesi/serbest bırakılması
//              talep edil.../istendi";
//   - death:   "hayatını kaybet/yitir...", "yaşamını kaybet/yitir...", "can ver...",
//              "şehit ol.../düş...", "öldü", "öldürüldü" over "yaralandı",
//              "ağır yaralı", "hastaneye kaldırıldı", "yoğun bakım".
// A REQUEST or a NEGATION is not an outcome, whatever stem it holds: the request
// forms ("tutuklanması talep edildi/edilen", "tutuklanmasını istedi", "tutuklanması
// istendi", and the same for "tahliye edilmesi" and "serbest bırakılması") and the
// negations ("tutuklanmadı", "tahliye edilmedi", "serbest bırakılmadı") state that
// the thing was asked for or did not happen. They are kept out of the outcome
// patterns (the request forms count as the family's earlier stage instead), so a
// request-stage text never stands in for a stale seed and a request-stage or
// negated headline never makes a seed look stale (correctness-1).
// The seed is stale when the headline states the outcome of a family, the seed
// does not, and the seed holds one of that family's earlier stages. A stale seed is
// treated like a malformed one: it counts as disagreeing, the gain over it is
// waived and its own text is kept out. One thing is added for it, because the
// stems cannot tell a replacement at the same stage from one that moved on: the
// replacement must itself state the outcome (`carriesOutcome`) and must not be a
// stage behind (`!stageBehindTitle`). Every other gate is unchanged. With no such
// member the seed stays, never blank. Still lexical, still linear: a fixed list of
// phrases, not a reading of the story. A story that moved on in a way these three
// families do not name (an indictment over an investigation, a verdict over a
// trial) is as invisible as before.

/** A seed scoring below this disagrees with the title (exclusive: 0.5 is kept). */
export const AGREEMENT_LOW = 0.5;
/** A replacement must score at least this (inclusive). */
export const AGREEMENT_HIGH = 0.75;
/** A replacement must beat the seed by at least this much (inclusive). */
export const AGREEMENT_MIN_GAIN = 0.3;
/** A title with fewer content tokens carries no signal: the seed is kept. */
export const AGREEMENT_MIN_TITLE_TOKENS = 3;
/** A replacement's tidied text must be at least this long (no stubs, no headlines). */
export const AGREEMENT_MIN_CHARS = 60;
/**
 * A replacement whose content stems overlap a wire or aggregator member's by at
 * least this share (inclusive, against the larger of the two texts) is that
 * agency's copy, not the outlet's own words. In the 280-cluster replay the three
 * picks that re-ran an Anadolu Ajansı lead with a phrase dropped or a word changed
 * scored 0.895, 0.935 and 0.952; the closest pick below the line is 0.80 (a
 * one-sentence rewrite of a BHA lead, kept) and the rest are 0.64 or less. The
 * line is a judgement between those, not a measured boundary.
 */
export const AGENCY_COPY_OVERLAP = 0.85;

/** Guards the ratio comparisons against floating point (9/20 + 0.3 is not 15/20). */
const EPSILON = 1e-9;

/**
 * Tokens are compared on their first five characters: a light stemmer for
 * Turkish's suffixes ("kazandı" and "kazanarak", "seçildi" and "seçilen",
 * "Senato" and "senatör"). It errs towards matching, which only makes the seed
 * look better (the safe side) and a replacement has to clear 0.75 anyway.
 */
export const STEM_LENGTH = 5;

/**
 * Function words that carry no topic, in the folded spelling (no diacritics, "ı"
 * as "i"). Small on purpose: "oldu", "ilk", "sonra" are content (the outcome
 * words of a headline are exactly what a stale seed lacks). One-letter tokens are
 * dropped separately. "su" (water) is not here although "şu" folds to it.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "ve", "ile", "de", "da", "ki", "mi", "mu", "bir", "bu", "icin", "gibi", "daha",
  "cok", "en", "ama", "fakat", "ancak", "veya", "ya", "her", "olarak", "olan",
  "ise", "hem", "ne", "bile", "kadar",
  "the", "an", "of", "in", "on", "to", "and", "for", "is", "at", "by", "with",
  "as", "from", "that", "this", "are", "was", "be", "it", "its",
]);

/** Turkish lower case, diacritics stripped, dotless "ı" as "i": "İSTANBUL", "ISTANBUL" and "İstanbul" agree. */
function fold(s: string): string {
  return s
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ı/g, "i");
}

// An apostrophe glued to a word starts a Turkish suffix ("Senato'ya", "ABD’nin",
// "14'er"): the suffix goes. A quote mark next to a space is only punctuation.
const APOSTROPHE_SUFFIX = /(?<=[\p{L}\p{N}])['’‘ʼ`´]\p{L}*/gu;
const NOT_A_WORD = /[^\p{L}\p{N}]+/u;

/** Every word of `text` in the folded spelling: apostrophe suffixes gone, split on anything that is not a letter or a digit. */
function words(text: string): string[] {
  return fold(text)
    .replace(APOSTROPHE_SUFFIX, " ")
    .split(NOT_A_WORD)
    .filter((w) => w !== "");
}

/** True for a folded word that carries content: not a stopword, not a lone letter (a lone digit stays). */
function isContentWord(w: string): boolean {
  if (STOPWORDS.has(w)) return false;
  return w.length >= 2 || /^\p{N}$/u.test(w);
}

/**
 * The content words of `text` in the folded spelling, whole (not yet cut to
 * {@link STEM_LENGTH}): exactly the words {@link stemsOf} cuts its stems from, in
 * text order, repeats kept. Stopwords and one-letter words are out; apostrophe
 * suffixes are gone. [] for a non-string. For a caller that has to tell two words
 * with one stem apart ("Cumhurbaşkanı" and "Cumhuriyet" are both `cumhu`).
 */
export function contentWords(text: string): string[] {
  return typeof text === "string" ? words(text).filter(isContentWord) : [];
}

/**
 * Stems of the content words of `text` (stopwords and one-letter words dropped).
 * A word `skipWord` flags (it is given the folded whole word) leaves no stem.
 */
function contentStems(text: string, skipWord?: (foldedWord: string) => boolean): Set<string> {
  const stems = new Set<string>();
  for (const w of words(text)) {
    if (!isContentWord(w)) continue;
    if (skipWord?.(w)) continue;
    stems.add(w.slice(0, STEM_LENGTH));
  }
  return stems;
}

/** The title's content stems, or null when it has too few to say anything. */
function titleStems(title: unknown): Set<string> | null {
  if (typeof title !== "string") return null;
  const stems = contentStems(title);
  return stems.size >= AGREEMENT_MIN_TITLE_TOKENS ? stems : null;
}

function coverage(stems: ReadonlySet<string>, text: unknown): number {
  if (typeof text !== "string") return 0;
  const present = contentStems(text);
  let hits = 0;
  for (const stem of stems) if (present.has(stem)) hits++;
  return hits / stems.size;
}

/**
 * The share of the title's distinct content tokens that `text` carries, 0 to 1,
 * or null when the title has fewer than {@link AGREEMENT_MIN_TITLE_TOKENS}
 * content tokens (or is not a string). Case, Turkish diacritics, punctuation,
 * apostrophe suffixes, stopwords and the order of the words do not matter;
 * tokens match on their first five characters. One pass over each text.
 */
export function titleAgreement(title: string, text: string): number | null {
  const stems = titleStems(title);
  return stems === null ? null : coverage(stems, text);
}

/**
 * The counts behind {@link titleAgreement}: how many of the title's distinct
 * content stems `text` carries (`shared`) out of how many the title has
 * (`total`), so `shared / total` is the agreement. null exactly when
 * titleAgreement is (fewer than {@link AGREEMENT_MIN_TITLE_TOKENS} content
 * tokens, or a non-string title); a non-string `text` shares nothing. Same
 * folding, same single pass over each text.
 */
export function titleStemOverlap(
  title: string,
  text: string,
): { shared: number; total: number } | null {
  const stems = titleStems(title);
  if (stems === null) return null;
  const present = typeof text === "string" ? contentStems(text) : new Set<string>();
  let shared = 0;
  for (const stem of stems) if (present.has(stem)) shared++;
  return { shared, total: stems.size };
}

/**
 * The distinct content stems of `text` (folded, first five characters, stopwords
 * and one-letter words out) as a fresh set the caller may keep or extend; empty
 * for a non-string. The vocabulary {@link sharedStemsExcluding} compares in, so a
 * caller that builds an `excluded` set runs its words through here, not through
 * its own folding.
 */
export function stemsOf(text: string): Set<string> {
  return typeof text === "string" ? contentStems(text) : new Set<string>();
}

/**
 * How many distinct content stems of `a` that `b` also carries, not counting the
 * ones in `excluded` (stems as {@link stemsOf} returns them). Same folding and
 * the same single pass as {@link titleStemOverlap}, with two differences: there
 * is NO minimum-token rule (a two-word `a` still counts, where titleStemOverlap
 * says null), and the result is the bare count, not a share. 0 when either side
 * is not a string. Used by "İlgili haberler" (h37-clusters-1) to ask how much two
 * headlines share BEYOND the entity they both name. `excluded` is only read.
 *
 * `skipWord`, when given, is asked about every folded content word of BOTH texts
 * and a word it flags is dropped before the stems are built, so it leaves no
 * stem on either side. That is how a word is told from another word with the same
 * five characters: excluding the stem `cumhu` would also drop "Cumhuriyet",
 * dropping the word "Cumhurbaşkanı" does not.
 */
export function sharedStemsExcluding(
  a: string,
  b: string,
  excluded: ReadonlySet<string>,
  skipWord?: (foldedWord: string) => boolean,
): number {
  if (typeof a !== "string" || typeof b !== "string") return 0;
  const present = contentStems(b, skipWord);
  let shared = 0;
  for (const stem of contentStems(a, skipWord)) if (present.has(stem) && !excluded.has(stem)) shared++;
  return shared;
}

/** Shared stems over the size of the LARGER set: 1 for the same words, 0 when either set is empty. */
function mutualOverlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (large.size === 0) return 0;
  let hits = 0;
  for (const stem of small) if (large.has(stem)) hits++;
  return hits / large.size;
}

/**
 * How much two texts say the same words, 0 to 1: the content stems both carry,
 * over the stems of the larger text. Symmetric. A long article that holds a short
 * lead scores low against it (a lead of 20 stems inside 40 is 0.5), the same lead
 * with a phrase dropped or a word changed scores high (20 of 22 is 0.91). Same
 * folding as {@link titleAgreement}; one pass over each text; 0 for a non-string.
 */
export function textOverlap(a: string, b: string): number {
  if (typeof a !== "string" || typeof b !== "string") return 0;
  return mutualOverlap(contentStems(a), contentStems(b));
}

/** True when the seed's score is low enough to look for something better. */
function disagrees(seedScore: number): boolean {
  return seedScore < AGREEMENT_LOW - EPSILON;
}

/**
 * The three-way gate: the seed is below {@link AGREEMENT_LOW} (exclusive), the
 * candidate is at least {@link AGREEMENT_HIGH} (inclusive) and beats the seed by
 * at least {@link AGREEMENT_MIN_GAIN} (inclusive). A null score on either side
 * (a title with no signal) never switches.
 *
 * `seedMalformed` (h34-reader-4: the seed is a feed-cut stub or has unbalanced
 * quotes, see {@link seedDisqualified}) takes the seed's score out of it: only the
 * candidate's {@link AGREEMENT_HIGH} is left. The seed is replaced for its form,
 * so its ceiling and the gain over it no longer apply. Default false.
 */
export function agreementSwitches(
  seedScore: number | null,
  candidateScore: number | null,
  seedMalformed = false,
): boolean {
  if (seedScore === null || candidateScore === null) return false;
  if (candidateScore < AGREEMENT_HIGH - EPSILON) return false;
  if (seedMalformed) return true;
  return disagrees(seedScore) && candidateScore - seedScore >= AGREEMENT_MIN_GAIN - EPSILON;
}

export type SummaryDefect = "stub" | "teaser" | "dateline" | "run-on";

const CLOSERS = new Set(['"', "”", "»", "’", "'", ")", "]"]);

/** `s` without the blanks and closing quotes at its end (a loop: a regex on a long blank run is quadratic). */
function withoutClosingMarks(s: string): string {
  let end = s.length;
  while (end > 0 && (s.charAt(end - 1).trim() === "" || CLOSERS.has(s.charAt(end - 1)))) end--;
  return s.slice(0, end);
}

/** A text that ends in "..." or "…": a feed cut it (Sözcü at 123 characters, Haberport at 203, the ingest clamp at 500). */
function endsCut(s: string): boolean {
  const end = withoutClosingMarks(s);
  return end.endsWith("...") || end.endsWith("…");
}

// A come-on: "Peki, ... kimdir?" "İşte ayrıntılar". A sentence that opens with
// "Peki" or "İşte" (folded: "peki", "iste"), not the same words inside a sentence.
const COME_ON = /(?:^|[.!?…]["”»’')\]]*\s+)(?:peki|iste)(?![\p{L}\p{N}])/u;

function isTeaser(shown: string): boolean {
  return shown.includes("?") || COME_ON.test(fold(shown));
}

// "İSTANBUL (Medyascope) – ...", "ANKARA (AA) - ...", "GÜNEY KORE, (DHA) - ...",
// "Melih Kiram GEDİK, (DHA) - ...", "Ankara, 4 Kasım (AA) - ...": a short lead, a
// parenthesised agency that starts with a letter, a dash.
const AGENCY_DATELINE = /^[^()\n]{0,40}\(\p{L}[^()\n]{0,29}\)\s*[-–—]/u;
// "HABER MERKEZİ - ...", "ANKARA – ...": nothing but capitals up to a dash. At
// least four letters, so "ABD-İran gerilimi" is not a dateline.
const CAPITALS_DATELINE = /^\p{Lu}[\p{Lu}\s.,'’]{1,40}[-–—]/u;
const MIN_DATELINE_LETTERS = 4;

function hasDatelineLead(shown: string): boolean {
  if (AGENCY_DATELINE.test(shown)) return true;
  const caps = CAPITALS_DATELINE.exec(shown);
  return caps !== null && (caps[0].match(/\p{L}/gu)?.length ?? 0) >= MIN_DATELINE_LETTERS;
}

/** The first this many words of a text, repeated further on, are a headline glued onto its own body. */
const RUN_ON_WORDS = 5;

function isRunOn(shown: string): boolean {
  const all = words(shown);
  const k = RUN_ON_WORDS;
  if (all.length < 2 * k) return false;
  for (let start = k; start + k <= all.length; start++) {
    let same = true;
    for (let j = 0; j < k && same; j++) same = all[start + j] === all[j];
    if (same) return true;
  }
  return false;
}

/**
 * Why a description is not fit to stand in for the seed, or null. `raw` is the
 * member's repaired, trimmed description and `shown` its tidied form
 * (`tidySummaryText`). Checked in this order, the first that applies is returned:
 *   - "stub": a feed cut it ("..." or "…" at the end, raw or tidied);
 *   - "teaser": a question mark anywhere, or a sentence that opens with Peki/İşte;
 *   - "dateline": an agency or all-caps place lead ("İSTANBUL (Medyascope) –");
 *   - "run-on": its first five words come again later (a title glued to the body).
 * Never throws.
 */
export function summaryDefect(raw: string, shown: string): SummaryDefect | null {
  if (typeof raw !== "string" || typeof shown !== "string") return null;
  if (endsCut(raw) || endsCut(shown)) return "stub";
  if (isTeaser(shown)) return "teaser";
  if (hasDatelineLead(shown)) return "dateline";
  if (isRunOn(shown)) return "run-on";
  return null;
}

// ---------------------------------------------------------------------------
// The seed's own form (h34-reader-4)
// ---------------------------------------------------------------------------

/**
 * Lengths at which an outlet's feed cuts its own description and adds "..."
 * (Sözcü 123, Daily Sabah 183, Haberport 202 and 203). The same list as
 * FEED_CAP_LENGTHS in summary-tidy.ts, which does not export it. The 499 and 500
 * of the ingest clamp are not here: the tidy step cuts that back to a sentence end.
 */
const FEED_CAP_LENGTHS: readonly number[] = [123, 183, 202, 203];
const CUT_DOTS = "...";

const LETTER_OR_DIGIT = /^[\p{L}\p{N}]$/u;

/** True for a raw text an outlet's feed cut inside a word: a cap length, "..." after a letter or digit. */
function isFeedCapCut(raw: string): boolean {
  if (!raw.endsWith(CUT_DOTS) || !FEED_CAP_LENGTHS.includes(raw.length)) return false;
  return LETTER_OR_DIGIT.test(raw.charAt(raw.length - CUT_DOTS.length - 1));
}

// Finite verb forms, in the folded spelling `words` returns (no diacritics, "ı" as
// "i", "ç" as "c", "ş" as "s", "ğ" as "g"). Suffix checks only, no dictionary: a
// noun that looks like a verb ("gelecek", "hadi") keeps a seed, a verb form that is
// missing (the aorist "-ar/-ir", the optative, the imperative) flags a cut sentence
// that was already cut. Left out on purpose: "-maz/-mez" (ertelenemez, kaçınılmaz
// are adjectives), "-n" after a past tense ("kadın", "adın"), and every bare "-ı".
interface FiniteEnding {
  suffix: string;
  /** Letters in front of the suffix. */
  minStem: number;
  /** "d": the letter in front is not a voiceless consonant; "t": it is; null: any. */
  voicing: "d" | "t" | null;
}

/** Consonants that take "-t..." instead of "-d..." (folded: "ç" is "c", "ş" is "s"). */
const VOICELESS = new Set(["c", "f", "h", "k", "p", "s", "t"]);

function endings(
  bases: readonly string[],
  persons: readonly string[],
  minStem: number,
  voicing: FiniteEnding["voicing"],
): FiniteEnding[] {
  const out: FiniteEnding[] = [];
  for (const base of bases) for (const person of persons) out.push({ suffix: base + person, minStem, voicing });
  return out;
}

const FINITE_ENDINGS: readonly FiniteEnding[] = [
  // Definite past: yaptı, dedi, açıkladı, söyledi, konuştular, yürüdük. "d" after a
  // vowel or a voiced consonant, "t" after a voiceless one: "toplantı" and
  // "hükümeti" are nouns, "yaptı" and "bitti" are not.
  ...endings(["di", "du"], ["", "m", "k", "niz", "nuz", "lar", "ler"], 2, "d"),
  ...endings(["ti", "tu"], ["", "m", "k", "niz", "nuz", "lar", "ler"], 2, "t"),
  // Reported past: değiştirmiş, benimsenmiştir, söylemişti.
  ...endings(
    ["mis", "mus"],
    ["", "ti", "tu", "tir", "tur", "lar", "ler", "im", "um", "iz", "uz", "sin", "sun", "siniz", "sunuz"],
    2,
    null,
  ),
  // Progressive: yükseliyor, çalışıyoruz, oluyordu.
  ...endings(["iyor", "uyor"], ["", "um", "sun", "uz", "sunuz", "lar", "du", "mus"], 1, null),
  // Future: yapacak, yöneteceğiz, açıklayacaktır.
  ...endings(["acak", "ecek"], ["", "tir", "tur", "lar", "ler", "sin", "siniz"], 2, null),
  ...endings(["acag", "eceg"], ["im", "iz"], 2, null),
  // Necessity and possibility: kaldırılmalı, olmalıdır, olabilir.
  ...endings(["mali", "meli"], ["", "dir", "dur", "lar", "ler"], 2, null),
  ...endings(["abilir", "ebilir"], ["", "ler", "lar"], 1, null),
  // Copula: ülkedir, kaçıştır.
  ...endings(["dir", "dur"], [""], 2, "d"),
  ...endings(["tir", "tur"], [""], 2, "t"),
];

/** Whole words that are a predicate of their own: "taviz yok", "yetki var". */
const FINITE_WORDS: ReadonlySet<string> = new Set([
  "var", "yok", "degil", "vardir", "yoktur", "degildir", "idi", "imis",
]);

/**
 * Words that end like a past tense and are not one: "Suudi Arabistan" (the replay's
 * 2248f2a7 read it as "suudi" = a verb and kept a cut seed), "kedi", "hadi",
 * "hindi". Folded, whole words. A name or noun missing here only keeps a seed.
 */
const NOT_FINITE_WORDS: ReadonlySet<string> = new Set(["suudi", "kedi", "hadi", "hindi"]);

function isFiniteVerbForm(word: string): boolean {
  if (FINITE_WORDS.has(word)) return true;
  if (NOT_FINITE_WORDS.has(word)) return false;
  for (const e of FINITE_ENDINGS) {
    const stem = word.length - e.suffix.length;
    if (stem < e.minStem || !word.endsWith(e.suffix)) continue;
    if (e.voicing === null) return true;
    const voiceless = VOICELESS.has(word.charAt(stem - 1));
    if (e.voicing === "t" ? voiceless : !voiceless) return true;
  }
  return false;
}

/**
 * True when some word of `text` ends in a Turkish finite verb form (past,
 * reported past, progressive, future, necessity, possibility, copula, "var/yok").
 * Lexical and one pass: see {@link FINITE_ENDINGS} for what it takes and leaves.
 * Never throws; false for a non-string.
 */
export function hasFiniteVerb(text: string): boolean {
  if (typeof text !== "string") return false;
  for (const w of words(text)) if (isFiniteVerbForm(w)) return true;
  return false;
}

const SENTENCE_END_MARKS = new Set([".", "!", "?", "…"]);

/** Abbreviations whose dot is not a sentence end (folded spelling). */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  "dr", "prof", "doc", "av", "sn", "st", "uzm", "yrd", "ogr", "gen", "alb", "org", "muh", "op",
  "ecz", "dt", "mah", "cad", "sok", "no", "vb", "vs", "vd", "yy", "bkz", "tel",
]);

/** True when the "." at `at` ends an abbreviation, an initial or an ordinal ("Prof.", "M.", "14."), not a sentence. */
function isNonSentenceDot(body: string, at: number): boolean {
  let start = at;
  while (start > 0 && LETTER_OR_DIGIT.test(body.charAt(start - 1))) start--;
  const token = body.slice(start, at);
  if (token === "") return false;
  if (/^\p{N}+$/u.test(token)) return true;
  if ([...token].length === 1) return true;
  return ABBREVIATIONS.has(fold(token));
}

/**
 * The last sentence of a text that ends in a cut: without the cut itself (the
 * dots, the "…", the blanks and closing marks behind them), after the last
 * ". ! ? …" (and its closing marks) that is followed by a blank and is not an
 * abbreviation's, an initial's or an ordinal's dot. The whole text when there is
 * none. A scan from the end, so it stops at the first sentence end.
 */
function lastSentence(shown: string): string {
  let end = shown.length;
  while (end > 0) {
    const ch = shown.charAt(end - 1);
    if (ch.trim() === "" || CLOSERS.has(ch) || ch === "." || ch === "…") end--;
    else break;
  }
  const body = shown.slice(0, end);
  for (let i = body.length - 2; i >= 0; i--) {
    if (body.charAt(i).trim() !== "") continue;
    let j = i - 1;
    while (j >= 0 && CLOSERS.has(body.charAt(j))) j--;
    if (j < 0 || !SENTENCE_END_MARKS.has(body.charAt(j))) continue;
    if (body.charAt(j) === "." && isNonSentenceDot(body, j)) continue;
    return body.slice(i + 1);
  }
  return body;
}

/**
 * A feed-cut stub, as the reader sees it: the tidied text ends in "..." or "…" and
 * either the raw text is a known feed-cap cut or the last sentence has no finite
 * verb. Not a stub: a tidied text that no longer ends in a cut (the 500-character
 * clamp the tidy step cut back to a sentence end), or a sentence that is complete
 * and only trails off (`... hedefliyoruz"…`).
 */
function isCutStub(raw: string, shown: string): boolean {
  if (!endsCut(shown)) return false;
  return isFeedCapCut(raw) || !hasFiniteVerb(lastSentence(shown));
}

/**
 * Whether the text opens a double quote it never closes (or closes one it never
 * opened): an odd number of straight " (U+0022) or unequal “ (U+201C) and ”
 * (U+201D). The same rule as neutral-title.ts for a title, without « ». Single
 * quotes and apostrophes are never counted. One pass, no regex.
 */
function unbalancedQuotes(s: string): boolean {
  let straight = 0;
  let curly = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) straight++;
    else if (c === 0x201c) curly++;
    else if (c === 0x201d) curly--;
  }
  return straight % 2 === 1 || curly !== 0;
}

export type SeedDefect = "stub" | "quotes";

/**
 * Why a seed is not fit to stay on the page whatever it covers of the headline, or
 * null (h34-reader-4). `raw` is the seed's repaired, trimmed description and
 * `shown` its tidied form (`tidySummaryText`), which is what the page would show.
 * Checked in this order, the first that applies is returned:
 *   - "stub": a feed cut it (see {@link isCutStub}): the shown text ends in "..."
 *     or "…" and the raw text is a known feed-cap cut or the last sentence has no
 *     finite verb ({@link hasFiniteVerb});
 *   - "quotes": the shown text has an odd number of straight " or unequal “ and ”.
 * Never throws.
 */
export function seedDisqualified(raw: string, shown: string): SeedDefect | null {
  if (typeof raw !== "string" || typeof shown !== "string") return null;
  if (isCutStub(raw, shown)) return "stub";
  if (unbalancedQuotes(shown)) return "quotes";
  return null;
}

// ---------------------------------------------------------------------------
// A headline that reports a later stage than the text (h54-editorial-1)
// ---------------------------------------------------------------------------

/**
 * One story arc: what the headline says once it has happened (`outcome`) and what
 * a text says while it has only begun (`earlier`). Every pattern is written in the
 * folded spelling `fold` returns (no diacritics, "ı" as "i"), so "bırakıl" is
 * "birakil". No pattern has a nested quantifier: they are literal phrases with
 * one-blank gaps, and the text's blanks are collapsed to one first, so a long run
 * of blanks costs a pass, not a backtrack.
 */
interface StageFamily {
  outcome: RegExp;
  /**
   * An outcome word that only its diacritics tell from another word, read on the
   * lower-cased text with its diacritics kept: "öldü" (died) is "oldu" (became) once
   * folded, and "oldu" is in half the headlines of the day. Null when the folded
   * spelling is enough.
   */
  outcomeSpelled: RegExp | null;
  earlier: RegExp;
}

const STAGE_FAMILIES: readonly StageFamily[] = [
  {
    // "tutuklanması talebiyle sevk edildi" holds "tutuklan" and is the REQUEST, not
    // the arrest; so are "tutuklanması talep edilen/edildi", "tutuklanmasını istedi"
    // and "tutuklanması istendi". "tutuklanmadı/tutuklanmayan/tutuklanmamış/
    // tutuklanmaz" are negations (the participle "tutuklanmış" has no "ma" and
    // stays an outcome). "tutuklanmasına karar verildi" is the arrest and stays one.
    outcome: /tutuklan(?!ma(?:si|sini)? (?:tale[bp]|iste)|ma(?:di|yan|mis|z))/,
    outcomeSpelled: null,
    earlier:
      /tutuklama (?:talebi|istemi)|tutuklanma(?:si|sini)? (?:tale[bp]|iste)|sevk edil|gozaltina alin/,
  },
  {
    // "tahliye edilmesi talebiyle" and "serbest bırakılmasını istedi" are the
    // request, as "tutuklanması talebiyle" is; "tahliye edilmedi" and "serbest
    // bırakılmadı" say it did not happen.
    outcome:
      /serbest birakil(?!ma(?:di|yan|mis|z)|masi(?:ni)? (?:tale[bp]|iste))|tahliye edil(?!me(?:di|yen|mis|z)|mesi(?:ni)? (?:tale[bp]|iste))|tahliyesine karar/,
    outcomeSpelled: null,
    earlier:
      /tahliye (?:talebi|istemi)|tahliye edilmesi(?:ni)? (?:tale[bp]|iste)|serbest birakilmasi(?:ni)? (?:tale[bp]|iste)/,
  },
  {
    // "can ver" and "şehit ol/düş" are other ways to say the same death. The
    // letter lookbehind keeps a name ending in -can ("Özcan verdiği", "Ercan
    // verdi") from reading as one.
    outcome:
      /(?<![\p{L}])(?:hayatini (?:kaybet|yitir)|yasamini (?:kaybet|yitir)|can ver|sehit (?:ol|dus))/u,
    // "öldü" (died) is "oldu" (became) once folded, so it is read with its
    // diacritics. "öldürüldü" (was killed) is the passive of the same death and is
    // spelled here too, so the folded form never collides with "oldu"; "öldürdü"
    // (killed someone) is not matched.
    outcomeSpelled: /(?<![\p{L}])öl(?:dü|dürüldü)(?![\p{L}])/u,
    earlier: /yaralandi|agir yarali|hastaneye kaldirildi|yogun bakim/,
  },
];

/** A text in the two spellings the stage patterns read, blanks collapsed to one. */
interface StageView {
  folded: string;
  spelled: string;
}

function stageView(text: string): StageView {
  const spaced = text.replace(/\s+/g, " ");
  return { folded: fold(spaced), spelled: spaced.toLocaleLowerCase("tr-TR").normalize("NFC") };
}

function statesOutcome(family: StageFamily, view: StageView): boolean {
  return family.outcome.test(view.folded) || (family.outcomeSpelled?.test(view.spelled) ?? false);
}

/** The families whose outcome the headline states. */
function outcomeFamilies(title: unknown): readonly StageFamily[] {
  if (typeof title !== "string" || title === "") return [];
  const view = stageView(title);
  return STAGE_FAMILIES.filter((family) => statesOutcome(family, view));
}

/** True when, for some family in `families`, the text does not state the outcome and holds an earlier stage. */
function isBehind(families: readonly StageFamily[], text: unknown): boolean {
  if (typeof text !== "string" || families.length === 0) return false;
  const view = stageView(text);
  return families.some((family) => !statesOutcome(family, view) && family.earlier.test(view.folded));
}

/** True when the text states the outcome of EVERY family in `families` (false for none: there is nothing to carry). */
function statesAll(families: readonly StageFamily[], text: unknown): boolean {
  if (typeof text !== "string" || families.length === 0) return false;
  const view = stageView(text);
  return families.every((family) => statesOutcome(family, view));
}

/**
 * True when the headline reports a LATER stage of the story than `text` does
 * (h54-editorial-1): for some family (arrest, release, death; see the header) the
 * title states the outcome, the text does not, and the text holds one of the
 * family's earlier stages. "Fon soruşturmasında Fatma Betül Sayan Kaya
 * tutuklandı" over "... tutuklama talebiyle mahkemeye sevk edildi" is behind. Not
 * behind: a text that states the outcome as well as the earlier stage ("hakimliğe
 * sevk edilen ... tutuklandı"), a text that holds no earlier stage, and a title
 * that is itself at the earlier stage ("tutuklama istemiyle hakimliğe sevk
 * edildi"), which states no outcome.
 *
 * Both are read in the folded spelling of this module (case, diacritics and "ı"
 * do not matter), blanks collapsed, except for the death family's "öldü", which is
 * matched (with "öldürüldü") as a whole word with its diacritics so that "oldu"
 * (became) never counts. One pass over each text. Never throws; false for a
 * non-string.
 */
export function stageBehindTitle(title: string, text: string): boolean {
  return isBehind(outcomeFamilies(title), text);
}

/**
 * True when `text` states the outcome of the family the headline triggered (the
 * pair of {@link stageBehindTitle}): "tutuklanarak cezaevine gönderildi" carries
 * "tutuklandı", "tutuklama talebiyle sevk edildi" and "tutuklanması talebiyle"
 * do not. A headline that triggers several families (it says "tutuklandı" and
 * "serbest bırakıldı") needs a text that states every one. False when the headline
 * triggers none: there is no outcome to carry. Never throws; false for a
 * non-string.
 */
export function carriesOutcome(title: string, text: string): boolean {
  return statesAll(outcomeFamilies(title), text);
}

/** The member that should replace the seed, with the text to show (its tidied description). */
export interface AgreeingPick {
  member: SummaryMember;
  text: string;
}

interface Scored extends AgreeingPick {
  score: number;
  /** Publish time for "newest" ordering; unknown is oldest. */
  recency: number;
  /** Publish time for "earliest" ordering; unknown is latest. */
  seniority: number;
}

function byNewest(a: Scored, b: Scored): number {
  return (
    b.score - a.score ||
    b.recency - a.recency ||
    a.member.source.name.localeCompare(b.member.source.name, "tr")
  );
}

/**
 * The member whose description should replace the seed's on the cluster page, or
 * null to keep the seed. Pure, one pass over the members plus one sort of the
 * qualifiers.
 *
 * The seed must disagree with `title` ({@link AGREEMENT_LOW}), be malformed
 * ({@link seedDisqualified}: a feed-cut stub, unbalanced quotes; h34-reader-4) or
 * be a stage behind the title ({@link stageBehindTitle}: "tutuklandı" over
 * "tutuklama talebiyle"; h54-editorial-1); a title without enough content tokens,
 * or a clean seed that agrees and is not behind, returns null before any other
 * member is looked at. For a malformed or stale seed the gain over the seed is
 * waived, and two more conditions hold: the member's text is not the seed's own
 * (raw or tidied, under another outlet's name) and has no unbalanced quotes. For a
 * stale seed a third holds: the member's text states the outcome the title
 * reports and is not itself a stage behind it ({@link carriesOutcome}). A member
 * qualifies when ALL of these hold:
 *   - its source allows excerpts (`excerpt_allowed !== false`) and is not a wire
 *     or aggregator (`normalizeSourceKind`; a missing kind is an outlet);
 *   - it is written in the seed's language (`sourceLang`);
 *   - its content hash is not one of `wireMajorityHashes` (the dispatch a wire
 *     redistribution copied: the seed's own check, applied to the candidate);
 *   - its description, repaired and trimmed, is not empty, is not the text of a
 *     rights-blocked member and is not the text of a wire or aggregator member (a
 *     copy of an agency's words is the agency's), and its tidied text is not a
 *     near copy of one either ({@link AGENCY_COPY_OVERLAP}: a phrase dropped, a
 *     word changed, a CTA tail added still leave the agency's words);
 *   - its tidied text is at least {@link AGREEMENT_MIN_CHARS} long and has no
 *     {@link summaryDefect};
 *   - its score passes {@link agreementSwitches}. Behind a clean seed a copy of the
 *     seed's text scores what the seed scores, so it can never pass.
 * Among the qualifiers the highest score wins and a tie goes to the newest; the
 * outlet name, ascending in Turkish order, settles the same instant, so the pick
 * never depends on the member order. Members with the same text count once and
 * are credited to the earliest of them, as `findSeedMember` credits the seed.
 */
export function findAgreeingMember({
  members,
  seed,
  seedShown,
  title,
  wireMajorityHashes,
}: {
  members: readonly SummaryMember[];
  seed: SummaryMember;
  /** The seed's tidied text: what the page would show without a replacement. */
  seedShown: string;
  title: string;
  wireMajorityHashes: ReadonlySet<string>;
}): AgreeingPick | null {
  const stems = titleStems(title);
  if (stems === null) return null;
  const seedScore = coverage(stems, seedShown);
  const seedRaw = repairEntityResidue(seed.article.description ?? "").trim();
  // The title's outcome families, read once: the seed and every candidate are
  // held against them.
  const families = outcomeFamilies(title);
  const stale = isBehind(families, seedShown);
  // A malformed or a stale seed is replaced for what it is, not for what it covers:
  // its score and the gain over it no longer apply.
  const malformed = seedDisqualified(seedRaw, seedShown) !== null || stale;
  if (!malformed && !disagrees(seedScore)) return null;

  const texts = members.map((m) => repairEntityResidue(m.article.description ?? "").trim());
  const blockedTexts = new Set<string>();
  const agencyTexts = new Set<string>();
  members.forEach((m, i) => {
    if (m.source.excerpt_allowed === false) blockedTexts.add(texts[i] ?? "");
    const kind = normalizeSourceKind(m.source.kind);
    if (kind === "wire" || kind === "aggregator") agencyTexts.add(texts[i] ?? "");
  });

  // The wire and aggregator members' tidied stems, built on first use: only a
  // member that already passed every other gate is compared against them.
  let agencyStems: Set<string>[] | null = null;
  const isAgencyCopy = (shown: string): boolean => {
    if (agencyStems === null) {
      agencyStems = [];
      const seen = new Set<string>();
      members.forEach((m, i) => {
        const kind = normalizeSourceKind(m.source.kind);
        const raw = texts[i] ?? "";
        if ((kind !== "wire" && kind !== "aggregator") || raw === "" || seen.has(raw)) return;
        seen.add(raw);
        agencyStems!.push(contentStems(tidySummaryText(raw)));
      });
    }
    const own = contentStems(shown);
    return agencyStems.some((agency) => {
      // The overlap cannot reach the line when one text is much the smaller.
      const [small, large] = own.size <= agency.size ? [own.size, agency.size] : [agency.size, own.size];
      if (large === 0 || small / large < AGENCY_COPY_OVERLAP - EPSILON) return false;
      return mutualOverlap(own, agency) >= AGENCY_COPY_OVERLAP - EPSILON;
    });
  };

  const seedLang = sourceLang(seed.source);
  // Same text, one entry: the earliest publisher.
  const byText = new Map<string, Scored>();
  members.forEach((m, i) => {
    if (m === seed) return;
    if (m.source.excerpt_allowed === false) return;
    // Stated outright although `agencyTexts` below implies it (an agency's own
    // text is in that set): the rule is "no wire or aggregator member".
    const kind = normalizeSourceKind(m.source.kind);
    if (kind === "wire" || kind === "aggregator") return;
    if (sourceLang(m.source) !== seedLang) return;
    const hash = m.article.content_hash;
    if (hash !== null && wireMajorityHashes.has(hash)) return;
    const raw = texts[i] ?? "";
    if (raw === "" || blockedTexts.has(raw) || agencyTexts.has(raw)) return;

    const shown = tidySummaryText(raw);
    if (shown.length < AGREEMENT_MIN_CHARS) return;
    if (summaryDefect(raw, shown) !== null) return;
    // A malformed seed is not held back by the gain, so its own words under
    // another outlet's name must be kept out here, and so must a text that is
    // malformed in the same way.
    if (malformed && (raw === seedRaw || shown === seedShown || unbalancedQuotes(shown))) return;
    // Behind a stale seed the stems cannot tell a text at the seed's stage from one
    // that moved on, so the candidate must say the outcome (`carriesOutcome`). A text
    // that states every outcome the title reports is never a stage behind it
    // (`!stageBehindTitle`), so that second test of the rule needs no call of its own.
    if (stale && !statesAll(families, shown)) return;
    const score = coverage(stems, shown);
    if (!agreementSwitches(seedScore, score, malformed)) return;
    if (isAgencyCopy(shown)) return;

    const t = Date.parse(m.article.published_at);
    const entry: Scored = {
      member: m,
      text: shown,
      score,
      recency: Number.isFinite(t) ? t : -Infinity,
      seniority: Number.isFinite(t) ? t : Infinity,
    };
    const held = byText.get(raw);
    if (
      held === undefined ||
      entry.seniority < held.seniority ||
      (entry.seniority === held.seniority &&
        entry.member.source.name.localeCompare(held.member.source.name, "tr") < 0)
    ) {
      byText.set(raw, entry);
    }
  });

  let best: Scored | null = null;
  for (const entry of byText.values()) {
    if (best === null || byNewest(entry, best) < 0) best = entry;
  }
  return best === null ? null : { member: best.member, text: best.text };
}
