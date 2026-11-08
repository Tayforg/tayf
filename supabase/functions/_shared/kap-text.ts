// supabase/functions/_shared/kap-text.ts
//
// h81-textclean-1: KAP's own notice feed loses the apostrophe that joins a Turkish
// suffix to a proper noun and leaves a literal '?' in its place ("Irak
// Cumhuriyeti?ndeki", "ABD?deki", "A.Ş.?nin", "Moody?s"). The raw KAP payload has
// it too, so the loss is upstream of Tayf: 845 of 210,954 stored
// kap_disclosures.summary rows carry it (subject: none), and /ekonomi/<ticker>
// printed it as text.
//
// Ingest and the stored row stay verbatim (the `raw` payload, and every Jev input,
// are unchanged). The repair runs at READ time, in the finance query's
// toDisclosure, so rows that are already stored heal without a backfill.
//
// This module is pure and has no imports, so it loads unchanged under Deno,
// vitest and Next (the same arrangement as rss/entities.ts).

/**
 * One regex, two alternatives, scanned left to right in a single linear pass.
 *
 *   1. A URL token (`http(s)://...` or `www....` up to the next whitespace) is
 *      matched only so that it is passed through: a query string such as
 *      `?id=5` or `?utm_source=a` must never become an apostrophe. (No stored
 *      summary holds a URL today; this is a guard, not a repair.) There is no
 *      `i` flag: under `/iu`, `\p{Ll}` also matches capitals, so the scheme and
 *      the `www` are spelled with explicit case classes instead.
 *
 *   2. The lost apostrophe: a '?' glued on the left to a letter, a digit, a '.'
 *      (the end of an abbreviation, "A.Ş.?nin") or a '%' ("%15?e"), and on the
 *      right to a lowercase word of 1-12 letters that ends where the word ends
 *      (the 906 stored cases span 53 distinct suffix runs, the longest 8 letters:
 *      nin, nın, nun, na, da, de, ya, ye, nda, nde, deki, lık, lu, inciliği ...).
 *      A capital or a digit after the word, or a longer word, means it is not a
 *      suffix, so the '?' stays. The lookahead is bounded (at most 12 steps), so
 *      the scan stays linear.
 *
 * Not touched, on purpose: a real question mark ("Neden?", "Ne oldu? Evet", "??"),
 * "X?Y" (a capital after the '?'), and the shapes KAP loses differently: a space
 * on either side ("A.Ş ?nin", "A.Ş.? nin"), a closing bracket ("(II-52.1)?nin"),
 * an all-capitals suffix ("KURULU?NUN") and a dash ("01.01.2023 ? 31.12.2023").
 */
const KAP_TEXT = /([Hh][Tt][Tt][Pp][Ss]?:\/\/\S+|[Ww][Ww][Ww]\.\S+)|(?<=[\p{L}\p{N}.%])\?(?=\p{Ll}{1,12}(?![\p{L}\p{N}]))/gu;

/** U+2019, the apostrophe the rest of the site's Turkish copy uses ("Tayf’ın"). */
const APOSTROPHE = "’";

/**
 * Repairs the suffix apostrophe KAP lost (see the regex above), then collapses a
 * run of two or more spaces or tabs to one space (KAP pads some summaries with up
 * to ~70 of them). Newlines are kept. Null in, null out.
 */
export function repairKapApostrophe(text: string | null): string | null {
  if (typeof text !== "string") return null;
  return text
    .replace(KAP_TEXT, (match, url: string | undefined) => (url === undefined ? APOSTROPHE : match))
    .replace(/[ \t]{2,}/g, " ");
}
