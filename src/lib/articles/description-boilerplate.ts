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
// substring matching.

/**
 * The call-to-action phrases, each lower-case and trimmed. Exported so
 * `summary-tidy.ts` can strip the same phrases as a TAIL of a longer summary;
 * this module keeps using them for the exact whole-string check below.
 *
 * "ayrıntılar birazdan" is the placeholder some feeds ship instead of a
 * description ("Ayrıntılar birazdan...", hunt 23, 3a46fc27): as a whole text it
 * is hidden here, and a capitalised "Ayrıntılar birazdan" at the end of a longer
 * text is a tail like the others.
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
 * True when `s` is, after trimming, whitespace-collapsing and stripping
 * trailing punctuation (`. … ! » › >` and spaces), exactly one of the known
 * call-to-action phrases (BOILERPLATE_PHRASES or TRAILING_CTA_PHRASES).
 * Null / undefined / blank input is `false` (the caller already hides an
 * absent description).
 */
export function isBoilerplateDescription(s: string | null | undefined): boolean {
  if (s == null) return false;
  const normalised = stripTrailingPunctuation(s.trim().replace(/\s+/g, " "));
  if (normalised === "") return false;
  // Both folds: plain lowercase turns "I" into "i" (right for the English
  // phrases), the tr-TR fold turns "I" into "ı" and "İ" into "i" (right for
  // "DEVAMI İÇİN TIKLAYIN"). Either one hitting a Set is a match.
  const plain = normalised.toLowerCase();
  const turkish = normalised.toLocaleLowerCase("tr-TR");
  return (
    BOILERPLATE_PHRASES.has(plain) ||
    BOILERPLATE_PHRASES.has(turkish) ||
    TRAILING_CTA_PHRASES.has(plain) ||
    TRAILING_CTA_PHRASES.has(turkish)
  );
}
