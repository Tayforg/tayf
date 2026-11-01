// Blindspot sibling veto (migration 126) — the title rule, in TypeScript.
//
// The clusterer sometimes splits one event into two clusters whose headlines
// are near-identical. When the silent side's coverage sits in the sibling
// cluster, the "kör nokta" claim on the first cluster is a matching gap, not
// real silence. `public.blindspot_recall_veto_refresh()` (migration 126)
// finds such siblings in SQL and adds their voting sources to the tally; this
// module is the TypeScript statement of the same title rule, so that
// /metodoloji can quote its numbers and the rule can be tested on real
// headlines. The SQL carries hand-written copies of every number below;
// tests/migrations/126-blindspot-sibling-veto.test.ts pins them to this file.
//
// Pure: no I/O, no clock, nothing to mock.

import { RISING_FOLD_FROM, RISING_FOLD_TO } from "@/lib/trends/rising-entities";

export const SIBLING_VETO = {
  /** Jaccard index of the two titles' stem sets, inclusive. */
  minJaccard: 0.5,
  /** Stems the two titles must share, inclusive. */
  minShared: 3,
  /** Two articles are siblings only when published at most this far apart. */
  windowHours: 24,
  /** A cluster is searched for siblings while it is at most this old (it is
   *  widened to the refresh window when that is longer). */
  scopeHours: 48,
  /** Words shorter than this are dropped. */
  tokenMinLen: 4,
  /** Words are cut to this many characters, a crude Turkish stemmer. */
  stemLen: 5,
} as const;

// translate(): fold Turkish letters to ASCII (İIıŞşĞğÜüÖöÇçÂâÎîÛû -> ASCII)
// before lower-casing, because JavaScript's toLowerCase maps İ to "i" plus a
// combining dot. Built once.
const FOLD = new Map<string, string>(
  [...RISING_FOLD_FROM].map((from, i) => [from, [...RISING_FOLD_TO][i] as string]),
);

function fold(title: string): string {
  let out = "";
  for (const ch of title) out += FOLD.get(ch) ?? ch;
  return out;
}

/**
 * The stem set of a headline: fold Turkish letters, lower-case, split on
 * anything that is not a-z or 0-9, keep words of at least `tokenMinLen`
 * characters and cut each to `stemLen`. Mirrors the SQL
 * `distinct left(t, 5) ... where length(t) >= 4` of migration 126.
 */
export function siblingTitleTokens(title: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!title) return out;
  for (const word of fold(title).toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= SIBLING_VETO.tokenMinLen) out.add(word.slice(0, SIBLING_VETO.stemLen));
  }
  return out;
}

/** True when two headlines read as the same story: at least `minShared`
 *  shared stems and a Jaccard index of at least `minJaccard`. */
export function siblingTitlesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const ta = siblingTitleTokens(a);
  const tb = siblingTitleTokens(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  if (shared < SIBLING_VETO.minShared) return false;
  return shared / (ta.size + tb.size - shared) >= SIBLING_VETO.minJaccard;
}
