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
//   3. `son_dakika` is a PREFIX of the title (SON_DAKIKA_PREFIX_RE: 'son dakika',
//      'flaş haber', 'breaking', 'acil'), never a word inside it. When it
//      matches, the REMAINDER of the title is classified through the chain
//      below with the description; the answer is `son_dakika` only when the
//      remainder is politika or genel, otherwise the remainder's own category
//      ('Son dakika | Galatasaray'da ...' is spor). A mid-title 'son dakika'
//      never counts: it is the SEO suffix of gold prices, 'deprem mi oldu?' and
//      'X öldü mü?' templates.
//   4. Order: politika, the URL section, spor, dunya, ekonomi, teknoloji, yasam,
//      genel. Politika has two kinds of evidence (classifyBody):
//        * title hit: POLITIKA_RE (unambiguous names and bodies), POLITIKA_TITLE_RE
//          (generic office and process words: bakan, seçim, hükümet, İçişleri,
//          ...), a party office ('genel başkan' / 'il başkan') together with a
//          party marker, a state senate, and the footballer 'Dervişoğlu' unless
//          the title is sport. It beats sport.
//        * text hit: POLITIKA_RE in the DESCRIPTION, a body (belediye / parti /
//          İBB) together with an enforcement action, a coalition together with
//          a party. It does NOT beat a sports title (SPOR_RE, a goal, or a
//          /spor/ URL section).
//      The generic words are title-only because in a description they decorate
//      crime, weather, price and sports stories ('Bakan Gürlek', 'İçişleri
//      Bakanlığı bildirdi', 'doğru kestane seçiminden').
//      'Genel başkan' and 'il başkan' are the office of every association,
//      federation, chamber and union ('Tüketici Hakları Derneği Genel Başkanı'),
//      so they admit a headline only with a party marker in the title or the
//      description (PARTY_OFFICE_TITLE_RE, PARTY_MARKER_RE; hunt-21).
//   5. Tokens of three letters or fewer match as whole words; longer stems are
//      anchored at a word start and may carry any suffix.
//   6. Four words whose fold collides with another word (gol / göl,
//      çin / cin, irak / ırak, TİP / tıp) are matched on the unfolded lowercase
//      view with letter boundaries.
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

// The breaking-news flag, read at the START of the folded title and swallowing
// the separator that follows it ('Son dakika | ', 'SON DAKİKA! ', 'Flaş haber: ').
// 'son dakikada' / 'son dakikalar' and the series 'Breaking Bad' are not it.
const SON_DAKIKA_PREFIX_RE =
  /^\s*(?:son\s+dakika(?![a-z])|flas\s+haber(?![a-z])|breaking(?!\s+bad)(?![a-z])|acil(?![a-z]))[\s|:!.…-]*/;

// Unambiguous names and bodies, matched in the title AND the description. The
// generic office and process words (bakan, seçim, hükümet, genel başkan, ...)
// are NOT here: see POLITIKA_TITLE_RE.
const POLITIKA_RE = compile(
  // 'kurtulmus' / 'babacan' are surnames, which take an apostrophe
  // ("Kurtulmuş'tan"): whole words, so the participle 'kurtulmuştu' is not them.
  // 'ozdag' is a whole word too ('gozdagi' is a threat); 'pkk' is a token;
  // 'btp' is the Bağımsız Türkiye Partisi (hunt-21: 162 titles over 30 days
  // matched it as a word, every one the party, no other expansion).
  ["oy", "chp", "akp", "mhp", "hdp", "kurtulmus", "babacan", "pkk", "ozdag", "btp"],
  [
    "muhalefet", "milletvekil", "siyaset", "anayasa", "meclis", "tbmm",
    "ak parti", "dem parti", "yeni parti", "iyi parti", "parti genel",
    // TBMM group deputy chairs. A bare 'baskan vekil' is NOT a stem: clubs and
    // federations have deputy chairs too ('Galatasaray Sportif A.Ş.
    // Başkanvekili') and politika runs before spor.
    "grup baskanvekil", "grup baskan vekil",
    "ozgur ozel", "imamoglu", "mansur yavas", "kilicdaroglu", "davutoglu",
    "bakirhan",
    // The Öcalan / İmralı process (hunt-20). A bare 'imrali' is NOT a stem: it
    // is also a place and a prison; 'buldan' and 'sancar' only as the full names
    // ('Buldan' is a town and a cloth, Aziz Sancar a Nobel laureate).
    "ocalan", "imrali heyet", "pervin buldan", "mithat sancar", "hatimogullari",
    "terorsuz turkiye", "surec komisyon",
    // Parties outside the big five (hunt-20 replay over 48 h of rows: 11 rows
    // hit 'zafer parti', all of them the party; no victory-party collision).
    // 'İşçi Partisi' is a raw pattern below, because the Korean Workers' Party
    // is not it. 'Bağımsız Türkiye Partisi' (hunt-21): 161 rows over 30 days
    // name it in the title or the description, every one the party (BTP).
    "zafer parti", "saadet parti", "yeniden refah", "deva parti",
    "gelecek parti", "memleket parti", "buyuk birlik parti",
    "bagimsiz turkiye parti",
  ],
  [
    // 'Bahcelievler' is a neighbourhood, not the MHP leader
    "\\bbahceli(?!ev)",
    // 'Recep Tayyip Erdoğan Stadyumu' / 'Erdoğan Üniversitesi' are venues
    "\\berdogan(?!\\s+(?:stad|univ))",
    // 'İşçi Partisi' (the Turkish TİP, Brazil's PT, the British Labour Party),
    // but not the Korean Workers' Party ('Kore İşçi Partisi', 'Kuzey Kore İşçi
    // Partisi', 'Kore'nin İşçi Partisi'): the hunt-20 replay's one false hit
    // was a North Korean warhead test (milliyet, /dunya/) admitted by the
    // description. Other countries' labour parties stay: they are party news
    // like the 'arap partil' / 'sol partil' headlines. The lookbehind is
    // variable-length but linear: its scan is bounded by one run of white space
    // and runs only where 'işçi parti' is already about to match.
    "(?<!\\bkore(?:'[a-z]+)?\\s+)\\bisci\\s+parti",
  ],
);

// Words that make a HEADLINE politics but only decorate a description, so they
// are matched against the TITLE alone (wave AW, measured on 48 h of production
// rows; the rows each one newly moves into politika were reviewed by hand):
//   * 'siyasi' / 'siyasal': 'siyasi' appears in 31 rows as text but only 6 as a
//     title word, and those 6 are all political ('BM Somali'deki siyasi
//     misyonunu bitirdi'); the other 25 are a Halloween essay, a credit-rating
//     note, a film about Aytmatov, ...
//   * 'ibb baskan' ('İBB Başkan Vekili', also one word): in a description it is
//     a car-park opening that quotes the deputy mayor.
//   * 'parlamento' / 'referandum' / 'senato': decisions of a foreign parliament
//     or electorate are politics; a mention inside a story is not.
//   * 'arap partil' / 'sol partil': the foreign-party headlines the reviewer
//     named. A bare 'partiler' is NOT here: 6 of 6 rows in 48 h were Halloween,
//     student and baby-shower parties.
//   * the generic office and process words (hunt-20): 'bakan' (also Bakanlık),
//     'başbakan', 'cumhurbaşkan', 'seçim', 'hükümet', 'belediye başkan',
//     'İçişleri', 'Dışişleri', 'kabine', 'Sarıgül'. ('Genel başkan' and 'il
//     başkan' left this list in hunt-21: see PARTY_OFFICE_TITLE_RE.) In a
//     description they are decoration: 91 of 188 rows that entered the gate in
//     one hour were admitted by them alone ('Bakan Gürlek' on a cancer-drug raid,
//     'İçişleri Bakanlığı' on a rain warning, 'ABD seçimleri' on a gold wrap,
//     'doğru kestane seçiminden' on a recipe).
const POLITIKA_TITLE_RE = compile(
  [],
  [
    "siyasi", "siyasal", "ibb baskan", "parlamento", "referandum",
    "arap partil", "sol partil",
    "bakan", "basbakan", "cumhurbaskan", "secim", "hukumet",
    "belediye baskan", "icisleri", "disisleri", "kabine",
    "sarigul",
  ],
);

// 'genel başkan' / 'il başkan' are the office of every association, federation,
// chamber and union ('Tüketici Hakları Derneği Genel Başkanı' was politika
// twice in one hour), so they are no longer in POLITIKA_TITLE_RE: a headline
// with one admits only together with a party marker anywhere in the title or
// description (PARTY_MARKER_RE). A leader or an acronym POLITIKA_RE already
// knows ('CHP Genel Başkanı Özel', 'BTP lideri') admits on its own, and
// 'belediye başkan' stays a plain title word.
//
// Replay (hunt-21, read-only, base 83fd6d1 against this module):
//   * 1,264 rows of 30 days whose title has 'genel başkan' / 'il başkan':
//     1,168 unchanged, 96 leave the gate, 0 enter. All 96 are a union, a
//     confederation, an association, a foundation, Kızılay or Borsa İstanbul
//     (DİSK, HAK-İŞ, TESK, SANKON, YOL-İŞ, İHD, TÜED, Tüketiciler Birliği, ...).
//   * a first cut with only 'parti' and BBP / YRP / BTP dropped 26 more rows
//     that ARE a party, because their text never says 'parti': EMEP, DSP, DP,
//     HKP, CTP (Kuzey Kıbrıs), HÜDA PAR, TİP. Those acronyms are markers now.
//     UBP is listed for the same reason as CTP; SP, TKP and ZP did not occur
//     in 30 days and are not guessed.
//   * 48 h of all rows (15,759): 23 change, 10 enter (all BTP) and 13 leave
//     (YOL-İŞ x6, a Korean warhead test, a hospital-rights association, a
//     union, a stock-exchange head, a confederation, a consumer federation).
const PARTY_OFFICE_TITLE_RE = compile([], ["genel baskan", "il baskan"]);
// 'parti' as a word start ('Saadet Partisi', 'partili', 'partiler'), not the
// club 'Partizan'; plus the party acronyms that are not in POLITIKA_RE.
const PARTY_MARKER_RE =
  /\bparti(?!zan)|\b(?:bbp|yrp|btp|dsp|dp|emep|hkp|ctp|ubp)\b|\bhuda\s+par\b/;
// 'TİP' folds to 'tip', the same as the common 'tıp' (medicine), so the acronym
// is read on the unfolded view, where 'TİP' / 'TIP' / 'Tip' are 'tip' and
// 'tıp' keeps its dotless ı (the GOL_RE / CIN_RE trick).
const TIP_ACRONYM_RE = /(?<!\p{L})tip(?!\p{L})/u;

// A title word too, unless the title is sport: the footballer 'Halil
// Dervişoğlu' (the Trabzonspor match report) shares the name of a party leader.
const TITLE_UNLESS_SPORT_RE = compile([], ["dervisoglu"]);

// 'senato' is a title word too, except for a university senate (4 of 22 rows
// in the 24 days measured: 'AİÇÜ Senatosu YÖKAK raporunu karara bağladı').
const SENATO_RE = /\bsenato/;
const UNIVERSITY_RE = /\b(?:universite|rektor|fakulte|yokak)/;

// A local body together with an enforcement action, anywhere in the text
// ('Bakırköy Belediyesi'ne yönelik soruşturma'). Bare judicial words are
// NEVER politics on their own: that would admit ordinary crime news.
//
// 'ibb' is a body of this rule and NOT a politika word. Decision data (read
// only, 2026-11-02): the 48 h titles matching `(^|[^[:alpha:]])İBB` were
// politika 7, genel 2, ekonomi 1, son_dakika 1 = 11, of which 8 political (the
// İBB trial x3, 'İBB Başkan Vekili', the CHP / Yeni Parti calls, the Sayıştay
// vurgun, a BTP visit) and 3 not (two car-park openings, a restoration). 73% is
// under the 80% bar, and as a text word it also moved 17 rows (a marathon, a
// car park, Kuyumcu Han). The deputy mayor is covered by 'ibb baskan' above.
//
// 'bakanlik' is NOT a body (hunt-20): a ministry together with an operation is
// crime news ('Bakan Gürlek' announcing a cancer-drug raid). A ministry in the
// HEADLINE is still politics through POLITIKA_TITLE_RE.
const COMPOUND_BODY_RE = /\b(?:belediye|parti)|\bibb\b/;
const COMPOUND_ACTION_RE = /\b(?:sorusturma|gozalti|tutukla|operasyon)/;

// 'koalisyon' alone is the Saudi-led 'Arap Koalisyonu' war ticker (9 of the 11
// rows in 48 h), so it counts together with a party ('Berlin'de Sol Parti ...
// ile koalisyon görüşmeleri').
const COALITION_RE = /\bkoalisyon/;
const PARTY_RE = /\bparti/;

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

// The chain after the breaking-news prefix: politika, the URL section, spor,
// dunya, ekonomi, teknoloji, yasam, genel. `titleLower` / `descLower` are the
// unfolded lowercase views (see lowerView).
function classifyBody(
  titleLower: string,
  descLower: string,
  url: string,
): NewsCategory {
  const titleHay = foldForCategory(titleLower);
  const descHay = foldForCategory(descLower);
  const hay = `${titleHay}\n${descHay}`;
  const lower = `${titleLower}\n${descLower}`;
  const section = detectCategoryFromUrl(url);

  // A sports headline: a club, a match, a goal, or a /spor/ section.
  const titleSport =
    SPOR_RE.test(titleHay) || GOL_RE.test(titleLower) || section === "spor";

  // Evidence in the headline beats sport; evidence only in the text does not.
  const titleHit =
    POLITIKA_RE.test(titleHay) ||
    POLITIKA_TITLE_RE.test(titleHay) ||
    (PARTY_OFFICE_TITLE_RE.test(titleHay) &&
      (PARTY_MARKER_RE.test(hay) || TIP_ACRONYM_RE.test(lower))) ||
    (SENATO_RE.test(titleHay) && !UNIVERSITY_RE.test(hay)) ||
    (!titleSport && TITLE_UNLESS_SPORT_RE.test(titleHay));
  const textHit =
    POLITIKA_RE.test(descHay) ||
    (COMPOUND_BODY_RE.test(hay) && COMPOUND_ACTION_RE.test(hay)) ||
    (COALITION_RE.test(hay) && PARTY_RE.test(hay));
  if (titleHit || (textHit && !titleSport)) return "politika";

  if (section) return section;

  if (SPOR_RE.test(hay) || GOL_RE.test(lower)) return "spor";
  if (DUNYA_RE.test(hay) || CIN_RE.test(lower) || IRAK_RE.test(lower)) return "dunya";
  if (EKONOMI_RE.test(hay)) return "ekonomi";
  if (TEKNOLOJI_RE.test(hay)) return "teknoloji";
  if (YASAM_RE.test(hay)) return "yasam";
  return "genel";
}

/**
 * Classify an article. A breaking-news PREFIX of the title ('Son dakika',
 * 'Flaş haber', 'Breaking', 'Acil') is cut off and the rest of the title is
 * classified: `son_dakika` when that is politika or genel (so breaking
 * political news stays in the gate), otherwise the remainder's own category.
 * Without the prefix: politika; then the URL section; then the keyword
 * categories in the order spor, dunya, ekonomi, teknoloji, yasam; else
 * `genel`.
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

  const prefix = SON_DAKIKA_PREFIX_RE.exec(foldForCategory(titleLower));
  if (!prefix) return classifyBody(titleLower, descLower, url);

  // The fold is one character for one character after lowerView, so the prefix
  // length indexes the unfolded view too. If it ever were not, classify the
  // whole title: the prefix words carry no keyword of their own.
  const remainder =
    foldForCategory(titleLower).length === titleLower.length
      ? titleLower.slice(prefix[0].length)
      : titleLower;
  const category = classifyBody(remainder, descLower, url);
  return category === "politika" || category === "genel" ? "son_dakika" : category;
}
