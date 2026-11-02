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
//                            appeared first on #site_linkat 02.11.2026 ." (Diken)
//                            and "<body>\n<title> yazısı ilk önce Serbestiyet
//                            adresinde yayınlanmıştır." (Serbestiyet)
//   - raw newlines
//   - a text the ingest clamp cut mid-word (500 characters ending "...")
//   - a leading "Son dakika |" / "Son dakika haberi:" ticker and a leading
//     list marker ("- ", "• ", "▪️ ")
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
/** A sentence-end cut must keep at least this share of the clamped text. */
const CLAMP_MIN_KEPT_SHARE = 0.6;
const SENTENCE_MARKS = new Set([".", "!", "?", "…"]);
/** Quotes and brackets that may close a sentence right after its mark. */
const CLOSERS = new Set(['"', "”", "»", "’", "'", ")", "]"]);
/** Dangling punctuation a word cut must not leave in front of the ellipsis. */
const CLAMP_DANGLING = new Set([",", ";", ":", "–", "—", "-"]);

function isBlankChar(ch: string): boolean {
  return ch.trim() === "";
}

// Title and street abbreviations that end in a dot without ending the sentence
// ("Prof. Dr. Gönül Paçacı", "Öğr. Gör. Ali", "Atatürk Cad. No. 5"). Compared on
// the tr-TR fold of the whole letter run before the dot.
const NON_SENTENCE_ABBREVIATIONS: ReadonlySet<string> = new Set([
  "dr", "prof", "doç", "doc", "av", "op", "uzm", "yrd", "öğr", "arş", "gör",
  "org", "korg", "tümg", "tuğg", "alb", "sn", "mah", "cad", "sok", "no", "vs",
  "vb", "bkz", "örn",
]);
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
 *   - a title or street abbreviation ({@link NON_SENTENCE_ABBREVIATIONS}), as a
 *     whole word ("Prof.", "DR.", but not "abcdr.").
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
  return NON_SENTENCE_ABBREVIATIONS.has(run.toLocaleLowerCase("tr-TR"));
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
 * disjoint) are not sentence ends.
 */
function lastSentenceEnd(body: string, skip: readonly SkipRange[] = []): number {
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
    return q;
  }
  return -1;
}

/**
 * Repair a text the ingest clamp cut. When the clamped text holds an appended
 * ticker ({@link cutAppendedTicker}: another story's headline, never ours) the
 * repair is that cut, whatever share it keeps and with no "…". Otherwise keep up
 * to the last sentence end when that keeps at least {@link CLAMP_MIN_KEPT_SHARE}
 * of the text, else cut at the last word boundary, drop dangling ", ; : – — -"
 * and add one "…". Returns null when the text is not a clamp or nothing can be
 * cut (a single long word).
 */
function repairClamp(raw: string): string | null {
  if (!CLAMP_LENGTHS.includes(raw.length) || !raw.endsWith(CLAMP_SUFFIX)) return null;
  const body = raw.slice(0, raw.length - CLAMP_SUFFIX.length);

  const withoutTicker = cutAppendedTicker(body);
  if (withoutTicker !== body && withoutTicker.trim() !== "") return withoutTicker.trimEnd();

  const end = lastSentenceEnd(body, unpunctuatedLineRanges(body));
  if (end > 0) {
    const kept = body.slice(0, end).trimEnd();
    if (kept.length >= CLAMP_MIN_KEPT_SHARE * body.length) return kept;
  }

  let cut = body.trimEnd();
  if (cut.length === body.length) {
    // The clamp fell inside a word: drop it.
    let at = body.length - 1;
    while (at >= 0 && !isBlankChar(body.charAt(at))) at--;
    if (at <= 0) return null;
    cut = body.slice(0, at);
  }
  let stop = cut.length;
  while (stop > 0 && (CLAMP_DANGLING.has(cut.charAt(stop - 1)) || isBlankChar(cut.charAt(stop - 1)))) stop--;
  cut = cut.slice(0, stop);
  if (cut === "") return null;
  return SENTENCE_MARKS.has(cut.charAt(cut.length - 1)) ? cut : cut + "…";
}

// ---------------------------------------------------------------------------
// Leading noise (h22-editorial-2, h23-live-1): a ticker ("Son dakika | X", "Son
// dakika! X", "Son dakika... X", "SON DAKİKA: X", "Son dakika haberi: X", "Son
// dakika haberine göre; X") and a list marker ("- X", "• X", "▪️ X"). The ticker
// is matched on the tr-TR fold (so "SON DAKİKA" folds to "son dakika") and cut
// from the original by the match length, which is only valid while the fold kept
// the length. A separator is required: "Son dakika golüyle ...", "Son dakikada
// ..." and "Son dakika haberi olarak duyuruldu" are sentences. Same shape as
// TICKER_LINE in _shared/cluster/description-clean.ts, anchored at the start.
// A marker needs blanks after it: "-5 derece" and "•madde" are text.
// ---------------------------------------------------------------------------

const LEADING_TICKER =
  /^son\s+dak[iı]ka(?:\s+haber(?:i|ine\s+g[öo]re))?(?![\p{L}\p{N}])\s*(?:\||!+|:|;|[.…]+)\s*/u;
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
 * Peel leading tickers and list markers, in whatever order they come ("Son
 * dakika | - X", "- Son dakika: X"), to a fixed point bounded by
 * {@link MAX_TICKER_PASSES} tickers and {@link MAX_MARKER_PASSES} markers.
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
  return out;
}

/** `s` without a trailing ":" (and the blanks around it), left by a stripped CTA. */
function dropDanglingColon(s: string): string {
  let end = s.length;
  while (end > 0 && (s.charAt(end - 1) === ":" || isBlankChar(s.charAt(end - 1)))) end--;
  return s.slice(0, end);
}

/**
 * Tidy a summary for display. Steps, in order:
 *   0. repair a text the ingest clamp cut ({@link repairClamp}); keyed on the
 *      raw input, so it runs before anything changes the length;
 *   1. drop whole lines that are a widget heading ("İlginizi Çekebilir");
 *   1b. strip the Diken header ("<title> dd.mm.yyyy Diken") and the WordPress /
 *      Yoast footers ("The post ... appeared first on ...", "... yazısı ilk
 *      önce ... adresinde yayınlanmıştır.") with {@link stripFeedWrappers},
 *      the same function the cluster consumer applies to the clustering text.
 *      It runs here, while the newlines are still present, because a footer
 *      starts at a line boundary;
 *   1c. cut an appended ticker and the related-news lines in front of it with
 *      {@link cutAppendedTicker} (Milliyet: "...hazırız\nSon dakika... Rusya
 *      için 3 fırsat!"), also while the newlines are present. A cut that would
 *      leave nothing is not made, so a text that is only "\nSon dakika... X"
 *      still shows its X;
 *   2. collapse every whitespace run that contains a newline to one space;
 *   2b. peel leading noise: a "Son dakika |" / "Son dakika haberi:" / "Son dakika
 *      haberine göre;" ticker (at most {@link MAX_TICKER_PASSES} in total) and a
 *      list marker "- " / "• " / "▪️ " (at most {@link MAX_MARKER_PASSES} in
 *      total), in either order;
 *   3. strip a trailing "Devamı için tıklayınız" / "Read more »" /
 *      "Detaylar haberimizde" / "İşte ayrıntılar" / "İşte merak edilen tüm
 *      detaylar" / "Ayrıntılar birazdan" style CTA, repeatedly (at most
 *      {@link MAX_CTA_PASSES} times); a sentence-style CTA that ends a short
 *      lower-case last sentence takes that sentence with it; a ":" the strip
 *      leaves dangling goes with it;
 *   4. put a space after a sentence mark glued to the next sentence
 *      ("kaldırıldı.Yangın" -> "kaldırıldı. Yangın"). Only a lower-case letter
 *      before the mark counts, so "T.C.", "A.Ş." and "U.S." are untouched, and
 *      the next character must be an upper-case letter, so decimals and
 *      domains ("3.5", "tayfhaber.com") are untouched;
 *   4b. collapse every whitespace run to one space;
 *   5. trim.
 *
 * Step 0 repairs a clamp with {@link cutAppendedTicker} first: foreign text is
 * never kept, so a clamped text that holds a ticker line ends where the ticker
 * block starts, with no "…".
 *
 * Returns "" when nothing but residue was there (a footer-only text included);
 * the caller then hides the summary. Idempotent for any input with at most
 * {@link MAX_CTA_PASSES} stacked CTAs, {@link MAX_TICKER_PASSES} stacked
 * tickers and {@link MAX_MARKER_PASSES} stacked list markers, whose footer, if
 * any, is not followed by a CTA (a footer is recognised only at the very end of
 * the text), and which has no Diken-style header after its first line (the
 * header is found before the newlines are collapsed, so such a line is a header
 * only once it has become part of the first line).
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
  out = stripFeedWrappers(out);

  // 1c. A different story's headline appended after the body (Milliyet's
  //     related-news line and "Son dakika..." ticker; h23-live-2). Never cut
  //     the text down to nothing.
  const withoutTicker = cutAppendedTicker(out);
  if (withoutTicker.trim() !== "") out = withoutTicker;

  // 2. Newlines (and the blanks around them) become one space. The lookbehind
  //    starts a match only at the beginning of a run of blanks, so a very long
  //    run of spaces with no newline is scanned once, not once per position.
  out = out.replace(/(?<![^\S\r\n])[^\S\r\n]*[\r\n]\s*/g, " ").trim();

  // 2b. Leading "Son dakika |" / "Son dakika haberi:" ticker and "- " marker.
  out = stripLeadingNoise(out);

  // 3. Trailing CTA, to a fixed point. "Gelişmeler şöyle: Detaylar haberimizde"
  //    would otherwise keep its colon.
  for (let pass = 0; pass < MAX_CTA_PASSES; pass++) {
    const stripped = stripTrailingCta(out);
    if (stripped === null) break;
    out = dropDanglingColon(stripped);
  }

  // 4. Glued sentences.
  out = out.replace(/([a-zçğıöşü])([.!?…])(?=[A-ZÇĞİÖŞÜ])/gu, "$1$2 ");

  // 4b. Whatever whitespace is left (double spaces, NBSP, tabs) becomes one space.
  out = out.replace(/\s+/g, " ");

  // 5.
  return out.trim();
}
