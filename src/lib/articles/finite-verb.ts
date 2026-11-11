// A lexical test for "this text has a Turkish finite verb" (h95-summaries-1), moved here
// from clusters/summary-agreement.ts by h112-ozetregress-1. summary-tidy.ts needs it (the
// trailing come-on cut keeps a declarative sentence) and summary-agreement.ts already
// imports summary-tidy.ts, so a direct import would be a cycle. This module imports from
// neither of them: summary-agreement.ts re-exports {@link hasFiniteVerb} and its existing
// imports and tests are unchanged. Pure; no I/O, no clock.

/**
 * Turkish lower case, diacritics stripped, dotless "ı" as "i": "İSTANBUL", "ISTANBUL" and
 * "İstanbul" agree. The same fold as `fold` in clusters/summary-agreement.ts (which keeps
 * its own copy for the word and stem checks; the two are not allowed to import each other).
 */
function fold(s: string): string {
  return s
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ı/g, "i");
}

// An apostrophe glued to a word starts a Turkish suffix ("Senato'ya", "ABD’nin",
// "14'er"): the suffix goes. A quote mark next to a space is only punctuation. The same
// pattern as in clusters/summary-agreement.ts.
const APOSTROPHE_SUFFIX = /(?<=[\p{L}\p{N}])['’‘ʼ`´]\p{L}*/gu;

// Finite verb forms, in the folded spelling of {@link fold} (no diacritics, "ı" as
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

// The words of a text with the marks that open a sentence or a clause (h95-summaries-1).
const WORD_OR_OPENING_MARK = /[\p{L}\p{N}\p{M}]+|[.!?…:"“«‘„]/gu;
const STARTS_WITH_WORD = /^[\p{L}\p{N}\p{M}]/u;
const STARTS_UPPER = /^\p{Lu}/u;
const HAS_LOWER = /\p{Ll}/u;

/**
 * True when some word of `text` ends in a Turkish finite verb form (past,
 * reported past, progressive, future, necessity, possibility, copula, "var/yok").
 * Lexical and one pass: see {@link FINITE_ENDINGS} for what it takes and leaves.
 * Never throws; false for a non-string.
 *
 * h95-summaries-1: a CAPITALISED word that does not open a sentence is a name, never
 * a verb: dd5535a7's cut sentence "..., TBMM Numan Kurtulmuş, Cumhurbaşkanı Yardımcısı
 * Cevdet Yılmaz, Yeni Parti Genel Başkanı..." held "Kurtulmuş" ("kurtul-muş", a
 * reported past) and passed for a complete sentence. A word opens a sentence at the
 * start of the text and after ". ! ? …", and opens a clause after ":" or an opening
 * quotation mark, so "Bakan Yılmaz: Kazandık" still has its verb. A word counts as
 * capitalised when it starts with a capital and has a lower-case letter in it: an
 * ALL-CAPS headline ("ERDOĞAN GÜNEY KORE'DEN AYRILDI") has no names to tell apart and
 * keeps being read whole.
 */
export function hasFiniteVerb(text: string): boolean {
  if (typeof text !== "string") return false;
  let opens = true;
  for (const m of text.replace(APOSTROPHE_SUFFIX, " ").matchAll(WORD_OR_OPENING_MARK)) {
    const token = m[0];
    if (!STARTS_WITH_WORD.test(token)) {
      opens = true;
      continue;
    }
    const name = !opens && STARTS_UPPER.test(token) && HAS_LOWER.test(token);
    opens = false;
    if (name) continue;
    if (isFiniteVerbForm(fold(token))) return true;
  }
  return false;
}

/**
 * True when the LAST word of `text` is a Turkish finite verb form, read with the rules of
 * {@link hasFiniteVerb} (the apostrophe suffix goes, and a capitalised word that does not
 * open a sentence is a name, never a verb). Turkish puts the predicate at the end of the
 * sentence (h113 correctness-2), so a participle in front of a noun ("İşte uygulanacak yeni
 * kurallar", "yapılacak zam oranı") or a word that merely ends like a past tense ("kendi",
 * "yedi") is not a predicate: {@link hasFiniteVerb} reads those as verbs, this does not.
 * Marks behind the last word (".", "?", closing quotes and brackets) are not words and do
 * not count. One pass over the tokens; the verb test runs once, on the last word.
 * Never throws; false for a non-string and for a text with no word.
 *
 * Accepted miss: a statement whose verb is followed by an adverb or a noun ("Bakan açıklama
 * yaptı bugün.") is not read as ending in a verb. summary-tidy.ts then reads it as come-on
 * shaped, which matters only when every sentence behind a Peki / İşte start is shaped too;
 * a Turkish sentence ends in its verb far more often than not.
 */
export function endsWithFiniteVerb(text: string): boolean {
  if (typeof text !== "string") return false;
  let opens = true;
  let last: string | null = null;
  for (const m of text.replace(APOSTROPHE_SUFFIX, " ").matchAll(WORD_OR_OPENING_MARK)) {
    const token = m[0];
    if (!STARTS_WITH_WORD.test(token)) {
      opens = true;
      continue;
    }
    const name = !opens && STARTS_UPPER.test(token) && HAS_LOWER.test(token);
    opens = false;
    last = name ? null : token;
  }
  return last !== null && isFiniteVerbForm(fold(last));
}
