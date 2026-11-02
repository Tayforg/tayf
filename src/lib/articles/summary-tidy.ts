import { BOILERPLATE_PHRASES } from "./description-boilerplate";

// Read-time tidy for feed residue in a cluster summary.
//
// clusters.summary_tr is the seed article's description verbatim, and the
// ingest tag stripper replaces every tag (<p>, <br>, <li>) with nothing, so a
// summary can carry:
//   - glued sentences        "hastaneye kaldırıldı.Yangın, Ortaköy"
//   - an outlet CTA tail     "... Sistemi (ILS)...Devamı için tıklayınız"
//   - widget heading lines   "belirtti.\nİlginizi Çekebilir\nToplantıya"
//   - raw newlines
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
    [...BOILERPLATE_PHRASES]
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

/**
 * Tidy a summary for display. Steps, in order:
 *   1. drop whole lines that are a widget heading ("İlginizi Çekebilir");
 *   2. collapse every whitespace run that contains a newline to one space;
 *   3. strip a trailing "Devamı için tıklayınız" / "Read more »" style CTA,
 *      repeatedly (at most {@link MAX_CTA_PASSES} times);
 *   4. put a space after a sentence mark glued to the next sentence
 *      ("kaldırıldı.Yangın" -> "kaldırıldı. Yangın"). Only a lower-case letter
 *      before the mark counts, so "T.C.", "A.Ş." and "U.S." are untouched, and
 *      the next character must be an upper-case letter, so decimals and
 *      domains ("3.5", "tayfhaber.com") are untouched;
 *   5. trim.
 *
 * Returns "" when nothing but residue was there; the caller then hides the
 * summary. Idempotent for any input with at most {@link MAX_CTA_PASSES}
 * stacked CTAs.
 */
export function tidySummaryText(s: string): string {
  // 1. Widget heading lines.
  let out = s
    .split(/\r?\n/)
    .filter((line) => !isWidgetLine(line))
    .join("\n");

  // 2. Newlines (and the blanks around them) become one space. The lookbehind
  //    starts a match only at the beginning of a run of blanks, so a very long
  //    run of spaces with no newline is scanned once, not once per position.
  out = out.replace(/(?<![^\S\r\n])[^\S\r\n]*[\r\n]\s*/g, " ").trim();

  // 3. Trailing CTA, to a fixed point.
  for (let pass = 0; pass < MAX_CTA_PASSES; pass++) {
    const stripped = stripTrailingCta(out);
    if (stripped === null) break;
    out = stripped;
  }

  // 4. Glued sentences.
  out = out.replace(/([a-zçğıöşü])([.!?…])(?=[A-ZÇĞİÖŞÜ])/gu, "$1$2 ");

  // 5.
  return out.trim();
}
