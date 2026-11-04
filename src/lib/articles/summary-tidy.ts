import {
  cutAppendedTicker,
  isUnpunctuatedShortLine,
  stripFeedWrappers,
} from "../../../supabase/functions/_shared/cluster/description-clean";
import { BOILERPLATE_PHRASES, TRAILING_CTA_PHRASES } from "./description-boilerplate";

// Read-time tidy for feed residue in a cluster summary.
//
// clusters.summary_tr is the seed article's description verbatim, and the
// ingest tag stripper replaces every tag (<p>, <br>, <li>) with nothing, so a
// summary can carry:
//   - glued sentences        "hastaneye kaldırıldı.Yangın, Ortaköy"
//   - an outlet CTA tail     "... Sistemi (ILS)...Devamı için tıklayınız"
//   - widget heading lines   "belirtti.\nİlginizi Çekebilir\nToplantıya"
//   - feed wrappers          "<title> 02.11.2026 Diken<body>\nThe post <title>
//                            appeared first on #site_linkat 02.11.2026 ." (Diken),
//                            "<body>\n<title> yazısı ilk önce Serbestiyet
//                            adresinde yayınlanmıştır." (Serbestiyet) and
//                            "<body>\n<headline> Medyascope" (Medyascope)
//   - raw newlines
//   - a text the ingest clamp cut mid-word (500 characters ending "...") or an
//     outlet's own feed cap cut mid-word (Haberport 202/203, Sözcü 123, Daily
//     Sabah 183 characters ending "...")
//   - a repaired cut that would end inside an open quotation, and a text a feed
//     cut inside a quotation before its trailing "[…]" (h29-regress-1)
//   - a sub-heading glued onto the body ("odaklı ziyaretİçişleri Bakanı",
//     "ziyaretin önemi:Cumhurbaşkanı Erdoğan")
//   - a heading line on top of the body ("Genel provanın akışı\nSinop'ta 29
//     Ekim ..."), which the newline collapse would run on into the first sentence
//   - a leading "Son dakika |" / "Son dakika haberi:" / "Son dakika haberine
//     göre," / "Son dakika gelişmesi..." ticker and a leading list marker
//     ("- ", "• ", "▪️ ")
//   - a trailing "Detaylar haberimizde..." / "İşte ayrıntılar..." sentence
//   - another story's headline appended after the body (Milliyet: a "related
//     news" line and its "Son dakika..." ticker)
//   - double spaces
//
// The ingest side must not change (content_hash and the corpus-equality test
// pin it), and nothing is rewritten in the database: this is a pure function
// applied to the text that is SHOWN. No Date, no IO.

/**
 * Widget heading lines ("You may also like" blocks that leak into a
 * description as their own line). Stored already folded with the tr-TR lower
 * case and without a trailing ":"; a line is compared after the same folding.
 */
export const WIDGET_HEADINGS: ReadonlySet<string> = new Set([
  "ilginizi çekebilir",
  "ilgili haberler",
  "bunlar da ilginizi çekebilir",
]);

/** Upper bound on how many stacked CTAs one call will peel off. */
const MAX_CTA_PASSES = 5;

// Punctuation that ends a sentence, a clause or a quotation: a CTA right after
// one of these is unmistakably a CTA, whatever its case.
const PUNCTUATION_BEFORE_CTA = /^[.!?…:)\]"”»]$/u;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Trailing CTA. Three ways to reach the phrase:
//   ^                          the whole string is the CTA
//   (?<=PUNCT)\s*              straight after sentence punctuation
//   (?<!\s)\s+                 after plain whitespace (the caller then demands
//                              a capital letter; see stripTrailingCta)
// The `(?<!\s)` guard starts the whitespace alternative only at the beginning
// of a run, so a long run of spaces costs O(n), not O(n^2). Phrases are tried
// longest first and may be separated by any whitespace (feeds emit NBSP and
// double spaces). After the phrase only `. … ! » › >` and whitespace may
// follow, up to the end of the string.
const CTA_TAIL = new RegExp(
  "(^|(?<=[.!?…:)\\]\"”»])\\s*|(?<!\\s)\\s+)(" +
    [...BOILERPLATE_PHRASES, ...TRAILING_CTA_PHRASES]
      .sort((a, b) => b.length - a.length)
      .map((phrase) => escapeRegExp(phrase).replace(/ /g, "\\s+"))
      .join("|") +
    ")[\\s.…!»›>]*$",
  "u",
);

// Plain lower case turns "I" into "i" (right for the English phrases); the
// tr-TR fold turns "I" into "ı" and "İ" into "i" (right for "DEVAMI İÇİN
// TIKLAYIN"). Either one may be the one that lines up with the phrase list.
const FOLDS: ReadonlyArray<(s: string) => string> = [
  (s) => s.toLocaleLowerCase("tr-TR"),
  (s) => s.toLowerCase(),
];

// Longest heading is 28 characters; the cap only keeps a pathological
// whitespace-heavy line from reaching the regexes below.
const MAX_HEADING_LENGTH = 64;

function isWidgetLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length > MAX_HEADING_LENGTH) return false;
  const heading = trimmed.replace(/\s+/g, " ").replace(/\s*:$/, "");
  if (heading === "") return false;
  return FOLDS.some((fold) => WIDGET_HEADINGS.has(fold(heading)));
}

/** A lower-case CTA sentence is dropped whole only when it is at most this long (code points). */
const MAX_LOWER_CASE_CTA_SENTENCE = 90;

/**
 * `s` without its last sentence, when that sentence ends in a sentence-style CTA
 * phrase written in lower case ("... KYK burs ve kredi başvurularına dair
 * detaylar haberimizde."), or null. `match` is the CTA_TAIL match on the folded
 * copy of `s`. Only {@link TRAILING_CTA_PHRASES} qualify (the English and older
 * Turkish phrases are ordinary prose in lower case); the sentence must start
 * after an earlier sentence end and hold at most
 * {@link MAX_LOWER_CASE_CTA_SENTENCE} code points. Cutting at the phrase instead
 * would leave "... başvurularına", a fragment.
 */
function dropLowerCaseCtaSentence(s: string, match: RegExpExecArray): string | null {
  const phrase = (match[2] ?? "").replace(/\s+/g, " ");
  if (!TRAILING_CTA_PHRASES.has(phrase)) return null;
  const end = lastSentenceEnd(s.slice(0, match.index));
  if (end <= 0) return null;
  const sentence = s.slice(end).trim();
  // A code point is at most two UTF-16 units: a longer string cannot fit.
  if (sentence.length > 2 * MAX_LOWER_CASE_CTA_SENTENCE) return null;
  if ([...sentence].length > MAX_LOWER_CASE_CTA_SENTENCE) return null;
  return s.slice(0, end).trimEnd();
}

/**
 * Remove one trailing CTA from `s`, or return null when there is none.
 *
 * The match runs on a case-folded copy of `s`; match offsets are only valid
 * for the original when the fold kept the length (plain `toLowerCase()` turns
 * "İ" into two code units), so a fold that changed the length is skipped.
 *
 * A CTA after sentence punctuation (or the whole string) is always removed. A
 * CTA after plain whitespace is removed only when it starts with a capital
 * letter: "kişi yaralandı Devamı için tıklayınız" is a tail, while
 * "experts want to read more" is ordinary prose. The one exception is a
 * sentence-style phrase ({@link TRAILING_CTA_PHRASES}) that ends a short last
 * sentence in lower case: that whole sentence goes
 * ({@link dropLowerCaseCtaSentence}).
 */
function stripTrailingCta(s: string): string | null {
  for (const fold of FOLDS) {
    const folded = fold(s);
    if (folded.length !== s.length) continue;
    const match = CTA_TAIL.exec(folded);
    if (!match) continue;

    const afterPunctuationOrStart =
      match.index === 0 ||
      PUNCTUATION_BEFORE_CTA.test(folded.charAt(match.index - 1));
    if (!afterPunctuationOrStart) {
      const ctaStart = match.index + (match[1] ?? "").length;
      if (!/\p{Lu}/u.test(s.charAt(ctaStart))) {
        const shorter = dropLowerCaseCtaSentence(s, match);
        if (shorter !== null) return shorter;
        continue;
      }
    }
    return s.slice(0, match.index).trimEnd();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ingest-clamp repair (h22-editorial-2). supabase/functions/_shared/rss/
// normalize.ts clamps a description to 497 UTF-16 units and appends "...", so a
// clamped text is 500 characters long (499 when the cut dropped half of a
// surrogate pair) and ends with "...", and the cut is wherever the 497th unit
// fell: "tedaviye devam edecek şeki...". The signature is the only evidence of
// a clamp; a shorter text ending "Detaylar..." is the outlet's own ellipsis.
// ---------------------------------------------------------------------------

const CLAMP_SUFFIX = "...";
const CLAMP_LENGTHS: readonly number[] = [499, 500];
/**
 * Outlet feed caps (h25-live-1): a few feeds cut their own description at a
 * fixed length and add "..." (200 characters of text for Haberport, 120 for
 * Sözcü, 180 for Daily Sabah), so the text ends mid-word: "açtığı kuaför salo...".
 * Eight days of `articles` (2026-10-26 to 2026-11-02, the last day partial),
 * descriptions ending a letter or digit + "...": haberport 203: 3569 rows,
 * sozcu 123: 1494, haberport 202: 483, daily-sabah 183: 352. Every other (source, length) pair is below 50 rows
 * (daily-sabah 182: 41, tele1 303: 31, muhalif 152-162: 3-27 per length) and the
 * 500-character rows are the ingest clamp above. No row held an astral
 * character, so the length PostgreSQL counts is the JS .length. Unlike the
 * ingest clamp these lengths are shared by texts that merely end in "...", so a
 * feed cap counts only when the "..." follows a letter or a digit: a cut inside
 * a word. A "..." after a blank or a punctuation mark is the outlet's own
 * ellipsis and stays with the CTA logic.
 */
const FEED_CAP_LENGTHS: readonly number[] = [123, 183, 202, 203];
/** A sentence-end cut must keep at least this share of the clamped text. */
const CLAMP_MIN_KEPT_SHARE = 0.6;
/**
 * The cut in front of an open quotation keeps at least this share of the clamped
 * text. Lower than {@link CLAMP_MIN_KEPT_SHARE}: the alternative is a cut that
 * ends inside the quotation, and e5d77d31 keeps 50.3% in front of its quotation.
 */
const CLAMP_QUOTE_MIN_KEPT_SHARE = 0.5;
const SENTENCE_MARKS = new Set([".", "!", "?", "…"]);
/** Quotes and brackets that may close a sentence right after its mark. */
const CLOSERS = new Set(['"', "”", "»", "’", "'", ")", "]"]);
/** Dangling punctuation a word cut must not leave in front of the ellipsis. */
const CLAMP_DANGLING = new Set([",", ";", ":", "–", "—", "-"]);

function isBlankChar(ch: string): boolean {
  return ch.trim() === "";
}

/**
 * A sentence mark glued to the next sentence ("kaldırıldı.Yangın"): a lower-case
 * letter, the mark, and an upper-case letter right behind it. Only a lower-case
 * letter before the mark counts, so "T.C.", "A.Ş." and "U.S." are untouched, and
 * the next character must be an upper-case letter, so decimals and domains
 * ("3.5", "tayfhaber.com") are untouched. Step 4 of {@link tidySummaryText} and
 * {@link repairClamp} (h26-live-1) both put a space after the mark with it.
 */
const GLUED_SENTENCE = /([a-zçğıöşü])([.!?…])(?=[A-ZÇĞİÖŞÜ])/gu;

// Title and street abbreviations that end in a dot without ending the sentence
// ("Prof. Dr. Gönül Paçacı", "Öğr. Gör. Ali", "Atatürk Cad. No. 5"), and the
// English month and company abbreviations that turn up in the English feeds
// ("ahead of the country's Nov. 8 Victory Day", "Kiva Marine Ltd. işletmesi";
// h26-live-1). Compared on the tr-TR fold of the whole letter run before the dot,
// and on the plain fold too: the tr-TR fold turns the "I" of "Inc" into "ı".
// Each entry only makes lastSentenceEnd more conservative.
const NON_SENTENCE_ABBREVIATIONS: ReadonlySet<string> = new Set([
  "dr", "prof", "doç", "doc", "av", "op", "uzm", "yrd", "öğr", "arş", "gör",
  "org", "korg", "tümg", "tuğg", "alb", "sn", "mah", "cad", "sok", "no", "vs",
  "vb", "bkz", "örn",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov",
  "dec", "ltd", "inc", "co", "corp", "şti", "mr", "mrs", "ms", "jr", "st",
]);
/**
 * An upper-case Roman numeral, 1 to 39 ("Sultan II. Abdülhamid", "XIV. Louis"):
 * the run before a dot is never empty when this is tested. Upper case only, so
 * "ii." and "iv." are ordinary words; a run of other capitals ("ABD", "NATO",
 * "VIP") does not match. Linear: at most 8 characters are ever tested.
 */
const ROMAN_NUMERAL = /^X{0,3}(?:IX|IV|V?I{0,3})$/;
/** Longest letter/digit run before a dot that is looked at; a longer run is a word. */
const MAX_RUN_BEFORE_DOT = 8;
/** A digit run of 1 to this many digits before a dot is a Turkish ordinal ("13. Zirve"). */
const MAX_ORDINAL_DIGITS = 4;
const FIRST_YEAR = 1900;
const LAST_YEAR = 2099;

function isLetterOrDigit(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

/**
 * True when the "." at `markIndex` ends a token and not a sentence. The run of
 * letters and digits right before the dot (looked at up to
 * {@link MAX_RUN_BEFORE_DOT} characters back; a longer run is an ordinary word
 * and gives false) is one of:
 *   - a single letter, an initial ("K. Sarıgül");
 *   - 1-4 digits, a Turkish ordinal ("Konseyi 13. Zirvesi"), except a 4-digit
 *     year from 1900 to 2099, which DOES end a sentence ("... 2026. Yeni dönem");
 *   - an upper-case Roman numeral ({@link ROMAN_NUMERAL}: "Sultan II.");
 *   - a title, street, month or company abbreviation
 *     ({@link NON_SENTENCE_ABBREVIATIONS}), as a whole word ("Prof.", "DR.",
 *     "Nov.", "Ltd.", but not "abcdr.").
 */
function isNonSentenceDot(body: string, markIndex: number): boolean {
  if (body.charAt(markIndex) !== ".") return false;
  let start = markIndex;
  while (start > 0 && isLetterOrDigit(body.charAt(start - 1))) {
    start--;
    if (markIndex - start > MAX_RUN_BEFORE_DOT) return false;
  }
  const run = body.slice(start, markIndex);
  if (run.length === 0) return false;
  if (run.length === 1) return true;
  if (run.length <= MAX_ORDINAL_DIGITS && /^[0-9]+$/.test(run)) {
    const n = Number(run);
    return run.length !== 4 || n < FIRST_YEAR || n > LAST_YEAR;
  }
  if (ROMAN_NUMERAL.test(run)) return true;
  return (
    NON_SENTENCE_ABBREVIATIONS.has(run.toLocaleLowerCase("tr-TR")) ||
    NON_SENTENCE_ABBREVIATIONS.has(run.toLowerCase())
  );
}

/** `[start, end)` of a stretch of text in which no mark counts as a sentence end. */
type SkipRange = readonly [number, number];

/**
 * The lines of a clamped `body` that hold another story's headline, in one pass:
 * not the first line, terminated by "\n" (the last line is the clamped one and
 * is never skipped), short and unpunctuated
 * ({@link isUnpunctuatedShortLine}). "11 ilde sahte kanser ilacı operasyonu! 22
 * gözaltı" between two paragraphs of 1f0261af put its "!" in front of the real
 * last sentence.
 */
function unpunctuatedLineRanges(body: string): SkipRange[] {
  const ranges: SkipRange[] = [];
  let start = body.indexOf("\n") + 1;
  if (start === 0) return ranges;
  while (start < body.length) {
    const end = body.indexOf("\n", start);
    if (end === -1) break;
    if (isUnpunctuatedShortLine(body.slice(start, end))) ranges.push([start, end]);
    start = end + 1;
  }
  return ranges;
}

/**
 * Index just after the last sentence end of `body` (the mark and any closing
 * quote), or -1. A sentence end is one of . ! ? … followed by whitespace, a
 * closing quote or bracket and then whitespace, or the end of the text. Decimals
 * ("3.5"), domains, initials ("K. Sarıgül"), ordinals ("13."), title
 * abbreviations ("Prof. Dr.") and a mark inside one of the `skip` ranges (sorted,
 * disjoint) are not sentence ends. When `accept` is given, a sentence end it
 * rejects (called with the index the text would be cut at) is passed over and
 * the search goes on with the one before it.
 */
function lastSentenceEnd(
  body: string,
  skip: readonly SkipRange[] = [],
  accept?: (end: number) => boolean,
): number {
  let r = skip.length - 1;
  for (let i = body.length - 1; i >= 0; i--) {
    if (!SENTENCE_MARKS.has(body.charAt(i))) continue;
    // `i` only decreases, so the range pointer only moves down.
    while (r >= 0 && (skip[r]?.[0] ?? 0) > i) r--;
    const range = r >= 0 ? skip[r] : undefined;
    if (range !== undefined && i < range[1]) continue;
    let q = i + 1;
    while (q < body.length && CLOSERS.has(body.charAt(q))) q++;
    if (q < body.length && !isBlankChar(body.charAt(q))) continue;
    if (isNonSentenceDot(body, i)) continue;
    if (accept !== undefined && !accept(q)) continue;
    return q;
  }
  return -1;
}

/**
 * `balanced(end)` for a clamped `body`: true when `body.slice(0, end)` leaves no
 * quotation open. Four running balances are built once, so each call is O(1):
 * the straight quote '"' must occur an even number of times, and the openers
 * “ « ‘ must not outnumber the closers ” » ’. The apostrophe ’ (U+2019) is also a
 * closer, which only ever makes the check let a text pass, never reject one.
 *
 * h30-live-1: some feeds close a U+2018 with the ASCII apostrophe (c5627cb9
 * stores "‘100 il 1000 ilçe' projesini"). An ASCII "'" therefore closes an open
 * ‘ (it counts -1 on the same balance) when one is open and the next character
 * is not a letter (the end of the text counts as not a letter). "‘İsrail'in
 * tutumu" stays open: an apostrophe in front of a letter is a Turkish suffix
 * apostrophe. An ASCII "'" with no open ‘ is never a closer and changes nothing.
 */
function quoteBalance(body: string): (end: number) => boolean {
  const n = body.length;
  const straight = new Int32Array(n + 1);
  const curly = new Int32Array(n + 1);
  const angle = new Int32Array(n + 1);
  const single = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const ch = body.charAt(i);
    straight[i + 1] = (straight[i] ?? 0) + (ch === '"' ? 1 : 0);
    curly[i + 1] = (curly[i] ?? 0) + (ch === "\u201C" ? 1 : ch === "\u201D" ? -1 : 0);
    angle[i + 1] = (angle[i] ?? 0) + (ch === "\u00AB" ? 1 : ch === "\u00BB" ? -1 : 0);
    const open = single[i] ?? 0;
    const closesAscii = ch === "'" && open > 0 && !ANY_LETTER.test(body.charAt(i + 1));
    single[i + 1] = open + (ch === "\u2018" ? 1 : ch === "\u2019" || closesAscii ? -1 : 0);
  }
  return (end) =>
    ((straight[end] ?? 0) & 1) === 0 &&
    (curly[end] ?? 0) <= 0 &&
    (angle[end] ?? 0) <= 0 &&
    (single[end] ?? 0) <= 0;
}

/**
 * `end` moved back over dangling ", ; : – — -" and blanks: the index a cut of
 * `s` should end at so that it does not leave one of them in front of an
 * ellipsis. Exported for the word cut of describeForMeta (summary-attribution.ts).
 */
export function trimDanglingEnd(s: string, end: number): number {
  let stop = end;
  while (stop > 0 && (CLAMP_DANGLING.has(s.charAt(stop - 1)) || isBlankChar(s.charAt(stop - 1)))) stop--;
  return stop;
}

/** True for a clamped text: the 499/500 ingest clamp or an outlet feed cap. */
function hasClampSignature(raw: string): boolean {
  if (!raw.endsWith(CLAMP_SUFFIX)) return false;
  if (CLAMP_LENGTHS.includes(raw.length)) return true;
  return (
    FEED_CAP_LENGTHS.includes(raw.length) &&
    isLetterOrDigit(raw.charAt(raw.length - CLAMP_SUFFIX.length - 1))
  );
}

/**
 * Repair a text the ingest clamp or an outlet feed cap cut ({@link
 * hasClampSignature}). When the clamped text holds an appended
 * ticker ({@link cutAppendedTicker}: another story's headline, never ours) the
 * repair is that cut, whatever share it keeps and with no "…". Otherwise keep up
 * to the last sentence end when that keeps at least {@link CLAMP_MIN_KEPT_SHARE}
 * of the text, else cut at the last word boundary, drop dangling ", ; : – — -"
 * and add one "…". A sentence end that leaves a quotation open (an odd number of
 * '"', more “ « ‘ than ” » ’; see {@link quoteBalance}) is passed over for the
 * one before it, and a word cut that still ends inside a quotation moves back in
 * front of the opener when that keeps at least {@link CLAMP_QUOTE_MIN_KEPT_SHARE}
 * of the text (e5d77d31). When no cut can be made without leaving a quotation
 * open (the opener is too early: c526f480, a whole speech), the text is repaired
 * as if quotations did not matter: the last sentence end, balanced or not, else
 * the word cut. A sentence mark glued to the next sentence
 * ("belirlenemedi.Müdahale") is a sentence end: the repair works on the text
 * with the space that step 4 of {@link tidySummaryText} would put there
 * ({@link GLUED_SENTENCE}), so a complete glued last sentence is not dropped
 * (h26-live-1); the clamp signature and the ticker cut stay on the raw text.
 * When the word cut still leaves part of a paragraph that the clamp cut (the
 * text after its last line break), the cut moves back to that line break if it
 * keeps at least {@link CLAMP_MIN_KEPT_SHARE} of the text and the line it then
 * ends on is not a short unpunctuated one (a heading, a label, a related
 * headline): the few words of the next paragraph are not a sentence.
 * Returns null when the text is not a clamp or nothing can be cut (a single long
 * word).
 */
function repairClamp(raw: string): string | null {
  if (!hasClampSignature(raw)) return null;
  const body = raw.slice(0, raw.length - CLAMP_SUFFIX.length);

  const withoutTicker = cutAppendedTicker(body);
  if (withoutTicker !== body && withoutTicker.trim() !== "") return withoutTicker.trimEnd();

  // h26-live-1: lastSentenceEnd needs a blank after the mark, and step 4 (which
  // un-glues "lower.Upper") runs after this repair, so a glued last sentence was
  // never a candidate. Un-glue first; every index and share below is in `text`.
  const text = body.replace(GLUED_SENTENCE, "$1$2 ");
  const balanced = quoteBalance(text);
  const lines = unpunctuatedLineRanges(text);
  const end = lastSentenceEnd(text, lines, balanced);
  if (end > 0) {
    const kept = text.slice(0, end).trimEnd();
    if (kept.length >= CLAMP_MIN_KEPT_SHARE * text.length) return kept;
  }

  let cut = text.trimEnd();
  if (cut.length === text.length) {
    // The clamp fell inside a word: drop it.
    let at = text.length - 1;
    while (at >= 0 && !isBlankChar(text.charAt(at))) at--;
    if (at <= 0) return null;
    cut = text.slice(0, at);
  }
  // 4ca344b8 (h24): "...Vefa: Ahmed-i Hânî\n\nTrump ..." kept "Trump", the first word
  // of the next paragraph. When what the word cut kept still ends in a paragraph
  // the clamp cut (nothing dropped after `cut` was a line break, otherwise that
  // paragraph is complete), end at the last line break instead, provided that
  // keeps the bar. A paragraph before an earlier break is never touched. The line
  // the cut would end on must be a paragraph: a short unpunctuated line there is a
  // heading, a "Name:" label or a pasted-in related headline (e345d54d, 9c4dc3ea,
  // 3da4c962, 307cf42b: the cut would have ended on "...Yollar göle döndü"), so
  // the word cut stays.
  const lastBreak = cut.lastIndexOf("\n");
  if (lastBreak > 0 && !text.slice(cut.length).includes("\n")) {
    const kept = cut.slice(0, lastBreak).trimEnd();
    if (
      kept.length >= CLAMP_MIN_KEPT_SHARE * text.length &&
      !isUnpunctuatedShortLine(kept.slice(kept.lastIndexOf("\n") + 1))
    ) {
      cut = kept;
    }
  }
  cut = cut.slice(0, trimDanglingEnd(cut, cut.length));
  if (cut === "") return null;
  // The cut ends inside an open quotation (e5d77d31): end in front of the opener
  // instead, the largest prefix that leaves nothing open, when it keeps enough.
  if (!balanced(cut.length)) {
    let at = cut.length;
    while (at > 0 && !balanced(at)) at--;
    const before = text.slice(0, trimDanglingEnd(text, at));
    if (before !== "" && before.length >= CLAMP_QUOTE_MIN_KEPT_SHARE * text.length) {
      cut = before;
    } else {
      // Nothing balanced is long enough: repair as if quotations did not matter
      // (the sentence ends the quote check passed over count again).
      const anyEnd = lastSentenceEnd(text, lines);
      const kept = anyEnd > 0 ? text.slice(0, anyEnd).trimEnd() : "";
      if (kept.length >= CLAMP_MIN_KEPT_SHARE * text.length) return kept;
    }
  }
  return SENTENCE_MARKS.has(cut.charAt(cut.length - 1)) ? cut : cut + "…";
}

/**
 * `text` cut so that it no longer ends inside an open quotation (h29-regress-1),
 * or null when no cut is long enough. A text that leaves no quotation open (the
 * straight quote an even number of times, no more “ « ‘ than ” » ’; see
 * {@link quoteBalance}) is returned as it is, the same string. Otherwise the
 * opener is the end of the largest prefix that leaves nothing open, and there are
 * two candidates:
 *   - A, the text up to the last sentence end that leaves nothing open, with no
 *     ellipsis (the sentence is complete);
 *   - B, the text up to the opener, with dangling ", ; : – — -" and blanks gone,
 *     plus one "…" unless it already ends in a sentence mark.
 * A cut is valid when it ends after `floor` (default 0: not empty) and keeps at
 * least `minShare` (default 0) of `text`. A wins when it is valid and keeps at
 * least {@link CLAMP_MIN_KEPT_SHARE} of what B keeps (the clamp repair's bar for a
 * sentence-end cut); otherwise B, then A, whichever is valid; null when neither
 * is. Linear: one pass for the balances, one for the opener, one for the sentence
 * end. Unlike {@link repairClamp} (which stays as it is) this also serves texts
 * that are not clamps: the excerpt marker of step 1b of {@link tidySummaryText}
 * and the word cut of describeForMeta (summary-attribution.ts).
 */
export function backOffOpenQuote(
  text: string,
  opts: { floor?: number; minShare?: number } = {},
): string | null {
  const balanced = quoteBalance(text);
  if (balanced(text.length)) return text;

  const floor = Math.max(0, opts.floor ?? 0);
  const minKept = (opts.minShare ?? 0) * text.length;

  // The opener: the largest prefix that leaves nothing open ends right in front of it.
  let at = text.length;
  while (at > 0 && !balanced(at)) at--;

  const sentenceEnd = lastSentenceEnd(text, [], balanced);
  const sentenceCutValid = sentenceEnd > floor && sentenceEnd >= minKept;
  const sentenceCut = sentenceCutValid ? text.slice(0, sentenceEnd).trimEnd() : null;

  const openerEnd = trimDanglingEnd(text, at);
  const openerCutValid = openerEnd > floor && openerEnd >= minKept;
  const openerCut = openerCutValid
    ? SENTENCE_MARKS.has(text.charAt(openerEnd - 1))
      ? text.slice(0, openerEnd)
      : text.slice(0, openerEnd) + "…"
    : null;

  if (sentenceCut !== null && sentenceEnd >= CLAMP_MIN_KEPT_SHARE * openerEnd) return sentenceCut;
  return openerCut ?? sentenceCut;
}

// ---------------------------------------------------------------------------
// Leading noise (h22-editorial-2, h23-live-1, h24): a ticker ("Son dakika | X",
// "Son dakika! X", "Son dakika... X", "SON DAKİKA: X", "Son dakika haberi: X",
// "Son dakika gelişmesi... X", "Son dakika haberine göre; X", "Son dakika
// haberine göre, X") and a list marker ("- X", "• X", "▪️ X"). The ticker is
// matched on the tr-TR fold (so "SON DAKİKA" folds to "son dakika") and cut from
// the original by the match length, which is only valid while the fold kept the
// length. A separator is required: "Son dakika golüyle ...", "Son dakikada ...",
// "Son dakika haberi olarak duyuruldu", "Son dakika gelişmesi olarak ..." and
// "Son dakika haberine göre kentte ..." are sentences. A comma is a separator
// after "haberine göre" only ("Son dakika, X" and "Son dakika haberi, X" are
// text). Same shape as TICKER_LINE in _shared/cluster/description-clean.ts,
// anchored at the start. A marker needs blanks after it: "-5 derece" and
// "•madde" are text.
//
// A ticker leaves a sentence that began after a comma or a colon, so its first
// word may be lower case ("Son dakika haberine göre, kentte yangın" -> "kentte
// yangın"): after a stripped ticker the first letter is upper-cased with the
// tr-TR rules (i -> İ, ı -> I); see {@link capitalizeFirstWord}.
// ---------------------------------------------------------------------------

const LEADING_TICKER =
  /^son\s+dak[iı]ka(?:\s+haberine\s+g[öo]re(?![\p{L}\p{N}])\s*(?:\||!+|:|;|,|[.…]+)|(?:\s+(?:haberi|geli[şs]mesi))?(?![\p{L}\p{N}])\s*(?:\||!+|:|;|[.…]+))\s*/u;
const ANY_LETTER = /^\p{L}$/u;
const LOWER_LETTER = /^\p{Ll}$/u;
/** What glues a word to the next one: "e-devlet", "tayfhaber.com", "iphone17", a combining mark. */
const GLUED_TO_WORD = /^[\p{N}\p{M}\-./_@]/u;
const LEADING_LIST_MARKER = /^(?:[-–•*]|\u25AA\uFE0F?)\s+/u;
/** At most this many tickers, and at most this many markers, are peeled in total. */
const MAX_TICKER_PASSES = 2;
const MAX_MARKER_PASSES = 2;

function stripOneTicker(s: string): string {
  const folded = s.toLocaleLowerCase("tr-TR");
  if (folded.length !== s.length) return s; // cannot slice safely
  const match = LEADING_TICKER.exec(folded);
  return match ? s.slice(match[0].length) : s;
}

function stripOneListMarker(s: string): string {
  const match = LEADING_LIST_MARKER.exec(s);
  return match ? s.slice(match[0].length) : s;
}

/**
 * `s` with its first letter upper-cased (tr-TR: "i" -> "İ", "ı" -> "I") when the
 * first word is entirely lower case: the run of letters at the start (a scan up
 * to the first non-letter) has no upper-case, title-case or caseless letter, is
 * not glued to a digit, a combining mark or one of "- . / _ @" ("e-devlet",
 * "tayfhaber.com"), and the upper-cased letter is a single code point (the
 * German "ß" would become "SS"). "iPhone", "ABD", "5 kişi", '"deprem"' and
 * "Kentte" are returned as they are. Character scan of the first word only.
 */
function capitalizeFirstWord(s: string): string {
  let end = 0;
  let firstLength = 0; // UTF-16 length of the first code point
  for (const ch of s) {
    if (!ANY_LETTER.test(ch)) break;
    if (!LOWER_LETTER.test(ch)) return s;
    if (end === 0) firstLength = ch.length;
    end += ch.length;
  }
  if (end === 0) return s;
  if (GLUED_TO_WORD.test(s.slice(end, end + 2))) return s;
  const upper = s.slice(0, firstLength).toLocaleUpperCase("tr-TR");
  if ([...upper].length !== 1) return s;
  return upper + s.slice(firstLength);
}

/**
 * Peel leading tickers and list markers, in whatever order they come ("Son
 * dakika | - X", "- Son dakika: X"), to a fixed point bounded by
 * {@link MAX_TICKER_PASSES} tickers and {@link MAX_MARKER_PASSES} markers. When
 * at least one ticker went, the first word of what is left starts upper-case
 * ({@link capitalizeFirstWord}); a list marker alone changes no case.
 */
function stripLeadingNoise(s: string): string {
  let out = s;
  let tickers = 0;
  let markers = 0;
  for (let pass = 0; pass <= MAX_TICKER_PASSES + MAX_MARKER_PASSES; pass++) {
    let changed = false;
    if (tickers < MAX_TICKER_PASSES) {
      const next = stripOneTicker(out);
      if (next !== out) {
        out = next;
        tickers++;
        changed = true;
      }
    }
    if (markers < MAX_MARKER_PASSES) {
      const next = stripOneListMarker(out);
      if (next !== out) {
        out = next;
        markers++;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return tickers > 0 ? capitalizeFirstWord(out) : out;
}

/** `s` without a trailing ":" (and the blanks around it), left by a stripped CTA. */
function dropDanglingColon(s: string): string {
  let end = s.length;
  while (end > 0 && (s.charAt(end - 1) === ":" || isBlankChar(s.charAt(end - 1)))) end--;
  return s.slice(0, end);
}

/**
 * `s` without the trailing CTAs, to a fixed point bounded by
 * {@link MAX_CTA_PASSES}; a ":" a strip leaves dangling goes with it.
 */
function peelTrailingCtas(s: string): string {
  let out = s;
  for (let pass = 0; pass < MAX_CTA_PASSES; pass++) {
    const stripped = stripTrailingCta(out);
    if (stripped === null) break;
    out = dropDanglingColon(stripped);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Glued sub-headings (h25-live-2). Haberport ships "<sub-heading><body>" with the
// block separator dropped by the tag stripper: "odaklı ziyaretİçişleri Bakanı",
// "yenilendiBüyükçekmece Belediye Meclisi", or "<label>:<body>" ("ziyaretin
// önemi:Cumhurbaşkanı Erdoğan ..."). Turkish letters only; a case map would also
// fold "İ"/"ı" and the circumflex vowels the wrong way for this scan.
// Scan of live cluster summaries (10,794 clusters, 2026-10-26 to 2026-11-02):
// 329 distinct tokens hold a lower->Upper join. 203 are the glue of a Turkish
// word and a place or title, and all 203 are split here. About 20 more are glues
// of a word and an acronym ("toplantısıTBMM", "ettiAK", "aldıASELSAN",
// "çıkardıG20"); h25 left them alone, h26-live-1 splits them. A replay of 10,859
// summaries (2026-10-26 to 2026-11-02) found 15 tokens of that shape, all of them
// real glue (AK, TBMM, CHP, UNESCO, G20, ASELSAN), and no macOS-style or currency
// token. A capital start ("TürkçedeFaddey") is not a glue. The remaining ~106 are brands and names that
// start upper case (MasterChef, YouTube, BirGün, VakıfBank, EuroLeague, ...) or
// lower case with at most two letters in front of the capital (iPhone, iMac,
// iPad, kWh, mRNA, mAh, eVTOL, beIN); none of those can match, because the run
// needs three lower-case letters. The lower-case brands that DO have three or
// more letters in front of their capitals (macOS, watchOS, visionOS, webOS, ...)
// are listed in {@link LOWER_PREFIX_BRANDS}, and a currency amount glued to its
// code ("5 milyarTL") is {@link CURRENCY_CODES}: both stay as they are.
// ---------------------------------------------------------------------------

const TR_LOWER = "a-zçğıöşüâîû";
const TR_UPPER = "A-ZÇĞİÖŞÜÂÎÛ";
/**
 * A whitespace-delimited token that STARTS with three or more lower-case letters
 * and then a capital that is followed by a lower-case letter (a word, "ziyaretİçişleri"),
 * another capital or a digit (an acronym, "toplantısıTBMM", "çıkardıG20"): the
 * run is a word, the rest the next sentence. "iPhone" (one letter in front),
 * "BirGün" and "MasterChef" (upper case start), "@YelizzKoray", "#yerelSeçim" and
 * URLs never match. The lookbehind starts a match only at the beginning of a
 * token, and the run is consumed once, so a very long token costs O(n).
 */
const GLUED_WORD = new RegExp(
  `(?<=^|\\s)([${TR_LOWER}]{3,})(?=[${TR_UPPER}](?:[${TR_LOWER}]|[${TR_UPPER}0-9]))`,
  "gu",
);
/**
 * Brands that start with three or more lower-case letters and then capitals, so
 * {@link GLUED_WORD} would split them; compared on the lower-cased core of the
 * token (its leading run of letters and digits, "macOS'un" -> "macos"). Brands
 * with at most two letters in front of the capital (iPhone, kWh, ...) never
 * match and are listed only to document the rule.
 */
const LOWER_PREFIX_BRANDS: ReadonlySet<string> = new Set([
  "macos", "watchos", "visionos", "tvos", "ipados", "webos", "iphone", "ipad",
  "imac", "ios", "evtol", "bein", "kwh", "mrna", "mah", "chatgpt",
]);
/**
 * Currency codes that stay glued to an amount in a feed ("5 milyarTL"): the
 * capitals behind the word are exactly one of these and no lower-case letter
 * follows them.
 */
const CURRENCY_CODES: ReadonlySet<string> = new Set(["TL", "YTL", "USD", "EUR", "GBP", "CHF"]);
const UPPER_TR_LETTER = new RegExp(`^[${TR_UPPER}]$`, "u");
const LOWER_ANY_LETTER = /^\p{Ll}$/u;

/**
 * Replacement for a {@link GLUED_WORD} match: the lower-case run plus ". ", or
 * the run itself when the token is a lower-case-prefix brand or the capitals
 * behind the run are a currency code. Each match scans its own token once (the
 * lookbehind allows one match per token), so the pass stays linear.
 */
function splitGluedWord(_match: string, run: string, offset: number, whole: string): string {
  // The core of the token: the run of letters and digits before the first
  // apostrophe, punctuation or blank ("macOS'un" -> "macOS").
  let coreEnd = offset + run.length;
  while (coreEnd < whole.length && isLetterOrDigit(whole.charAt(coreEnd))) coreEnd++;
  if (LOWER_PREFIX_BRANDS.has(whole.slice(offset, coreEnd).toLowerCase())) return run;

  // The capitals right behind the run: a currency code is not an acronym unless
  // a lower-case letter follows it.
  const upperStart = offset + run.length;
  let upperEnd = upperStart;
  while (upperEnd < whole.length && UPPER_TR_LETTER.test(whole.charAt(upperEnd))) upperEnd++;
  if (
    CURRENCY_CODES.has(whole.slice(upperStart, upperEnd)) &&
    !LOWER_ANY_LETTER.test(whole.charAt(upperEnd))
  ) {
    return run;
  }
  return run + ". ";
}

/** A lower-case label of at most 81 characters, no sentence mark, glued to a capital: "ziyaretin önemi:Cumhurbaşkanı". */
const GLUED_LABEL = new RegExp(`^[${TR_LOWER}][^.!?…:]{0,80}:(?=[${TR_UPPER}])`, "u");
/** A lower-case letter, a colon and a capital: "önemi:Cumhurbaşkanı". Digits are not matched, so "10:30" stays. */
const GLUED_COLON = new RegExp(`([${TR_LOWER}]):(?=[${TR_UPPER}])`, "gu");

/** Step 4c of {@link tidySummaryText}. */
function splitGluedHeadings(s: string): string {
  return s
    .replace(GLUED_WORD, splitGluedWord)
    .replace(GLUED_LABEL, "")
    .replace(GLUED_COLON, "$1: ");
}

// ---------------------------------------------------------------------------
// Heading line (h30-live-1). Haberport and a few other feeds ship
// "<heading>\n<body>": a short unpunctuated line, then the body. Step 2 of
// tidySummaryText turns the line break into a blank, so the summary read
// "Genel provanın akışı Sinop'ta 29 Ekim Cumhuriyet Bayramı'nın ..." (bef94c53,
// 3158fd7a, 6c2af39b, d298d680) and the meta description repeated the heading as
// if it were the first words of the sentence. The first line is a heading when it
// is 15 to 140 characters, has no sentence mark and no colon, does not end in a
// dash or a comma (it is a sentence that goes on in the next line), does not
// start with a list marker (a bullet is a sentence of the story), and the
// next line starts with a capital. The heading goes when what is left is a body
// of its own (80 characters, blanks collapsed); a shorter body keeps the heading
// as its first sentence, joined with ". ".
// ---------------------------------------------------------------------------

const MIN_HEADING_LINE = 15;
const MAX_HEADING_LINE = 140;
/** A body shorter than this (blanks collapsed) keeps its heading line, as a first sentence. */
const MIN_BODY_AFTER_HEADING = 80;
/** A first line holding one of these is a sentence, a label or a time, not a heading. */
const HEADING_LINE_MARKS: ReadonlySet<string> = new Set([".", "!", "?", ":", "\u2026"]);
/** A first line ending in one of these goes on in the next line. */
const HEADING_LINE_OPEN_ENDS: ReadonlySet<string> = new Set([",", ";", "\u2013", "\u2014", "-"]);

/** True when `s` (without its trailing blanks) is at least `min` characters long with every run of blanks counted once. One pass, stops at `min`. */
function collapsedLengthReaches(s: string, min: number): boolean {
  let end = s.length;
  while (end > 0 && isBlankChar(s.charAt(end - 1))) end--;
  let n = 0;
  let inBlank = false;
  for (let i = 0; i < end; i++) {
    const blank = isBlankChar(s.charAt(i));
    if (!blank || !inBlank) n++;
    inBlank = blank;
    if (n >= min) return true;
  }
  return false;
}

/**
 * Step 1d of {@link tidySummaryText}: `s` (line breaks still in place) without a
 * heading first line, or with the heading joined to the body as a first sentence
 * when the body alone is shorter than {@link MIN_BODY_AFTER_HEADING}. Only the
 * first line is looked at, once; any text that does not have the shape comes back
 * as the same string. Linear: one scan of the first line, one bounded scan of the
 * body, no regular expression over the text.
 */
function dropHeadingLine(s: string): string {
  const t = s.trimStart();
  const nl = t.indexOf("\n");
  if (nl < 0) return s;
  const head = t.slice(0, nl).trim();
  if (head.length < MIN_HEADING_LINE || head.length > MAX_HEADING_LINE) return s;
  for (const ch of head) if (HEADING_LINE_MARKS.has(ch)) return s;
  if (HEADING_LINE_OPEN_ENDS.has(head.charAt(head.length - 1))) return s;
  // A bullet ("- X", "• X") is a sentence of the story, not a heading: the replay
  // of 8,488 live summaries found two bullet lists (f85bc48e, 307cf42b) whose
  // first bullet this step would have dropped. `head` is at most 140 characters.
  if (LEADING_LIST_MARKER.test(head)) return s;
  const rest = t.slice(nl + 1).trimStart();
  if (!UPPER_TR_LETTER.test(rest.charAt(0))) return s;
  return collapsedLengthReaches(rest, MIN_BODY_AFTER_HEADING) ? rest : `${head}. ${rest}`;
}

/**
 * Tidy a summary for display. Steps, in order:
 *   0. repair a text the ingest clamp or an outlet feed cap cut
 *      ({@link repairClamp}); keyed on the raw input, so it runs before anything
 *      changes the length;
 *   1. drop whole lines that are a widget heading ("İlginizi Çekebilir");
 *   1b. strip the Diken header ("<title> dd.mm.yyyy Diken"), the WordPress /
 *      Yoast footers ("The post ... appeared first on ...", "... yazısı ilk
 *      önce ... adresinde yayınlanmıştır.") and the Medyascope site-name footer
 *      ("<headline> Medyascope" as the last line) with {@link stripFeedWrappers},
 *      the same function the cluster consumer applies to the clustering text.
 *      It runs here, while the newlines are still present, because a footer
 *      starts at a line boundary. When that turned a trailing excerpt marker
 *      into "…" and the text is cut inside a quotation ("…videoda “ABD Senatosu
 *      için…"), it ends at the last sentence end in front of the opener, or at
 *      the word in front of it, when that keeps at least half of the text
 *      ({@link backOffOpenQuote}); an opener in the first half leaves the text as
 *      it is;
 *   1c. cut an appended ticker and the related-news lines in front of it with
 *      {@link cutAppendedTicker} (Milliyet: "...hazırız\nSon dakika... Rusya
 *      için 3 fırsat!"), also while the newlines are present. A cut that would
 *      leave nothing is not made, so a text that is only "\nSon dakika... X"
 *      still shows its X;
 *   1d. drop a heading first line ({@link dropHeadingLine}, h30-live-1): 15 to
 *      140 characters, none of ". ! ? : …", not ending in ", ; – — -", not
 *      starting with a list marker, with a next line that starts with a capital
 *      letter. The heading goes when the
 *      rest is at least {@link MIN_BODY_AFTER_HEADING} characters long (blanks
 *      collapsed), otherwise it stays as the first sentence ("<heading>. <rest>").
 *      Only the first line is looked at, in one pass;
 *   2. collapse every whitespace run that contains a newline to one space;
 *   2b. peel leading noise: a "Son dakika |" / "Son dakika haberi:" / "Son dakika
 *      gelişmesi..." / "Son dakika haberine göre;" (or "göre,") ticker (at most
 *      {@link MAX_TICKER_PASSES} in total) and a list marker "- " / "• " / "▪️ "
 *      (at most {@link MAX_MARKER_PASSES} in total), in either order; after a
 *      stripped ticker a lower-case first word is capitalised
 *      ({@link capitalizeFirstWord});
 *   3. strip a trailing "Devamı için tıklayınız" / "Read more »" /
 *      "Detaylar haberimizde" / "İşte ayrıntılar" / "İşte merak edilen tüm
 *      detaylar" / "Ayrıntılar birazdan" style CTA, repeatedly (at most
 *      {@link MAX_CTA_PASSES} times); a sentence-style CTA that ends a short
 *      lower-case last sentence takes that sentence with it; a ":" the strip
 *      leaves dangling goes with it;
 *   4. put a space after a sentence mark glued to the next sentence
 *      ("kaldırıldı.Yangın" -> "kaldırıldı. Yangın", {@link GLUED_SENTENCE}).
 *      Only a lower-case letter before the mark counts, so "T.C.", "A.Ş." and
 *      "U.S." are untouched, and the next character must be an upper-case
 *      letter, so decimals and domains ("3.5", "tayfhaber.com") are untouched;
 *   4c. undo a sub-heading glued onto the body (Haberport), see
 *      {@link splitGluedHeadings}: a whitespace-delimited token that starts with
 *      three or more lower-case letters and then "Upper+lower" or an acronym
 *      ("Upper+Upper" or "Upper+digit") is split with ". " ("ziyaretİçişleri" ->
 *      "ziyaret. İçişleri", "toplantısıTBMM" -> "toplantısı. TBMM"), except a
 *      lower-case-prefix brand ("macOS'un", {@link LOWER_PREFIX_BRANDS}) and an
 *      amount glued to its currency code ("5 milyarTL", {@link CURRENCY_CODES});
 *      a leading lower-case label of up to 81 characters with no sentence mark,
 *      glued by a ":" to a capital, is dropped ("ziyaretin önemi:Cumhurbaşkanı"
 *      -> "Cumhurbaşkanı"); a lower-case letter, ":" and a capital elsewhere gets
 *      a space ("önemi: Cumhurbaşkanı"). A split can put a CTA phrase behind a
 *      sentence mark ("tamamlandıDevamını oku"), so step 3 runs again when 4c
 *      changed the text;
 *   4b. collapse every whitespace run to one space;
 *   5. trim.
 *
 * Step 0 repairs a clamp with {@link cutAppendedTicker} first: foreign text is
 * never kept, so a clamped text that holds a ticker line ends where the ticker
 * block starts, with no "…". A clamp that holds a line break late in the text
 * ends there when no sentence end does (see {@link repairClamp}). A cut never
 * ends inside an open quotation when it can end in front of it.
 *
 * Returns "" when nothing but residue was there (a footer-only text included);
 * the caller then hides the summary. Idempotent for any input with at most
 * {@link MAX_CTA_PASSES} stacked CTAs, {@link MAX_TICKER_PASSES} stacked
 * tickers and {@link MAX_MARKER_PASSES} stacked list markers, whose footer, if
 * any, is not followed by a CTA (a footer is recognised only at the very end of
 * the text), and which has no Diken-style header after its first line (the
 * header is found before the newlines are collapsed, so such a line is a header
 * only once it has become part of the first line). One more exception, from the
 * feed caps: the clamp signature is read off the raw input, so an outlet text
 * that is a 200-character cut + "..." + "Devamı için tıklayınız" (3 in 1000
 * live summaries) comes back as the cut ("... yeni bir..."), and a second call
 * sees a feed-cap signature and repairs it. The summary is tidied once.
 */
export function tidySummaryText(s: string): string {
  // 0. Ingest clamp ("...tedaviye devam edecek şeki..."), on the raw input.
  const repaired = repairClamp(s);

  // 1. Widget heading lines.
  let out = (repaired ?? s)
    .split(/\r?\n/)
    .filter((line) => !isWidgetLine(line))
    .join("\n");

  // 1b. Diken / Serbestiyet feed wrappers (h19-ingest-2). The text still holds
  //     its newlines here: the footers are found by them.
  //     The excerpt marker " […]" becomes "…" (stripFeedWrappers), and a feed
  //     that cut the excerpt inside a quotation leaves "…videoda “ABD Senatosu
  //     için…" (h29-regress-1, 49cb984b): the "…" is then backed off to the last
  //     sentence end or to the word in front of the opener, when that keeps at
  //     least half of the text (backOffOpenQuote). A clamp (`repaired`) was
  //     already cut with the same care, and the author's own "…" is not ours.
  const unwrapped = stripFeedWrappers(out);
  out =
    repaired === null && unwrapped !== out && unwrapped.endsWith("…")
      ? (backOffOpenQuote(unwrapped, { minShare: CLAMP_QUOTE_MIN_KEPT_SHARE }) ?? unwrapped)
      : unwrapped;

  // 1c. A different story's headline appended after the body (Milliyet's
  //     related-news line and "Son dakika..." ticker; h23-live-2). Never cut
  //     the text down to nothing.
  const withoutTicker = cutAppendedTicker(out);
  if (withoutTicker.trim() !== "") out = withoutTicker;

  // 1d. A heading line on top of the body (h30-live-1), while the line breaks
  //     are still there.
  out = dropHeadingLine(out);

  // 2. Newlines (and the blanks around them) become one space. The lookbehind
  //    starts a match only at the beginning of a run of blanks, so a very long
  //    run of spaces with no newline is scanned once, not once per position.
  out = out.replace(/(?<![^\S\r\n])[^\S\r\n]*[\r\n]\s*/g, " ").trim();

  // 2b. Leading "Son dakika |" / "Son dakika haberi:" ticker and "- " marker.
  out = stripLeadingNoise(out);

  // 3. Trailing CTA, to a fixed point. "Gelişmeler şöyle: Detaylar haberimizde"
  //    would otherwise keep its colon.
  out = peelTrailingCtas(out);

  // 4. Glued sentences.
  out = out.replace(GLUED_SENTENCE, "$1$2 ");

  // 4c. Sub-heading glued onto the body (h25-live-2). A split can put a CTA
  //     behind a sentence mark, so the trailing CTA is peeled once more.
  const unglued = splitGluedHeadings(out);
  if (unglued !== out) out = peelTrailingCtas(unglued);

  // 4b. Whatever whitespace is left (double spaces, NBSP, tabs) becomes one space.
  out = out.replace(/\s+/g, " ");

  // 5.
  return out.trim();
}
