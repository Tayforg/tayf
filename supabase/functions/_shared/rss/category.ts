// supabase/functions/_shared/rss/category.ts
//
// The ingest category classifier. A pure module: no imports, no Deno global,
// every regex compiled once at module scope and linear (no nested quantifiers).
//
// Why it matters: the live trigger `articles_cluster_enqueue` fires only for
// category `politika` / `son_dakika`, so this function decides which stories
// are ever clustered. hunt-19 (2026-11-02) found the old one (a substring
// regex chain over `title + description + url`) kept 26% of the headlines that
// name a Turkish party or leader out of the gate while letting unrelated items
// in:
//
//   * unbounded substrings: `oy` inside the URL slug `karakoyde`, `acil` inside
//     `acildi`, `cin` inside `icin`, `kur` inside `kurulmali`, `ai` inside
//     `ailesi`;
//   * the URL as haystack: the `sondakika.com` host made every row of that
//     source son_dakika;
//   * `toLowerCase()` turns `İ` into `i` + U+0307, so `SON DAKİKA` and `YENİ`
//     never matched anything;
//   * `spor` ran before `politika` ('para transferlerini' made a Sarıgül
//     headline spor) and a `/dunya/` URL section won before the politika
//     keywords (a Cumhurbaşkanı Erdoğan trip became dunya);
//   * Milliyet appends ANOTHER story's headline to its descriptions after a
//     `Son dakika...` line.
//
// The rules now:
//
//   1. The text is folded to ASCII (`foldForCategory`) BEFORE lowercasing, so
//      every keyword below is plain ASCII.
//   2. The haystack is `title + "\n" + description`, with the description cut
//      before its ticker block. The URL is never part of it: it is read only by
//      `detectCategoryFromUrl`, and only its path.
//   3. Order: son_dakika (TITLE only), politika, the URL section, spor, dunya,
//      ekonomi, teknoloji, yasam, genel.
//   4. Tokens of three letters or fewer match as whole words; longer stems are
//      anchored at a word start and may carry any suffix.
//   5. Three words whose fold collides with another word (gol / göl,
//      çin / cin, irak / ırak) are matched on the unfolded lowercase view with
//      letter boundaries.
//
// Forward-only: it changes the category of NEW rows. `content_hash` does not
// depend on the category, and nothing is re-enqueued.

export type NewsCategory =
  | "son_dakika"
  | "politika"
  | "dunya"
  | "ekonomi"
  | "spor"
  | "teknoloji"
  | "yasam"
  | "genel";

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

// One entry per character the fold rewrites. U+0307 (combining dot above) is
// dropped; the typographic apostrophes become a plain one.
const FOLD_MAP: Readonly<Record<string, string>> = {
  "İ": "i", "I": "i", "ı": "i",
  "Ş": "s", "ş": "s",
  "Ğ": "g", "ğ": "g",
  "Ü": "u", "ü": "u",
  "Ö": "o", "ö": "o",
  "Ç": "c", "ç": "c",
  "Â": "a", "â": "a",
  "Î": "i", "î": "i",
  "Û": "u", "û": "u",
  "̇": "",
  "’": "'", "‘": "'", "ʼ": "'",
};

const FOLD_RE = /[İIıŞşĞğÜüÖöÇçÂâÎîÛû̇’‘ʼ]/g;
const DOT_ABOVE_RE = /̇/g;

/**
 * Fold Turkish text to lowercase ASCII for keyword matching, in one pass.
 *
 * The letters are mapped BEFORE lowercasing (`İ`, `I`, `ı` -> `i`; `ş` -> `s`;
 * `ğ` -> `g`; `ü` -> `u`; `ö` -> `o`; `ç` -> `c`; `â` -> `a`; `î` -> `i`;
 * `û` -> `u`), so `YENİ` becomes `yeni` and never `yeni` + U+0307. U+0307 is
 * dropped wherever it appears and `’ ‘ ʼ` become `'`. The rest is a plain
 * `toLowerCase()`.
 */
export function foldForCategory(s: string): string {
  return s.replace(FOLD_RE, (ch) => FOLD_MAP[ch] ?? ch).toLowerCase();
}

// Unfolded lowercase with the combining dot removed. Default-locale
// `toLowerCase` on purpose (it is locale independent): `Irak` -> `irak` (the
// country) while the Turkish adjective `ırak` keeps its dotless ı. A Turkish
// locale would turn the `I` of `Irak` into `ı` and lose the difference.
function lowerView(s: string): string {
  return s.toLowerCase().replace(DOT_ABOVE_RE, "");
}

// ---------------------------------------------------------------------------
// Keyword tables (folded ASCII)
// ---------------------------------------------------------------------------

// A space inside a keyword matches any run of white space (NBSP included).
function alt(words: readonly string[]): string {
  return words.map((w) => w.replace(/ /g, "\\s+")).join("|");
}

// `wholeWords`: short tokens, matched as whole words. `stems`: anchored at a
// word start, any suffix allowed. `raw`: hand-written patterns.
function compile(
  wholeWords: readonly string[],
  stems: readonly string[],
  raw: readonly string[] = [],
): RegExp {
  const parts: string[] = [];
  if (wholeWords.length > 0) parts.push(`\\b(?:${alt(wholeWords)})\\b`);
  if (stems.length > 0) parts.push(`\\b(?:${alt(stems)})`);
  return new RegExp([...parts, ...raw].join("|"));
}

const SON_DAKIKA_RE =
  /\bson\s+dakika(?![a-z])|\bflas\s+haber\b|\bbreaking\b(?!\s+bad)|^\s*acil\b/;

const POLITIKA_RE = compile(
  // 'kurtulmus' / 'babacan' are surnames, which take an apostrophe
  // ("Kurtulmuş'tan"): whole words, so the participle 'kurtulmuştu' is not them.
  ["oy", "chp", "akp", "mhp", "hdp", "kurtulmus", "babacan"],
  [
    // 'basbakan' keeps the prime ministers the old substring `bakan` caught
    "erdogan", "cumhurbaskan", "basbakan", "bakan", "secim", "muhalefet",
    "hukumet", "milletvekil", "siyaset", "anayasa", "meclis", "tbmm",
    "ak parti", "dem parti", "yeni parti", "iyi parti",
    "parti genel", "genel baskan", "il baskan", "belediye baskan",
    "icisleri", "disisleri", "kabine",
    "ozgur ozel", "imamoglu", "mansur yavas", "kilicdaroglu",
    "sarigul", "davutoglu", "dervisoglu", "bakirhan",
  ],
  [
    // 'Bahcelievler' is a neighbourhood, not the MHP leader
    "\\bbahceli(?!ev)",
  ],
);

// A local body together with an enforcement action, anywhere in the text
// ('Bakırköy Belediyesi'ne yönelik soruşturma'). Bare judicial words are
// NEVER politics on their own: that would admit ordinary crime news.
const COMPOUND_BODY_RE = /\b(?:belediye|bakanlik|parti)/;
const COMPOUND_ACTION_RE = /\b(?:sorusturma|gozalti|tutukla|operasyon)/;

const SPOR_RE = compile(
  ["tff"],
  [
    "futbol", "super lig", "galatasaray", "fenerbahce", "besiktas",
    "trabzonspor", "basaksehir", "kasimpasa", "goztepe", "karagumruk",
    "genclerbirligi", "basketbol", "voleybol", "sampiyonlar ligi",
    "milli takim", "teknik direktor", "stadyum", "olimpiyat", "uefa", "fifa",
  ],
  [
    "\\b[a-z]+spor\\b",
    "\\bmac(?:i|in|ta|tan|a|inda|indan|inin|ini|iyla|lar\\w*)?\\b",
    // a money transfer is not a footballer's
    "(?<!para )\\btransfer",
  ],
);

const DUNYA_RE = compile(
  ["abd", "eu", "bm", "nato"],
  [
    "amerika", "rusya", "ukrayna", "avrupa", "birlesmis milletler",
    "ingiltere", "almanya", "fransa", "iran", "israil", "filistin", "gazze",
    "suriye", "dunya", "uluslararasi", "kuresel", "beyaz saray", "putin",
    "trump",
  ],
);

const EKONOMI_RE = compile(
  ["tl", "bist"],
  [
    "dolar", "enflasyon", "faiz", "borsa", "merkez bankasi", "ekonomi",
    "ihracat", "ithalat", "buyume", "gsyih", "vergi", "maas", "asgari ucret",
    "piyasa",
  ],
  [
    "\\bzam\\b", "\\bzamm", "\\bzamlar", "\\bkur\\b", "\\bkurlar",
    // 'Europa League' is not money
    "\\beuro(?!pa)",
  ],
);

const TEKNOLOJI_RE = compile(
  ["ai"],
  [
    "yapay zeka", "iphone", "samsung", "google", "microsoft", "apple",
    "siber", "yazilim", "uygulama", "robot", "teknoloji", "dijital",
    "startup", "kripto", "bitcoin", "blockchain",
  ],
);

const YASAM_RE = compile(
  ["sel"],
  [
    "saglik", "egitim", "universite", "deprem", "hava durumu", "trafik",
    "yangin", "seller", "cevre", "kultur", "sanat", "muzik", "sinema", "dizi",
    "magazin", "yasam",
  ],
  [
    // 'kazandi' / 'kazanc' are not accidents
    "\\bkaza(?!n)",
  ],
);

// Words whose fold collides with another word, matched on the unfolded view.
// Letters on either side disqualify the match (suffixes are listed).
const GOL_RE = /(?<!\p{L})gol(?:ü\p{L}*|e|de|le|ler\p{L}*)?(?!\p{L})/u;
const CIN_RE = /(?<!\p{L})çin(?:li\p{L}*)?(?!\p{L})/u;
const IRAK_RE = /(?<!\p{L})irak/u;

// Milliyet appends another story's headline to its descriptions: a line that
// starts with 'Son dakika' followed by 1-3 dots, an ellipsis, ':' or '!'. The
// first line is never a ticker (the regex needs a preceding newline). Applied
// to the lowercase view, where 'DAKİKA' is already 'dakika'.
const TICKER_RE = /\n[ \t ]*son[ \t ]+dak[iı]ka(?:\.{1,3}|…|:|!)/;

// ---------------------------------------------------------------------------
// URL section
// ---------------------------------------------------------------------------

/**
 * The section a publisher filed the article under, read from the URL PATH
 * only. The host, the query string and the words of the slug never count (the
 * `sondakika.com` host, `?next=/spor/` and `abdulkadir-selvi` are not sections).
 * `null` for an unparseable URL or a path without a known section.
 */
export function detectCategoryFromUrl(url: string): NewsCategory | null {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  if (/\/spor\/|\/sport/.test(path)) return "spor";
  if (/\/siyaset\/|\/politika\/|\/politi/.test(path)) return "politika";
  if (/\/ekonomi\/|\/finans\/|\/economy/.test(path)) return "ekonomi";
  if (/\/teknoloji\/|\/tech/.test(path)) return "teknoloji";
  if (/\/dunya\/|\/world\/|\/global/.test(path)) return "dunya";
  if (/\/yasam\/|\/life\/|\/saglik\/|\/egitim/.test(path)) return "yasam";
  return null;
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify an article. `son_dakika` comes from the title alone; then
 * `politika`; then the URL section; then the keyword categories in the order
 * spor, dunya, ekonomi, teknoloji, yasam; else `genel`.
 */
export function classifyCategory(
  title: string,
  description: string | null,
  url: string,
): NewsCategory {
  const titleLower = lowerView(typeof title === "string" ? title : "");
  let descLower = lowerView(typeof description === "string" ? description : "");
  const ticker = TICKER_RE.exec(descLower);
  if (ticker) descLower = descLower.slice(0, ticker.index);

  if (SON_DAKIKA_RE.test(foldForCategory(titleLower))) return "son_dakika";

  const lower = `${titleLower}\n${descLower}`;
  const hay = foldForCategory(lower);
  if (
    POLITIKA_RE.test(hay) ||
    (COMPOUND_BODY_RE.test(hay) && COMPOUND_ACTION_RE.test(hay))
  ) {
    return "politika";
  }

  const section = detectCategoryFromUrl(url);
  if (section) return section;

  if (SPOR_RE.test(hay) || GOL_RE.test(lower)) return "spor";
  if (DUNYA_RE.test(hay) || CIN_RE.test(lower) || IRAK_RE.test(lower)) return "dunya";
  if (EKONOMI_RE.test(hay)) return "ekonomi";
  if (TEKNOLOJI_RE.test(hay)) return "teknoloji";
  if (YASAM_RE.test(hay)) return "yasam";
  return "genel";
}
