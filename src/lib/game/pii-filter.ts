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
export const PRIVATE_INDIVIDUAL_PATTERNS: readonly RegExp[] = [
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

// Pre-folded copy of PRIVATE_INDIVIDUAL_PATTERNS, tested against the
// diacritic-folded title below. Built once at module load, not per call.
const FOLDED_PRIVATE_INDIVIDUAL_PATTERNS: readonly RegExp[] =
  PRIVATE_INDIVIDUAL_PATTERNS.map((pattern) => new RegExp(foldDiacritics(pattern.source)));

/**
 * False when `title` matches any `PRIVATE_INDIVIDUAL_PATTERNS` entry, in
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
  const normalized = title.toLocaleLowerCase("tr-TR");
  const folded = foldDiacritics(normalized);
  return !(
    PRIVATE_INDIVIDUAL_PATTERNS.some((pattern) => pattern.test(normalized)) ||
    FOLDED_PRIVATE_INDIVIDUAL_PATTERNS.some((pattern) => pattern.test(folded))
  );
}
