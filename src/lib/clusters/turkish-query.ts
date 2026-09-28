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
