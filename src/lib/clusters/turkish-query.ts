// Turkish-aware search-query normalisation, pure (no Supabase, no Next
// cache directive) so it is directly unit-testable and shareable between
// search-query.ts and the 083 migration's `search_cluster_ids` RPC — the
// three variants produced here are exactly the three lexeme spellings the
// GIN index (migration 035's `search_tsv`, generated via
// `to_tsvector('turkish', ...)`) can hold for one Turkish dotted/dotless
// "i" word, because Postgres's `lower()` runs under the DB's en_US.UTF-8
// collation, NOT a Turkish one:
//
//   - 'IŞIK' (all caps)  -> en_US lower() -> 'işik' (dotted i, both I's)
//   - 'Işık' (title case) -> en_US lower() -> 'işık' (dotted first i, ş,
//     then ASCII 'I' from the *second* character never being touched by
//     the earlier uppercase step keeps its Turkish form) -- see Q2 in the
//     083 migration header for the measured triple.
//   - 'ışık' (already lower, Turkish dotless ı) -> en_US lower() is a
//     no-op on non-ASCII -> 'ışık'
//
// `turkishQueryVariants` reproduces those three spellings from a single
// reader-typed query by round-tripping through `toLocaleUpperCase('tr')`
// / `toLocaleLowerCase('tr')` (which DO know the Turkish casing rules) and
// then folding ASCII/Turkish "I" variants the same way Postgres's en_US
// lower() would, via `pgLower`.
import { hasSearchOperator } from "./search-aliases";

export const MAX_QUERY_VARIANTS = 3;

/**
 * Emulates Postgres's en_US.UTF-8 `lower()` for the one letter whose
 * casing differs between the "C"/en_US collation and Turkish: ASCII `I`
 * and dotted capital `İ` both fold to dotted lowercase `i` under en_US,
 * never to Turkish dotless `ı`. Every other letter (ı, ş, ğ, ü, ö, ç
 * included) already round-trips correctly through a plain
 * `toLocaleLowerCase('tr')` because en_US lower() leaves non-ASCII
 * letters untouched and Turkish lower() agrees with it there.
 */
export function pgLower(s: string): string {
  return s.replace(/[İI]/g, "i").toLocaleLowerCase("tr");
}

/** Upper-cases (Turkish rules) the first `\p{L}` letter in `token`,
 * leaving any leading non-letter characters (a leading '-', an opening
 * quote, …) untouched. */
function titleCaseToken(token: string): string {
  const lower = token.toLocaleLowerCase("tr");
  const match = lower.match(/\p{L}/u);
  if (!match || match.index === undefined) return lower;
  const idx = match.index;
  const upper = lower[idx]!.toLocaleUpperCase("tr");
  return lower.slice(0, idx) + upper + lower.slice(idx + 1);
}

/** Title-cases every whitespace-separated token of `s` using Turkish
 * casing rules. Whitespace runs are preserved verbatim (split via a
 * capturing regex) so multi-space input isn't collapsed. */
export function titleCaseTr(s: string): string {
  return s
    .split(/(\s+)/)
    .map((part) => (/^\s+$/.test(part) ? part : titleCaseToken(part)))
    .join("");
}

/**
 * Produces up to `MAX_QUERY_VARIANTS` distinct lexeme spellings for a
 * reader-typed query, so a search for 'IŞIK' matches clusters whose
 * `search_tsv` stored the lexeme under any of the three en_US-lower()
 * spellings a Turkish "I" can take. Returns `[]` for whitespace-only
 * input (nothing to search for).
 */
export function turkishQueryVariants(q: string): string[] {
  const t = q.trim();
  if (t.length === 0) return [];

  const candidates = [
    t.toLocaleLowerCase("tr"),
    pgLower(t.toLocaleUpperCase("tr")),
    pgLower(titleCaseTr(t)),
  ];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    if (c.length === 0) continue;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    if (out.length >= MAX_QUERY_VARIANTS) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Archive-search fold + query normalisation (migration 129).
//
// `turkishQueryVariants` above only reproduces the three spellings that the
// en_US lower() can leave in the stored `search_tsv`, and it keeps Turkish
// letters. A reader typing ASCII ('sisli', 'cumhurbaskani', 'imamoglu', 'ozel')
// therefore matched nothing. Migration 129 adds a second, folded index over
// `tayf_search_fold(title_tr_neutral || title_tr || summary_tr)`; `foldTr` is
// the TypeScript twin of that SQL function and builds the `p_folded` argument.
//
// The fold is the house fold of migrations 112/125/126 (rising-entities.ts'
// RISING_FOLD_FROM/TO): translate first, then lower. The SQL lower() runs under
// `collate "C"`, which only touches ASCII, so it does not depend on the
// database locale and the function is honestly IMMUTABLE. `foldTr` mirrors it
// exactly: map each character, drop U+0307 (combining dot above, what
// translate() deletes because chr(775) has no counterpart in TO), lowercase
// A-Z only. tests/migrations/129-search-fold-rank.test.ts pins the parity.
//
// The two strings are literals (not imported) so this module stays free of the
// trends vocabulary (rising-entities.ts); turkish-query.test.ts asserts they
// equal RISING_FOLD_FROM / RISING_FOLD_TO.
// ---------------------------------------------------------------------------

/** Turkish and circumflex letters that fold to ASCII (same as RISING_FOLD_FROM). */
export const SEARCH_FOLD_FROM = "İIıŞşĞğÜüÖöÇçÂâÎîÛû";
/** ASCII targets, same code-point length as SEARCH_FOLD_FROM (same as RISING_FOLD_TO). */
export const SEARCH_FOLD_TO = "iiissgguuooccaaiiuu";

const FOLD_MAP: ReadonlyMap<string, string> = new Map(
  [...SEARCH_FOLD_FROM].map((from, i) => [from, [...SEARCH_FOLD_TO][i] as string]),
);

/**
 * TypeScript twin of the SQL `public.tayf_search_fold(text)`:
 * `lower(translate(s, FROM || chr(775), TO) collate "C")`. Turkish letters map
 * to their ASCII base, U+0307 is deleted, and only ASCII A-Z is lower-cased
 * (so `É` stays `É`, as it does under the C collation).
 */
export function foldTr(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === "\u0307") continue;
    const mapped = FOLD_MAP.get(ch) ?? ch;
    out += mapped >= "A" && mapped <= "Z" ? mapped.toLowerCase() : mapped;
  }
  return out;
}

// C0 controls (U+0000-U+001F) and DEL + C1 controls (U+007F-U+009F), plus
// UTF-16 surrogates that are not part of a pair. Postgres rejects U+0000
// outright (the whole RPC fails and the page used to show a false "zaman
// aşımı") and a lone surrogate does not survive the JSON body either.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

// Format characters (Unicode category Cf): zero-width space / joiner /
// non-joiner, word joiner, soft hyphen, byte order mark, bidi marks and
// overrides. They are invisible, so a reader cannot see why 'trump' + U+200B
// finds nothing, and they are not whitespace, so `\s` does not split on them.
const FORMAT_CHARS = /\p{Cf}/gu;

/**
 * The Unicode cleanup every search-query path runs first (h50-search-2):
 * delete format characters, THEN apply NFKC. NFKC composes a decomposed letter
 * ('s' + U+0327 -> 'ş', 'I' + U+0307 -> 'İ') and folds full-width forms and
 * ligatures to their plain spelling ('ＴＲＵＭＰ' -> 'TRUMP', 'ﬁ' -> 'fi', U+FF0D ->
 * '-', U+FF07 -> "'"), which is what the stored titles and `matchKey` already
 * use. The order matters for idempotence: NFKC never produces a format
 * character, but deleting one AFTER normalising can leave a base letter next to
 * a combining mark that the next pass would compose ('a' + U+200B + U+0301).
 * Linear in the input.
 */
export function cleanQueryUnicode(s: string): string {
  return s.replace(FORMAT_CHARS, "").normalize("NFKC");
}

// A Turkish case suffix is written after an apostrophe: Erdoğan'ın, Özel'den,
// Bahçeli'nin. The stored titles carry the bare name (or the suffixed form
// without the apostrophe), so the apostrophe and the suffix after a letter are
// cut. The class covers ' (U+0027), ’ (U+2019), ʼ (U+02BC) and ‘ (U+2018).
// A combining mark counts as part of the letter before it (it composes into that
// letter), so cutting one apostrophe never changes whether the next is cut.
//
// h50-search-2: only a TURKISH suffix is cut. Every apostrophe tail used to go,
// which turned "Kur'an" into 'kur' and refused "O'Brien" as one character long.
// The match is a run of apostrophes plus the letters after it, so a stacked run
// is cut or kept as one unit (a second pass finds nothing left to do), and no
// quantifier can backtrack: the tail is greedy and nothing follows it.
const APOSTROPHE_TAIL = /(?<=[\p{L}\p{M}])['\u2019\u02bc\u2018]+(\p{L}*)/gu;

// The longest suffix chain the allowlist accepts, in UTF-16 units: the
// glued plural + possessive + case forms ('lerinden', 'larımızdan') fit.
const SUFFIX_TAIL_MAX_LENGTH = 12;

// ı i u ü, the four-way vowel of Turkish suffixes.
const V4 = "[ıiuü]";

// The Turkish case, plural, possessive and copula suffixes a news headline puts
// after the apostrophe of a proper name. Anchored on both ends, no nested
// quantifier: each `\p{L}*` is last in its branch, so the match is linear.
const SUFFIX_TAIL = new RegExp(
  "^(?:" +
    [
      "y?[ae]", // dative: a e ya ye
      "n[ae]", // dative after a possessive: na ne
      `y?${V4}`, // accusative: ı i u ü yı yi yu yü
      `n${V4}`, // accusative after a possessive: nı ni nu nü
      `n?${V4}n`, // genitive: ın in un ün nın nin nun nün
      "[dt][ae](?:n|k[iı](?:ler|lar)?)?", // locative / ablative / relative: da de dan den daki deki dekiler (Turkish lower-casing of ASCII KI gives kı)
      "n[dt][ae](?:n|k[iı](?:ler|lar)?)?", // the same after a possessive: nda nde ndan nden ndaki ndekiler
      "y?l[ae]", // instrumental: la le yla yle
      "l[ae]r\\p{L}*", // plural and what follows: lar ler ların lerden ...
      `l${V4}\\p{L}*`, // -lı -li -lik -liler ...
      `${V4}n[dt][ae](?:n|k[iı](?:ler|lar)?)?`, // possessive + locative / ablative: ında inden ındaki
      `${V4}n${V4}n`, // possessive + genitive: ının inin
      `${V4}m${V4}z\\p{L}*`, // first person plural possessive: ımız imizin ...
      "[cç][ae]", // ca ce ça çe
      `[cç]${V4}\\p{L}*`, // cı ci cu cü çı çi çu çü and what follows: cüler, ciler
      `[dt]${V4}r`, // dır dir dur dür tır tir tur tür
      `s${V4}n?`, // third person possessive: sı si su sü sın sin
    ].join("|") +
    ")$",
  "u",
);

/**
 * True when `tail` (the letters after an apostrophe, without the apostrophe) is
 * a Turkish case or possessive suffix: 'ın', 'dan', 'nin', 'ye', 'liler'. False
 * for the tail of a name that happens to carry an apostrophe ('an' of Kur'an,
 * 'brien' of O'Brien, 'oréal' of L'Oréal) and for the empty tail (the caller
 * decides what a dangling apostrophe is). The length is checked first, so a long
 * tail costs nothing; the tail is lower-cased with the Turkish rules, so 'NİN'
 * and 'IN' match. Shared by `normaliseSearchQuery` and the in-feed matcher so
 * the archive and the page cut the same words.
 */
export function isTurkishSuffixTail(tail: string): boolean {
  if (tail.length === 0 || tail.length > SUFFIX_TAIL_MAX_LENGTH) return false;
  return SUFFIX_TAIL.test(tail.toLocaleLowerCase("tr"));
}

/**
 * Cleans a reader-typed archive-search query before it is cached, folded or
 * sent to Postgres:
 *   1. format characters out and NFKC (`cleanQueryUnicode`);
 *   2. control characters and lone surrogates become a space;
 *   3. an apostrophe followed by a Turkish suffix, or by nothing, is dropped
 *      after a letter (Erdoğan'ın -> Erdoğan); any other tail stays (Kur'an,
 *      O'Brien, L'Oréal);
 *   4. whitespace runs collapse and the ends are trimmed.
 * Double quotes (phrase search) and every other character are kept.
 * Applied only by `searchClusters`: `turkishQueryVariants` stays unchanged
 * because entity-hub passes curated apostrophe inflections through it.
 */
export function normaliseSearchQuery(q: string): string {
  return cleanQueryUnicode(q)
    .replace(UNSAFE_CHARS, " ")
    .replace(APOSTROPHE_TAIL, (match, tail: string) =>
      tail === "" || isTurkishSuffixTail(tail) ? "" : match,
    )
    // Cutting an apostrophe can leave a letter next to a combining mark that
    // was behind it ('l' + ‘ + U+0327): compose again, or the next pass would.
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Canonical search query: the cache key and the RPC input of the home search
// (h30-abuse-1).
//
// `searchClusters` used to key its cache on `normaliseSearchQuery(q)`, so
// 'Erdoğan', 'ERDOĞAN!', ' erdoğan ' and 'erdoğan.' were four cache entries and
// four 0.4-0.5 s `search_cluster_ids` RPCs for one search, and a 200-character
// 40-word query was a fifth. `canonicalSearchQuery` collapses a case and
// punctuation family to ONE string and bounds its size before the key is built.
//
// There is deliberately NO Turkish fold here. `p_variants` is built from this
// string by `turkishQueryVariants`, which already lower-cases, upper-cases and
// title-cases it internally, and `foldTr` maps İ/I/ı to i, so lower-casing with
// the Turkish rules first leaves BOTH RPC arguments byte-identical to what the
// un-canonicalised query produced (turkish-query.test.ts pins that parity).
// Folding the key to ASCII would change them: the `search_tsv` arm would lose
// its Turkish-letter lexemes, and a quoted '"Devlet Bahçeli"' would reach the
// folded arm as a plain AND query (migration 129 drops phrases there). So
// 'erdogan' (ASCII) and 'erdoğan' stay two keys on purpose: their results
// already differ today.
// ---------------------------------------------------------------------------

/** The most terms (whitespace-separated words) the archive search keeps. */
export const MAX_SEARCH_TERMS = 6;
/** The longest canonical query, in UTF-16 code units (never ends in half an emoji). */
export const MAX_SEARCH_QUERY_LENGTH = 64;

// One code point at a time: an emoji is a single \p{S} code point but two
// UTF-16 units, so testing a code unit would never match it.
const EDGE_PUNCTUATION = /^[\p{P}\p{S}]$/u;

// '"' opens or closes a phrase and '-' negates a term (Postgres
// websearch_to_tsquery reads both), so they are kept at a term's edge.
function isStrippableEdge(ch: string): boolean {
  return ch !== '"' && ch !== "-" && EDGE_PUNCTUATION.test(ch);
}

/**
 * Cuts leading and trailing punctuation/symbols off one term. Two indices walk
 * in from the ends, one code point per step, so the cost is linear in the term
 * (an anchored `[\p{P}\p{S}]+$` regex is quadratic on a long run that is not at
 * the end, and CodeQL flags it).
 */
function stripEdgePunctuation(term: string): string {
  const points = Array.from(term);
  let start = 0;
  let end = points.length;
  while (start < end && isStrippableEdge(points[start]!)) start++;
  while (end > start && isStrippableEdge(points[end - 1]!)) end--;
  return start === 0 && end === points.length ? term : points.slice(start, end).join("");
}

// A dash between words is a separator ('Erdoğan - Bahçeli', 'trump <-> iran'),
// not websearch's NOT: Postgres reads 'erdoğan - bahçeli' as erdoğa & !bahçel
// and the archive then shows stories that do NOT mention Bahçeli (h50-search-2).
// '-' is kept at a term's edge for the attached negation ('-bahçeli'), so a term
// of nothing but dashes is the one left over to drop. U+2010-U+2015 (hyphen to
// horizontal bar) and U+2212 (minus) are punctuation or symbols that the edge
// strip already removes; they are listed so the test does not depend on that.
function isDashChar(ch: string): boolean {
  return ch === "-" || (ch >= "\u2010" && ch <= "\u2015") || ch === "\u2212";
}

function isDashOnly(term: string): boolean {
  if (term === "") return false;
  for (const ch of term) if (!isDashChar(ch)) return false;
  return true;
}

interface SearchTerm {
  /** The word as the reader typed it (Unicode cleaned, controls replaced, nothing else touched). */
  typed: string;
  /** Its canonical form: Turkish apostrophe suffix cut, Turkish lower-case, edges stripped. */
  term: string;
}

/**
 * The one walk over a reader-typed query that `canonicalSearchQuery`,
 * `searchQueryCut` and `searchedWordsAsTyped` all share, so what they call "a
 * term" cannot drift apart. Words are split on whitespace; a word that is
 * empty once cleaned (bare punctuation, an emoji) is not a term. Stops after
 * `limit` terms, so the cost is linear in the input and never in the number of
 * words past the limit. The cleaning is `normaliseSearchQuery` applied word by
 * word, which is the same as applying it to the whole text first (a word holds
 * no whitespace and the apostrophe cut never reaches across one). The Unicode
 * cleanup runs on the whole text before the split, so a zero-width character or
 * a full-width space cannot hide a word boundary or a leading '-'. A term of
 * nothing but dashes is a separator and is skipped like bare punctuation.
 */
function searchTerms(q: string, limit: number): SearchTerm[] {
  const out: SearchTerm[] = [];
  for (const typed of cleanQueryUnicode(q).replace(UNSAFE_CHARS, " ").split(/\s+/)) {
    if (typed === "") continue;
    // Lower-casing can leave a pair the next pass would compose (Turkish 'İ'
    // + U+0301 becomes 'i' + U+0301), so normalise once more after it.
    const term = stripEdgePunctuation(
      normaliseSearchQuery(typed).toLocaleLowerCase("tr").normalize("NFKC"),
    );
    if (term === "" || isDashOnly(term)) continue;
    out.push({ typed, term });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The cache key and RPC input for a reader-typed archive-search query:
 *   1. `normaliseSearchQuery` (format characters out, NFKC, controls out, a
 *      Turkish apostrophe suffix dropped, whitespace collapsed);
 *   2. Turkish lower-casing ('IŞIK', 'Işık', 'ışık' -> 'ışık');
 *   3. punctuation and symbols cut off both edges of every term, so
 *      'ERDOĞAN!', '“Erdoğan”' and 'Erdoğan.' share a key; a leading '-' and
 *      the double quote of a phrase search are kept;
 *   4. terms left empty, or made of dashes only ('Erdoğan - Bahçeli',
 *      'trump <-> iran'), are dropped and only the first MAX_SEARCH_TERMS kept;
 *   5. the whole is cut to MAX_SEARCH_QUERY_LENGTH without leaving half a
 *      surrogate pair, and the cut term's edge is stripped again.
 * Pure, idempotent and linear in the input. '' means "nothing to search for".
 * No Turkish fold (see the header above): the RPC arguments do not change.
 */
export function canonicalSearchQuery(q: string): string {
  const terms = searchTerms(q, MAX_SEARCH_TERMS).map((t) => t.term);

  const joined = terms.join(" ");
  if (joined.length <= MAX_SEARCH_QUERY_LENGTH) return joined;

  // The cut can land between the halves of a surrogate pair (a lone high
  // surrogate does not survive the JSON body to Postgres) or leave the last
  // term ending in punctuation, so strip that term's edge again: this keeps
  // the function idempotent.
  const cut = joined.slice(0, MAX_SEARCH_QUERY_LENGTH).replace(/[\ud800-\udbff]$/, "");
  const lastSpace = cut.lastIndexOf(" ");
  // The cut can also leave an apostrophe tail that is a suffix only now
  // ("k’daİ" cut to "k’da"), so the apostrophe rule runs on that term again.
  const lastTerm = stripEdgePunctuation(normaliseSearchQuery(cut.slice(lastSpace + 1)));
  // A cut through '-bahçeli' leaves a lone '-': it would be a separator on the
  // next pass, so it goes now and the function stays idempotent.
  return (cut.slice(0, lastSpace + 1) + (isDashOnly(lastTerm) ? "" : lastTerm)).trim();
}

// ---------------------------------------------------------------------------
// Which cap changed the search (h42-search-2).
//
// The 6-term and 64-character caps are a deliberate cost bound, but they used to
// be silent: a reader who typed 7 words got the archive of the first 6 under an
// echo that claimed all 7, and the in-feed filter still applied the 7th. The home
// page says so now ("Arama ilk 6 kelimeyle yapıldı.") and filters the feed with the
// same words the archive used.
// ---------------------------------------------------------------------------

/** Which cap shortened a query: the term count or the character length. */
export type SearchQueryCut = "terms" | "length";

/**
 * Null when `canonicalSearchQuery(q)` searches everything the reader typed.
 * 'length' when the 64-character cut applies to the kept terms (checked first:
 * it is the tighter bound, so the words that survive are fewer than MAX_SEARCH_TERMS);
 * 'terms' when only more than MAX_SEARCH_TERMS non-empty terms were typed.
 * Reads at most MAX_SEARCH_TERMS + 1 terms.
 */
export function searchQueryCut(q: string): SearchQueryCut | null {
  const found = searchTerms(q, MAX_SEARCH_TERMS + 1);
  const kept = found.slice(0, MAX_SEARCH_TERMS).map((t) => t.term).join(" ");
  if (kept.length > MAX_SEARCH_QUERY_LENGTH) return "length";
  return found.length > MAX_SEARCH_TERMS ? "terms" : null;
}

/**
 * True when the caps dropped part of what the reader typed. False for a
 * canonical query passed back in (it is already within both caps).
 */
export function searchQueryWasShortened(q: string): boolean {
  return searchQueryCut(q) !== null;
}

/**
 * The first MAX_SEARCH_TERMS words of `q` as the reader typed them (case and
 * punctuation kept, whitespace collapsed, bare-punctuation words skipped as the
 * search skips them): the text the page echoes back for a shortened query.
 */
export function searchedWordsAsTyped(q: string): string {
  return searchTerms(q, MAX_SEARCH_TERMS)
    .map((t) => t.typed)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Sibling query: the headline form of an everyday noun (h96-search-1).
//
// The Turkish snowball stemmer gives two shapes of everyday noun their own
// lexeme, so the form a reader types never meets the form a headline carries:
//
//   zam -> zam, but zammı -> zammı, zammına -> zamm          (doubled consonant)
//   vergi -> vergi, but vergisi -> vergis, vergisinde -> vergi (possessive)
//   ceza -> ceza, but cezası -> cezas; belediye -> beledi, but belediyesi -> belediyes
//
// On production (2026-11-09) 'elektrik zammı', 'emlak vergisi', 'doğal gaz zammı'
// and 'asgari ücret zammı' found nothing while 'elektrik zam' found 9 stories,
// 'emlak vergi' 2, 'doğal gaz zam' 4 and 'asgari ücret zam' 6; 'trafik cezası' found
// 18 against 34 for 'trafik ceza'.
//
// `searchSiblingQuery` rewrites those two shapes to the root. The archive search
// (search-query.ts) searches the typed spellings FIRST, with at most three
// `p_variants`, and only when that call leaves slots of the page empty makes a
// SECOND call with the sibling's spellings, appending the ids it adds after the
// typed ones. The sibling is never merged into the typed call: migration 172 ORs
// `p_variants[1..3]` with equal rank, so a merged call let unrelated 'kara' rows
// push real 'karasu' rows off the page. `p_folded` stays the typed words in both
// calls, so 166's over-stem guard and 172's tier read what the reader typed.
//
// Two narrow rules, both anchored on the whole term and with one quantifier each,
// so the match is linear. Terms are compared Turkish-lower-cased and ASCII-folded
// where it matters, so 'vergisi' and 'VERGİSİ' and 'zammi' all qualify.
//
//   (A) possessive after a vowel, the -sı / -si ending only:
//       <2+ letters><vowel>s<ı i> -> <letters><vowel>
//       vergisi -> vergi, cezası -> ceza, soruşturması -> soruşturma,
//       belediyesi -> belediye. The -su / -sü ending is NOT a possessive of these
//       nouns: it is a compound name (Karasu, Sarısu, Ilısu, Akarsu) whose 'root'
//       ('kara', 'sarı') is another word and would flood the page. The fruit
//       'kayısı' fits the shape but its 'root' 'kayı' is unrelated, so a small
//       folded deny set (NO_SIBLING_TERMS) is checked before the rule.
//   (B) a CLOSED allowlist of doubled stems (GEMINATE_ROOTS): the doubled stem plus
//       one of ı i u ü -> the root. zammı -> zam, hakkı -> hak, affı -> af.
//       The allowlist is closed on purpose: a general doubled-consonant rule turns
//       'messi' into 'mes'. Add a root only after checking it against the live archive.
//
// Not covered (on purpose): the other possessive and case endings. A rule is added
// only with the live counts that justify it.
// ---------------------------------------------------------------------------

/**
 * Doubled stems whose bare vowel forms (zammı, hakkı, affı ...) the stemmer
 * leaves whole. Key: the doubled stem. Value: the root that headlines also use.
 * Reviewed against the live archive; closed on purpose (see above).
 */
export const GEMINATE_ROOTS: ReadonlyMap<string, string> = new Map([
  ["zamm", "zam"],
  ["hakk", "hak"],
  ["aff", "af"],
  ["hiss", "his"],
  ["hatt", "hat"],
  ["sırr", "sır"],
  ["redd", "ret"],
]);

// Compared folded, so 'sırrı' and 'sirri' both reach the root.
const GEMINATE_BY_FOLD: ReadonlyMap<string, string> = new Map(
  [...GEMINATE_ROOTS].map(([doubled, root]) => [foldTr(doubled), root]),
);

// Terms that fit rule A's shape and are not a possessive of their 'root': 'kayısı' is the
// fruit, 'kayı' is something else. Compared folded, so 'kayısı' and 'kayisi' are one entry.
// Add a word only with a live example of the wrong sibling.
const NO_SIBLING_TERMS: ReadonlySet<string> = new Set(["kayisi"]);

// Rule A. One unbounded quantifier, anchored on both ends: linear. The -sı / -si ending
// only (a -su / -sü word is a compound name, see the header). ASCII 'i' is in both
// classes, so an ASCII-typed term ('vergisi', 'cezasi') qualifies.
const POSSESSIVE_AFTER_VOWEL = /^(\p{L}{2,}[aeıioöuü])s[ıi]$/u;

/** The root of one term under rule B then rule A (after the deny set), or null. The term is not cased yet. */
function siblingTerm(term: string): string | null {
  // A canonical query holds terms of at most MAX_SEARCH_QUERY_LENGTH characters;
  // a longer one is not a word and is never examined, so the cost per term is bounded.
  if (term.length < 3 || term.length > MAX_SEARCH_QUERY_LENGTH) return null;
  const low = term.toLocaleLowerCase("tr");
  const vowel = low.slice(-1);
  if (vowel === "ı" || vowel === "i" || vowel === "u" || vowel === "ü") {
    const root = GEMINATE_BY_FOLD.get(foldTr(low.slice(0, -1)));
    if (root !== undefined) return root;
  }
  if (NO_SIBLING_TERMS.has(foldTr(low))) return null;
  const match = POSSESSIVE_AFTER_VOWEL.exec(low);
  return match === null ? null : (match[1] as string);
}

/**
 * The same query with every term that is a possessive-after-a-vowel or a listed
 * doubled-stem form replaced by its root ('elektrik zammı' -> 'elektrik zam',
 * 'emlak vergisi' -> 'emlak vergi'); the other terms are kept as typed. Null when
 * the query uses websearch syntax (`hasSearchOperator`: the reader is in charge)
 * or when no term changes, so applying it to its own output gives null. The term
 * count never changes, so the 6-term and 64-character bound of the canonical
 * query holds for the sibling too.
 */
export function searchSiblingQuery(q: string): string | null {
  if (hasSearchOperator(q)) return null;
  let changed = false;
  const terms = q
    .split(/\s+/)
    .filter((t) => t !== "")
    .map((t) => {
      const root = siblingTerm(t);
      if (root === null) return t;
      changed = true;
      return root;
    });
  return changed ? terms.join(" ") : null;
}
