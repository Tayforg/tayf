// Turkish headline tokenizer for the "Ayrışan Kelimeler" (/hafta) feature.
//
// Pure, dependency-free (no Next/Supabase imports) so it is trivially unit
// tested and reusable from the pure fightin-words / distinctive-words
// layers above it.
//
// The Turkish-I trap: `String.prototype.toLowerCase()` maps 'İ' → 'i' +
// U+0307 (COMBINING DOT ABOVE), not a single 'i'. Every lowercasing call in
// this module goes through `toLocaleLowerCase('tr')` instead — see
// src/lib/game/pii-filter.ts for the same trap documented on the case-fold
// side of the problem.

/**
 * Turkish stopwords: function words, headline boilerplate and month names.
 * Lowercase, Turkish alphabet (ç ğ ı ö ş ü).
 */
export const TR_STOPWORDS: ReadonlySet<string> = new Set([
  // Function words
  "ve", "veya", "ya", "yada", "ile", "ama", "fakat", "ancak", "lakin", "ise",
  "de", "da", "ki", "mi", "mı", "mu", "mü", "bu", "şu", "o", "bunu", "buna",
  "bunun", "şunu", "onu", "ona", "onun", "bir", "birkaç", "her", "hem", "ne",
  "hiç", "için", "gibi", "kadar", "göre", "daha", "en", "çok", "az", "sonra",
  "önce", "karşı", "arasında", "üzerine", "hakkında", "ilgili", "dair",
  "olan", "olarak", "oldu", "olduğu", "olduğunu", "olacak", "olur", "olmuş",
  "olması", "oluyor", "etti", "eden", "edildi", "ediyor", "edecek", "yaptı",
  "yapılan", "yapıldı", "dedi", "diye", "değil", "var", "yok", "nasıl",
  "neden", "niye", "kim", "kimdir", "nedir", "nerede", "hangi", "ben", "sen",
  "biz", "siz", "onlar", "kendi", "bile", "sadece", "yine", "artık", "tüm",
  "bütün", "bazı", "ilk", "son", "yeni", "iki", "üç", "dört", "beş",
  // Headline boilerplate
  "dakika", "sondakika", "flaş", "video", "videolu", "izle", "canlı",
  "galeri", "foto", "fotoğraf", "fotoğraflı", "haber", "haberi", "haberler",
  "gündem", "özel", "işte", "detaylar", "açıklandı", "açıklama", "açıkladı",
  "belli", "güncel", "bugün", "yarın", "dün", "saat", "gün", "günü", "yıl",
  "yılı", "hafta", "ay",
  // Months
  "ocak", "şubat", "mart", "nisan", "mayıs", "haziran", "temmuz", "ağustos",
  "eylül", "ekim", "kasım", "aralık",
]);

/** One raw token off a headline, with its lowercased comparison form. */
export interface HeadlineToken {
  term: string;
  surface: string;
}

/**
 * Characters that write a Turkish apostrophe: ASCII ', right and left single
 * quotation marks (U+2019, U+2018), modifier letter apostrophe (U+02BC),
 * backtick and acute accent. The same set as summary-agreement.ts.
 */
const APOSTROPHES: ReadonlySet<string> = new Set([
  "'",
  "\u2019",
  "\u2018",
  "\u02bc",
  "`",
  "\u00b4",
]);
const LETTER_RE = /\p{L}/u;
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;
const SPLIT_RE = /[^\p{L}\p{N}]+/u;
const ALL_DIGITS_RE = /^\p{N}+$/u;

/**
 * Marks that close a quotation, a parenthesis or an abbreviation: when one of
 * them sits between a letter or digit and an apostrophe, the apostrophe still
 * attaches a suffix to the word before the mark (M.B.’nin, (AKP)'nin).
 */
const SUFFIX_CLOSERS: ReadonlySet<string> = new Set([".", ")", "]", "”", '"', "»"]);

/**
 * True when the apostrophe at `chars[i]` (i > 0) starts a suffix: the previous
 * character is a letter or digit, or it is a closing mark that itself follows a
 * letter or digit.
 */
function startsSuffix(chars: string[], i: number): boolean {
  const prev = chars[i - 1]!;
  if (LETTER_OR_DIGIT_RE.test(prev)) return true;
  return i >= 2 && SUFFIX_CLOSERS.has(prev) && LETTER_OR_DIGIT_RE.test(chars[i - 2]!);
}

/**
 * Cuts the Turkish case/possessive suffix after an apostrophe: the apostrophe
 * and the letters that follow it go (Erdoğan'dan → Erdoğan, 2026'da → 2026).
 *
 * Only an apostrophe whose previous character is a letter or digit starts a
 * suffix. An apostrophe right after a closing mark or an abbreviation period
 * (. ) ] ” " ») that itself follows a letter or digit also starts one: M.B.’nin,
 * A.Ş.'deki, (AKP)'nin, “…”'nin. At the start of the text or after a space or
 * other punctuation it is an opening quote ('AKP', ‘Yapay zekâ’, `darbe`): it
 * is left in place, SPLIT_RE turns it into a separator, and the quoted word
 * survives.
 *
 * A character walk over code points rather than a regex: one pass, constant
 * work per character, no backtracking. "Previous character" is read from the
 * original text, so a chain such as AKP'li'ler cuts both suffixes.
 */
function stripApostropheSuffixes(text: string): string {
  const chars = Array.from(text);
  const kept: string[] = [];
  let i = 0;

  while (i < chars.length) {
    const ch = chars[i]!;
    if (i > 0 && APOSTROPHES.has(ch) && startsSuffix(chars, i)) {
      i += 1;
      while (i < chars.length && LETTER_RE.test(chars[i]!)) i += 1;
      continue;
    }
    kept.push(ch);
    i += 1;
  }

  return kept.join("");
}

/**
 * Splits a headline into raw tokens, stripping Turkish possessive/case
 * apostrophe suffixes (Erdoğan'dan → Erdoğan) before splitting on
 * non-letter/non-digit runs. Only an apostrophe that directly follows a letter
 * or digit starts a suffix, and so does one right after a closing mark or an
 * abbreviation period (. ) ] ” " ») that itself follows a letter or digit
 * (M.B.’nin, A.Ş.'deki, (AKP)'nin, “…”'nin): an opening quote ('İhmal'
 * iddiası) is plain punctuation, so the quoted word stays a token. U+02BC
 * counts as an apostrophe (Erdoğanʼdan → Erdoğan), as in summary-agreement.ts.
 *
 * NFC-normalizes first: a decomposed 'İ' (I + U+0307 COMBINING DOT ABOVE)
 * folds back into the precomposed İ so it round-trips through
 * `toLocaleLowerCase('tr')` correctly instead of leaving a stray combining
 * mark in the output term.
 */
export function tokenizeHeadline(title: string): HeadlineToken[] {
  const normalized = title.normalize("NFC");
  const stripped = stripApostropheSuffixes(normalized);
  const rawTokens = stripped.split(SPLIT_RE).filter((t) => t.length > 0);

  return rawTokens.map((raw) => ({
    surface: raw,
    // Never plain toLowerCase(): it turns İ into i + U+0307.
    term: raw.toLocaleLowerCase("tr"),
  }));
}

/**
 * True when `term` is a content word: at least 2 code points, not all
 * digits, and not a stopword.
 */
export function isContentTerm(term: string): boolean {
  if ([...term].length < 2) return false;
  if (ALL_DIGITS_RE.test(term)) return false;
  if (TR_STOPWORDS.has(term)) return false;
  return true;
}

/**
 * Content unigrams and adjacent-content-token bigrams for one headline,
 * keyed by the lowercase term with the most common display surface as the
 * value.
 *
 * A stopword between two content tokens breaks the bigram: "Fidan ile
 * Safedi görüştü" yields unigrams fidan / safedi / görüştü and exactly one
 * bigram, "safedi görüştü" ("ile" sits between fidan and safedi so that
 * pair never forms).
 */
export function headlineTerms(title: string): Map<string, string> {
  const tokens = tokenizeHeadline(title);
  const out = new Map<string, string>();

  for (let i = 0; i < tokens.length; i++) {
    const cur = tokens[i]!;
    if (isContentTerm(cur.term)) {
      if (!out.has(cur.term)) out.set(cur.term, cur.surface);

      const next = tokens[i + 1];
      if (next && isContentTerm(next.term)) {
        const bigramTerm = `${cur.term} ${next.term}`;
        const bigramSurface = `${cur.surface} ${next.surface}`;
        if (!out.has(bigramTerm)) out.set(bigramTerm, bigramSurface);
      }
    }
  }

  return out;
}

/**
 * A dedupe key for a headline: every raw term (stopwords included) joined
 * by a single space, lowercased Turkish-aware. Two casings of the same
 * headline produce the same key.
 */
export function headlineKey(title: string): string {
  return tokenizeHeadline(title)
    .map((t) => t.term)
    .join(" ");
}
