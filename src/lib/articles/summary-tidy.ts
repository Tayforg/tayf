import { stripFeedWrappers } from "../../../supabase/functions/_shared/cluster/description-clean";
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
//   - a leading "Son dakika |" / "Son dakika!" ticker
//   - a trailing "Detaylar haberimizde..." / "İşte ayrıntılar..." sentence
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
 * "experts want to read more" is ordinary prose.
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
      if (!/\p{Lu}/u.test(s.charAt(ctaStart))) continue;
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

/** A letter run of one character before the mark: an initial ("K."), not a sentence end. */
function endsInitial(body: string, markIndex: number): boolean {
  if (body.charAt(markIndex) !== ".") return false;
  const prev = body.charAt(markIndex - 1);
  if (!/\p{L}/u.test(prev)) return false;
  return markIndex < 2 || !/\p{L}/u.test(body.charAt(markIndex - 2));
}

/**
 * Index just after the last sentence end of `body` (the mark and any closing
 * quote), or -1. A sentence end is one of . ! ? … followed by whitespace, a
 * closing quote or bracket and then whitespace, or the end of the text. Decimals
 * ("3.5"), domains and initials ("K. Sarıgül") are not sentence ends.
 */
function lastSentenceEnd(body: string): number {
  for (let i = body.length - 1; i >= 0; i--) {
    if (!SENTENCE_MARKS.has(body.charAt(i))) continue;
    let q = i + 1;
    while (q < body.length && CLOSERS.has(body.charAt(q))) q++;
    if (q < body.length && !isBlankChar(body.charAt(q))) continue;
    if (endsInitial(body, i)) continue;
    return q;
  }
  return -1;
}

/**
 * Repair a text the ingest clamp cut: keep up to the last sentence end when
 * that keeps at least {@link CLAMP_MIN_KEPT_SHARE} of the text, else cut at the
 * last word boundary, drop dangling ", ; : – — -" and add one "…". Returns null
 * when the text is not a clamp or nothing can be cut (a single long word).
 */
function repairClamp(raw: string): string | null {
  if (!CLAMP_LENGTHS.includes(raw.length) || !raw.endsWith(CLAMP_SUFFIX)) return null;
  const body = raw.slice(0, raw.length - CLAMP_SUFFIX.length);

  const end = lastSentenceEnd(body);
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
// Leading ticker (h22-editorial-2): "Son dakika | X", "Son dakika! X", "Son
// dakika... X", "SON DAKİKA: X". Matched on the tr-TR fold (so "SON DAKİKA"
// folds to "son dakika") and cut from the original by the match length, which is
// only valid while the fold kept the length. A separator is required: "Son
// dakika golüyle ..." and "Son dakikada ..." are sentences. Same shape as
// TICKER_LINE in _shared/cluster/description-clean.ts, anchored at the start.
// ---------------------------------------------------------------------------

const LEADING_TICKER = /^son\s+dak[iı]ka(?![\p{L}\p{N}])\s*(?:\||!+|:|[.…]+)\s*/u;
const MAX_TICKER_PASSES = 2;

function stripLeadingTicker(s: string): string {
  let out = s;
  for (let pass = 0; pass < MAX_TICKER_PASSES; pass++) {
    const folded = out.toLocaleLowerCase("tr-TR");
    if (folded.length !== out.length) break; // cannot slice safely
    const match = LEADING_TICKER.exec(folded);
    if (!match) break;
    out = out.slice(match[0].length);
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
 *   2. collapse every whitespace run that contains a newline to one space;
 *   2b. strip a leading "Son dakika |" / "Son dakika!" ticker (at most
 *      {@link MAX_TICKER_PASSES} times);
 *   3. strip a trailing "Devamı için tıklayınız" / "Read more »" /
 *      "Detaylar haberimizde" / "İşte ayrıntılar" style CTA, repeatedly (at
 *      most {@link MAX_CTA_PASSES} times); a ":" the strip leaves dangling goes
 *      with it;
 *   4. put a space after a sentence mark glued to the next sentence
 *      ("kaldırıldı.Yangın" -> "kaldırıldı. Yangın"). Only a lower-case letter
 *      before the mark counts, so "T.C.", "A.Ş." and "U.S." are untouched, and
 *      the next character must be an upper-case letter, so decimals and
 *      domains ("3.5", "tayfhaber.com") are untouched;
 *   4b. collapse every whitespace run to one space;
 *   5. trim.
 *
 * Returns "" when nothing but residue was there (a footer-only text included);
 * the caller then hides the summary. Idempotent for any input with at most
 * {@link MAX_CTA_PASSES} stacked CTAs and {@link MAX_TICKER_PASSES} stacked
 * tickers, whose footer, if any, is not followed
 * by a CTA (a footer is recognised only at the very end of the text), and
 * which has no Diken-style header after its first line (the header is found
 * before the newlines are collapsed, so such a line is a header only once it
 * has become part of the first line).
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

  // 2. Newlines (and the blanks around them) become one space. The lookbehind
  //    starts a match only at the beginning of a run of blanks, so a very long
  //    run of spaces with no newline is scanned once, not once per position.
  out = out.replace(/(?<![^\S\r\n])[^\S\r\n]*[\r\n]\s*/g, " ").trim();

  // 2b. Leading "Son dakika |" ticker.
  out = stripLeadingTicker(out);

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
