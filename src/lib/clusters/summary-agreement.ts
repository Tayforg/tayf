import { repairEntityResidue } from "../../../supabase/functions/_shared/rss/entities";
import { isOpinionUrl } from "@/lib/articles/opinion-url";
import { isHeadlineEcho } from "@/lib/articles/description-boilerplate";
import { hasFiniteVerb } from "@/lib/articles/finite-verb";
import { clampCutIntroducedQuote, isCtaFeedCut, isUnmarkedClamp, tidySummaryText } from "@/lib/articles/summary-tidy";
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
//
// h54-editorial-3: an opinion column is not the story's summary. 539e6666's seed was
// a Hürriyet /yazarlar/ column's lead ("TÜRK siyasi tarihinde utanmazlıkta yarışacak
// iki örnek vardır; ..."), a thesis stated as fact under "Özet — Hürriyet". Two rules,
// both read from the member's article URL (`isOpinionUrl`; a member without a `url`
// is not known to be a column):
//   - an OPINION SEED counts as malformed, like a stub or a stale seed: it counts as
//     disagreeing, the gain over it is waived and its own text is kept out of the
//     candidates. It is replaced only by a member that clears every other gate;
//     with none it stays (never blank), and the page labels it "köşe yazısı";
//   - an OPINION MEMBER is never a replacement, for any seed: a Sabah or A Haber
//     mirror of the same column covers the headline as well as the original does.
// Lexical and linear like the rest: the URL path is the outlet's own word for it.
//
// h95-summaries-1: the seed's FORM, second pass. Five more shapes were kept because
// they were never looked at, and a sixth because the bar for the replacement was set
// for a seed that is fine:
//   - a LIVE-BLOG LINE ("Cumhurbaşkanı Erdoğan, TRT World Forum 2026 Resmi Açılış
//     Töreni'nde açıklamalarda bulunuyor.": 11 of 985 clusters of a week, 29 sources
//     under the biggest): one sentence that says someone is speaking and nothing of
//     what they said (`isLiveLine`). A seed that is one is 'live'; a member that is one
//     never stands in for the seed ('live' in `summaryDefect`: 459a7b61 had swapped to
//     Haber7's line);
//   - a TEASER seed: the text opens with "Peki" / "İşte" and the tidy step has nothing
//     in front of it to end the text on ('teaser');
//   - an ECHO: the description is the member's own headline (Korkusuz ships the title as
//     its description) or the cluster's title again ('echo'). A candidate that is one is
//     never picked, for any seed;
//   - a SURNAME that hid a stub: `hasFiniteVerb` read "Kurtulmuş" as a reported past
//     ("kurtul-muş") and called dd5535a7's cut sentence complete, so a capitalised word
//     that does not open a sentence is no longer a verb;
//   - a CUT WITH NO ELLIPSIS (a text of exactly 400 or 500 characters that ends in a
//     letter or a comma, ABC Haber: "... yeni kanun hazırlığı h"): the tidy step backs
//     it off to a sentence end like the marked clamp, and when no sentence end exists it
//     is cut at a word with "…" and is a stub (`isUnmarkedClamp`);
//   - THE FLOOR. Every clean replacement had to score AGREEMENT_HIGH (0.75), also when
//     the seed was thrown out for its form. On a live line the other members' texts are
//     as short as the seed's and score alike (b04edded: seed 0.33, Aydınlık 0.67; dd5535a7:
//     0.0 against 0.67; f1837ee1: 0.6 against 0.7), so none could pass. For a seed that is
//     a form defect (stub, quotes, live, teaser, echo) a replacement needs
//     AGREEMENT_FORM_DEFECT_MIN (0.6) instead; an opinion or a stale seed keeps 0.75, as
//     the gate for those two is about what they say, not how they look. 85ef184c (29
//     sources, every candidate 0.4) stays as it is: the documented residual. With no
//     qualifying member the seed stays, never blank.
// A clean seed that scores 0.5 or more is still never replaced.
//
// h122-ozet-1: a CMS FIELD DUMP is a form defect too ('cms'). Independent Türkçe's RSS
// description is its raw Drupal fields ("<caption><lead>Pazartesi, Kasım 9, 2026 -
// 18:30Main image: Type: newsSEO Title: <the headline>copyright Independentturkish:"); the
// tidy step now cuts it (stripIndyturkCmsDump), but its "SEO Title:" repeats the headline
// word for word, so the text scored 1.00 and won the Özet of 710ef4bb, and the recency
// tie-break gave it b8e7cc75 over Yeniçağ's clean 0.83. The markers are read on the RAW text
// ({@link CMS_RESIDUE}: the tidied text no longer holds them): a member that has them is never
// a replacement ('cms' in `summaryDefect`), and a seed that has them is replaced from
// AGREEMENT_FORM_DEFECT_MIN up ('cms' in `seedDisqualified`, checked first).
//
// h122-ozet-2: two more seeds that never state the news, both kept because they cover
// enough of the headline's words:
//   - a QUOTE-ONLY seed. Haberler.com copies Anadolu Ajansı's quote bullets as its
//     description ('- "Genel Sekreterlik görevine talibim ..." "40 yıllık ..."'), and the
//     Özet of 72abfb9f (7 sources), c859c91b and 4e0c0003 was one or two bare quotations
//     with no speaker (the seed scored 0.50, 0.36 and 0.00, and every replacement was under
//     0.75). `isQuoteOnly` is a form defect ('quote-only', checked after 'quotes' so an
//     unbalanced text keeps 'quotes'; floor AGREEMENT_FORM_DEFECT_MIN), and a member that is
//     one never stands in ('quote-only' in `summaryDefect`);
//   - an EXPLAINER seed. 777ea7c5 (14 sources, "... Yonca Şık gözaltına alındı") showed Elips
//     Haber's "Yonca Verdioğlu Şık kimdir?" biography ("... Ahmet Şık'ın eşidir. ...
//     Gazetecilik Bölümü mezunudur."), which names the people (0.63) and never says what
//     happened. The seed's own ARTICLE title is read (`isExplainerTitle`: "kimdir", "kaç
//     yaşında", "nereli", "biyografisi"): when it is an explainer and the cluster's headline
//     is not, the seed is malformed like an opinion seed: the gain is waived and its own text
//     is kept out. The floor stays AGREEMENT_HIGH and it is NOT a `SeedDefect`: the gate is
//     about what the text says, not how it looks. Candidates are not filtered by their titles
//     (Cumhuriyet's "Ahmet Şık kimdir?" article carries the detention in its description).
//
// h122-ozet-3: two cuts that hide the statement were not stubs. (a) Turkuvaz's "<cut>...Devamı
// için tıklayınız" (A Haber, Sabah, Yeni Asır: 107 cluster seeds in 7 days) is cut at about 200
// characters, mid-word, but the body is 203 to 210 characters, so the feed-cap lengths never
// matched and "…terörsüz Türkiye sürecine, fon..." (dfaaceac, 0.43) passed because its last
// sentence holds a finite verb. The tidy step now repairs such a text like a clamp
// (`isCtaFeedCut`), and when what is shown still ends in "…" the seed is a stub whatever its
// verbs say. (b) A clamp cut inside a quotation that a ":" introduces ("... belirten Duran,
// şunları kaydetti: \"Cumhurbaşkanımız ...", 837fa770) is shown up to a sentence end in front of
// the introducer, with none of what was said: `clampCutIntroducedQuote` makes the seed a stub even
// though the shown text ends on a full stop. With no qualifying member the seed stays (98266829:
// Posta holds the same text), never blank.
//
// h132-ozetpost-1: two gaps in the seed rules above, both seen on indexable multi-source pages
// on 2026-11-11 (in the 517 non-archived clusters with 2 members or more first published in the
// last 48 hours, 32 shown Özets were a form defect by the code's own `seedDisqualified`, 20 of
// them stubs; this change moves 4 of the 517 and leaves 29, 17 of them stubs):
//   - a NAME THAT CARRIES A DIGIT defeated `isLiveLine`. Star's "COP31 Başkanı ve ... Murat
//     Kurum, Antalya'da \"COP31 Liderler Zirvesi\"nde konuşuyor" (ece7ef31, 6 sources) is a live
//     line, but the digit test saw the 31 of "COP31" (a year, an ordinal and a quoted event name
//     were taken out first, a name was not), so it stayed the Özet and the meta description. A
//     name token (a capital letter, at most 10 more letters, an optional hyphen, 1 to 4 digits,
//     not glued to a letter or digit in front and not followed by a digit: COP31, G20, F-16,
//     Covid-19) is now blanked out with the year and the ordinal. A figure is not a name and
//     still fails the line ("yüzde 30", "58 bin", "17 işçinin");
//   - a STUB THAT COVERS ALMOST NONE OF THE HEADLINE kept the 0.6 floor of the form defects, and
//     the member that says what happened scored just under it (78d3a0ee, 7 sources: Sözcü's
//     "... toplantısı öncesinde Aile ..." scored 0.0, Mynet's clean sentence 0.56). Behind a stub
//     whose own score is below AGREEMENT_STUB_LOW_SEED (0.3, exclusive) the floor is
//     AGREEMENT_LOW (0.5), the line below which a seed itself is held to disagree: a member that
//     covers half of the headline is a better Özet than a cut that covers a third of it at
//     most. A stub that covers 0.3 or more (2f5d7d53 0.44, 56eaa832 0.5), and every other form
//     defect (quotes, live, teaser, echo, CMS dump, quote-only), keeps AGREEMENT_FORM_DEFECT_MIN;
//     an opinion, an explainer or a stale seed keeps AGREEMENT_HIGH. Every other gate of a
//     candidate (defect, agency copy, language, rights, echo, length) is unchanged, and with no
//     qualifying member the seed stays, never blank (9dd62dcd: the live line is kept, no member
//     is clean and covers enough). A past tense ("açıklama yaptı") stays a report, not a live line.

/** A seed scoring below this disagrees with the title (exclusive: 0.5 is kept). */
export const AGREEMENT_LOW = 0.5;
/** A replacement must score at least this (inclusive). */
export const AGREEMENT_HIGH = 0.75;
/** A replacement must beat the seed by at least this much (inclusive). */
export const AGREEMENT_MIN_GAIN = 0.3;
/**
 * A replacement must score at least this (inclusive) when the seed is a form defect
 * ({@link SeedDefect}: a CMS field dump, a stub, unbalanced quotes, only quotations, a live line, a
 * teaser or an echo)
 * instead of {@link AGREEMENT_HIGH}; behind a stub that scores under {@link AGREEMENT_STUB_LOW_SEED}
 * it is {@link AGREEMENT_LOW} (h132-ozetpost-1). In the replay of the 1,600 newest clusters of 3
 * members or more, the clean replacements behind a live line scored 0.6 to 0.7 against
 * the headline (the live lines of the other outlets carry the same words and are not
 * candidates), and none reached 0.75. 0.6 is three of five title stems, the smallest
 * share that is more than half; a judgement, not a measured boundary.
 */
export const AGREEMENT_FORM_DEFECT_MIN = 0.6;
/**
 * A stub seed that scores below this (exclusive) against the title covers almost none of it, and
 * a replacement needs only {@link AGREEMENT_LOW} instead of {@link AGREEMENT_FORM_DEFECT_MIN}
 * (h132-ozetpost-1). In the 517 clusters of 48 hours the stubs below it scored 0 to 0.22 and the
 * clean members behind them 0.50 to 0.56; the stubs at 0.44 and 0.5 are not changed. A judgement,
 * not a measured boundary: 0.3 is about one stem in three.
 */
export const AGREEMENT_STUB_LOW_SEED = 0.3;
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
 * candidate's `floor` is left. The seed is replaced for its form, so its ceiling and
 * the gain over it no longer apply. Default false.
 *
 * `floor` (h95-summaries-1) is the least the candidate may score, inclusive; the
 * default is {@link AGREEMENT_HIGH}. The caller passes
 * {@link AGREEMENT_FORM_DEFECT_MIN} for a seed that is a form defect, and {@link AGREEMENT_LOW}
 * for a stub that covers almost none of the title (h132-ozetpost-1). A floor applies
 * to a well-formed seed too (the ceiling and the gain still do), but the caller never
 * lowers it for one.
 */
export function agreementSwitches(
  seedScore: number | null,
  candidateScore: number | null,
  seedMalformed = false,
  floor = AGREEMENT_HIGH,
): boolean {
  if (seedScore === null || candidateScore === null) return false;
  if (candidateScore < floor - EPSILON) return false;
  if (seedMalformed) return true;
  return disagrees(seedScore) && candidateScore - seedScore >= AGREEMENT_MIN_GAIN - EPSILON;
}

export type SummaryDefect = "cms" | "stub" | "teaser" | "dateline" | "run-on" | "live" | "quote-only";

/**
 * The fields of Independent Türkçe's raw Drupal dump (h122-ozet-1), tested on the RAW
 * description: "SEO Title:", "Main image:" and "copyright Independentturkish". Bounded gap,
 * so a long run of blanks after "copyright" costs one pass.
 */
const CMS_RESIDUE = /SEO Title:|Main image:|copyright\s{0,8}Independentturkish/i;

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
//
// h81-textclean-2: these two patterns are the DETECTOR (a member that carries a
// lead never stands in for the seed) and they stay as loose as they were.
// `stripDatelineLead` in summary-tidy.ts is the STRIPPER, deliberately stricter
// (a known agency or an all-caps lead, at least 20 characters left, ...), and it
// removes the lead from the tidied text. Because of that the detector reads the
// RAW text as well as the shown one in {@link summaryDefect}: `shown` no longer
// carries the lead.
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

// A live-blog line (h95-summaries-1): "Cumhurbaşkanı Erdoğan, TRT World Forum 2026
// Resmi Açılış Töreni'nde açıklamalarda bulunuyor." Folded spelling (no diacritics,
// "ı" as "i"). The predicate is the END of the line: "açıklamalarda bulunuyor" /
// "açıklama yapıyor" (either optionally "önemli"), "konuşuyor", "konuşma yapıyor",
// "yanıtlıyor" / "cevaplıyor" (optionally "soruları"). A past tense ("konuştu") is a
// report, not a live line.
const LIVE_PREDICATE =
  /(?:^|\s)(?:(?:onemli\s+)?(?:aciklamalarda\s+bulunuyor|aciklama\s+yapiyor)|konusuyor|konusma\s+yapiyor|(?:sorulari\s+)?(?:yanitliyor|cevapliyor))$/u;
/** A live line is one short sentence: at most this many characters (inclusive). */
const LIVE_MAX_CHARS = 160;
const TRAILING_LIVE_MARKS = /[\s.!…]+$/u;
// An event's name is not what is said at it: a quoted name whose closing mark is
// glued to a case suffix ('"12. Türk Tıp Dünyası Kurultayı ... Töreni"nde', "'...
// Töreni'nde", “...”nde), a year ("TRT World Forum 2026") and an ordinal ("12. Türk").
// The opener must not follow a letter or a digit (an apostrophe in a word is no quote).
// A quotation that is followed by a blank, a comma or "diyerek" is a speaker's words
// and stays, so the check for a quote mark below still fails it.
const QUOTED_EVENT_NAME = /(?<![\p{L}\p{N}])["“«„'‘][^"“”«»„‘’]{1,120}?["”»’'](?=\p{L})/gu;
const YEAR = /(?<![\p{N}])(?:19|20)\d{2}(?![\p{N}])/gu;
const ORDINAL = /(?<![\p{N}.,])\d{1,3}\.(?=\s+\p{Lu})/gu;
// A name that carries digits is not a figure (h132-ozetpost-1): "COP31", "G20", "F-16", "Covid-19".
// A capital letter, at most 10 more letters, an optional hyphen, one to four digits; not glued to a
// letter or a digit in front, not followed by a digit (a run of five digits is a number). Every
// repeat is bounded and the letters, the hyphen and the digits cannot stand for one another, so
// the pattern backtracks by a constant at most, whatever the text.
const DIGIT_NAME = /(?<![\p{L}\p{N}])\p{Lu}\p{L}{0,10}-?\p{N}{1,4}(?!\p{N})/gu;
const QUOTE_MARKS = /["“”«»„‘]/u;
const ANY_DIGIT = /\p{N}/u;
/** Clause separators that open a second statement. */
const SECOND_CLAUSE_MARKS = /[;:]/u;

/** True when `text` holds a sentence end (". ! ? …" and closing marks, then a blank) that is not an abbreviation's, an initial's or an ordinal's dot. */
function hasSentenceEnd(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (!SENTENCE_END_MARKS.has(text.charAt(i))) continue;
    let end = i + 1;
    while (end < text.length && CLOSERS.has(text.charAt(end))) end++;
    if (end >= text.length || text.charAt(end).trim() !== "") continue;
    if (text.charAt(i) === "." && isNonSentenceDot(text, i)) continue;
    return true;
  }
  return false;
}

/**
 * True for a live-blog line (h95-summaries-1): ONE sentence of at most 160 characters
 * whose final predicate says someone is speaking and nothing of what is said:
 * "açıklamalarda bulunuyor", "açıklama yapıyor" (both optionally "önemli"),
 * "konuşuyor", "konuşma yapıyor", "(soruları) yanıtlıyor" or "cevaplıyor", with a
 * trailing "." / "..." / "…" or none. Not a live line: a past tense, a second sentence
 * or clause (a ";" or ":", or a finite verb in front of the predicate: "toplantıyı açtı
 * ve konuşuyor"), a question, a figure, a quotation that is not an event's name, a cut
 * inside the predicate. `shown` is the tidied text.
 *
 * The four things that read as a figure or a quotation and are not: a year ("TRT World
 * Forum 2026"), an ordinal ("12. Türk Tıp Dünyası Kurultayı"), a quoted event name
 * whose closing mark is glued to its suffix ("... Töreni"nde konuşuyor") and a name that
 * carries digits ("COP31", "G20", "F-16", "Covid-19": a capital, at most 10 letters, an
 * optional hyphen, 1 to 4 digits; h132-ozetpost-1), are taken out before the digit and
 * quote-mark test, so the lines of 85ef184c, b04edded and ece7ef31 are live lines;
 * "yüzde 30", "58 bin", "17 işçinin" and `"enflasyon düşecek" diyerek` are not. Lexical, one
 * pass plus one regular expression per step, no nested quantifier. Never throws.
 */
export function isLiveLine(shown: string): boolean {
  if (typeof shown !== "string") return false;
  const text = shown.trim();
  if (text === "" || text.length > LIVE_MAX_CHARS) return false;
  const core = text.replace(TRAILING_LIVE_MARKS, "");
  const named = core.replace(QUOTED_EVENT_NAME, " ").replace(YEAR, " ").replace(ORDINAL, " ").replace(DIGIT_NAME, " ");
  if (ANY_DIGIT.test(named) || QUOTE_MARKS.test(named) || SECOND_CLAUSE_MARKS.test(named)) return false;
  const folded = fold(named);
  // The index of the predicate in `named` is the index in `folded` only when the fold kept the length.
  if (folded.length !== named.length) return false;
  const predicate = LIVE_PREDICATE.exec(folded);
  if (predicate === null) return false;
  if (hasSentenceEnd(named)) return false;
  return !hasFiniteVerb(named.slice(0, predicate.index));
}

/** A list marker that may stand in front of the first quotation ("- ", "• "); the tidy step drops it. */
const QUOTE_ONLY_MARKERS: readonly string[] = ["- ", "• "];

/**
 * True when `shown` is nothing but quotations (h122-ozet-2): after trimming and dropping one
 * leading list marker ("- ", "• "), one or more COMPLETE double-quoted segments ("…" up to the next
 * straight quote, or “…” with nested pairs balanced), separated only by blanks (none is fine) and
 * optionally followed by one ".", with no letter, digit or other mark outside the quotes. A
 * segment holds something besides blanks. Single quotes and apostrophes are ignored (they are
 * not segments). False for a speaker ("Sinirlioğlu, \"...\" dedi."), a quoted word in a sentence
 * ("\"Ekonomi\" başlıklı rapor yayımlandı."), an unbalanced quote, '' and a non-string. One pass over
 * the text: every segment is found with `indexOf` or a depth count, and nothing is looked at twice.
 */
export function isQuoteOnly(shown: string): boolean {
  if (typeof shown !== "string") return false;
  let s = shown.trim();
  for (const marker of QUOTE_ONLY_MARKERS) {
    if (s.startsWith(marker)) {
      s = s.slice(marker.length);
      break;
    }
  }
  const n = s.length;
  let segments = 0;
  let i = 0;
  while (i < n) {
    const c = s.charAt(i);
    if (c.trim() === "") {
      i++;
    } else if (c === '"') {
      const close = s.indexOf('"', i + 1);
      if (close === -1 || s.slice(i + 1, close).trim() === "") return false;
      segments++;
      i = close + 1;
    } else if (c === "\u201c") {
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        const d = s.charAt(j);
        if (d === "\u201c") depth++;
        else if (d === "\u201d") depth--;
        j++;
      }
      if (depth !== 0 || s.slice(i + 1, j - 1).trim() === "") return false;
      segments++;
      i = j;
    } else {
      // The only thing allowed outside a quotation: one full stop, the last character.
      return c === "." && segments > 0 && s.slice(i + 1).trim() === "";
    }
  }
  return segments > 0;
}

/**
 * Why a description is not fit to stand in for the seed, or null. `raw` is the
 * member's repaired, trimmed description and `shown` its tidied form
 * (`tidySummaryText`). Checked in this order, the first that applies is returned:
 *   - "cms": the RAW text holds a field of Independent Türkçe's CMS dump ("SEO Title:",
 *     "Main image:", "copyright Independentturkish"; h122-ozet-1): the tidy step cuts the
 *     dump, and what is left is a guess at the lead, so it never stands in;
 *   - "stub": a feed cut it ("..." or "…" at the end, raw or tidied);
 *   - "teaser": a question mark anywhere, or a sentence that opens with Peki/İşte;
 *   - "dateline": an agency or all-caps place lead ("İSTANBUL (Medyascope) –") in
 *     the shown text or in the raw one (the tidy step strips most leads from
 *     `shown`, h81-textclean-2, so the raw text is what still carries it);
 *   - "run-on": its first five words come again later (a title glued to the body);
 *   - "live": a live-blog line ({@link isLiveLine}, h95-summaries-1): it says that
 *     someone is speaking and nothing of what is said;
 *   - "quote-only": the text is nothing but quotations ({@link isQuoteOnly}, h122-ozet-2):
 *     Haberler.com's copy of a wire's quote bullets, with no speaker.
 * An echo of a headline needs the headlines and is checked by the caller
 * ({@link findAgreeingMember}). Never throws.
 */
export function summaryDefect(raw: string, shown: string): SummaryDefect | null {
  if (typeof raw !== "string" || typeof shown !== "string") return null;
  if (CMS_RESIDUE.test(raw)) return "cms";
  if (endsCut(raw) || endsCut(shown)) return "stub";
  if (isTeaser(shown)) return "teaser";
  if (hasDatelineLead(shown) || hasDatelineLead(raw.trim())) return "dateline";
  if (isRunOn(shown)) return "run-on";
  if (isLiveLine(shown)) return "live";
  if (isQuoteOnly(shown)) return "quote-only";
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

// hasFiniteVerb lives in articles/finite-verb.ts since h112-ozetregress-1 (summary-tidy.ts
// needs it and this file imports summary-tidy.ts); it is re-exported so every existing
// import and test keeps working.
export { hasFiniteVerb };

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
 *
 * h95-summaries-1: a 400 or 500 character raw text with no ellipsis that ends in a
 * letter or a comma ({@link isUnmarkedClamp}) was cut by its outlet. The tidy step
 * backs it off to a sentence end when there is one (no cut is left to see); when none
 * exists it ends in "…" after a word cut, and that text is a stub whatever its last
 * sentence holds: the verb in it belongs to a sentence the cut took the end of.
 *
 * h122-ozet-3: the same for a Turkuvaz CTA feed cut ({@link isCtaFeedCut}, "<cut>...Devamı için
 * tıklayınız", whatever the length of the body): the tidy step repairs it, and when that leaves a
 * "…" the last sentence's verb belongs to a sentence the cut took the end of.
 */
function isCutStub(raw: string, shown: string): boolean {
  if (!endsCut(shown)) return false;
  return isFeedCapCut(raw) || isUnmarkedClamp(raw) || isCtaFeedCut(raw) || !hasFiniteVerb(lastSentence(shown));
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

export type SeedDefect = "cms" | "stub" | "quotes" | "quote-only" | "live" | "teaser" | "echo";

/** A text that opens with "Peki" or "İşte" as a whole word (the folded COME_ON rule, anchored at the start). */
const OPENS_WITH_COME_ON = /^(?:peki|iste)(?![\p{L}\p{N}])/u;

/** The headlines a seed's shown text may only be repeating: its own article's, and the cluster's (h95-summaries-1). */
export interface SeedTitles {
  memberTitle?: string | null;
  clusterTitle?: string | null;
}

/**
 * Why a seed is not fit to stay on the page whatever it covers of the headline, or
 * null (h34-reader-4, h95-summaries-1). `raw` is the seed's repaired, trimmed
 * description and `shown` its tidied form (`tidySummaryText`), which is what the page
 * would show. Checked in this order, the first that applies is returned:
 *   - "cms": the RAW text holds a field of Independent Türkçe's CMS dump ("SEO Title:",
 *     "Main image:", "copyright Independentturkish"; {@link CMS_RESIDUE}, h122-ozet-1). The
 *     tidied text has the dump cut away, so only the raw text can tell;
 *   - "stub": a feed cut it (see {@link isCutStub}): the shown text ends in "..."
 *     or "…" and the raw text is a known feed-cap cut, an unmarked 400 / 500
 *     character cut, a Turkuvaz CTA feed cut ({@link isCtaFeedCut}, h122-ozet-3) or the last
 *     sentence has no finite verb ({@link hasFiniteVerb}); or the raw text is a clamp that
 *     ended inside a quotation introduced by a ":" ({@link clampCutIntroducedQuote},
 *     h122-ozet-3): what is shown ends before the introducer's sentence and has none of what
 *     was said, whatever it ends on;
 *   - "quotes": the shown text has an odd number of straight " or unequal “ and ”;
 *   - "quote-only": the shown text is nothing but quotations ({@link isQuoteOnly},
 *     h122-ozet-2): no speaker, no sentence of the outlet's own. Checked after "quotes", so an
 *     unbalanced text keeps "quotes";
 *   - "live": a live-blog line ({@link isLiveLine});
 *   - "teaser": the shown text OPENS with Peki / İşte (the tidy step cuts a come-on
 *     that has a complete sentence in front of it, so what is left is one with nothing
 *     to cut);
 *   - "echo": the shown text only repeats a headline: the seed article's own
 *     (`titles.memberTitle`) or the cluster's (`titles.clusterTitle`), compared with
 *     `isHeadlineEcho` (case, blanks, trailing marks and a cut-off "…" do not matter).
 *     Without `titles` there is nothing to echo.
 * Every one of them is a form defect: the replacement needs
 * {@link AGREEMENT_FORM_DEFECT_MIN}, not {@link AGREEMENT_HIGH}; behind a "stub" that scores under
 * {@link AGREEMENT_STUB_LOW_SEED} against the title, {@link AGREEMENT_LOW} (h132-ozetpost-1,
 * decided in {@link findAgreeingMember}, which knows the title). Never throws.
 */
export function seedDisqualified(raw: string, shown: string, titles: SeedTitles = {}): SeedDefect | null {
  if (typeof raw !== "string" || typeof shown !== "string") return null;
  if (CMS_RESIDUE.test(raw)) return "cms";
  if (isCutStub(raw, shown)) return "stub";
  if (clampCutIntroducedQuote(raw)) return "stub";
  if (unbalancedQuotes(shown)) return "quotes";
  if (isQuoteOnly(shown)) return "quote-only";
  if (isLiveLine(shown)) return "live";
  if (OPENS_WITH_COME_ON.test(fold(shown.trimStart()))) return "teaser";
  if (isHeadlineEcho(titles.memberTitle, shown) || isHeadlineEcho(titles.clusterTitle, shown)) return "echo";
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

/**
 * "kimdir", "kaç yaşında", "nereli" and "biyografisi" as whole words, in the folded spelling of
 * this module (so "KİMDİR", "kaç  yaşında" with a no-break space and "Nereli?" match). The gap
 * in "kaç yaşında" is 1 to 4 blanks: no unbounded quantifier.
 */
const EXPLAINER_TITLE = /\bkimdir\b|\bkac\s{1,4}yasinda\b|\bnereli\b|\bbiyografisi\b/;

/**
 * True when a headline is an explainer, not a report (h122-ozet-2): "Yonca Verdioğlu Şık kimdir?",
 * "... kaç yaşında, nereli?", "... biyografisi". Whole words, on the module's fold (case and
 * diacritics do not matter). `findAgreeingMember` reads the SEED article's title with it: a seed
 * that is an explainer under a headline that is not one is a biography of the people the
 * headline names, whatever words it shares with it. False for null, undefined and a non-string.
 */
export function isExplainerTitle(title: string | null | undefined): boolean {
  return typeof title === "string" && EXPLAINER_TITLE.test(fold(title));
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
 * ({@link seedDisqualified}: a CMS dump, a feed-cut stub, a clamp that hid its quotation,
 * unbalanced quotes, quotations only; h34-reader-4, h122), be
 * a stage behind the title ({@link stageBehindTitle}: "tutuklandı" over
 * "tutuklama talebiyle"; h54-editorial-1) or be an opinion column (its article
 * `url` is an opinion path, {@link isOpinionUrl}; h54-editorial-3) or be an explainer
 * (its article title is "X kimdir?", "kaç yaşında", "nereli" or "biyografisi" and the
 * cluster's title is not one, {@link isExplainerTitle}; h122-ozet-2); a title without
 * enough content tokens, or a clean seed that agrees and is not behind, returns
 * null before any other member is looked at. For a malformed, opinion, explainer or stale seed
 * the gain over the seed is waived, and two more conditions hold: the member's text is not the seed's own
 * (raw or tidied, under another outlet's name) and has no unbalanced quotes. For a
 * stale seed a third holds: the member's text states the outcome the title
 * reports and is not itself a stage behind it ({@link carriesOutcome}). A member
 * qualifies when ALL of these hold:
 *   - its source allows excerpts (`excerpt_allowed !== false`) and is not a wire
 *     or aggregator (`normalizeSourceKind`; a missing kind is an outlet);
 *   - it is not an opinion column (its article `url` is not an opinion path,
 *     h54-editorial-3), whatever the seed is;
 *   - it is written in the seed's language (`sourceLang`);
 *   - its content hash is not one of `wireMajorityHashes` (the dispatch a wire
 *     redistribution copied: the seed's own check, applied to the candidate);
 *   - its description, repaired and trimmed, is not empty, is not the text of a
 *     rights-blocked member and is not the text of a wire or aggregator member (a
 *     copy of an agency's words is the agency's), and its tidied text is not a
 *     near copy of one either ({@link AGENCY_COPY_OVERLAP}: a phrase dropped, a
 *     word changed, a CTA tail added still leave the agency's words);
 *   - its tidied text is at least {@link AGREEMENT_MIN_CHARS} long and has no
 *     {@link summaryDefect} (a live-blog line included, h95-summaries-1);
 *   - its tidied text is not an echo of a headline: its own article's title
 *     (`member.article.title`, absent on a lighter projection) or the cluster title
 *     (`isHeadlineEcho`, h95-summaries-1);
 *   - its score passes {@link agreementSwitches}, with the floor of the seed's defect:
 *     {@link AGREEMENT_FORM_DEFECT_MIN} behind a CMS dump, a stub, quotes, quotations only, a
 *     live line, a teaser or an echo ({@link seedDisqualified}), {@link AGREEMENT_LOW} behind a
 *     stub that scores under {@link AGREEMENT_STUB_LOW_SEED} (h132-ozetpost-1), {@link AGREEMENT_HIGH}
 *     otherwise (an opinion, a stale or an explainer seed keep it: what they say is the
 *     problem, not how they look). A candidate is never filtered by its OWN title. Behind a clean
 *     seed a copy of the seed's text scores what the seed scores, so it can never pass.
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
  // An opinion column is the story's summary only when nothing else can be
  // (h54-editorial-3): it is replaced for what it is, whatever it covers.
  const opinionSeed = isOpinionUrl(seed.article.url);
  // A biography is not the story's summary either (h122-ozet-2): the seed's article is "X
  // kimdir?" and the headline is not an explainer. Replaced for what it is, at AGREEMENT_HIGH.
  const explainerSeed = isExplainerTitle(seed.article.title) && !isExplainerTitle(title);
  // A malformed, an opinion, an explainer or a stale seed is replaced for what it is, not for
  // what it covers: its score and the gain over it no longer apply. A form defect (stub,
  // quotes, quote-only, live, teaser, echo, and h122-ozet-1's CMS dump) also lowers the bar
  // for the replacement (h95-summaries-1); an opinion, an explainer or a stale seed keeps
  // AGREEMENT_HIGH. A stub that covers almost none of the title (under AGREEMENT_STUB_LOW_SEED,
  // h132-ozetpost-1) lowers it once more, to AGREEMENT_LOW: a member that covers half of the
  // headline is a better Özet than a cut that covers a third of it at most.
  const defect = seedDisqualified(seedRaw, seedShown, {
    memberTitle: seed.article.title,
    clusterTitle: title,
  });
  const malformed = defect !== null || stale || opinionSeed || explainerSeed;
  const nearZeroStub = defect === "stub" && seedScore < AGREEMENT_STUB_LOW_SEED - EPSILON;
  const floor = nearZeroStub ? AGREEMENT_LOW : defect !== null ? AGREEMENT_FORM_DEFECT_MIN : AGREEMENT_HIGH;
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
    // A column never stands in for the summary, whether the seed is news or a column
    // (a mirror of the seed's own column covers the headline as well as it does).
    if (isOpinionUrl(m.article.url)) return;
    if (sourceLang(m.source) !== seedLang) return;
    const hash = m.article.content_hash;
    if (hash !== null && wireMajorityHashes.has(hash)) return;
    const raw = texts[i] ?? "";
    if (raw === "" || blockedTexts.has(raw) || agencyTexts.has(raw)) return;

    const shown = tidySummaryText(raw);
    if (shown.length < AGREEMENT_MIN_CHARS) return;
    if (summaryDefect(raw, shown) !== null) return;
    // A description that is only a headline says nothing the page does not (h95-
    // summaries-1): the member's own, or the cluster's, for every seed.
    if (isHeadlineEcho(m.article.title, shown) || isHeadlineEcho(title, shown)) return;
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
    if (!agreementSwitches(seedScore, score, malformed, floor)) return;
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
