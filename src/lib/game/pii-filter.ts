// /oyun's private-individual filter. Runs BEFORE sampling (headline-pool.ts
// calls this inside `selectGameHeadlines`, ahead of the shuffle/limit step),
// never after — a headline that never entered the pool can't leak into the
// game regardless of how sampling works downstream.
//
// This is a blunt, deliberately SHORT exclusion filter, not a classifier.
// Every entry must be a word that reliably signals a named private
// individual (a minor, a suspect, a victim) rather than a public figure or
// institution. When in doubt, exclude — do not add a pattern "just in
// case" it might also match legitimate political coverage; keep the list
// short and reviewable instead.
//
// False negatives (a headline that names a private individual but matches
// no pattern here) are ACCEPTABLE and cost nothing — the game simply
// doesn't catch that one headline.
// False positives are NOT the concern here (an eligible headline wrongly
// excluded also costs nothing — there are always more headlines). The
// unacceptable failure mode is the true positive we MISS: a private
// individual's name surfacing in the game pool, which is a KVKK problem.
// Bias every judgement call on this list toward exclusion.
//
// TWO versions of the list exist, because the daily puzzle must replay byte for
// byte (daily-set.ts: DAILY_PII_STEM_FROM):
//   * PRIVATE_INDIVIDUAL_PATTERNS_V1 is the list as it stood when the daily
//     puzzles already played were drawn. Its stems are anchored on ONE
//     inflection of a word ("tutukland" matches "tutuklandı" but not
//     "tutuklanmıştı" or "tutuklanan"). Only the daily set uses it, for the
//     keys before the gate, through `isGameEligibleTitleV1`.
//   * PRIVATE_INDIVIDUAL_PATTERNS (v2) is the same list with the stem of four
//     words it already holds widened to every inflection (the "öldür" stem is
//     anchored on a word start, see below). Everything else
//     (Bölge, Çerçeve, embeds, cards, social, the daily set from the gate on)
//     uses it through `isGameEligibleTitle`.
// The list is founder-owned (migration 165): v2 adds no new WORD, it only widens
// what a listed word matches. Adding a word is a founder decision.

/**
 * The list the already-played daily puzzles were drawn with. Frozen: do not
 * edit it, a change would rewrite a puzzle a player has seen.
 */
export const PRIVATE_INDIVIDUAL_PATTERNS_V1: readonly RegExp[] = [
  /yaşındaki/,
  /isimli/,
  /adlı/,
  /çocuk/,
  /reşit olmayan/,
  /şüpheli/,
  /sanık/,
  /mağdur/,
  /tutukland/,
  /tutuklu/,
  /tutuklama/,
  /gözaltına alınd/,
  /gözaltında/,
  /cinayet/,
  /taciz/,
  /istismar/,
  /tecavüz/,
  /intihar/,
  /ceset/,
  /öldürül/,
  /yaralan/,
  /hayatını kaybet/,
  /bıçakl/,
];

/**
 * The current list: PRIVATE_INDIVIDUAL_PATTERNS_V1 with the stem of four listed
 * words widened so that every inflection matches ("tutuklanmıştı", "tutuklanan",
 * "gözaltına alınmıştı", "gözaltına alınan", "hayatını kaybeden", "öldüren"):
 *   /tutukland/ -> /tutuklan/, /gözaltına alınd/ -> /gözaltına alın/ (plus
 *   /gözaltı/ next to /gözaltında/, the noun in "gözaltı kararı"),
 *   /hayatını kaybet/ -> /hayatını kayb/, /öldürül/ -> /(?<![a-zçğıöşü])öldür/.
 * v2 is a widening of v1 with one exception: a title v1 rejects, v2 rejects
 * too, except that v1's folded /oldurul/ also matched mid-word "doldurul-"
 * ("sandık doldurulacak"), which is no PII word. The stem of "öldür" must start
 * a word: its diacritic-folded copy is /oldur/, which sits inside every
 * "doldur-" / "soldur-" form ("Boşluğu Ankara dolduruyor", "Meydanı doldurdu",
 * "koltuğunu kim doldurabilecek", "renkler soldurdu"; 20 of 32,104 prod titles
 * in 3 days) and would drop those ordinary headlines from the pool. The
 * lookbehind is one character, so the match stays linear. "öldüren",
 * "öldürülen", "öldürdü", "Ali'yi öldürdü" and the diacritic-free "oldurdu"
 * still match. All other entries are unchanged.
 *
 * Deliberately NOT here (founder proposals, see migration 165's comment that this
 * list is founder-owned): /yaşamını yitir/ (a synonym of the listed "hayatını
 * kaybet"), /zanlı/ (a synonym of the listed "şüpheli") and /etkin pişmanlık/.
 */
export const PRIVATE_INDIVIDUAL_PATTERNS: readonly RegExp[] = [
  /yaşındaki/,
  /isimli/,
  /adlı/,
  /çocuk/,
  /reşit olmayan/,
  /şüpheli/,
  /sanık/,
  /mağdur/,
  /tutuklan/,
  /tutuklu/,
  /tutuklama/,
  /gözaltına alın/,
  /gözaltında/,
  /gözaltı/,
  /cinayet/,
  /taciz/,
  /istismar/,
  /tecavüz/,
  /intihar/,
  /ceset/,
  /(?<![a-zçğıöşü])öldür/,
  /yaralan/,
  /hayatını kayb/,
  /bıçakl/,
];

// Maps every Turkish diacritic letter this list's patterns use to its
// diacritic-free ASCII counterpart. Degraded/mistranscribed Turkish text
// (this pipeline already carries a CP1254 mojibake regression case) can
// reach these titles with diacritics dropped entirely — "17 yasindaki genc"
// never matches /yaşındaki/ on its own. Folding both the title and the
// pattern sources the same way catches that without weakening the
// diacritic-aware match above.
const DIACRITIC_FOLD_MAP: Record<string, string> = {
  ç: "c",
  ğ: "g",
  ı: "i",
  ö: "o",
  ş: "s",
  ü: "u",
};

function foldDiacritics(input: string): string {
  return input.replace(/[çğıöşü]/g, (ch) => DIACRITIC_FOLD_MAP[ch] ?? ch);
}

// Pre-folded copies of the two lists, tested against the diacritic-folded title
// below. Built once at module load, not per call.
function foldPatterns(patterns: readonly RegExp[]): readonly RegExp[] {
  return patterns.map((pattern) => new RegExp(foldDiacritics(pattern.source)));
}

const FOLDED_PRIVATE_INDIVIDUAL_PATTERNS: readonly RegExp[] = foldPatterns(
  PRIVATE_INDIVIDUAL_PATTERNS,
);
const FOLDED_PRIVATE_INDIVIDUAL_PATTERNS_V1: readonly RegExp[] = foldPatterns(
  PRIVATE_INDIVIDUAL_PATTERNS_V1,
);

function isEligibleUnder(
  title: string,
  patterns: readonly RegExp[],
  foldedPatterns: readonly RegExp[],
): boolean {
  const normalized = title.toLocaleLowerCase("tr-TR");
  const folded = foldDiacritics(normalized);
  return !(
    patterns.some((pattern) => pattern.test(normalized)) ||
    foldedPatterns.some((pattern) => pattern.test(folded))
  );
}

/**
 * False when `title` matches any `PRIVATE_INDIVIDUAL_PATTERNS` (v2) entry, in
 * either its diacritic-aware or diacritic-folded form.
 *
 * Matching is case-insensitive AND Turkish-locale aware: plain regex `/i`
 * folding does not correctly relate dotted İ/i and dotless I/ı (e.g.
 * `/adlı/i` does not match "ADLI" — verified, this is the classic
 * "Turkish I problem"). We normalize with `toLocaleLowerCase("tr-TR")`
 * before testing so both "İSİMLİ" and an all-caps "... ADLI ..." headline
 * correctly match their lowercase Turkish patterns above.
 *
 * We additionally test a diacritic-folded copy of both the title and the
 * patterns (ç/ğ/ı/ö/ş/ü -> c/g/i/o/s/u) — diacritic-free Turkish (e.g.
 * "sanik", "yasindaki") otherwise evades every entry above. A title is
 * excluded if EITHER form matches; over-exclusion here is free, and
 * under-exclusion is a KVKK problem.
 */
export function isGameEligibleTitle(title: string): boolean {
  return isEligibleUnder(
    title,
    PRIVATE_INDIVIDUAL_PATTERNS,
    FOLDED_PRIVATE_INDIVIDUAL_PATTERNS,
  );
}

/**
 * `isGameEligibleTitle` under PRIVATE_INDIVIDUAL_PATTERNS_V1, the list the
 * daily puzzles already played were drawn with. Only daily-set.ts calls it, for
 * the keys before DAILY_PII_STEM_FROM, so those puzzles recompute exactly as
 * they were served. Every other caller uses `isGameEligibleTitle`.
 */
export function isGameEligibleTitleV1(title: string): boolean {
  return isEligibleUnder(
    title,
    PRIVATE_INDIVIDUAL_PATTERNS_V1,
    FOLDED_PRIVATE_INDIVIDUAL_PATTERNS_V1,
  );
}
