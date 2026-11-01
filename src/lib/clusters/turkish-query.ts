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
