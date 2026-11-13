// /oyun's outlet-name rule. A practice headline that NAMES its own outlet
// ("CNN TÜRK Azerbaycan’da ...", "Trump'ın eski kurul üyesi CNN TÜRK'te", "GZT
// sordu ...", "OdaTV'ye konuştu") gives the answer to "which camp is this outlet
// in?" away, so headline-pool.ts drops it from the pool.
//
// Why not the daily mode's `titleLeaksOutlet` (daily-set.ts): that rule is a
// plain substring test on the folded name and on every slug token of 4+
// characters, so it also fires on "Yeni Parti'den istifa etti" (Yeni Şafak),
// "Cumhuriyet Halk Partisi ..." (Cumhuriyet) and "Türkiye ile Azerbaycan ..."
// (Türkiye Gazetesi). The daily puzzles must stay replayable byte for byte, so
// that rule is left alone; this one matches whole words only, matches the name
// as one phrase, and for names that are ordinary Turkish words checks only the
// forms the common word never takes (see `ORDINARY_WORD_NAMES`).
//
// Pure, no imports: safe in any bundle, and nothing here can pull a server
// module in. Keep it that way (outlet-leak.test.ts guards it).

const DIACRITIC_FOLD_MAP: Record<string, string> = {
  ç: "c",
  ğ: "g",
  ı: "i",
  ö: "o",
  ş: "s",
  ü: "u",
};

// Copy of daily-set.ts's foldTr (not imported: that module owns the daily
// puzzle and pulls in more than a bundle needs): Turkish-locale lowercase, so
// "I" becomes "ı" and "İ" becomes "i", then the six diacritics are stripped.
function foldTr(input: string): string {
  return input
    .toLocaleLowerCase("tr-TR")
    .replace(/[çğıöşü]/g, (ch) => DIACRITIC_FOLD_MAP[ch] ?? ch);
}

/**
 * Single-word outlet names that are ALSO ordinary Turkish words, folded. A
 * headline holding one of them on its own ("Sabah saatlerinde deprem", "AK Parti
 * Sözcüsü", "Anayasa'ya aykırı karar", "İstiklal Caddesi") is not naming the
 * outlet, and each is common enough that checking it as a bare word would drop
 * real headlines for nothing. A name on this list is therefore NOT checked as a
 * phrase; only the forms the common word never takes are (`ordinaryNameIsNamed`:
 * an apostrophe suffix, ALL CAPS, a title-initial series line, and for five names
 * Title case after the first word). Multi-word names are not affected:
 * "Türkiye Gazetesi" is checked as the phrase it is.
 *
 * The first eighteen are the names the finding listed; the last five were added
 * after reading the active single-word outlet names from `sources` on
 * 2026-11-08 (44 names): Aykırı (contrary), İstiklal (independence), Milat
 * (turning point), Muhalif (opposing) and Haberiniz ("your news"). The rest are
 * coined or brand names (Agos, Bianet, BirGün, Habertürk, NTV, OdaTV, GZT, T24,
 * Tele1 ...) that a headline only holds when it means the outlet, so they stay
 * checked.
 */
const ORDINARY_WORD_NAMES: ReadonlySet<string> = new Set(
  [
    "Akşam",
    "Aydınlık",
    "Bugün",
    "Cumhuriyet",
    "Diken",
    "Evrensel",
    "Güneş",
    "Hürriyet",
    "Karar",
    "Korkusuz",
    "Milliyet",
    "Posta",
    "Sabah",
    "Sözcü",
    "Star",
    "Takvim",
    "Türkiye",
    "Yurt",
    "Aykırı",
    "İstiklal",
    "Milat",
    "Muhalif",
    "Haberiniz",
  ].map(foldTr),
);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Names an outlet is also called by, keyed by the FOLDED source name (single
 * spaces): CNN Türk's own copy says "CNN'e konuştu", TRT Haber's "TRT'ye
 * konuştu". Each alias is checked as a whole word exactly like the name. A Map,
 * so a source called "constructor" finds no inherited key.
 */
const OUTLET_NAME_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ["cnn turk", ["cnn"]],
  ["trt haber", ["trt"]],
]);

/**
 * The ordinary-word names (folded) that also fire on a Title-case occurrence
 * after the first word of the title ("Çelişkiyi Takvim yakaladı"): five names
 * whose common word is rare in a headline outside the title position. The other
 * ordinary-word names are common mid-title ("Karar Duruşması", "Cumhuriyet
 * Bayramı", "Sabah Namazı"), so for them only the apostrophe, ALL-CAPS and
 * series-line forms count.
 */
const MID_TITLE_TITLE_CASE_NAMES: ReadonlySet<string> = new Set(
  ["Milliyet", "Takvim", "Sözcü", "Korkusuz", "Diken"].map(foldTr),
);

// The names no self-reference rule applies to: "Türkiye" is the country, in
// "Türkiye'nin ..." and "TÜRKİYE'de ..." in countless headlines.
const NEVER_SELF_REFERENCE_NAMES: ReadonlySet<string> = new Set(["turkiye"]);

// A word is a run of a-z, 0-9 and the six Turkish letters in either case, the
// same boundary the phrase rule applies after folding.
const WORD_RUN_SOURCE = "[a-zA-Z0-9çğıöşüÇĞİÖŞÜ]+";
const LETTER_RE = /[a-zA-ZçğıöşüÇĞİÖŞÜ]/;
// Apostrophes feeds use: ' and ’, plus the left quote and the modifier letter
// that are typed in their place.
const APOSTROPHES: ReadonlySet<string> = new Set(["'", "\u2019", "\u2018", "\u02bc"]);
const APOSTROPHE_CLASS = [...APOSTROPHES].join("");
const SERIES_SUFFIX = "(?:den|dan|ten|tan)";
const MIN_ALL_CAPS_LETTERS = 4;
const MAX_SERIES_PLACE_CHARS = 60;

function isAllCaps(word: string): boolean {
  return word === word.toLocaleUpperCase("tr-TR");
}

function isTitleCase(word: string): boolean {
  const first = word.charAt(0);
  const rest = word.slice(1);
  return (
    first !== first.toLocaleLowerCase("tr-TR") &&
    first === first.toLocaleUpperCase("tr-TR") &&
    rest === rest.toLocaleLowerCase("tr-TR")
  );
}

/**
 * True when the ORIGINAL `title` holds `name` (folded, one word, an ordinary
 * Turkish word) in a form the common word never takes. Scans the words of the
 * title once and the title head once, so it is linear in the title length.
 *
 *  1. The name as a whole word, in Title case or ALL CAPS, right before an
 *     apostrophe and a letter: "Milliyet’e konuştu", "KARAR'ın gündeme
 *     getirdiği", "Sözcü'ye". Common nouns take no apostrophe.
 *  2. The name as an ALL-CAPS whole word of 4+ letters: "SÖZCÜ", "KARAR".
 *  3. For `MID_TITLE_TITLE_CASE_NAMES` only, the name as a Title-case whole word
 *     that is not the first word of the title: "Çelişkiyi Takvim yakaladı".
 *  4. A title-initial series line: "<Name> <place>'den bildiriyor" ("Cumhuriyet
 *     Silivri'den bildiriyor"), also "dan", "ten", "tan"; any case.
 */
function ordinaryNameIsNamed(title: string, foldedTitle: string, name: string): boolean {
  const midTitleTitleCase = MID_TITLE_TITLE_CASE_NAMES.has(name);
  const wordRun = new RegExp(WORD_RUN_SOURCE, "g");
  let isFirstWord = true;
  for (let m = wordRun.exec(title); m !== null; m = wordRun.exec(title)) {
    const word = m[0];
    const atTitleStart = isFirstWord;
    isFirstWord = false;
    // Length first: only a word as long as the name can be the name, so the
    // fold below runs on a handful of words, not on every word of a long title.
    if (word.length !== name.length || foldTr(word) !== name) continue;

    const allCaps = isAllCaps(word);
    const titleCase = !allCaps && isTitleCase(word);
    if (!allCaps && !titleCase) continue;

    const end = m.index + word.length;
    if (
      end + 1 < title.length &&
      APOSTROPHES.has(title.charAt(end)) &&
      LETTER_RE.test(title.charAt(end + 1))
    ) {
      return true;
    }
    if (allCaps && word.length >= MIN_ALL_CAPS_LETTERS) return true;
    if (titleCase && !atTitleStart && midTitleTitleCase) return true;
  }

  const series = new RegExp(
    `^\\s*${escapeRegExp(name)}\\s+\\S{1,${MAX_SERIES_PLACE_CHARS}}[${APOSTROPHE_CLASS}]${SERIES_SUFFIX}\\s+bildiriyor`,
  );
  return series.test(foldedTitle);
}

function wholeWordPhrase(words: readonly string[]): RegExp {
  const phrase = words.map(escapeRegExp).join("\\s+");
  return new RegExp(`(^|[^a-z0-9])${phrase}($|[^a-z0-9])`);
}

/**
 * True when `title` names the outlet `source.name`: the folded name occurs in
 * the folded title as a whole word (or, for a multi-word name, a whole phrase
 * with any run of whitespace between the words), or an alias of the name does
 * (`OUTLET_NAME_ALIASES`: "CNN" for CNN Türk). A name of one word that is an
 * ordinary Turkish word (`ORDINARY_WORD_NAMES`) is not checked as a bare word:
 * it is reported only in a form the common word never takes
 * (`ordinaryNameIsNamed`), never for "Türkiye". An empty or blank name or title
 * is never reported.
 *
 * Both sides are folded with `foldTr` (Turkish lowercase, diacritics stripped),
 * so "CNN TÜRK'te" matches the name "CNN Türk". A "word" boundary is the start
 * or end of the title or any character outside a-z and 0-9 once folded, so
 * "OdaTV'ye" and "NTV:" match but "Kontvilla" does not match "NTV". The case
 * rules of `ordinaryNameIsNamed` read the original title, not the folded one.
 */
export function titleNamesOutlet(title: string, source: { name: string }): boolean {
  const tokens = foldTr(source.name)
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return false;

  const foldedTitle = foldTr(title);
  if (foldedTitle.trim().length === 0) return false;

  const aliases = OUTLET_NAME_ALIASES.get(tokens.join(" ")) ?? [];
  if (aliases.some((alias) => wholeWordPhrase(alias.split(" ")).test(foldedTitle))) return true;

  if (tokens.length === 1 && ORDINARY_WORD_NAMES.has(tokens[0] as string)) {
    if (NEVER_SELF_REFERENCE_NAMES.has(tokens[0] as string)) return false;
    return ordinaryNameIsNamed(title, foldedTitle, tokens[0] as string);
  }

  return wholeWordPhrase(tokens).test(foldedTitle);
}
