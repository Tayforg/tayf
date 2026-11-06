// RSS <description> boilerplate detection.
//
// Some feeds ship a call-to-action instead of a summary ("Click to continue",
// "Devamını oku"). Rendered as an article excerpt it reads as if the outlet's
// text were that sentence. This is a pure render-time check: nothing is
// deleted from the database, and `articleExcerptEligible` (rights) is the
// separate licensing gate.
//
// Exact matching only, on purpose. A longer sentence that merely STARTS with
// the phrase ("Click to continue reading the minister's statement on ...") is
// a real, truncated summary and must keep showing. No regex fuzziness, no
// substring matching. Two shapes are matched beyond the whole text, both exact
// in the same sense (h48-ingest-1): a text of nothing but punctuation and
// whitespace ("." / "..." / "…"), and a text whose entire FIRST LINE is one of
// the phrases ("Ayrıntılar geliyor...\n\n\n\n<another story's headline>"; see
// `startsWithPlaceholderLine`).
//
// `isHeadlineEcho` is the third check of the same family: a description that
// repeats the article's own title (Korkusuz 98 %, CNN Türk 49 % of the last
// 48 h) says nothing the card does not already say.

/**
 * The call-to-action phrases, each lower-case and trimmed. Exported so
 * `summary-tidy.ts` can strip the same phrases as a TAIL of a longer summary;
 * this module keeps using them for the exact whole-string check below.
 *
 * "ayrıntılar birazdan" is the placeholder some feeds ship instead of a
 * description ("Ayrıntılar birazdan...", hunt 23, 3a46fc27): as a whole text it
 * is hidden here, and a capitalised "Ayrıntılar birazdan" at the end of a longer
 * text is a tail like the others. h48-ingest-1 added the same placeholder in its
 * other tenses, "ayrıntılar geliyor" / "ayrıntılar gelecek" and "detaylar
 * geliyor" / "detaylar gelecek" (Milliyet, Posta, Muhalif: 13 + 4 + 1 rows in
 * seven days, and the cluster summary of 620362a3).
 */
export const BOILERPLATE_PHRASES: ReadonlySet<string> = new Set([
  "click to continue",
  "click here to continue",
  "read more",
  "continue reading",
  "devamını oku",
  "devamı için tıklayın",
  "devamı için tıklayınız",
  "haberin devamı için tıklayın",
  "ayrıntılar birazdan",
  "ayrıntılar geliyor",
  "ayrıntılar gelecek",
  "detaylar geliyor",
  "detaylar gelecek",
]);

/**
 * Sentence-style call-to-action tails ("Peki, neden? Detaylar haberimizde...",
 * "... paylaşım geldi. İşte ayrıntılar...", "... sevk edildi. İşte merak edilen
 * tüm detaylar..."): the outlet's own teaser for the article behind the
 * description (hunt 22, f097fa3e and a65f404a; hunt 23, da55a291 and af529f2a).
 * Same shape as BOILERPLATE_PHRASES (tr-TR lower case, trimmed, single spaces)
 * and kept in a separate set so the older one, and the tests that pin its size,
 * stay as they were. `isBoilerplateDescription` checks both sets;
 * `summary-tidy.ts` strips the union as a TAIL of a longer summary. Only these
 * sentence-style phrases may also end a short LOWER-CASE last sentence ("...
 * başvurularına dair detaylar haberimizde."), which summary-tidy then drops
 * whole; the phrases of BOILERPLATE_PHRASES never do.
 */
export const TRAILING_CTA_PHRASES: ReadonlySet<string> = new Set([
  "detaylar haberimizde",
  "işte ayrıntılar",
  "işte detaylar",
  "işte merak edilen tüm detaylar",
  "işte tüm detaylar",
  "işte merak edilenler",
]);

// Characters a CTA may be followed by without being part of a longer text.
const TRAILING_PUNCTUATION = new Set([".", "…", "!", "»", "›", ">"]);

/** `s` without trailing whitespace and `. … ! » › >` (one pass, no regex). */
function stripTrailingPunctuation(s: string): string {
  let end = s.length;
  while (end > 0) {
    const ch = s.charAt(end - 1);
    if (TRAILING_PUNCTUATION.has(ch) || ch.trim() === "") end--;
    else break;
  }
  return s.slice(0, end);
}

/**
 * `text` (one line or the whole description) trimmed, whitespace-collapsed and
 * without trailing `. … ! » › >`, in both folds, tested against `sets`. Plain
 * lower case turns "I" into "i" (right for the English phrases), the tr-TR fold
 * turns "I" into "ı" and "İ" into "i" (right for "DEVAMI İÇİN TIKLAYIN"). Either
 * one hitting a Set is a match. Linear: one pass each for the collapse, the
 * trailing strip and the two folds.
 */
function matchesPhrase(text: string, sets: readonly ReadonlySet<string>[]): boolean {
  const normalised = stripTrailingPunctuation(text.trim().replace(/\s+/g, " "));
  if (normalised === "") return false;
  const plain = normalised.toLowerCase();
  const turkish = normalised.toLocaleLowerCase("tr-TR");
  return sets.some((set) => set.has(plain) || set.has(turkish));
}

/** Punctuation, symbols and whitespace: the characters a "description" made of nothing else is not a summary of. */
const PUNCTUATION_OR_SYMBOL_OR_BLANK = /^[\p{P}\p{S}\s]$/u;

/**
 * True when `text` is non-empty and every code point is punctuation, a symbol
 * or whitespace ("." / "…" / "..." / "- - -"; cumhuriyet and haber7 ship a lone
 * "." as the description, 19 rows in seven days). One pass, stops at the first
 * letter or digit; the pattern tests a single code point, so there is no
 * backtracking.
 */
function isPunctuationOnly(text: string): boolean {
  let seen = false;
  for (const ch of text) {
    if (!PUNCTUATION_OR_SYMBOL_OR_BLANK.test(ch)) return false;
    seen = true;
  }
  return seen;
}

/**
 * The first line is scanned over at most this many UTF-16 units. The longest
 * phrase is 28 characters; the rest is room for trailing punctuation and
 * blanks, so a longer first line cannot be a bare placeholder.
 */
const MAX_PLACEHOLDER_LINE = 120;

/**
 * True when the first non-blank line of `s` is, on its own, one of the
 * {@link BOILERPLATE_PHRASES} (same folding and trailing punctuation as
 * {@link isBoilerplateDescription}). a72f9464's summary is "Ayrıntılar
 * geliyor...\n\n\n\nKKTC Başbakanı Üstel, ... teşekkür etti": the placeholder, then
 * another story's headline pasted behind it; 2 of the 14 placeholder summaries
 * of two weeks carry such a second line (the other is "Ayrıntılar
 * birazdan...\nKaynak: TRT Haber"). The text behind a placeholder is not the outlet's summary of this
 * story, so the whole text counts as boilerplate.
 *
 * Only the line is compared, as a whole: "Ayrıntılar geliyor: Bakan Yılmaz ..."
 * is a sentence and a placeholder on a LATER line is a tail
 * (`summary-tidy.ts`). Only {@link BOILERPLATE_PHRASES} count; the
 * sentence-style {@link TRAILING_CTA_PHRASES} ("İşte detaylar") open real
 * paragraphs. Linear: one scan over the leading blanks, one bounded scan over
 * the line, no regular expression over the text.
 */
export function startsWithPlaceholderLine(s: string | null | undefined): boolean {
  if (s == null) return false;
  let start = 0;
  while (start < s.length && s.charAt(start).trim() === "") start++;
  if (start === s.length) return false;
  let end = start;
  while (end < s.length) {
    const ch = s.charAt(end);
    if (ch === "\n" || ch === "\r") break;
    end++;
    if (end - start > MAX_PLACEHOLDER_LINE) return false;
  }
  return matchesPhrase(s.slice(start, end), [BOILERPLATE_PHRASES]);
}

/**
 * True when `s` is a call-to-action stub rather than a summary:
 *   - after trimming, whitespace-collapsing and stripping trailing punctuation
 *     (`. … ! » › >` and spaces), exactly one of the known phrases
 *     (BOILERPLATE_PHRASES or TRAILING_CTA_PHRASES);
 *   - nothing but punctuation, symbols and whitespace ("." / "…" / "...");
 *   - a text whose first line is such a placeholder phrase
 *     ({@link startsWithPlaceholderLine}).
 * Null / undefined / blank input is `false` (the caller already hides an
 * absent description).
 */
export function isBoilerplateDescription(s: string | null | undefined): boolean {
  if (s == null) return false;
  const trimmed = s.trim();
  if (trimmed === "") return false;
  if (isPunctuationOnly(trimmed)) return true;
  return (
    matchesPhrase(trimmed, [BOILERPLATE_PHRASES, TRAILING_CTA_PHRASES]) ||
    startsWithPlaceholderLine(trimmed)
  );
}

// ---------------------------------------------------------------------------
// Headline echo (h48-ingest-1)
// ---------------------------------------------------------------------------

const PUNCTUATION_CHAR = /^\p{P}$/u;

/** `s` without its trailing blanks and punctuation (`. … ! ? : ) " »` ...), one backward pass. */
function stripTrailingMarks(s: string): string {
  let end = s.length;
  while (end > 0) {
    const ch = s.charAt(end - 1);
    if (ch.trim() === "" || PUNCTUATION_CHAR.test(ch)) end--;
    else break;
  }
  return s.slice(0, end);
}

/**
 * The comparison form of a title or a description: NFC, tr-TR lower case (so
 * "ISPARTA'DA" and "Isparta'da" agree, and "İZMİR" meets "İzmir"), every
 * whitespace run one blank, no trailing blanks or punctuation (an ellipsis
 * included). Linear.
 */
function echoForm(s: string): string {
  return stripTrailingMarks(s.normalize("NFC").toLocaleLowerCase("tr-TR").replace(/\s+/g, " ").trim());
}

/** True when `s` (blanks aside) ends in "…" or in three or more dots. */
function endsInEllipsis(s: string): boolean {
  const t = s.trimEnd();
  return t.endsWith("\u2026") || t.endsWith("...");
}

/**
 * True when `description` only repeats `title`: the excerpt line under a card
 * that says what the card's own headline already says. Korkusuz ships the title
 * as its description (128 of 130 rows in 48 h), CNN Türk 284 of 576, and
 * cumhuriyet, haberler.com, star and istiklal do it now and then.
 *
 * Both texts go through the same normalisation (NFC, tr-TR lower case,
 * whitespace collapsed, trailing blanks and punctuation including "..." and "…"
 * removed). The description is an echo when
 *   - the two are equal, or
 *   - the description ended in an ellipsis and, normalised, is a prefix of the
 *     title ("Bakan Yılmaz yeni vergi düzenlemesini aç..." under "Bakan Yılmaz
 *     yeni vergi düzenlemesini açıkladı"): a feed that cut the headline.
 * A description that goes on after the title is a summary, so it is never an
 * echo; neither is a prefix of the title without an ellipsis (a complete,
 * shorter text), a description that is only punctuation (nothing to compare) or
 * a null / empty either side. Linear: no nested quantifiers, no backtracking.
 */
export function isHeadlineEcho(
  title: string | null | undefined,
  description: string | null | undefined,
): boolean {
  if (title == null || description == null) return false;
  const d = echoForm(description);
  if (d === "") return false;
  const t = echoForm(title);
  if (t === "") return false;
  if (d === t) return true;
  return endsInEllipsis(description) && t.startsWith(d);
}
