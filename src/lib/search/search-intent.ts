// Search intent for the home search (h153). Pure: no next/*, no supabase. Its
// imports are the query normaliser and three small constants, so the page, the
// loader (search-intent-query.ts) and the tests share one set of rules.
//
// WHAT. "/?q=THYAO" and "/?q=Hürriyet" used to land on the archive, which does
// full-text search over cluster headlines only. Headlines rarely spell a code
// (they say "THY"), so the reader saw little or "Hiç haber bulunamadı", although
// /ekonomi/THYAO and /source/hurriyet are full pages. When the WHOLE query is a
// traded BIST code or an active outlet's name, the page now shows ONE link row
// under the "için N sonuç" line. The results, the counts, the live region, the
// metadata and the follow button are untouched, and there is no redirect.
//
// WHEN. Only when the query is exactly one code-shaped word (4 to 6 letters,
// optionally with a '#', '$' or Turkish apostrophe suffix) or exactly an outlet's
// name (1 to 4 words, any case, any Turkish or ASCII spelling, a '-', '.', '_',
// '&' or '+' inside a word ignored: "Halk TV", "halktv", "HALK-TV"). A search
// operator (a double quote, a '-negation', a standalone `or`) is the reader
// driving the archive and gets no link. Outlets are asked first: "Sözcü" is the
// newspaper even if some company were coded SOZCU.
//
// PRECISION OVER RECALL. A link next to a search for an ordinary word is worse
// than no link, so two curated deny lists cut the words the reader most probably
// means as a word. A missed word gives a harmless but odd link; a denied code
// gives no link and /ekonomi is still one click away. Both lists are measured, not
// guessed. Production, read-only, 2026-11-12:
//
// Q1  bist_companies: 626 companies with shares_traded; 629 codes of the shape
//     ^[A-Z]{4,6}$ and 21 codes off it (3-letter aliases such as TGB, or a digit).
// Q2  Do traded codes collide with headline words? Articles published in the last
//     14 days whose folded title holds a code as a whole word, and how many of
//     those titles are tagged with that very ticker in article_tickers (top rows,
//     titles_with_word / tagged):
//       EKIM 1383/0, HEDEF 561/6, KONYA 457/0, UNLU 437/0, YESIL 411/0,
//       BEYAZ 316/1, DAGI 243/0, KENT 214/2, LIDER 180/0, MAVI 161/0, SOKE 150/0,
//       BIZIM 111/0, AFYON 90/5, TERA 89/14, USAK 83/0, EDIP 81/0, FENER 81/0,
//       METRO 61/2, ISKUR 51/0, DEVA 48/2, YIGIT 46/0, ULKER 26/25, GEDIK 24/3,
//       GOZDE 23/0, SISE 21/1, DENGE 20/1, ULAS 19/0, SANKO 19/18, YAYLA 17/0,
//       SMART 16/4, ESEN 15/0, ASTOR 15/15, ARENA 14/1, LINK 11/1, ORGE 10/1,
//       ATLAS 8/0, BESTE 8/0, AKSA 6/1, PENTA 6/6, MARTI 6/1, CIMSA 5/0 ...
//     RULE: a code with 5 or more titles and fewer than half of them tagged is a
//     word the headlines use for something else, and is denied. ULKER, SANKO,
//     ASTOR and PENTA are tagged in 94% to 100% of their titles: the reader means
//     the company, so they stay linkable (so do SASA, VAKKO, KOTON, AYGAZ). A seed
//     code that scored 0 stays in the list: these are ordinary words and their use
//     in headlines is seasonal. CIMSA's five titles are a basketball club (Çimsa
//     ÇBK Mersin), TERA's are mostly "Tera fonu", so both are real collisions.
// Q3  Outlet names as headline words: active sources, clusters updated in the last
//     14 days with article_count >= 2 (3473 of them), whole-word match of the
//     folded name on the folded neutral title (top rows, clusters_14d):
//       cumhuriyet 32, dunya 20, karar 10, iha 4, trt-world 3, aykiri 3,
//       takvim 3, muhalif 2, cnn-turk 2, sabah 1, halk-tv 1, sozcu 1, a-haber 1,
//       krt-tv 1, yeni-safak 1, aksam 1, bianet 1, son-dakika 1, gzt 1, star 1,
//       milliyet 1, then 0 for the rest (hurriyet 0, ntv 0).
//     RULE: an active source named in 10 or more clusters is a word, except the
//     four the request names (hurriyet, sozcu, ntv, halk tv), which stay allowed:
//     hurriyet 0, sozcu 1, ntv 0, halk-tv 1. The three that cross the line
//     (cumhuriyet, dunya, karar) were already in the seed. The seed also holds
//     the ordinary-word names of sources that are inactive today (or that no
//     headline used in the window), because a source can be reactivated and the
//     word does not change.
//     Q3 READ THE NEUTRAL CLUSTER TITLE ONLY, which understated a word that the SOURCES' own headlines use
//     (h157-search-2): iha scored 4 clusters, yet 196 of 68,693 ARTICLE titles of the last 7 days
//     (2026-11-12) hold İHA as a whole word (the drone: "Rusya: Moskova bölgesine 417 İHA yönlendirildi")
//     and 0 of them come from the İHA source, which has never stored an article. /?q=iha showed
//     "Haber kaynağı: İHA kaynak sayfası" above 22 drone stories and linked an empty, noindex page, so
//     "iha" joins OUTLET_WORD_DENY. A future re-run of Q3 must count ARTICLE titles as well as cluster
//     titles: the neutral title of a cluster hides how often a headline writer uses the word.
// Q4  Two active sources with one compact key (name folded, separators dropped):
//     0 rows. If two ever do, the first in the registry's order (by name) wins.
// Q5  hurriyet, sozcu, ntv and halk-tv are all active; THYAO, KCHOL and ISCTR are
//     traded.
//
// Extend the lists only from that kind of evidence, and re-run Q2 and Q3 first.
//
// SECURITY. The query is matched only by pure functions, never concatenated into
// SQL or a URL. An href is built from a slug that passes SOURCE_SLUG_RE, or from a
// code that passes TICKER_INTENT_SHAPE and is in the traded set; the outlet's
// name is rendered as a React child (escaped). Every regex here is anchored with
// no nested quantifier; folding and name matching walk characters.

import { hasSearchOperator } from "@/lib/clusters/search-aliases";
import { canonicalSearchQuery, cleanQueryUnicode, foldTr } from "@/lib/clusters/turkish-query";
import { NON_EQUITY_TICKERS } from "@/lib/finance/ticker-index";
import { SOURCE_SLUG_RE } from "@/lib/seo/source-slug-gate";

export type SearchIntent =
  | { kind: "ticker"; ticker: string }
  | { kind: "source"; slug: string; name: string };

/** The two fields of an active source the outlet match reads. */
export interface IntentSource {
  slug: string;
  name: string;
}

/** A traded BIST equity code: 4 to 6 ASCII capitals (the 3-letter codes are aliases). */
export const TICKER_INTENT_SHAPE = /^[A-Z]{4,6}$/;

/** "Sabah Gazetesi": the word that makes an ordinary-word outlet name unambiguous. */
export const OUTLET_QUALIFIER = "gazetesi";

/** The longest outlet name (in words) a query can spell: "Hürriyet Daily News" is 3. */
export const MAX_OUTLET_TERMS = 4;

// The compact outlet name is 2 to 40 characters once folded.
const MIN_OUTLET_CHARS = 2;
const MAX_OUTLET_CHARS = 40;

/**
 * Traded codes that are also everyday words, so a search for the word is not a
 * search for the company. Folded, upper case. Seeded from the code and Turkish
 * usage, then extended from Q2 (see the header: titles with the word >= 5 and
 * fewer than half tagged with the ticker). One reason per group.
 */
export const TICKER_WORD_DENY: ReadonlySet<string> = new Set([
  // party, landmark or place (DEVA is a party, KONYA / ADANA / USAK provinces, AKSA a
  // district, BALAT a quarter; Q2 adds SOKE and AFYON, towns, and FENER, a district)
  "DEVA",
  "ADANA",
  "AKSA",
  "BALAT",
  "KONYA",
  "USAK",
  "SOKE",
  "AFYON",
  "FENER",
  // everyday words (Q2: EKIM is October, HEDEF "target", BIZIM "ours"; MARTI is a gull,
  // SISE a bottle, SMART and BESTE and ORGE ordinary words; CIMSA is a basketball club)
  "ALTIN",
  "MAVI",
  "DENGE",
  "YESIL",
  "BEYAZ",
  "UNLU",
  "KENT",
  "METRO",
  "LOGO",
  "ATLAS",
  "MARKA",
  "UFUK",
  "HOROZ",
  "DAGI",
  "YAYLA",
  "ARENA",
  "EFOR",
  "LIDER",
  "LINK",
  "EKIM",
  "HEDEF",
  "BIZIM",
  "MARTI",
  "SISE",
  "SMART",
  "BESTE",
  "ORGE",
  "CIMSA",
  "TERA",
  "GOZDE",
  "ISKUR",
  // personal names (Q2 adds YIGIT)
  "ESEN",
  "EDIP",
  "ADEL",
  "ULAS",
  "GEDIK",
  "YIGIT",
  // Company brands (SASA, ULKER, VAKKO, KOTON, AYGAZ) are NOT denied: there the reader
  // means the company.
]);

/**
 * Outlet names that are ordinary words or phrases, as SPACED FOLDED forms: a query
 * that equals one of them is not a search for the outlet unless the reader adds
 * OUTLET_QUALIFIER ("sabah gazetesi"). Seeded, then extended from Q3 (a source named
 * in 10 or more clusters in 14 days), with hurriyet, sozcu, ntv and halk tv left out
 * on purpose: the request names them.
 */
export const OUTLET_WORD_DENY: ReadonlySet<string> = new Set([
  // single words (Q3 confirms cumhuriyet 32, dunya 20 and karar 10 clusters in 14 days)
  "sabah",
  "aksam",
  "star",
  "takvim",
  "posta",
  "milat",
  "fanatik",
  "diken",
  "dunya",
  "karar",
  "cumhuriyet",
  // iha: the drone word. 196 of 68,693 article titles in 7 days (2026-11-12) hold İHA, 0 from the İHA
  // source, which has never stored an article. "iha gazetesi" still reaches it (OUTLET_QUALIFIER).
  "iha",
  "korkusuz",
  "muhalif",
  "evrensel",
  "aydinlik",
  "aykiri",
  "tobb",
  "gunes",
  "sok",
  "istiklal",
  "ortadogu",
  // phrases
  "son dakika",
  "sondakika",
  "en son haber",
  "bir gun",
  "yeni cag",
  "gercek gundem",
  "dogru haber",
  "kisa dalga",
  "isin detayi",
  "acik gazete",
  "bir gazete",
  "iklim haber",
  "hukuki haber",
  "finansal gundem",
  "yeni mesaj",
  "yeni asir",
  "ulusal kanal",
  "sol haber",
  "internet haber",
  "ajans haber",
]);

/**
 * One word of a query or of an outlet's name, folded for comparison: Turkish letters
 * to ASCII (foldTr), lower case, a-z and 0-9 kept, and the separators `.` `-` `_` `&`
 * `+` `'` and U+2019 dropped. Any other character (a space, a slash, an accented
 * letter foldTr leaves alone, CJK) gives null: the word is not a name we can compare.
 * One walk over the characters, no regex.
 */
export function foldWord(word: string): string | null {
  let out = "";
  for (const ch of foldTr(word)) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      out += ch;
    } else if (ch === "." || ch === "-" || ch === "_" || ch === "&" || ch === "+" || ch === "'" || ch === "’") {
      // a separator inside a name: "Halk-TV", "haberler.com", "AT&T"
    } else {
      return null;
    }
  }
  return out;
}

/**
 * The traded-code candidate of a query, or null. The canonical query (the exact
 * words the archive searches: case, apostrophe suffix and edge punctuation gone)
 * must be ONE term and no search operator; that term, folded and upper-cased, must
 * have the shape of a code and not be an everyday word. The fold maps the dotted and
 * dotless I, so "İSCTR", "ısctr" and "isctr" are one code.
 */
export function tickerCandidate(q: string): string | null {
  const canonical = canonicalSearchQuery(q);
  if (canonical === "" || hasSearchOperator(canonical)) return null;
  // The canonical form joins its terms with single spaces: no space, one term.
  if (canonical.includes(" ")) return null;
  const folded = foldTr(canonical);
  const code = folded.toUpperCase();
  // A letter whose upper case is longer ('ß' to 'SS') would turn two characters into
  // four: a code is exactly what the reader typed, letter for letter.
  if (code.length !== folded.length) return null;
  if (!TICKER_INTENT_SHAPE.test(code)) return null;
  if (TICKER_WORD_DENY.has(code)) return null;
  return code;
}

/**
 * The folded words of a query that could name an outlet, or null: the canonical query
 * has 1 to MAX_OUTLET_TERMS terms, no search operator, every term folds (foldWord),
 * and the compact name (words joined) is 2 to 40 characters.
 */
export function outletQueryWords(q: string): string[] | null {
  const canonical = canonicalSearchQuery(q);
  if (canonical === "" || hasSearchOperator(canonical)) return null;
  const terms = canonical.split(" ");
  if (terms.length < 1 || terms.length > MAX_OUTLET_TERMS) return null;
  const words: string[] = [];
  for (const term of terms) {
    const folded = foldWord(term);
    if (folded === null) return null;
    if (folded !== "") words.push(folded);
  }
  const length = words.join("").length;
  if (length < MIN_OUTLET_CHARS || length > MAX_OUTLET_CHARS) return null;
  return words;
}

/**
 * The folded words of an outlet's display name, or null when a character cannot be
 * folded. Same walk as the query side, so "Yeniçağ" and "yenicag" meet.
 */
export function outletNameWords(name: string): string[] | null {
  const words: string[] = [];
  for (const part of splitOnWhitespace(cleanQueryUnicode(name).toLocaleLowerCase("tr"))) {
    const folded = foldWord(part);
    if (folded === null) return null;
    if (folded !== "") words.push(folded);
  }
  return words;
}

/** The non-empty runs between whitespace characters (the set `trim` strips), by one walk, no regex. */
function splitOnWhitespace(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (const ch of text) {
    if (ch.trim() === "") {
      if (current !== "") parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current !== "") parts.push(current);
  return parts;
}

/** The first source, in input order, whose slug is well-formed and whose compact name is `compact`. */
function findByCompactName(compact: string, sources: readonly IntentSource[]): IntentSource | null {
  if (compact === "") return null;
  for (const source of sources) {
    if (!SOURCE_SLUG_RE.test(source.slug)) continue;
    if (outletNameWords(source.name)?.join("") === compact) return source;
  }
  return null;
}

/**
 * The outlet a folded query names, or null. The whole query must be the whole name
 * (separators and spaces ignored: "Halk TV", "halktv"). Pass 1 refuses a name that is
 * an ordinary word or phrase (OUTLET_WORD_DENY). Pass 2 accepts the name followed by
 * OUTLET_QUALIFIER ("sabah gazetesi"), the reader's own word that it is the paper;
 * the deny list is not applied there.
 */
export function matchOutlet(words: readonly string[], sources: readonly IntentSource[] | null): IntentSource | null {
  if (sources === null || sources.length === 0 || words.length === 0) return null;
  if (!OUTLET_WORD_DENY.has(words.join(" "))) {
    const hit = findByCompactName(words.join(""), sources);
    if (hit !== null) return hit;
  }
  if (words.length >= 2 && words[words.length - 1] === OUTLET_QUALIFIER) {
    return findByCompactName(words.slice(0, -1).join(""), sources);
  }
  return null;
}

/**
 * The one link the query earns, or null. Outlets first, then a traded equity code. A
 * missing list (null: its read failed) only rules that kind out.
 */
export function resolveSearchIntent(args: {
  q: string;
  sources: readonly IntentSource[] | null;
  tickers: readonly string[] | null;
}): SearchIntent | null {
  const words = outletQueryWords(args.q);
  if (words !== null) {
    const source = matchOutlet(words, args.sources);
    if (source !== null) return { kind: "source", slug: source.slug, name: source.name };
  }
  const code = tickerCandidate(args.q);
  if (code !== null && !NON_EQUITY_TICKERS.has(code) && args.tickers !== null && args.tickers.includes(code)) {
    return { kind: "ticker", ticker: code };
  }
  return null;
}

/**
 * The exact Turkish copy and target of the row. No suffix is ever attached to a name,
 * so vowel harmony never applies: the lead ends in a colon and the link text is the
 * code or the name plus a fixed noun phrase.
 */
export function searchIntentLink(intent: SearchIntent): { href: string; lead: string; linkText: string } {
  if (intent.kind === "ticker") {
    return {
      href: `/ekonomi/${intent.ticker}`,
      lead: "Borsa İstanbul kodu:",
      linkText: `${intent.ticker} hisse sayfası`,
    };
  }
  return {
    href: `/source/${intent.slug}`,
    lead: "Haber kaynağı:",
    linkText: `${intent.name} kaynak sayfası`,
  };
}
