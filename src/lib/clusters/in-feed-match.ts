// In-feed filter for the home search box. Pure (its only import, turkish-query,
// has no imports itself) so it can be unit-tested (and reused) without pulling
// Supabase or React in.
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
//                   "erdogan" after folding).
//
// Diacritics are folded the same way as the archive RPC's tayf_search_fold
// (migration 129; foldTr is its TypeScript twin), so ASCII "erdogan" finds
// "Erdoğan" in the feed and the in-feed cards agree with the archive section
// below them about what a query means. Folding is applied to the query tokens
// and to the title alike; the word-start rule is unchanged.

import { foldTr } from "./turkish-query";

const MIN_TOKEN_LENGTH = 2;

/**
 * Turkish-aware comparison key: NFC, tr-lowercase, then the archive fold
 * (foldTr: ğ ş ç ö ü ı İ â î û -> ASCII, U+0307 dropped). The explicit U+0307
 * removal stays for clarity; foldTr already deletes it.
 */
function matchKey(s: string): string {
  return foldTr(s.normalize("NFC").toLocaleLowerCase("tr")).replace(
    /\u0307/g,
    "",
  );
}

const APOSTROPHE_SUFFIX = /['’ʼ‘]\p{L}*$/u;
const EDGE_NON_WORD = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * Query text -> match keys. Strips `"`, drops a standalone `or` and
 * `-negated` tokens, cuts an apostrophe suffix, trims leading/trailing
 * non-letter/digit characters, drops keys shorter than 2 characters and
 * dedupes. Returns [] when nothing usable is left.
 */
export function searchTokens(q: string): string[] {
  const keys = new Set<string>();
  for (const raw of q.replace(/"/g, "").split(/\s+/)) {
    if (raw === "" || raw.startsWith("-")) continue;
    const word = raw.replace(APOSTROPHE_SUFFIX, "").replace(EDGE_NON_WORD, "");
    if (word.toLowerCase() === "or") continue;
    const key = matchKey(word);
    if (key.length >= MIN_TOKEN_LENGTH) keys.add(key);
  }
  return [...keys];
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
