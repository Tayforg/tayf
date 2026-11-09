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
// Candidates are voting-source (outlet/wire) articles, either in a live cluster
// (126) or unclustered and outside the gate categories politika/son_dakika
// (148): the clusterer admits only those two categories, so a story the silent
// side filed under dunya, genel or yasam sits in no cluster at all.
// tests/migrations/148-blindspot-unclustered-siblings.test.ts pins the 148 copy
// (the arm, its filters and the bdbf9948 headlines) to this file.
//
// Two evidence tiers (migration 180). The strict tier is 126's: 3 shared stems and a
// Jaccard index of at least 0.5. The rare tier accepts a looser overlap (3 shared stems,
// Jaccard at least 0.3) when at least 2 of the shared stems are RARE: their document
// frequency is at most `rareMaxDocShare` of the titles in the MEMBER ARTICLE'S OWN pair
// window, the voting-source candidates published within `windowHours` either side of it.
// The window is the member's, not the run's: the line does not move with the refresh scope
// (p_since) or with other clusters' member dates, so a pair's verdict is a function of the
// two titles and that window. A rare stem (kasa, ruhsa, selde) names the event; a common one
// (bakan, milyon, lira) does not, which is why plain looser thresholds are unsafe and this
// one is not. Production trial, 2026-11-08, 52 public claims: Jaccard >= 0.3 alone flips about
// 22 of them. Replay 2026-11-09 over 198 live blindspots: the rare tier vetoes 11 more than
// the strict tier, 7 of them the same event (the 180 header lists them).
// tests/migrations/180-blindspot-sibling-rare-tier.test.ts pins the SQL copy of every number
// below to this file and is the source of truth for the window and the voting-kind base.
//
// Known limit: generic wording shares no rare stem ("Fransa genel grev" headlines), so some
// same-event pairs stay out of reach of any title rule.
//
// Pure: no I/O, no clock, nothing to mock.

import { RISING_FOLD_FROM, RISING_FOLD_TO } from "@/lib/trends/rising-entities";

export const SIBLING_VETO = {
  /** Jaccard index of the two titles' stem sets, inclusive. */
  minJaccard: 0.5,
  /** Stems the two titles must share, inclusive. */
  minShared: 3,
  /** Rare tier (180): stems the two titles must share, inclusive. The SQL carries one
   *  shared-stem gate for both tiers, so this stays equal to `minShared`. */
  looseMinShared: 3,
  /** Rare tier (180): Jaccard index of the two stem sets, inclusive. */
  looseMinJaccard: 0.3,
  /** Rare tier (180): shared stems that must be rare in the window, inclusive. */
  rareMinShared: 2,
  /** Rare tier (180): a stem is rare when its document frequency is at most this
   *  share of the titles in the member article's own +-`windowHours` candidate window,
   *  inclusive (0.25 percent). */
  rareMaxDocShare: 0.0025,
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

/**
 * Document frequency of every stem: the number of titles that contain it (a title
 * counts once however often it repeats a stem). Mirrors the SQL `wdf` CTE of
 * migration 180, `count(distinct st.article_id)` per member stem. The caller passes
 * the titles of ONE member's candidate window (the voting-source articles published
 * within `windowHours` either side of that member), never a scope-wide pool: the
 * frequencies, and the `totalDocs` that goes with them, belong to that window.
 */
export function stemDocFrequency(titles: readonly (string | null | undefined)[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const title of titles) {
    for (const stem of siblingTitleTokens(title)) out.set(stem, (out.get(stem) ?? 0) + 1);
  }
  return out;
}

/**
 * True when two headlines read as the same story under either tier: the strict
 * tier of `siblingTitlesMatch`, OR (rare tier, migration 180) at least
 * `looseMinShared` shared stems, a Jaccard index of at least `looseMinJaccard`
 * and at least `rareMinShared` shared stems whose document frequency is at most
 * `rareMaxDocShare * totalDocs`. `docFreq` and `totalDocs` are over the member's
 * +-`windowHours` candidate window (the titles `stemDocFrequency` was given), not
 * over the whole search scope; `totalDocs` is that window's distinct candidate
 * articles. A stem missing from `docFreq` has frequency 0. Every comparison is
 * inclusive; the SQL twin is the HAVING clause of the `pairs` CTE in migration 180
 * (`wdf.df <= wlim.lim`).
 */
export function siblingTitlesMatchRare(
  a: string | null | undefined,
  b: string | null | undefined,
  docFreq: ReadonlyMap<string, number>,
  totalDocs: number,
): boolean {
  if (siblingTitlesMatch(a, b)) return true;
  const ta = siblingTitleTokens(a);
  const tb = siblingTitleTokens(b);
  const limit = SIBLING_VETO.rareMaxDocShare * totalDocs;
  let shared = 0;
  let rare = 0;
  for (const t of ta) {
    if (!tb.has(t)) continue;
    shared += 1;
    if ((docFreq.get(t) ?? 0) <= limit) rare += 1;
  }
  if (shared < SIBLING_VETO.looseMinShared) return false;
  if (shared / (ta.size + tb.size - shared) < SIBLING_VETO.looseMinJaccard) return false;
  return rare >= SIBLING_VETO.rareMinShared;
}
