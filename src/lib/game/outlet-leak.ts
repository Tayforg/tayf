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
// as one phrase, and skips names that are ordinary Turkish words.
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
 * outlet, and each is common enough that checking it would drop real headlines
 * for nothing. A name on this list is never checked. Multi-word names are not
 * affected: "Türkiye Gazetesi" is checked as the phrase it is.
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
 * True when `title` names the outlet `source.name`: the folded name occurs in
 * the folded title as a whole word (or, for a multi-word name, a whole phrase
 * with any run of whitespace between the words). A name of one word that is an
 * ordinary Turkish word (`ORDINARY_WORD_NAMES`) is never reported, and neither
 * is an empty or blank name or title.
 *
 * Both sides are folded with `foldTr` (Turkish lowercase, diacritics stripped),
 * so "CNN TÜRK'te" matches the name "CNN Türk". A "word" boundary is the start
 * or end of the title or any character outside a-z and 0-9 once folded, so
 * "OdaTV'ye" and "NTV:" match but "Kontvilla" does not match "NTV".
 */
export function titleNamesOutlet(title: string, source: { name: string }): boolean {
  const tokens = foldTr(source.name)
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return false;
  if (tokens.length === 1 && ORDINARY_WORD_NAMES.has(tokens[0] as string)) return false;

  const foldedTitle = foldTr(title);
  if (foldedTitle.trim().length === 0) return false;

  const phrase = tokens.map(escapeRegExp).join("\\s+");
  return new RegExp(`(^|[^a-z0-9])${phrase}($|[^a-z0-9])`).test(foldedTitle);
}
