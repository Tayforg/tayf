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
//          (generic office and process words: bakan, hükümet, İçişleri, ...),
//          a state election ('seçim' or 'oy' that names no chamber, club or
//          other non-state electorate, in a title that is not sport), the
//          presidency ('cumhurbaşkan' unless a sporting-event noun follows),
//          a party office ('genel başkan' / 'il başkan') together with a party
//          marker, a state senate, and the footballer 'Dervişoğlu' unless the
//          title is sport. It beats sport.
//        * text hit: POLITIKA_DESC_RE in the DESCRIPTION, a body (belediye /
//          İBB, a Turkish party acronym, a party office with a party word)
//          together with an enforcement action, a coalition together with a
//          party. It does NOT beat a sports title (SPOR_RE, a goal, or a
//          /spor/ URL section).
//      The generic words are title-only because in a description they decorate
//      crime, weather, price and sports stories ('Bakan Gürlek', 'İçişleri
//      Bakanlığı bildirdi', 'doğru kestane seçiminden').
//      'Genel başkan' and 'il başkan' are the office of every association,
//      federation, chamber and union ('Tüketici Hakları Derneği Genel Başkanı'),
//      so they admit a headline only with a party marker in the title or the
//      description (PARTY_OFFICE_TITLE_RE, PARTY_MARKER_RE; hunt-21).
//      The bare stem 'dünya' is a dunya marker only when it is not a life-event or
//      sport-event idiom ('dünyaya geldi', 'dünyaevine girdi', 'Dünya
//      Şampiyonası') or when the TITLE names a place abroad: see hunt-32 below.
//   5. Tokens of three letters or fewer match as whole words; longer stems are
//      anchored at a word start and may carry any suffix.
//   6. Four words whose fold collides with another word (gol / göl,
//      çin / cin, irak / ırak, TİP / tıp) are matched on the unfolded lowercase
//      view with letter boundaries.
//
// hunt-22 (2026-11-02) replay, read-only: base ec94980 against this module over
// 16,028 stored rows of 48 h (2026-10-31 10:30Z .. 2026-11-02 10:30Z). The gate
// (politika | son_dakika) goes from 2,778 rows (17.3%) to 2,738 (17.1%): 0 rows
// enter, 40 leave, and the other 15,988 rows keep their category (no change
// inside the gate or outside it). All 40 leavers were labelled by hand and none
// is political:
//   * 12 members of the Şanlıurfa Ticaret ve Sanayi Odası (ŞUTSO) election
//     cluster (a poll worker's heart attack), 5 more chamber elections (Van TSO
//     x2, Erzincan TSO x2, Gebze Ticaret Odası), 4 Fenerbahçe candidate remarks,
//     the Galatasaray 'Seçim fırtınası', a federation general assembly
//     ('oy birliğiyle');
//   * 5 'Cumhurbaşkanlığı 7. Uluslararası Yat Yarışları' rows and 4 horse-race
//     rows ('Cumhurbaşkanlığı Koşusu' / 'Kupası');
//   * 3 'Cadılar Bayramı partisi' brawls (bare 'parti' + 'gözaltı'), the oil
//     story with the US 'Cumhuriyetçi Parti' and 'İran'a yönelik operasyonlar';
//   * 'hava muhalefeti' (a power cut), 'Recep Tayyip Erdoğan Millet Bahçesi' (a
//     Kayseri cycling event), 'şair, yazar ve siyasetçi Yahya Kemal Beyatlı',
//     'doğru ürün seçimiyle' (a cleaning-paper maker).
// The first cuts of four rules were measured and changed: the whole-text
// variant of every electorate word dropped two political rows (see
// SECIM_TITLE_RE), a blanket `siyaset(?!ci)` in the description dropped five
// (two political, see POLITIKA_DESC_RE), reading 'Tip' as the party TİP let a
// North Korean cluster-bomb row IN, and dropping the bare 'parti' without a
// party-office form dropped a detained party leader (see COMPOUND_PARTY_RE).
// Review replay (7 days, 71,162 rows, published 2026-10-26 .. 2026-11-02): the
// gate goes from 13,210 to 13,120 rows (109 leave, 19 enter). The first cut of
// the same replay had 131 leavers: 22 of them were political (bar elections and
// the Kanadoğlu investigation, an Israeli election vetoed by 'Tel Aviv
// Borsası', TİP students, party-leader stories) and are back in. The 19 that
// enter are the TİP students / Bakan Tekin banner story (17 rows, scattered over
// spor, yasam and genel at base because the text says "TİP'li") and two EMEP
// rows. The 109 leavers were read by hand: chamber and club elections, the
// regatta, horse races, 'hava muhalefeti', Erdoğan venues, Halloween brawls,
// the oil story, a hurricane death, Yahya Kemal Beyatlı, 'ürün seçimi'.
// Known residuals: a poll worker's death whose text names no chamber at all
// (haberturk, the 13th ŞUTSO member), 'İSİG Meclisi' (an NGO, 'meclis'), an AK
// Parti deputy congratulating Eskişehirspor (the title says 'milletvekili'),
// and 'siyaset' in a list of local stakeholders (Kızılay Balıkesir).
//
// hunt-31 (2026-11-04) gate precision: three non-political clusters sat in the
// gate, each through a rule that has a political sense and a non-political one.
//
//   * 'meclis' (was a POLITIKA_STEMS entry) is MECLIS_RE now and counts, in the
//     title and in the description, unless the text names a chamber / TSO / TOBB /
//     İTO / club and NO state assembly (stateMeclis, STATE_ASSEMBLY_RE). The İTO
//     chair election (cluster 00e97812, 10 outlets) says '270 Meclis üyesinin
//     251'sinin oyunu alarak'. 'İTO' is in the MECLIS-only organisation pattern
//     (MECLIS_ORG_RE), not in ORG_ELECTORATE_RE: two of the ten members (Aydınlık,
//     OdaTV) write only 'İTO', and the 'oy' and 'seçim' rules stay as they were.
//   * 'muhalefet' loses the legal phrase 'kanuna muhalefet' ('Siber Güvenlik
//     Kanununa muhalefet', the İçişleri fraud and illegal-betting operation of
//     cluster ab868b2d, 12 outlets) next to the old 'hava muhalefeti'. Dative
//     forms only, so 'Yeni yasa muhalefetin tepkisini çekti' stays politika.
//   * 'siyaset dünyası' right after a sector list ('iş ve', 'iş, sanat ve',
//     'spor,') is a list of mourners or guests, not politics (the Zorlu Holding
//     chair's funeral, cluster 09779679, 5 outlets). Every other 'siyaset' keeps
//     admitting; 'siyasetçi' is untouched.
//
// Replay, read-only: HEAD (hunt-30 build) against this module over every stored
// row created 2026-10-28 14:00Z .. 2026-11-04 13:39Z (66,578 rows, 0 duplicate
// ids; 15,588 stored politika or son_dakika). The gate (politika | son_dakika) of
// the classifier goes from 12,700 rows to 12,631: 0 rows enter, 69 leave, 0
// change between politika and son_dakika, and the other 66,509 rows keep their
// category. All 69 leavers were read by hand and none is political:
//   * 44 chamber 'meclis' rows: 11 İTO chair-election rows, 13 İstanbul Sanayi Odası
//     (İSO) election rows (one of them the İTO + İSO wrap 'İstanbul yarışında son
//     tur!'), 2 TOBB İçecek Sanayi Meclisi rows, and 18 rows of the Düzce, Samsun,
//     Elazığ, Tokat, Bilecik, Beypazarı, Kayseri, Adana (ATO) and Bursa (BTSO,
//     TEKNOSAB) chambers; exactly three rows leave through 'İTO' alone (Aydınlık,
//     OdaTV, and the İTO + İSO wrap);
//   * 19 'kanun* muhalefet' rows: 11 of the İçişleri operation (10 members of cluster
//     ab868b2d and one more Haberler.com wrap) and 8 charges of the same shape
//     (2863 / 5607 / 7258 sayılı Kanun'a, Vergi Usul Kanunu, Kültür ve Tabiat
//     Varlıklarını Koruma Kanunu: contraband, illegal alcohol, a looted-site raid,
//     an unpaid-tax arrest warrant);
//   * 6 'iş ve siyaset dünyası' rows: 5 of the Zorlu funeral and the gala of the
//     film Çatlı 2 ('iş, sanat ve siyaset dünyasından ... davetli').
// Known residuals: two members of cluster ab868b2d (Haberler.com, Sputnik Türkçe)
// stay politika because their HEADLINE says 'İçişleri Bakanlığı' (a POLITIKA_TITLE_RE
// office word, unchanged); 'iş dünyasının ve siyaset dünyasının' (the sector word
// is not right before 've') and 'siyaset ve iş dünyası' still admit; 'yasalara
// muhalefet' (plural dative) still admits; 'oda' in the sense of a ROOM beside
// 'Meclis' with no TBMM / Millet Meclisi would leave, as it already does for 'seçim'
// and 'oy' (none of the 66,578 rows). Three rows with 'meclis' and a chamber word
// stay in the gate through another marker (AK Parti, MHP, TBMM / İYİ Parti).
//
// hunt-32 (2026-11-04) dünya idioms: the bare stem 'dünya' (a word start, any
// suffix) was a dunya marker, so 'dünyaevine girdi', 'dünyaya geldi' and 'Dünya
// Şampiyonası' filed weddings, births and sport results as world news (five hours
// of stored rows: 412 dunya rows, 50 with no other marker, 34 of them through a
// compound). Dropping the stem (wave BN) was rejected at review: a 7-day replay
// changed 1,233 rows, 905 leaving dunya and 138 entering. This keeps the stem, the
// marker list (DUNYA_MARKER_RE), the chain order and the whole politika gate, and
// takes out only the occurrences that are idioms:
//
//   * L, life events: 'dünyaya gel* / getir*', 'dünyaya gözlerini aç*',
//     'gözlerini dünyaya ...', 'dünyaevi*' / 'dünya evine'.
//   * S, sport events: 'Dünya [<=3 words] Şampiyonası' and 'Dünya [<=2 words]
//     Kupası'. A row that leaves dunya through S goes to spor.
//
// A row leaves dunya only when ALL of these hold (dunyaIn): (a) no base marker is
// anywhere in the text (a DUNYA_MARKER_RE word, 'çin' or 'irak'); (b) every
// 'dunya' of the title and the description is an idiom (DUNYA_PLAIN_RE finds none:
// 'dünyada', 'dünyadaki', 'dünyayı', 'dünya genelinde', 'yeni dünya düzeni',
// 'Dünya Bankası', 'Dünya Sağlık Örgütü', 'dünya şampiyonu / ikincisi', 'Türk /
// İslam / Arap / Batı dünyası', 'dünyanın öbür ucu' are plain uses and keep
// dunya); (c) the foreign veto FOREIGN_RE does not fire on the TITLE. FOREIGN_RE
// matches country NAMES with any suffix ('Nijeryalı', 'İtalyan' count) but not the
// separate demonym words ('Alman', 'İngiliz', 'Fransız', 'Japon', 'Rus').
//
// Why the veto reads the title for L and S, not the whole text: a birth, a wedding
// or a championship is world news when the HEADLINE places it abroad. The named
// rows conflict with a whole-text country veto: Leclerc's description names the
// 'Brezilya Grand Prix'si' (a driver's daughter is born, the title is
// 'Charles Leclerc baba oldu'); the description of 14b2c693 names Hindistan and
// Yeni Delhi (Turkish wrist wrestlers' nine medals); the Mercedes G-Serisi row
// says 'Alman otomotiv devi'. The Malezya Grand Prix rows (b5a21766, 11eb80b1) and
// the Portekiz triathle row have the country in the HEADLINE and stay dunya.
// The first design had a second scope for the W idioms (a sector word + 'dünyası',
// 'dünyanın [<=2 words] en', 'dünyaca', 'Dünya Miras*' / 'dünya rekor*'): the
// veto read title + description there, the brief's literal rule.
//
// The W idioms are NOT shipped. The 7-day replay (below) changed 293 rows with all
// six families (W1 137, W2 75, W3 45, L 25, S 12, W4 1; a row can carry two) and
// the cap is 60, so the families were cut in a fixed order and re-measured: W4 ->
// 292 rows, W3 -> 247, W2 narrowed to the adjacent 'dünyanın en' -> 244, W2
// removed -> 172, W1's sector list cut to nine words (iş, siyaset, sanat, futbol,
// spor, otomobil, gösteri, moda, müzik) -> 114, W1 removed -> 35. The W rows were
// read by hand: most were Turkish or celebrity stories (the Zorlu funeral 'iş ve
// siyaset dünyası', the 'Türk Tıp Dünyası Kurultayı', the Kekova wreck in the
// Guinness book, 'dünyaca ünlü' actors, the Binance hack), but five were foreign:
// the Trevi fountain of Roma, the Kowloon Walled City in Hong Kong, Nauru's
// phosphate wealth ('Naoero'), the Dead Sea sinkholes and a municipal-supermarket
// story of 'dünyanın en büyük şehirlerinden biri' (the last two name no place in
// the stored 120 characters, so no veto entry can fix them). The lookarounds of
// the cut families, for a later wave that brings its own replay and a narrower
// veto: W1 (?!s(?<=\b<sector>\s+dunyas)), W2 (?!nin(?:\s+[a-z]+){0,2}\s+en\b),
// W3 (?!ca\b), W4 (?!\s+(?:miras|rekor)).
//
// Replay, read-only: HEAD (hunt-31 build) against this module over every stored
// row created 2026-10-28 15:00Z .. 2026-11-04 15:12Z (67,066 rows, 0 duplicate ids;
// 15,597 stored politika or son_dakika). 35 rows change, all from dunya: 19 to
// genel, 12 to spor, 2 to yasam, 1 to ekonomi, 1 to teknoloji. 0 rows enter dunya,
// 0 rows of any other category change, and the gate (politika | son_dakika) is
// 12,702 rows before and after (0 rows reach son_dakika through the prefix path).
// All 35 were read by hand and none is foreign: 23 L rows (Tuğrul Şan's wedding in
// Ordu, the Göreme rock-fall couple who had just 'dünyaevine girmişti', lambs, a
// Kangal litter, Leclerc's daughter, a wedding date) and 12 S rows (Turkish
// wrestlers, a weightlifter, a shooter, the F1 title run; the venue, when named,
// is only in the description). Known residuals, pinned in the tests: the Tesla
// market-value list (W2), Mercedes G-Serisi and Kim Kardashian (W1), Hailey
// Bieber (W3), the UNESCO 'Dünya Mirası' list (W4), the Netflix film about London's
// 'yeraltı dünyası' (W1), 'dünyanın öbür ucuna' (not in the idiom list). The word
// windows of the lookarounds run across the newline between the title and the
// description, so a title ending in 'dünya' can borrow an S idiom from the first
// words of the description (one of the 35 rows, 13cfce1e 'Milli sporcumuz dünya
// ikincisi', where it is right).
//
// Linear: every pattern starts with the literal 'dunya' (or 'gozlerini'), so the
// lookarounds run only at a hit; each is bounded by at most four words or by one
// run of white space, and [a-z0-9-] and \s are disjoint, so a failed word run is
// never re-split; the runs of white space of two hits are disjoint, so the sum over
// a text is linear. FOREIGN_RE is a plain alternation of word-start stems, read on
// the title only. The tests time the worst shapes at 200k characters (the worst
// pair of calls was 71.9 ms on a busy machine; the old classifier 28.9 to 96.9 ms).
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
//
// The tables are shared by two compiled patterns: POLITIKA_RE (the title) and
// POLITIKA_DESC_RE (the description), which differ in ONE stem. 'siyaset' is a
// politics word in both ('siyaset kulisleri'), but 'siyasetçi' is also an
// OCCUPATION, and in a description it decorates a biography ('şair, yazar ve
// siyasetçi Yahya Kemal Beyatlı'). The description pattern therefore skips a
// 'siyasetçi' that follows 've' (an occupation list); the title keeps every
// form (hunt-22). A blanket `siyaset(?!ci)` in the description moved five rows
// out of the 48 h replay, and two of them were political (a Serbian student
// list that won the parliamentary election, a column on harassment claims
// against politicians), so only the biography shape is cut.
//
// 'kurtulmus' / 'babacan' are surnames, which take an apostrophe
// ("Kurtulmuş'tan"): whole words, so the participle 'kurtulmuştu' is not them.
// 'ozdag' is a whole word too ('gozdagi' is a threat); 'pkk' is a token;
// 'btp' is the Bağımsız Türkiye Partisi (hunt-21: 162 titles over 30 days
// matched it as a word, every one the party, no other expansion).
//
// 'oy' (the vote) is NOT in the table: it is VOTE_RE, below, because a vote in
// a chamber or club election ('oy verme işlemi sırasında' in the Şanlıurfa
// Ticaret ve Sanayi Odası cluster) is no more politics than the 'seçim' it
// belongs to.
const POLITIKA_WHOLE = [
  "chp", "akp", "mhp", "hdp", "kurtulmus", "babacan", "pkk", "ozdag", "btp",
];
const POLITIKA_STEMS = [
  // 'muhalefet' is a raw pattern below: 'hava muhalefeti' is the weather.
  // 'meclis' is MECLIS_RE (hunt-31): a chamber has an assembly too.
  "milletvekil", "anayasa", "tbmm",
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
];
const POLITIKA_RAW = [
  // 'Bahcelievler' is a neighbourhood, not the MHP leader
  "\\bbahceli(?!ev)",
  // 'Recep Tayyip Erdoğan Stadyumu' / 'Erdoğan Üniversitesi' are venues, and so
  // is every other place that carries the president's name (hunt-22: 'Recep
  // Tayyip Erdoğan Millet Bahçesi' admitted a Kayseri cycling event). Only the
  // NAMED-venue forms are listed: 'Erdoğan camiden çıkışta', 'Erdoğan kongrede'
  // and 'Erdoğan parkta' are still the president ('camii' is the mosque,
  // 'parki' the possessive of 'park'). Every alternative starts with a letter
  // and the optional group sits between two literals, so the lookahead is
  // linear.
  "\\berdogan(?!\\s+(?:stad|univ|millet\\s+bahce|parki|bulvari|caddesi|kongre\\s+(?:ve\\s+kultur\\s+)?merkez|kultur\\s+merkez|hastanesi|camii|kulliyesi|spor\\s+salon|lisesi))",
  // 'hava muhalefeti' (adverse weather, the excuse of a power cut) is not the
  // opposition, and neither is the legal phrase 'kanuna muhalefet' (hunt-31:
  // "Siber Güvenlik Kanununa muhalefet" is a charge, the İçişleri fraud
  // operation of cluster ab868b2d). The literal comes FIRST and the lookbehinds
  // follow it, so they run only at a 'muhalefet' that is already a hit. Each is
  // variable length but linear: its scan is bounded by one word plus one run of
  // white space, and a text holds only so many hits (the runs are disjoint). The
  // law forms are DATIVE on purpose ('kanun' + any suffix + 'a': kanuna,
  // kanununa, kanun'a, kanunlara; 'yasa' + any suffix + 'ya' / 'na': yasaya,
  // yasasına), because the nominative 'Yeni yasa muhalefetin tepkisini çekti' and
  // 'Kanun teklifi muhalefetin itirazına rağmen kabul edildi' are the opposition.
  // 'yasak' (a ban) shares the 'yasa' prefix but is NOT the law: 'Miting
  // yasağına muhalefetten sert tepki' and 'Eylem yasaklamasına muhalefet tepki
  // gösterdi' are the opposition reacting to a ban. The text is folded first, so
  // the ban is 'yasak…' before a consonant suffix (yasaklamasına, yasaklarına)
  // and 'yasag…' before a vowel suffix (yasağına -> yasagina); `(?![kg])` after
  // 'yasa' excludes both, and no law form has a k or g there (yasaya, yasası,
  // yasasına). The lookahead sits inside the lookbehind and is one character
  // wide, so the guard stays linear.
  String.raw`\bmuhalefet(?<!\bhava\s+muhalefet)(?<!\bkanun[a-z']*a\s+muhalefet)(?<!\byasa(?![kg])[a-z']*[yn]a\s+muhalefet)`,
  // 'İşçi Partisi' (the Turkish TİP, Brazil's PT, the British Labour Party),
  // but not the Korean Workers' Party ('Kore İşçi Partisi', 'Kuzey Kore İşçi
  // Partisi', 'Kore'nin İşçi Partisi'): the hunt-20 replay's one false hit
  // was a North Korean warhead test (milliyet, /dunya/) admitted by the
  // description. Other countries' labour parties stay: they are party news
  // like the 'arap partil' / 'sol partil' headlines. The lookbehind is
  // variable-length but linear: its scan is bounded by one run of white space
  // and runs only where 'işçi parti' is already about to match.
  "(?<!\\bkore(?:'[a-z]+)?\\s+)\\bisci\\s+parti",
];
// 'siyaset dünyası' after a sector word is a list of mourners, guests or fans,
// not politics (hunt-31: "İş ve siyaset dünyası Levent'te buluştu", the funeral
// of the Zorlu Holding chair, cluster 09779679). SIYASET_LIST_GUARD is a
// negative lookbehind that sees the sector list ('iş ve', 'iş, sanat ve', 'spor,')
// right before 'siyaset'; it is tried only where 'siyaset' is followed by
// 'dünya', so every other 'siyaset' ('siyaset kulisleri', 'Siyaset dünyasında
// deprem', 'siyasetçi') keeps admitting. Variable length but linear: its scan is
// bounded by one word, one run of white space and one word.
const SIYASET_SECTOR = "(?:is|sanat|spor|kultur|bilim|medya|ekonomi)";
const SIYASET_LIST_GUARD = String.raw`(?<!\b${SIYASET_SECTOR}(?:\s+ve|\s*,)\s+siyaset)`;
const SIYASET_TITLE = String.raw`\bsiyaset(?:(?!\s+dunya)|${SIYASET_LIST_GUARD})`;
const SIYASET_DESC = String.raw`\bsiyaset(?!ci)(?:(?!\s+dunya)|${SIYASET_LIST_GUARD})`;

const POLITIKA_RE = compile(POLITIKA_WHOLE, POLITIKA_STEMS, [...POLITIKA_RAW, SIYASET_TITLE]);
const POLITIKA_DESC_RE = compile(
  POLITIKA_WHOLE,
  POLITIKA_STEMS,
  // 'siyaset' and every form of 'siyasetçi' except the occupation in a list of
  // occupations ('şair, yazar ve siyasetçi Yahya Kemal Beyatlı'); the lookbehind
  // is bounded by one run of white space, like the 'hava' guard.
  [...POLITIKA_RAW, SIYASET_DESC, "(?<!\\bve\\s+)\\bsiyasetci"],
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
//   * named office holders and the İBB trial (wave BD, hunt-25): a headline
//     that NAMES the person without the office word ('Cevdet Yılmaz: Diplomasi
//     ve diyalogdan asla vazgeçilmemelidir', the 'Cumhurbaşkanı Yardımcısı' is
//     in the description) fell out of the gate when #167 moved 'cumhurbaşkan' /
//     'bakan' here. Read-only SQL, 2026-11-02: 23 'Cevdet Yılmaz' titles
//     created before 06:00Z (the old classifier) were 96% politika / son_dakika,
//     the 10 created after it are 30%; seven rows from six outlets sat in
//     dunya / ekonomi beside clustered siblings. 'ibb davas' is the same loss
//     for the trial: 'ibb' is only a COMPOUND_BODY word that needs an action,
//     'dava' is not one, and 4 'İBB davasında ...' rows (sozcu, dokuz8,
//     medyascope = genel; son-dakika = ekonomi) stood next to 11 clustered
//     siblings. 'hakan fidan' (the foreign minister without 'Dışişleri
//     Bakanı') and 'sinirlioglu' (Feridun Sinirlioğlu, Turkey's UN candidate)
//     are the same shape. They are title-only like the office words: in a
//     description the name is a mention. 'fuat oktay' and 'mehmet simsek' are
//     NOT stems: the wave-AX meta test pins that its rows need more than a
//     bare name, and 'Mehmet Şimşek' headlines are economy wraps ('Bakan
//     Şimşek' already admits through 'bakan'; 'Şimşekspor' is a club and 'Vali
//     Yılmaz Şimşek' a governor). The 7-day replay (stored rows, read-only) put
//     every entering row on a political story and moved none out.
const POLITIKA_TITLE_RE = compile(
  [],
  [
    "siyasi", "siyasal", "ibb baskan", "parlamento", "referandum",
    "arap partil", "sol partil",
    "bakan", "basbakan", "hukumet",
    "belediye baskan", "icisleri", "disisleri", "kabine",
    "sarigul",
    "cevdet yilmaz", "hakan fidan", "sinirlioglu", "ibb davas",
  ],
);

// 'secim' and 'cumhurbaskan' left the list above in hunt-22 because each is
// also the vocabulary of a non-political story, and a title hit beats sport:
//   * 'secim' is a CLUB board election ('Galatasaray bir anda karıştı! Seçim
//     fırtınası esiyor'), a CHAMBER election (the Şanlıurfa Ticaret ve Sanayi
//     Odası cluster: 'ŞUTSO seçimlerinde kalp krizi geçiren sandık görevlisi',
//     13 rows) or a CHOICE ('doğru ürün seçimiyle'). SECIM_TITLE_RE counts only
//     when the title is not sport, names no non-state electorate
//     (NON_STATE_ELECTORATE_RE) and is not the choice sense (CHOICE_SECIM_RE).
//     Three of the 13 chamber rows name the chamber only in the description
//     ('Seçimde acı olay! Sandık görevlisi hayatını kaybetti'), so the
//     UNAMBIGUOUS organisations (ORG_ELECTORATE_RE: oda, TSO, TOBB, kulüp) are
//     read in the whole text; a Fenerbahçe candidate's
//     election remark names the club only in the description. The other words
//     are read in the title alone: the whole-text variant of all of them
//     dropped two political rows of the 48 h replay (a Bulgarian presidential
//     vote cast 'dernekte' in Sakarya, a Brazilian election essay with
//     'sendikal örgütlenme').
//     See secimInTitle and voteIn.
//   * 'cumhurbaskan' is the name of a regatta ('Cumhurbaşkanlığı 7.
//     Uluslararası Yat Yarışları'), a horse race, a cycling tour and a cup. It
//     counts unless a sporting-event noun FOLLOWS it in the title
//     (SPORT_EVENT_AFTER_RE): a noun before it ('Kupa töreninde Cumhurbaşkanı
//     konuştu') does not drop it, and 'cumhurbaşkanlığı yarışı' (singular, an
//     election race) and 'yatırım' are not in the list. See cumhurbaskanInTitle.
const SECIM_TITLE_RE = /\bsecim/;
// A chamber (oda / odasi / odalar, TSO and its prefixed forms ŞUTSO / İTSO,
// TOBB) or a club (kulüp / kulübü). Word starts only: 'odatv' and 'odak' are not
// them; the prefix of 'tso' is at most five letters, so the scan is bounded.
//
// NOT a bar (baro) and NOT a stock exchange (borsa). The first cut listed both
// and a 7-day replay (71,162 rows) showed what they cost: bar elections are
// contested along political lines (the İstanbul and İzmir Bar elections won by
// nationalist-secularist slates; the prosecutor's investigation of a candidate
// over his speech at the İstanbul Bar general assembly; a column on the Brazil,
// Serbia and İstanbul Bar elections), and 'Tel Aviv Borsası' alone vetoed an
// Israeli general election story. A stock exchange is not an electorate at all
// (TOBB already covers the commodity exchanges that hold chamber elections).
const ORG_ELECTORATE_RE =
  /\boda(?:s|lar|\b)|\b[a-z]{0,5}tso\b|\btobb\b|\bkulub|\bkulup/;
// A federation (but not 'Rusya Federasyonu', the state), an association, a
// union, a student council.
const OTHER_ELECTORATE_RE =
  /(?<!\brusya\s+)\bfederasyon|\bdernek|\bsendika|\bogrenci\s+meclis/;
const NON_STATE_ELECTORATE_RE = new RegExp(
  `${ORG_ELECTORATE_RE.source}|${OTHER_ELECTORATE_RE.source}`,
);
// 'meclis' is politics only when it is a STATE assembly (hunt-31). A chamber has
// an assembly too: the İstanbul Ticaret Odası (İTO) chair election, cluster
// 00e97812 (10 outlets), says '270 Meclis üyesinin 251'sinin oyunu alarak', and
// 'meclis' was a POLITIKA_STEMS entry that the chamber / club exemption of the
// 'oy' and 'seçim' rules never reached. A word start, any suffix ('meclisi',
// "Meclis'te", 'meclisinde').
const MECLIS_RE = /\bmeclis/;
// The organisations whose 'meclis' is not the state's: ORG_ELECTORATE_RE plus İTO,
// the Istanbul chamber's own acronym. Two of the ten İTO members of cluster
// 00e97812 (Aydınlık, OdaTV) never write 'Oda' or 'TSO', only 'İTO'. 'İTO' is NOT
// in ORG_ELECTORATE_RE: that would also move the 'oy' and 'seçim' rules, which
// this wave leaves alone.
const MECLIS_ORG_RE = new RegExp(`${ORG_ELECTORATE_RE.source}|\\bito\\b`);
// A text that names the state assembly itself (TBMM, Millet Meclisi, a municipal
// or provincial council, a deputy) keeps 'meclis' politics even beside a chamber
// ('Ticaret odası başkanı TBMM'de konuştu'). Word starts; 'tbmm' is a whole word.
const STATE_ASSEMBLY_RE =
  /\btbmm\b|\bmillet\s+meclis|\bbelediye\s+meclis|\bil\s+genel\s+meclis|\bmilletvekil/;
// 'doğru ürün seçimiyle', 'renk seçimi', 'okul seçimi'
const CHOICE_SECIM_RE = /\b(?:urun|renk|malzeme|kiyafet|menu|meslek|okul)\s+secim/;
// 'oy' as a whole word ('oy kullandı', 'oy sayımı'): politics unless the text
// names a non-state electorate. A party, a leader or the Meclis in the same
// text admits through POLITIKA_RE on its own.
const VOTE_RE = /\boy\b/;
const CUMHURBASKAN_TITLE_RE = /\bcumhurbaskan/;
const SPORT_EVENT_AFTER_RE =
  /\b(?:yat\s+yaris|yelken|kupa|turnuva|bisiklet|maraton|ralli|kosusu|golf|satranc|atletizm)/;

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
const COMPOUND_BODY_RE = /\bbelediye|\bibb\b/;
// A party counts as a body when the text NAMES it, not when it merely says
// 'parti'. A bare 'parti' no longer is (hunt-22: the US 'Cumhuriyetçi Parti' next
// to 'ABD ve İsrail'in İran'a yönelik operasyonları' in an oil-price story, and
// three 'Cadılar Bayramı partisi' brawls with 'gözaltı'). What does count:
//   * the named parties and acronyms that never say 'parti' (the named ones are
//     POLITIKA_RE hits already), 'DP' but not 'DP World' (a port operator);
//   * a party with its organisation noun after it ('Parti yöneticileri',
//     'Raam Partisi liderlerinin', 'Emek Partisi üyelerine'), or 'partili': an
//     event party has none ('Cadılar Bayramı partisi', 'doğum günü partisi');
//   * 'parti bina' (the office of a domestic party, two hunt-19 tests pin it);
//   * a party office in the text together with a party word ('Cumhuriyetçi
//     Vatanseverler Partisi Genel Başkanı Serkan Öz gözaltına alındı':
//     PARTY_OFFICE_TITLE_RE and PARTY_MARKER_RE, also read on the whole text).
// TİP is read separately (TIP_MEMBER_RE): 'tip' (type) is a word, and 'Standart
// Tip 2 misket bombası ... operasyonel' (a North Korean test) entered the gate
// through it in the 48 h replay.
//
// The first cut of hunt-22 kept only the acronyms and dropped, in the 7-day
// replay, the TİP students jailed over a banner against the education minister
// (their text says "TİP'li" and 'Parti yöneticileri'), an Israeli Arab-party
// leaders story and the Indian CPI(M) voter-roll story; hand probes dropped
// 'Emek Partisi üyelerine operasyon', 'SOL Parti üyelerine gözaltı' and 'TKP
// üyesi 5 kişi gözaltına alındı'. Those are the opposition stories the
// blindspot feature exists for.
const COMPOUND_PARTY_RE = new RegExp(
  [
    // Turkish parties that never say 'parti' (TKP joins the acronyms of
    // PARTY_MARKER_RE: 'TKP üyesi 5 kişi gözaltına alındı').
    String.raw`\b(?:bbp|yrp|btp|dsp|emep|hkp|ctp|ubp|tkp)\b`,
    String.raw`\bdp\b(?!\s+world)`,
    String.raw`\bhuda\s+par\b`,
    // Named parties outside the tables: 'Emek Partisi', 'SOL Parti', and a
    // communist party (the Indian CPI(M) is 'Hindistan Komünist Partisi').
    String.raw`\b(?:emek|sol|komunist)\s+parti`,
    String.raw`\bparti\s+bina`,
    // A party named by its ORGANISATION, whatever its name: members, officials,
    // leaders, spokespeople, deputies, provincial chairs ('Parti yöneticileri',
    // 'Raam Partisi liderlerinin', 'partisinin yöneticileri'), or 'partili' (a
    // party member). An event party never has these nouns after it ('Cadılar
    // Bayramı partisi', 'uyuşturucu partisi', 'doğum günü partisi'). Each start
    // is a word start and the \w* / \s+ runs are disjoint, so the scan is
    // linear.
    String.raw`\bparti\w*\s+(?:uye|yonetici|lider|temsilci|sozcu|milletvekil|mensup|il\s+baskan|ilce\s+baskan)`,
    String.raw`\bpartili`,
  ].join("|"),
);
// 'TİP' is read on the unfolded view (it folds to the same 'tip' as 'tıp',
// medicine, and 'Standart Tip 2' is a missile warhead), so only its member
// forms count: "TİP'li", 'TİP üyesi', 'TİP il başkanı'.
const TIP_MEMBER_RE =
  /(?<!\p{L})tip(?:['’ʼ]l[iı](?!\p{L})|\s+(?:[üu]ye|il\s+başkan|ilçe|milletvekil|gençlik))/u;
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

// World news: the base markers (countries, blocs, leaders) and the bare stem
// 'dunya'. The stem is NOT a marker by itself: see 'hunt-32 dünya idioms' in the
// header, and dunyaIn below.
const DUNYA_WHOLE = ["abd", "eu", "bm", "nato"];
const DUNYA_MARKER_STEMS = [
  "amerika", "rusya", "ukrayna", "avrupa", "birlesmis milletler",
  "ingiltere", "almanya", "fransa", "iran", "israil", "filistin", "gazze",
  "suriye", "uluslararasi", "kuresel", "beyaz saray", "putin",
  "trump",
];
const DUNYA_MARKER_RE = compile(DUNYA_WHOLE, DUNYA_MARKER_STEMS);
const DUNYA_STEM_RE = /\bdunya/;

// One lookaround per idiom family, each tried right after the literal 'dunya': a
// 'dunya' that none of them rules out is a PLAIN use (dünyada, dünyayı, Dünya
// Bankası, yeni dünya düzeni, Türk dünyası, iş dünyası, dünyaca ünlü, ...). To drop
// a family, delete its line. Linear: see the header.
const DUNYA_IDIOM_LOOKAROUNDS: readonly string[] = [
  // L: dünyaya gel* / getir* / gözlerini aç*, gözlerini dünyaya ..., dünyaevi*
  String.raw`(?<!\bgozlerini\s+dunya)`,
  String.raw`(?!ya\s+(?:gel|getir|gozlerini\s+ac))`,
  String.raw`(?!\s*evi)`,
  // S: Dünya [<=3 words] Şampiyonası, Dünya [<=2 words] Kupası
  String.raw`(?!\s+(?:[a-z0-9-]+\s+){0,3}sampiyona)`,
  String.raw`(?!\s+(?:[a-z0-9-]+\s+){0,2}kupa)`,
];
const DUNYA_PLAIN_RE = new RegExp(String.raw`\bdunya` + DUNYA_IDIOM_LOOKAROUNDS.join(""));

// The S families: a row that leaves dunya through one of them is a sport event.
const DUNYA_SPORT_EVENT_RE = new RegExp(
  String.raw`\bdunya\s+(?:[a-z0-9-]+\s+){0,3}sampiyona|\bdunya\s+(?:[a-z0-9-]+\s+){0,2}kupa`,
);

// The foreign veto, read on the TITLE: a country, capital, leader or
// international organisation. It matches country NAMES with any suffix
// ('Nijeryalı', 'İtalyan'), not the separate demonym words ('Alman', 'İngiliz',
// 'Fransız', 'Japon', 'Rus').
// Deliberately absent, for their collisions: misir (corn), mali (fiscal), sam,
// bagdat, asya (a name), roma, cad, sili, karadag, sofya, umman, fas.
const FOREIGN_WHOLE = [
  "ab", "bae", "kktc", "imf", "oecd", "opec", "g7", "g20", "iit", "dso", "tdt",
  "agit", "peru", "modi", "lula", "tusk",
];
const FOREIGN_STEMS = [
  // countries
  "japonya", "pakistan", "afganistan", "banglades", "sri lanka", "srilanka",
  "nepal", "endonezya", "malezya", "singapur", "tayland", "vietnam", "filipin",
  "tayvan", "mogolistan", "kazakistan", "ozbekistan", "kirgizistan",
  "turkmenistan", "tacikistan", "azerbaycan", "gurcistan", "ermenistan",
  "kibris", "suudi", "kuveyt", "bahreyn", "birlesik arap", "yemen", "urdun",
  "lubnan", "libya", "tunus", "cezayir", "sudan", "etiyopya", "somali", "kenya",
  "nijer", "gana", "senegal", "kamerun", "ruanda", "uganda", "tanzanya",
  "mozambik", "angola", "zimbabve", "kongo", "afrika", "yunanistan",
  "bulgaristan", "romanya", "moldova", "macaristan", "polonya", "cekya",
  "slovakya", "slovenya", "hirvatistan", "sirbistan", "bosna", "kosova",
  "arnavutluk", "makedonya", "italya", "ispanya", "portekiz", "hollanda",
  "belcika", "luksemburg", "isvicre", "avusturya", "danimarka", "isvec",
  "norvec", "finlandiya", "izlanda", "irlanda", "birlesik krallik", "iskocya",
  "litvanya", "letonya", "estonya", "belarus", "kanada", "meksika", "brezilya",
  "arjantin", "kolombiya", "venezuela", "kuba", "avustralya", "yeni zelanda",
  "balkanlar", "ortadogu", "orta dogu", "kafkasya", "korfez ulke",
  // capitals and cities
  "washington", "new york", "moskova", "kiev", "kyiv", "londra", "paris",
  "berlin", "bruksel", "pekin", "tokyo", "seul", "tahran", "tel aviv", "kudus",
  "beyrut", "kahire", "riyad", "doha", "dubai", "abu dabi", "islamabad",
  "kabil", "yeni delhi", "baku", "tiflis", "erivan", "atina", "belgrad",
  "saraybosna", "viyana", "varsova", "budapeste", "prag", "madrid", "lizbon",
  "amsterdam", "cenevre", "vatikan", "astana", "taskent", "havana", "karakas",
  "oslo", "stokholm", "kopenhag", "helsinki", "dublin",
  // leaders and organisations
  "zelenski", "zelensky", "netanyahu", "biden", "macron", "merz", "scholz",
  "starmer", "meloni", "cinping", "jinping", "aliyev", "pezeskiyan", "hamaney",
  "esad", "vucic", "orban", "milei", "maduro", "guterres", "rutte",
  "von der leyen", "kim jong", "tokayev", "lavrov", "rubio", "unesco", "unicef",
  "interpol", "europol", "kizilhac", "islam isbirligi", "turk devletleri",
  "hamas", "hizbullah", "husi", "taliban", "deas", "isid", "buyukelci",
  "konsolos", "diplomat", "devlet baskan",
];
// 'koreografi', 'Hindistan cevizi' and 'katarakt' are not the countries.
const FOREIGN_RAW = [
  String.raw`\bkore(?!ograf)`,
  String.raw`\bhindistan(?!\s+ceviz)`,
  String.raw`\bkatar(?!akt)`,
];
const FOREIGN_RE = compile(FOREIGN_WHOLE, FOREIGN_STEMS, FOREIGN_RAW);

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

// A non-state electorate: any of the words in the title, or a chamber / club
// anywhere in the text (see the note above SECIM_TITLE_RE).
function nonStateElectorate(titleHay: string, hay: string): boolean {
  return NON_STATE_ELECTORATE_RE.test(titleHay) || ORG_ELECTORATE_RE.test(hay);
}

// 'oy' in the given text is a state vote unless the text names a non-state
// electorate (see VOTE_RE).
function voteIn(text: string, titleHay: string, hay: string): boolean {
  return VOTE_RE.test(text) && !nonStateElectorate(titleHay, hay);
}

// 'meclis' in the given text is the state assembly unless the whole text names a
// chamber, TSO, TOBB, İTO or club and no state assembly (see MECLIS_RE).
function stateMeclis(text: string, hay: string): boolean {
  return MECLIS_RE.test(text) && !(MECLIS_ORG_RE.test(hay) && !STATE_ASSEMBLY_RE.test(hay));
}

// 'seçim' in the title is a state election unless the title is sport, the text
// names a non-state electorate, or it is the choice sense (see SECIM_TITLE_RE).
function secimInTitle(titleHay: string, hay: string, titleSport: boolean): boolean {
  return (
    !titleSport &&
    SECIM_TITLE_RE.test(titleHay) &&
    !nonStateElectorate(titleHay, hay) &&
    !CHOICE_SECIM_RE.test(titleHay)
  );
}

// 'cumhurbaşkan' in the title is the presidency unless a sporting-event noun
// follows it in the title (see CUMHURBASKAN_TITLE_RE).
function cumhurbaskanInTitle(titleHay: string): boolean {
  const m = CUMHURBASKAN_TITLE_RE.exec(titleHay);
  return m !== null && !SPORT_EVENT_AFTER_RE.test(titleHay.slice(m.index + m[0].length));
}

// A text is world news when it has a base marker (DUNYA_MARKER_RE, 'çin', 'irak')
// or a 'dunya' that is not an L / S idiom. A text whose every 'dunya' is an idiom
// is world news only when the TITLE names a place or an organisation abroad
// (FOREIGN_RE). See 'hunt-32 dünya idioms' in the header.
function dunyaIn(titleHay: string, hay: string, lower: string): boolean {
  if (DUNYA_MARKER_RE.test(hay) || CIN_RE.test(lower) || IRAK_RE.test(lower)) return true;
  if (!DUNYA_STEM_RE.test(hay)) return false;
  return DUNYA_PLAIN_RE.test(hay) || FOREIGN_RE.test(titleHay);
}

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
    voteIn(titleHay, titleHay, hay) ||
    stateMeclis(titleHay, hay) ||
    secimInTitle(titleHay, hay, titleSport) ||
    cumhurbaskanInTitle(titleHay) ||
    (PARTY_OFFICE_TITLE_RE.test(titleHay) &&
      (PARTY_MARKER_RE.test(hay) || TIP_ACRONYM_RE.test(lower))) ||
    (SENATO_RE.test(titleHay) && !UNIVERSITY_RE.test(hay)) ||
    (!titleSport && TITLE_UNLESS_SPORT_RE.test(titleHay));
  const textHit =
    POLITIKA_DESC_RE.test(descHay) ||
    voteIn(descHay, titleHay, hay) ||
    stateMeclis(descHay, hay) ||
    ((COMPOUND_BODY_RE.test(hay) ||
      COMPOUND_PARTY_RE.test(hay) ||
      TIP_MEMBER_RE.test(lower) ||
      (PARTY_OFFICE_TITLE_RE.test(hay) && PARTY_MARKER_RE.test(hay))) &&
      COMPOUND_ACTION_RE.test(hay)) ||
    (COALITION_RE.test(hay) && PARTY_RE.test(hay));
  if (titleHit || (textHit && !titleSport)) return "politika";

  if (section) return section;

  if (SPOR_RE.test(hay) || GOL_RE.test(lower)) return "spor";
  if (dunyaIn(titleHay, hay, lower)) return "dunya";
  if (DUNYA_SPORT_EVENT_RE.test(hay)) return "spor";
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
