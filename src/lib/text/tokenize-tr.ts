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

const APOSTROPHE_SUFFIX_RE = /['’‘`´]\p{L}*/gu;
const SPLIT_RE = /[^\p{L}\p{N}]+/u;
const ALL_DIGITS_RE = /^\p{N}+$/u;

/**
 * Splits a headline into raw tokens, stripping Turkish possessive/case
 * apostrophe suffixes (Erdoğan'dan → Erdoğan) before splitting on
 * non-letter/non-digit runs.
 *
 * NFC-normalizes first: a decomposed 'İ' (I + U+0307 COMBINING DOT ABOVE)
 * folds back into the precomposed İ so it round-trips through
 * `toLocaleLowerCase('tr')` correctly instead of leaving a stray combining
 * mark in the output term.
 */
export function tokenizeHeadline(title: string): HeadlineToken[] {
  const normalized = title.normalize("NFC");
  const stripped = normalized.replace(APOSTROPHE_SUFFIX_RE, "");
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
