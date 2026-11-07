// Curated vocabulary behind "Yükselen Konular" on /trends (migration 112).
//
// Why a vocabulary and not `articles.entities`: that column was measured EMPTY
// in production (098 header, 2026-09-29), so there is no per-article entity
// data to roll up. Migration 112 instead tokenizes article TITLES against this
// list, one Istanbul day at a time, inside the existing hourly rollup cron, and
// stores one count per (day, entity) in
// `trends_daily_entity_counts_ist_rollup`. Nothing scans `articles` on the
// request path.
//
// Token rules
//   * Tokens are FOLDED lowercase ASCII: Turkish letters are mapped to their
//     ASCII base (RISING_FOLD_FROM -> RISING_FOLD_TO below), the title is
//     lowercased, then split on /[^a-z0-9]+/. "Özgür Özel'in" therefore yields
//     the words ozgur, ozel, in.
//   * A token is a single word (unigram) or two adjacent words joined by one
//     space (bigram). Every token is unique across ALL entries, so an article
//     can match an entity through several of its tokens but never two entities
//     through one token.
//   * An article counts ONCE per entity however many of its tokens it hits
//     (the SQL uses `select distinct id, entity`): the numbers are articles,
//     not mentions.
//
// Deliberately NOT in the list (ambiguous, generic, or not a "topic"):
//   * cities and clubs (a city is a place, not a story; clubs are sport noise)
//   * religion terms
//   * generic or ambiguous words: ozel, iyi, tip, gelecek, vatan, adalet,
//     saglik, yilmaz, guler, yavas, simsek on its own (only "mehmet simsek"),
//     altin, kur, euro, avrupa, turkiye, bakan, secim, ekonomi
//   * years and "pct"-style figures
// Known residual ambiguity, accepted: "mit" (MİT, but also Turkish "myth"),
// "cin" (Çin, but also "genie"), "deva" (DEVA Partisi, but also "cure").
//
// SQL parity: supabase/migrations/112_trends_entity_rollup.sql embeds this
// list as `emap(token, entity)` and the two fold strings as the translate()
// literals. tests/migrations/112-trends-entity-rollup.test.ts fails the build
// if the migration drifts from this file, in either direction.
//
// Hub-only data (/gundem/[key], migration 125): RISING_HUB_SPECS, below the
// list. It is hub-only, never read by /trends or migration 112, and `tokens`
// never changes because of it: it steers ONLY how src/lib/entities/entity-hub.ts
// searches a hub. It lives beside the list, not on the entries, so a
// RisingEntity stays exactly { key, label, tokens } for the rollup, the
// middleware and the tests that pin that shape.

export type RisingEntity = {
  /** Stable slug stored in the rollup table (`^[a-z0-9-]+$`). */
  key: string;
  /** Turkish display label, also the home-search query. */
  label: string;
  /** Folded lowercase tokens; a bigram has a single space. */
  tokens: readonly string[];
};

/**
 * How a hub (/gundem/[key], migration 125) searches one entity. Hub-only, never
 * read by /trends or migration 112; every field is optional.
 */
export type RisingHubSpec = {
  /**
   * Turkish display spellings the hub searches INSTEAD of the label (the label
   * stays the page title and the fallback). Each one becomes a stemmed
   * prefilter query and a folded regex pattern, so "AKP" and "AK Parti", or
   * "Zelenski" and "Zelenskiy", all find the story.
   */
  aliases?: readonly string[];
  /**
   * 'word' (default) closes a single-word pattern with a word boundary, so
   * "deva" never matches "devam". 'prefix' leaves it open for words that take
   * Turkish suffixes without an apostrophe ("dolara", "borsada", "faizi",
   * "meclisin").
   */
  hubMatch?: "word" | "prefix";
  /**
   * Suffixed spellings added to the stemmed PREFILTER only, never to the regex
   * patterns. The Turkish stemmer reduces a bare word and its inflected forms
   * to different stems ("borsa" -> bor, "borsada" -> borsa, "borsası" ->
   * borsas), so the bare word alone misses most real mentions; the regex guard
   * keeps the extra recall precise.
   */
  inflections?: readonly string[];
  /**
   * Aliases emitted WITHOUT the `excludes` and `requires` guards: the spelling
   * is unambiguous on its own ("TCMB", "TBMM"), so a foreign cue elsewhere in
   * the story must not drop it and no cue is needed to keep it. Every entry is
   * one of `aliases`, compared as written, and a spec with `trusted` also has
   * `excludes` or `requires`.
   */
  trusted?: readonly string[];
  /**
   * Foreign or municipal cues that veto a non-trusted alias: folded lowercase
   * ASCII phrases, words separated by single spaces ("polonya", "federal
   * anayasa", "belediye meclis"). entity-hub.ts turns them into a negative
   * lookahead over the whole folded text, so "Polonya'da ... Anayasa
   * Mahkemesi" is not the Turkish court. A phrase is open-ended (it also
   * catches "polonyada"), except a single word of 3 letters or fewer, which
   * takes a word boundary ("fed" never hits "federasyon").
   */
  excludes?: readonly string[];
  /**
   * Cues a non-trusted alias needs: at least ONE of them must appear anywhere
   * in the same folded text, or the alias does not count (the bare "Meclis"
   * needs "tbmm", "genel kurul" or a party name, so an İTO, municipal or
   * foreign "meclis" story drops out). Same shape as `excludes`: folded
   * lowercase ASCII phrases, words separated by single spaces, and the same
   * open/closed word rule (open-ended, except a single word of 3 letters or
   * fewer, which takes a word boundary: "chp"). entity-hub.ts turns them into a
   * positive lookahead after the `excludes` lookahead, so an exclude still
   * vetoes a story that carries a cue.
   */
  requires?: readonly string[];
  /**
   * Single words that, standing directly in front of the entity's word, make it
   * someone else's: "ABD Dışişleri Bakanı" and "İran Dışişleri Sözcüsü" are
   * foreign ministries, not the Turkish one. Folded lowercase ASCII words
   * (entries that fold to more than one word are dropped). entity-hub.ts emits
   * one fixed-length negative lookbehind per word, `(?<!abd\s)(?<!iran\s)`,
   * right before the base word, so the word counts only where it is NOT directly
   * preceded by a listed word and one whitespace character. Unlike `excludes`
   * it looks at the word's own neighbour, not at the whole story: a story that
   * also names the Turkish ministry once, unprefixed, still matches. It applies
   * to every form, `trusted` or not.
   */
  notAfter?: readonly string[];
  /**
   * Keeps the entity's single-word forms out of amounts: the word must not
   * follow a digit or a quantity word ("100 dolar", "2,1 milyar dolarlık",
   * "milyarlarca doları"). Only for entities whose bare name is also a unit,
   * where the story is about the sum and not the thing ("dolar").
   */
  quantityGuard?: true;
  /**
   * The hub regex runs on the headlines only (`title_tr` and `title_tr_neutral`)
   * and ignores the first line of the summary that migration 156 added to the
   * text. For a hub whose name is mostly an epithet in the lead sentence: "eski
   * AK Parti milletvekili Ertan Aydın", "AK Parti Samsun Milletvekili ...
   * başkanlığında" listed 129 of akp's 303 clusters (14 days, 2026-11-06) and
   * most of them are not about the party. entity-hub-query.ts sends it as
   * `p_headline_only` to `entity_cluster_ids_v3` (migration 170); until 170 is
   * applied the read falls back to v2 and the lead counts again. Set on akp
   * ONLY: for chp and mhp the lead mostly says "CHP lideri ..." or "MHP lideri
   * Devlet Bahçeli", which is the party's own story, and the country and person
   * hubs name their subject there. Part of the hub's cache key.
   */
  headlineOnly?: true;
};

/** Turkish letters (and circumflexed vowels) that fold to ASCII. */
export const RISING_FOLD_FROM = "İIıŞşĞğÜüÖöÇçÂâÎîÛû";
/** ASCII targets, same code-point length as RISING_FOLD_FROM. */
export const RISING_FOLD_TO = "iiissgguuooccaaiiuu";

export const RISING_ENTITIES: readonly RisingEntity[] = [
  // Parties
  { key: "akp", label: "AK Parti", tokens: ["akp", "ak parti"] },
  { key: "chp", label: "CHP", tokens: ["chp"] },
  { key: "mhp", label: "MHP", tokens: ["mhp"] },
  { key: "dem", label: "DEM Parti", tokens: ["dem"] },
  { key: "hdp", label: "HDP", tokens: ["hdp"] },
  { key: "iyi-parti", label: "İYİ Parti", tokens: ["iyi parti"] },
  { key: "yrp", label: "Yeniden Refah", tokens: ["yrp", "yeniden refah"] },
  { key: "deva", label: "DEVA", tokens: ["deva"] },

  // Institutions
  { key: "meclis", label: "Meclis", tokens: ["meclis", "tbmm"] },
  { key: "aym", label: "Anayasa Mahkemesi", tokens: ["aym", "anayasa mahkemesi"] },
  { key: "yargitay", label: "Yargıtay", tokens: ["yargitay"] },
  { key: "danistay", label: "Danıştay", tokens: ["danistay"] },
  { key: "ysk", label: "YSK", tokens: ["ysk"] },
  { key: "tcmb", label: "Merkez Bankası", tokens: ["tcmb", "merkez bankasi"] },
  { key: "tuik", label: "TÜİK", tokens: ["tuik"] },
  { key: "bddk", label: "BDDK", tokens: ["bddk"] },
  { key: "spk", label: "SPK", tokens: ["spk"] },
  { key: "msb", label: "MSB", tokens: ["msb"] },
  { key: "tsk", label: "TSK", tokens: ["tsk"] },
  { key: "afad", label: "AFAD", tokens: ["afad"] },
  { key: "diyanet", label: "Diyanet", tokens: ["diyanet"] },
  { key: "disisleri", label: "Dışişleri", tokens: ["disisleri"] },
  { key: "meb", label: "MEB", tokens: ["meb"] },
  { key: "rtuk", label: "RTÜK", tokens: ["rtuk"] },
  { key: "mit", label: "MİT", tokens: ["mit"] },

  // People
  { key: "erdogan", label: "Erdoğan", tokens: ["erdogan"] },
  { key: "ozgur-ozel", label: "Özgür Özel", tokens: ["ozgur ozel"] },
  { key: "imamoglu", label: "İmamoğlu", tokens: ["imamoglu"] },
  { key: "bahceli", label: "Bahçeli", tokens: ["bahceli"] },
  { key: "kilicdaroglu", label: "Kılıçdaroğlu", tokens: ["kilicdaroglu"] },
  { key: "mansur-yavas", label: "Mansur Yavaş", tokens: ["mansur yavas"] },
  { key: "simsek", label: "Mehmet Şimşek", tokens: ["mehmet simsek"] },
  { key: "fidan", label: "Hakan Fidan", tokens: ["hakan fidan"] },
  { key: "yerlikaya", label: "Ali Yerlikaya", tokens: ["yerlikaya"] },
  { key: "babacan", label: "Babacan", tokens: ["babacan"] },
  { key: "davutoglu", label: "Davutoğlu", tokens: ["davutoglu"] },
  { key: "aksener", label: "Akşener", tokens: ["aksener"] },
  { key: "demirtas", label: "Demirtaş", tokens: ["demirtas"] },
  { key: "ocalan", label: "Öcalan", tokens: ["ocalan"] },
  { key: "trump", label: "Trump", tokens: ["trump"] },
  { key: "putin", label: "Putin", tokens: ["putin"] },
  { key: "netanyahu", label: "Netanyahu", tokens: ["netanyahu"] },
  { key: "zelenski", label: "Zelenski", tokens: ["zelenski", "zelenskiy"] },

  // Countries and organisations
  { key: "abd", label: "ABD", tokens: ["abd"] },
  { key: "rusya", label: "Rusya", tokens: ["rusya"] },
  { key: "ukrayna", label: "Ukrayna", tokens: ["ukrayna"] },
  { key: "suriye", label: "Suriye", tokens: ["suriye"] },
  { key: "iran", label: "İran", tokens: ["iran"] },
  { key: "israil", label: "İsrail", tokens: ["israil"] },
  { key: "gazze", label: "Gazze", tokens: ["gazze"] },
  { key: "hamas", label: "Hamas", tokens: ["hamas"] },
  { key: "pkk", label: "PKK", tokens: ["pkk"] },
  { key: "feto", label: "FETÖ", tokens: ["feto"] },
  { key: "nato", label: "NATO", tokens: ["nato"] },
  { key: "yunanistan", label: "Yunanistan", tokens: ["yunanistan"] },
  { key: "almanya", label: "Almanya", tokens: ["almanya"] },
  { key: "cin", label: "Çin", tokens: ["cin"] },

  // Economy
  { key: "enflasyon", label: "Enflasyon", tokens: ["enflasyon"] },
  { key: "faiz", label: "Faiz", tokens: ["faiz"] },
  { key: "dolar", label: "Dolar", tokens: ["dolar"] },
  { key: "borsa", label: "Borsa İstanbul", tokens: ["borsa", "bist"] },
  { key: "asgari-ucret", label: "Asgari ücret", tokens: ["asgari ucret"] },
];

/** Hub-only search data, keyed by RisingEntity.key. An entity without an entry is searched by its label, as a whole word. */
export const RISING_HUB_SPECS: Readonly<Record<string, RisingHubSpec>> = {
  // Headline only (h56-entities-2): 129 of 303 clusters named the party only in the summary lead.
  akp: {
    aliases: ["AK Parti", "AKP"],
    inflections: ["AK Partili", "AK Partimize"],
    headlineOnly: true,
  },
  // The President, not the other Erdoğans (h56-entities-1): the bare "Erdoğan"
  // also names Emine and Bilal Erdoğan (31 of 42 clusters wrongly listed in the
  // 14-day replay), Yılmaz the director, Fatih and Asuman of Pasifik Holding,
  // Filiz, Canan, Nehir and Meryem. Two guards, split on purpose:
  //   * excludes veto the WHOLE story when a family member is named, so "Emine
  //     Erdoğan'dan mesaj" and "Bilal Erdoğan ... savundu" drop, unless a trusted
  //     presidential form is in it too: "Emine Erdoğan ile Cumhurbaşkanı Erdoğan
  //     Seul'de karşılandı" and "Recep Tayyip Erdoğan, Bilal Erdoğan ile ..." stay.
  //   * notAfter skips ONE occurrence, the one standing right behind a given
  //     name ("Yılmaz Erdoğan", "Fatih Erdoğan"), so "Cevdet Yılmaz, Erdoğan'ın
  //     ..." (a comma between them) and "Erdoğan'dan Gazze tepkisi" stay.
  // Only the bare name needs it: "Cumhurbaşkanı Erdoğan" and "Recep Tayyip
  // Erdoğan" name the President on their own. /trends (migration 163) is
  // untouched: erdogan is not one of its guarded keys, and `tokens` does not change.
  erdogan: {
    aliases: ["Erdoğan", "Cumhurbaşkanı Erdoğan", "Recep Tayyip Erdoğan"],
    trusted: ["Cumhurbaşkanı Erdoğan", "Recep Tayyip Erdoğan"],
    excludes: ["emine erdogan", "bilal erdogan", "sumeyye erdogan", "esra erdogan"],
    notAfter: ["fatih", "yilmaz", "asuman", "canan", "meryem", "nehir", "filiz"],
  },
  dem: { inflections: ["DEM Partili"] },
  "iyi-parti": { inflections: ["İYİ Partili"] },
  yrp: { aliases: ["Yeniden Refah", "YRP"] },
  meclis: {
    aliases: ["Meclis", "TBMM", "Büyük Millet Meclisi"],
    hubMatch: "prefix",
    trusted: ["TBMM", "Büyük Millet Meclisi"],
    excludes: [
      "temsilciler meclisi",
      "knesset",
      "israil",
      "iran",
      "libya",
      "belediye meclis",
      "il genel meclis",
      "ilce meclis",
      "mahalle meclis",
      "ulusal meclis",
      "rum meclis",
      "gkry",
      "ticaret odas",
      "sanayi odas",
      "ito",
      "mto",
      "atso",
      "belediyesi meclis",
      "buyuksehir meclis",
      "meclis uyes",
      "arnavutluk",
    ],
    // The bare "Meclis" counts only beside a TBMM or Turkish-politics cue.
    requires: [
      "tbmm",
      "genel kurul",
      "milletvekil",
      "kanun teklif",
      "yasa teklif",
      "grup toplanti",
      "meclis baskan",
      "kurtulmus",
      "komisyon",
      "butce gorusme",
      "chp",
      "akp",
      "ak parti",
      "mhp",
      "dem parti",
      "iyi parti",
      "yeniden refah",
    ],
  },
  aym: {
    aliases: ["Anayasa Mahkemesi", "AYM"],
    trusted: ["AYM"],
    excludes: ["polonya", "federal anayasa", "kktc anayasa"],
  },
  // The Turkish central bank only (h61-emptystates-2): the bare "Merkez Bankası" is any country's
  // ("Paraguay'da ... Merkez Bankası bankaya el koyup tasfiyeyi başlattı" was the whole 14-day hub), and
  // the named foreign banks below are only the ones someone thought of. So the non-trusted form also
  // needs one Turkish monetary-policy cue anywhere in the title, neutral title or summary lead; the
  // trusted "TCMB" stays bare. Hub-only: /trends (migration 163) reads tokens, excludes and trusted of
  // this entity and never `requires`, so its guard is untouched and the excludes list below must stay
  // equal to the SQL one (tests/migrations/163).
  // The cue list was finalised on a read-only replay (2026-11-07, 120 days of clusters that name the
  // bank, 230 matched the old patterns): the generic monetary words ("faiz", "enflasyon", "rezerv",
  // "doviz", "para politika") each let in about as many Turkish stories as foreign ones and stay;
  // "tbmm" and "repo" were added because they bring back three Turkish stories (a TBMM agenda item with
  // the bank's presentation, the 2027 budget week, the liquidity measures) and no foreign one.
  tcmb: {
    aliases: ["Merkez Bankası", "TCMB"],
    trusted: ["TCMB"],
    excludes: [
      "avrupa merkez",
      "ecb",
      "fed",
      "abd merkez",
      "amerikan merkez",
      "israil merkez",
      "ingiltere merkez",
      "japonya merkez",
      "rusya merkez",
      "cin merkez",
    ],
    requires: [
      "tcmb",
      "karahan",
      "ppk",
      "para politika",
      "faiz",
      "enflasyon",
      "rezerv",
      "turk lira",
      "doviz",
      "kur korumal",
      "turkiye cumhuriyet merkez",
      "piyasa katilimci",
      "tbmm",
      "repo",
    ],
  },
  zelenski: { aliases: ["Zelenski", "Zelenskiy", "Zelensky", "Zelenskyy"] },
  enflasyon: { hubMatch: "prefix" },
  faiz: { hubMatch: "prefix" },
  dolar: { hubMatch: "prefix", quantityGuard: true },
  // The Turkish ministry only: "Dışişleri" right after a foreign country word
  // ("ABD Dışişleri Bakanı Rubio", "İran Dışişleri Sözcüsü") is that country's.
  disisleri: {
    notAfter: [
      "abd",
      "amerika",
      "almanya",
      "alman",
      "fransa",
      "fransiz",
      "iran",
      "israil",
      "cin",
      "yunanistan",
      "yunan",
      "ukrayna",
      "rusya",
      "rus",
      "kktc",
      "ingiltere",
      "ingiliz",
      "katar",
      "misir",
      "suriye",
      "lubnan",
      "pakistan",
      "hindistan",
      "azerbaycan",
      "ermenistan",
      "japonya",
      "kore",
      "venezuela",
      "polonya",
      "ispanya",
      "italya",
      "macaristan",
      "avrupa",
    ],
  },
  // Borsa İstanbul and BIST name the exchange on their own (trusted). The bare
  // "borsa" is also the New York, Asian and European bourses and crypto
  // exchanges, so it is vetoed by those cues anywhere in the story.
  borsa: {
    aliases: ["Borsa İstanbul", "Borsa", "BIST"],
    hubMatch: "prefix",
    trusted: ["Borsa İstanbul", "BIST"],
    inflections: ["Borsada", "Borsası"],
    excludes: [
      "new york",
      "wall street",
      "nasdaq",
      "dow jones",
      "nikkei",
      "asya borsa",
      "avrupa borsa",
      "londra borsa",
      "frankfurt",
      "binance",
      "kripto",
      "ticaret borsa",
    ],
  },
  pkk: { inflections: ["PKK/KCK"] },
  "asgari-ucret": { inflections: ["asgari ücretli", "asgari ücretlilerin"] },
};

const FOLD_MAP: ReadonlyMap<string, string> = (() => {
  const from = [...RISING_FOLD_FROM];
  const to = [...RISING_FOLD_TO];
  return new Map(from.map((ch, i) => [ch, to[i] as string]));
})();

/**
 * JS twin of the SQL tokenizer in migration 112, for tests and parity only
 * (nothing on the request path tokenizes titles):
 *
 *   lower(translate(title, FOLD_FROM, FOLD_TO)) -> split on [^a-z0-9]+ ->
 *   drop empty pieces -> unigrams, then adjacent bigrams ("a b").
 *
 * `translate` runs BEFORE `lower`, exactly as in the SQL, so the capital
 * dotted İ and the capital dotless I both fold to a plain "i".
 */
export function foldTitleGrams(title: string): string[] {
  let folded = "";
  for (const ch of title) folded += FOLD_MAP.get(ch) ?? ch;
  const words = folded
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
  const grams = [...words];
  for (let i = 0; i + 1 < words.length; i++) {
    grams.push(`${words[i]} ${words[i + 1]}`);
  }
  return grams;
}
