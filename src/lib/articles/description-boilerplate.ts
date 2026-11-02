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
]);

/**
 * True when `s` is, after trimming, whitespace-collapsing and stripping
 * trailing punctuation (`. … ! » › >` and spaces), exactly one of the known
 * call-to-action phrases. Null / undefined / blank input is `false` (the
 * caller already hides an absent description).
 */
export function isBoilerplateDescription(s: string | null | undefined): boolean {
  if (s == null) return false;
  const normalised = s
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[\s.…!»›>]+$/, "");
  if (normalised === "") return false;
  // Both folds: plain lowercase turns "I" into "i" (right for the English
  // phrases), the tr-TR fold turns "I" into "ı" and "İ" into "i" (right for
  // "DEVAMI İÇİN TIKLAYIN"). Either one hitting the Set is a match.
  return (
    BOILERPLATE_PHRASES.has(normalised.toLowerCase()) ||
    BOILERPLATE_PHRASES.has(normalised.toLocaleLowerCase("tr-TR"))
  );
}
