// In-feed filter for the home search box. Pure (it imports only turkish-query and
// search-aliases, which are pure too) so it can be unit-tested (and reused)
// without pulling Supabase or React in.
//
// Rule: every query token must occur at a WORD START in the cluster title.
//   - order-free:   "Erdoğan Cumhurbaşkanı" finds "Cumhurbaşkanı Erdoğan ..."
//   - prefix:       "ak" finds "AK Parti ..." and "Akşener ...", but not
//                   "Başbakan" or "dakikaya" (a plain substring match did)
//   - tr casing:    "ISTANBUL" finds "İstanbul'da ..." (dotted/dotless i fold)
//   - lenient:      quotes, a standalone `or` and -negated words are ignored
//                   (the archive RPC interprets them; this filter only has to
//                   show what is already on the page), and an apostrophe
//                   suffix typed by the reader is dropped ("Erdoğan'ın" ->
//                   "erdogan" after folding). Only a TURKISH suffix is
//                   dropped (turkish-query.ts isTurkishSuffixTail), so "Kur'an",
//                   "O'Brien" and "L'Oréal" stay whole, as they do in the
//                   archive query. A dash between words is a separator.
//   - aliases:      "AKP" also finds "AK Parti ..." and the reverse
//                   (search-aliases.ts), exactly when the archive expands the
//                   same query, so the cards and the archive section agree.
//
// Diacritics are folded the same way as the archive RPC's tayf_search_fold
// (migration 129; foldTr is its TypeScript twin), so ASCII "erdogan" finds
// "Erdoğan" in the feed and the in-feed cards agree with the archive section
// below them about what a query means. Folding is applied to the query tokens
// and to the title alike; the word-start rule is unchanged.

import { aliasTermForms, expandAliasQuery } from "./search-aliases";
import {
  canonicalSearchQuery,
  cleanQueryUnicode,
  foldTr,
  isTurkishSuffixTail,
} from "./turkish-query";

const MIN_TOKEN_LENGTH = 2;

// The typographic apostrophes the reader or a headline may use for '.
const APOSTROPHE_VARIANTS = /[\u2019\u02bc\u2018]/g;

/**
 * Turkish-aware comparison key: NFKC without format characters (cleanQueryUnicode:
 * NFD 'ş', zero-width characters and full-width letters read like their plain
 * spelling), the typographic apostrophes mapped to ', tr-lowercase, then the
 * archive fold (foldTr: ğ ş ç ö ü ı İ â î û -> ASCII, U+0307 dropped). The
 * explicit U+0307 removal stays for clarity; foldTr already deletes it. The
 * apostrophe map is what lets the query "Kur'an" find a title spelled "Kur’an".
 */
function matchKey(s: string): string {
  return foldTr(
    cleanQueryUnicode(s)
      .replace(APOSTROPHE_VARIANTS, "'")
      .toLocaleLowerCase("tr"),
  ).replace(/\u0307/g, "");
}

const LETTER = /^\p{L}$/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

function isApostrophe(ch: string): boolean {
  return ch === "'" || ch === "\u2019" || ch === "\u02bc" || ch === "\u2018";
}

// A suffix tail is at most 12 letters (isTurkishSuffixTail), so the walk back
// over the trailing letters looks at 13 at most: a longer tail is never cut.
const TAIL_SCAN_LIMIT = 13;

/**
 * Cuts an apostrophe and the Turkish suffix after it off the END of a word:
 * "Erdoğan'ın" -> "Erdoğan", "CHP'liler" -> "CHP", "Erdoğan'" -> "Erdoğan". A tail
 * that is not a suffix stays ("Kur'an", "O'Brien", "L'Oréal"). The apostrophe
 * is looked for from the end by a bounded character walk, so a long run of
 * apostrophes or letters costs nothing extra.
 */
function cutApostropheSuffix(word: string): string {
  let i = word.length;
  const stop = Math.max(0, word.length - TAIL_SCAN_LIMIT);
  // U+02BC is an apostrophe AND a letter: the apostrophe test comes first.
  while (i > stop && !isApostrophe(word[i - 1]!) && LETTER.test(word[i - 1]!)) i--;
  if (i === 0 || !isApostrophe(word[i - 1]!)) return word;
  const tail = word.slice(i);
  return tail === "" || isTurkishSuffixTail(tail) ? word.slice(0, i - 1) : word;
}

/**
 * Trims every leading and trailing character that is not a letter or digit. Two
 * indices walk in from the ends, one code point per step, so the cost is linear
 * (an anchored trailing-run regex retries from every position of a long run).
 */
function trimNonWordEdges(word: string): string {
  const points = Array.from(word);
  let start = 0;
  let end = points.length;
  while (start < end && !LETTER_OR_DIGIT.test(points[start]!)) start++;
  while (end > start && !LETTER_OR_DIGIT.test(points[end - 1]!)) end--;
  return start === 0 && end === points.length ? word : points.slice(start, end).join("");
}

/**
 * Query text -> match keys. Cleans the Unicode first (NFKC, format characters
 * out, so a zero-width or full-width mark cannot hide a word or a leading '-'),
 * strips `"`, drops a standalone `or` and `-negated` tokens, cuts an apostrophe
 * followed by a Turkish suffix, trims leading/trailing non-letter/digit
 * characters, drops keys shorter than 2 characters and dedupes. A dash on its
 * own ("erdoğan - bahçeli", "trump <-> iran") is a separator: it is trimmed to
 * nothing and the words on both sides stay. Returns [] when nothing usable is
 * left.
 */
export function searchTokens(q: string): string[] {
  const keys = new Set<string>();
  for (const raw of cleanQueryUnicode(q).replace(/"/g, "").split(/\s+/)) {
    if (raw === "" || raw.startsWith("-")) continue;
    const word = trimNonWordEdges(cutApostropheSuffix(raw));
    if (word.toLowerCase() === "or") continue;
    const key = matchKey(word);
    if (key.length >= MIN_TOKEN_LENGTH) keys.add(key);
  }
  return [...keys];
}

/**
 * The token lists a title may match for the query `q`: `searchTokens(q)` first,
 * then, when the archive would expand the same query (an alias like AKP / AK Parti
 * and no quote, negation or `or`; search-aliases.ts), the token list with the
 * alias spelled the other way. A card shows when `titleMatchesTokens` holds for
 * ANY of them. Whether to expand is decided on `canonicalSearchQuery(q)`, the
 * string the archive expands, so the two paths cannot disagree.
 */
export function searchTokenAlternatives(q: string): string[][] {
  const tokens = searchTokens(q);
  if (expandAliasQuery(canonicalSearchQuery(q)) === null) return [tokens];
  const forms = aliasTermForms(tokens);
  if (forms === null) return [tokens];
  const own = tokens.join(" ");
  return [tokens, ...forms.filter((form) => form.join(" ") !== own)];
}

/** True when `index` is the first character or follows a non-letter/digit. */
function atWordStart(key: string, index: number): boolean {
  if (index === 0) return true;
  // Last code point before `index` (a surrogate pair is one character).
  const prev = Array.from(key.slice(Math.max(0, index - 2), index)).pop() ?? "";
  return !LETTER_OR_DIGIT.test(prev);
}

function hasWordStartOccurrence(haystack: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    if (atWordStart(haystack, at)) return true;
    from = at + 1;
  }
}

/**
 * True when every token starts a word of `title`. An empty token list never
 * matches (a query that reduces to nothing, e.g. "-ak", shows no in-feed
 * cards rather than the whole feed). Tokens come from `searchTokens` but are
 * re-keyed here, so passing raw lowercase words works too.
 */
export function titleMatchesTokens(
  title: string,
  tokens: readonly string[],
): boolean {
  if (tokens.length === 0) return false;
  const key = matchKey(title);
  return tokens.every((token) => {
    const needle = matchKey(token);
    return needle !== "" && hasWordStartOccurrence(key, needle);
  });
}

/**
 * Heading of the archive section. The search RPC returns at most a fixed
 * number of ids, ranked by relevance; when it returned that many, the list is
 * the best matches rather than all of them, and the heading says so.
 */
export function archiveHeading(count: number, capped: boolean): string {
  return capped
    ? `Arşivden: en ilgili ${count} sonuç`
    : `Arşivden: ${count} sonuç`;
}
