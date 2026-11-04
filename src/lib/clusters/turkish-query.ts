// Turkish-aware search-query normalisation, pure (no Supabase, no Next
// cache directive) so it is directly unit-testable and shareable between
// search-query.ts and the 083 migration's `search_cluster_ids` RPC — the
// three variants produced here are exactly the three lexeme spellings the
// GIN index (migration 035's `search_tsv`, generated via
// `to_tsvector('turkish', ...)`) can hold for one Turkish dotted/dotless
// "i" word, because Postgres's `lower()` runs under the DB's en_US.UTF-8
// collation, NOT a Turkish one:
//
//   - 'IŞIK' (all caps)  -> en_US lower() -> 'işik' (dotted i, both I's)
//   - 'Işık' (title case) -> en_US lower() -> 'işık' (dotted first i, ş,
//     then ASCII 'I' from the *second* character never being touched by
//     the earlier uppercase step keeps its Turkish form) -- see Q2 in the
//     083 migration header for the measured triple.
//   - 'ışık' (already lower, Turkish dotless ı) -> en_US lower() is a
//     no-op on non-ASCII -> 'ışık'
//
// `turkishQueryVariants` reproduces those three spellings from a single
// reader-typed query by round-tripping through `toLocaleUpperCase('tr')`
// / `toLocaleLowerCase('tr')` (which DO know the Turkish casing rules) and
// then folding ASCII/Turkish "I" variants the same way Postgres's en_US
// lower() would, via `pgLower`.
export const MAX_QUERY_VARIANTS = 3;

/**
 * Emulates Postgres's en_US.UTF-8 `lower()` for the one letter whose
 * casing differs between the "C"/en_US collation and Turkish: ASCII `I`
 * and dotted capital `İ` both fold to dotted lowercase `i` under en_US,
 * never to Turkish dotless `ı`. Every other letter (ı, ş, ğ, ü, ö, ç
 * included) already round-trips correctly through a plain
 * `toLocaleLowerCase('tr')` because en_US lower() leaves non-ASCII
 * letters untouched and Turkish lower() agrees with it there.
 */
export function pgLower(s: string): string {
  return s.replace(/[İI]/g, "i").toLocaleLowerCase("tr");
}

/** Upper-cases (Turkish rules) the first `\p{L}` letter in `token`,
 * leaving any leading non-letter characters (a leading '-', an opening
 * quote, …) untouched. */
function titleCaseToken(token: string): string {
  const lower = token.toLocaleLowerCase("tr");
  const match = lower.match(/\p{L}/u);
  if (!match || match.index === undefined) return lower;
  const idx = match.index;
  const upper = lower[idx]!.toLocaleUpperCase("tr");
  return lower.slice(0, idx) + upper + lower.slice(idx + 1);
}

/** Title-cases every whitespace-separated token of `s` using Turkish
 * casing rules. Whitespace runs are preserved verbatim (split via a
 * capturing regex) so multi-space input isn't collapsed. */
export function titleCaseTr(s: string): string {
  return s
    .split(/(\s+)/)
    .map((part) => (/^\s+$/.test(part) ? part : titleCaseToken(part)))
    .join("");
}

/**
 * Produces up to `MAX_QUERY_VARIANTS` distinct lexeme spellings for a
 * reader-typed query, so a search for 'IŞIK' matches clusters whose
 * `search_tsv` stored the lexeme under any of the three en_US-lower()
 * spellings a Turkish "I" can take. Returns `[]` for whitespace-only
 * input (nothing to search for).
 */
export function turkishQueryVariants(q: string): string[] {
  const t = q.trim();
  if (t.length === 0) return [];

  const candidates = [
    t.toLocaleLowerCase("tr"),
    pgLower(t.toLocaleUpperCase("tr")),
    pgLower(titleCaseTr(t)),
  ];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    if (c.length === 0) continue;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    if (out.length >= MAX_QUERY_VARIANTS) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Archive-search fold + query normalisation (migration 129).
//
// `turkishQueryVariants` above only reproduces the three spellings that the
// en_US lower() can leave in the stored `search_tsv`, and it keeps Turkish
// letters. A reader typing ASCII ('sisli', 'cumhurbaskani', 'imamoglu', 'ozel')
// therefore matched nothing. Migration 129 adds a second, folded index over
// `tayf_search_fold(title_tr_neutral || title_tr || summary_tr)`; `foldTr` is
// the TypeScript twin of that SQL function and builds the `p_folded` argument.
//
// The fold is the house fold of migrations 112/125/126 (rising-entities.ts'
// RISING_FOLD_FROM/TO): translate first, then lower. The SQL lower() runs under
// `collate "C"`, which only touches ASCII, so it does not depend on the
// database locale and the function is honestly IMMUTABLE. `foldTr` mirrors it
// exactly: map each character, drop U+0307 (combining dot above, what
// translate() deletes because chr(775) has no counterpart in TO), lowercase
// A-Z only. tests/migrations/129-search-fold-rank.test.ts pins the parity.
//
// The two strings are literals (not imported) so this module stays free of the
// trends vocabulary (rising-entities.ts); turkish-query.test.ts asserts they
// equal RISING_FOLD_FROM / RISING_FOLD_TO.
// ---------------------------------------------------------------------------

/** Turkish and circumflex letters that fold to ASCII (same as RISING_FOLD_FROM). */
export const SEARCH_FOLD_FROM = "İIıŞşĞğÜüÖöÇçÂâÎîÛû";
/** ASCII targets, same code-point length as SEARCH_FOLD_FROM (same as RISING_FOLD_TO). */
export const SEARCH_FOLD_TO = "iiissgguuooccaaiiuu";

const FOLD_MAP: ReadonlyMap<string, string> = new Map(
  [...SEARCH_FOLD_FROM].map((from, i) => [from, [...SEARCH_FOLD_TO][i] as string]),
);

/**
 * TypeScript twin of the SQL `public.tayf_search_fold(text)`:
 * `lower(translate(s, FROM || chr(775), TO) collate "C")`. Turkish letters map
 * to their ASCII base, U+0307 is deleted, and only ASCII A-Z is lower-cased
 * (so `É` stays `É`, as it does under the C collation).
 */
export function foldTr(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === "\u0307") continue;
    const mapped = FOLD_MAP.get(ch) ?? ch;
    out += mapped >= "A" && mapped <= "Z" ? mapped.toLowerCase() : mapped;
  }
  return out;
}

// C0 controls (U+0000-U+001F) and DEL + C1 controls (U+007F-U+009F), plus
// UTF-16 surrogates that are not part of a pair. Postgres rejects U+0000
// outright (the whole RPC fails and the page used to show a false "zaman
// aşımı") and a lone surrogate does not survive the JSON body either.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

// A Turkish case suffix is written after an apostrophe: Erdoğan'ın, Özel'den,
// Bahçeli'nin. The stored titles carry the bare name (or the suffixed form
// without the apostrophe), so the apostrophe and the suffix after a letter are
// cut. The class covers ' (U+0027), ’ (U+2019), ʼ (U+02BC) and ‘ (U+2018).
const APOSTROPHE_SUFFIX = /(?<=\p{L})['\u2019\u02bc\u2018]\p{L}*/gu;

/**
 * Cleans a reader-typed archive-search query before it is cached, folded or
 * sent to Postgres:
 *   1. control characters and lone surrogates become a space;
 *   2. an apostrophe suffix after a letter is dropped (Erdoğan'ın -> Erdoğan);
 *   3. whitespace runs collapse and the ends are trimmed.
 * Double quotes (phrase search) and every other character are kept.
 * Applied only by `searchClusters`: `turkishQueryVariants` stays unchanged
 * because entity-hub passes curated apostrophe inflections through it.
 */
export function normaliseSearchQuery(q: string): string {
  return q
    .replace(UNSAFE_CHARS, " ")
    .replace(APOSTROPHE_SUFFIX, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Canonical search query: the cache key and the RPC input of the home search
// (h30-abuse-1).
//
// `searchClusters` used to key its cache on `normaliseSearchQuery(q)`, so
// 'Erdoğan', 'ERDOĞAN!', ' erdoğan ' and 'erdoğan.' were four cache entries and
// four 0.4-0.5 s `search_cluster_ids` RPCs for one search, and a 200-character
// 40-word query was a fifth. `canonicalSearchQuery` collapses a case and
// punctuation family to ONE string and bounds its size before the key is built.
//
// There is deliberately NO Turkish fold here. `p_variants` is built from this
// string by `turkishQueryVariants`, which already lower-cases, upper-cases and
// title-cases it internally, and `foldTr` maps İ/I/ı to i, so lower-casing with
// the Turkish rules first leaves BOTH RPC arguments byte-identical to what the
// un-canonicalised query produced (turkish-query.test.ts pins that parity).
// Folding the key to ASCII would change them: the `search_tsv` arm would lose
// its Turkish-letter lexemes, and a quoted '"Devlet Bahçeli"' would reach the
// folded arm as a plain AND query (migration 129 drops phrases there). So
// 'erdogan' (ASCII) and 'erdoğan' stay two keys on purpose: their results
// already differ today.
// ---------------------------------------------------------------------------

/** The most terms (whitespace-separated words) the archive search keeps. */
export const MAX_SEARCH_TERMS = 6;
/** The longest canonical query, in UTF-16 code units (never ends in half an emoji). */
export const MAX_SEARCH_QUERY_LENGTH = 64;

// One code point at a time: an emoji is a single \p{S} code point but two
// UTF-16 units, so testing a code unit would never match it.
const EDGE_PUNCTUATION = /^[\p{P}\p{S}]$/u;

// '"' opens or closes a phrase and '-' negates a term (Postgres
// websearch_to_tsquery reads both), so they are kept at a term's edge.
function isStrippableEdge(ch: string): boolean {
  return ch !== '"' && ch !== "-" && EDGE_PUNCTUATION.test(ch);
}

/**
 * Cuts leading and trailing punctuation/symbols off one term. Two indices walk
 * in from the ends, one code point per step, so the cost is linear in the term
 * (an anchored `[\p{P}\p{S}]+$` regex is quadratic on a long run that is not at
 * the end, and CodeQL flags it).
 */
function stripEdgePunctuation(term: string): string {
  const points = Array.from(term);
  let start = 0;
  let end = points.length;
  while (start < end && isStrippableEdge(points[start]!)) start++;
  while (end > start && isStrippableEdge(points[end - 1]!)) end--;
  return start === 0 && end === points.length ? term : points.slice(start, end).join("");
}

/**
 * The cache key and RPC input for a reader-typed archive-search query:
 *   1. `normaliseSearchQuery` (controls out, apostrophe suffix dropped,
 *      whitespace collapsed);
 *   2. Turkish lower-casing ('IŞIK', 'Işık', 'ışık' -> 'ışık');
 *   3. punctuation and symbols cut off both edges of every term, so
 *      'ERDOĞAN!', '“Erdoğan”' and 'Erdoğan.' share a key; a leading '-' and
 *      the double quote of a phrase search are kept;
 *   4. terms left empty are dropped and only the first MAX_SEARCH_TERMS kept;
 *   5. the whole is cut to MAX_SEARCH_QUERY_LENGTH without leaving half a
 *      surrogate pair, and the cut term's edge is stripped again.
 * Pure, idempotent and linear in the input. '' means "nothing to search for".
 * No Turkish fold (see the header above): the RPC arguments do not change.
 */
export function canonicalSearchQuery(q: string): string {
  const terms: string[] = [];
  for (const raw of normaliseSearchQuery(q).toLocaleLowerCase("tr").split(" ")) {
    const term = stripEdgePunctuation(raw);
    if (term === "") continue;
    terms.push(term);
    if (terms.length >= MAX_SEARCH_TERMS) break;
  }

  const joined = terms.join(" ");
  if (joined.length <= MAX_SEARCH_QUERY_LENGTH) return joined;

  // The cut can land between the halves of a surrogate pair (a lone high
  // surrogate does not survive the JSON body to Postgres) or leave the last
  // term ending in punctuation, so strip that term's edge again: this keeps
  // the function idempotent.
  const cut = joined.slice(0, MAX_SEARCH_QUERY_LENGTH).replace(/[\ud800-\udbff]$/, "");
  const lastSpace = cut.lastIndexOf(" ");
  return (cut.slice(0, lastSpace + 1) + stripEdgePunctuation(cut.slice(lastSpace + 1))).trim();
}
