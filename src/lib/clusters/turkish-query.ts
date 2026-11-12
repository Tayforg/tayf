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

// A '/', '\' or '|' between two letters separates two words (h144-search-3): 'Rusya/Ukrayna',
// 'Dolar/TL' and 'CHP|AKP' were ONE term each, so the archive looked for one lexeme that no story
// holds (0 stories against 50 for 'rusya ukrayna'; 'dolar/tl' 1 against 13 for 'dolar tl'). The
// archive's folded arm turns only a hyphen into a space. Digits are left alone ('24/7', '1/2', a
// date or a ratio). One character with a one-character look-behind and look-ahead: no quantifier,
// so the match is linear. Shared with the in-feed filter (in-feed-match.ts searchTokens), so the
// cards above the archive section and the archive read the same words. Replace it with ' '.
export const SLASH_BETWEEN_LETTERS = /(?<=\p{L})[\/\\|](?=\p{L})/gu;

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
 * nothing but dashes is a separator and is skipped like bare punctuation. A '/',
 * '\' or '|' between two letters is a separator too (SLASH_BETWEEN_LETTERS), so
 * the words on both sides are two terms. The slash is looked at twice: before the
 * split (the common case) and again on the cleaned term, because the apostrophe cut
 * can bring two letters together across a slash ("Erdoğan'/Bahçeli" -> 'erdoğan/bahçeli',
 * h145 review TS-3); a second pass would otherwise split what the first left whole.
 */
function searchTerms(q: string, limit: number): SearchTerm[] {
  const out: SearchTerm[] = [];
  for (const typed of cleanQueryUnicode(q)
    .replace(UNSAFE_CHARS, " ")
    .replace(SLASH_BETWEEN_LETTERS, " ")
    .split(/\s+/)) {
    if (typed === "") continue;
    // Lower-casing can leave a pair the next pass would compose (Turkish 'İ'
    // + U+0301 becomes 'i' + U+0301), so normalise once more after it.
    const term = stripEdgePunctuation(
      normaliseSearchQuery(typed).toLocaleLowerCase("tr").normalize("NFKC"),
    );
    if (term === "" || isDashOnly(term)) continue;
    // The apostrophe cut can leave a slash between two letters: split the term again. Each piece is
    // its own term, with the matching piece of the typed word as its echo (the typed word split on the
    // same characters; the piece itself when the counts differ).
    const pieces = term.split(SLASH_BETWEEN_LETTERS);
    if (pieces.length === 1) {
      out.push({ typed, term });
      if (out.length >= limit) break;
      continue;
    }
    const typedPieces = typed.split(/[\/\\|]/);
    const aligned = typedPieces.length === pieces.length;
    for (let i = 0; i < pieces.length; i++) {
      const piece = stripEdgePunctuation(pieces[i] as string);
      if (piece === "" || isDashOnly(piece)) continue;
      const echo = aligned ? (typedPieces[i] as string) : "";
      out.push({ typed: echo === "" ? piece : echo, term: piece });
      if (out.length >= limit) return out;
    }
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
 *   5. the whole is cut to MAX_SEARCH_QUERY_LENGTH. When the cut lands inside a
 *      term and more than one term is kept, that partial term is dropped whole
 *      (h144-search-3: a pasted headline used to search 'iste' of 'isteyenler', a
 *      fragment no story holds, and answered "sonuç bulunamadı"). A single term
 *      longer than the bound keeps the cut itself, without leaving half a
 *      surrogate pair, and its edge is stripped again.
 * A '/', '\' or '|' between two letters separates words (step 3's walk).
 * Pure, idempotent and linear in the input. '' means "nothing to search for".
 * No Turkish fold (see the header above): the RPC arguments do not change.
 */
export function canonicalSearchQuery(q: string): string {
  const terms = searchTerms(q, MAX_SEARCH_TERMS).map((t) => t.term);

  const joined = terms.join(" ");
  if (joined.length <= MAX_SEARCH_QUERY_LENGTH) return joined;

  // h144-search-3: a cut inside a term (the character after the cut is not a space) leaves half
  // a word, which the archive then searches as a word of its own. With more than one term kept
  // the partial term goes entirely, back to the last space. The terms before it are whole and
  // already canonical, so a second pass finds nothing to do (idempotent), and no surrogate pair
  // can be split. A single term longer than the bound has nothing to fall back to: it keeps
  // the cut below.
  const head = joined.slice(0, MAX_SEARCH_QUERY_LENGTH);
  if (joined.charAt(MAX_SEARCH_QUERY_LENGTH) !== " ") {
    const lastWholeEnd = head.lastIndexOf(" ");
    if (lastWholeEnd > 0) return head.slice(0, lastWholeEnd).trim();
  }

  // The cut can land between the halves of a surrogate pair (a lone high
  // surrogate does not survive the JSON body to Postgres) or leave the last
  // term ending in punctuation, so strip that term's edge again: this keeps
  // the function idempotent.
  const cut = head.replace(/[\ud800-\udbff]$/, "");
  const lastSpace = cut.lastIndexOf(" ");
  // The cut can also leave an apostrophe tail that is a suffix only now
  // ("k’daİ" cut to "k’da"), so the apostrophe rule runs on that term again.
  const lastTerm = stripEdgePunctuation(normaliseSearchQuery(cut.slice(lastSpace + 1)));
  // A cut through a single long term of dashes can leave a lone '-' (a cut through
  // '-bahçeli' among other terms no longer does: that partial term is dropped whole
  // above): it would be a separator on the next pass, so it goes now and the function
  // stays idempotent.
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
 * True when the length cut lands INSIDE a word that the search then uses as a fragment: the first
 * term is longer than MAX_SEARCH_QUERY_LENGTH, which is exactly when `canonicalSearchQuery` takes its
 * single-term cut (nothing before that term to fall back to). A 3-word query that is too long drops
 * whole words and reads false; a first word of exactly the bound is kept whole and reads false too.
 * The page words its length note with this (h145 review TS-5): "the words that fit" is false for a
 * single 300-letter word whose first 64 letters are searched. Reads one term, so the cost is linear.
 */
export function searchQueryCutsWord(q: string): boolean {
  const first = searchTerms(q, 1)[0];
  return first !== undefined && first.term.length > MAX_SEARCH_QUERY_LENGTH;
}

/**
 * True when the caps dropped part of what the reader typed. False for a
 * canonical query passed back in (it is already within both caps).
 */
export function searchQueryWasShortened(q: string): boolean {
  return searchQueryCut(q) !== null;
}

/**
 * The words of `q` the search used, as the reader typed them (case and
 * punctuation kept, whitespace collapsed, bare-punctuation words skipped as the
 * search skips them): the text the page echoes back for a shortened query. Under
 * a term cut that is the first MAX_SEARCH_TERMS words; under a length cut
 * (h144-search-3) it is the first k words, k being the number of terms the
 * canonical query kept, so the echo never shows a word the 64-character cut
 * dropped. A split '/' word is two words here, as in the search.
 */
export function searchedWordsAsTyped(q: string): string {
  const words = searchTerms(q, MAX_SEARCH_TERMS).map((t) => t.typed);
  if (searchQueryCut(q) === "length") {
    // A term holds no space, so the canonical query's terms are its space-separated pieces.
    const kept = canonicalSearchQuery(q).split(" ").filter((t) => t !== "").length;
    if (kept > 0) return words.slice(0, kept).join(" ");
  }
  return words.join(" ");
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
// push real 'karasu' rows off the page. The typed call sends `p_folded` = the typed
// words and the sibling call the sibling's words (h124-postship-1), so each call's own
// 166 over-stem guard and 172 / 194 tiers read the words that call searched for.
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
// Two more rules, added with their live counts (h144-search-1, production, 2026-11-12,
// ts_lexize('turkish_stem') and search_cluster_ids(array[q], tayf_search_fold(q), 50)).
// The stemmer cuts the bare word and its case-suffixed form differently:
//
//   imamoğlu -> imamoğlu, but imamoğluna -> imamoğl      suriye -> suri, but suriyede -> suriye
//   adana -> ada, but adanada -> adana                   kaza -> kaz, but kazada -> kaza
//   oylama -> oyla, but oylamada and oylamayı -> oylama
//
// 'imamoğluna' 0, 'kılıçdaroğlunu' 0, 'suriyede' 0, 'adanada' 0, 'abdye' 0, 'çinde' 0, 'trumpa' 0
// (against 50 for each bare word; 'ankarada' 9, 'bursada' 3); 'netanyahu bloğu ilk oylama' 0
// against 2 for 'oylamayı' and 'oylamada'; 'bolu kaza' 7 against 29 for 'bolu kazada'.
// The apostrophe form ('İmamoğlu'na') already works: APOSTROPHE_TAIL cuts it.
//
//   (C) a case suffix typed WITHOUT an apostrophe (siblingTerm): the root of a letters-only
//       term. The tails are tried longest first, the root is the term minus the tail, and every
//       gate must hold:
//         (i)   the root has at least 4 letters;
//         (ii)  phonotactics: nın nin nun nün and ya ye yı yi yu yü follow a vowel; na ne nı ni
//               nu nü and nda nde ndan nden follow ı i u ü (the n of a possessive: -oğlu names);
//               da de dan den follow a vowel or a voiced consonant; ta te tan ten follow a
//               voiceless one (ç f h k p s ş t);
//         (iii) vowel harmony with the root's LAST vowel (a ı o u take the a-form of a two-way
//               tail, e i ö ü the e-form; four-way tails: a ı -> ı, e i -> i, o u -> u, ö ü -> ü;
//               an ASCII i counts as i, so 'imamogluna' qualifies);
//         (iv)  the term is not in the deny set (NO_SIBLING_TERMS): kanada, hollanda, makine ...
//               fit the shape and their 'root' is another word or a junk stem.
//       imamoğluna -> imamoğlu, suriyede -> suriye, adanada -> adana, ankaradan -> ankara,
//       kılıçdaroğlunu -> kılıçdaroğlu. A closed allowlist of acronyms and short names
//       (SHORT_CASE_ROOTS: abd ab bm çin chp mhp akp ysk aym tbmm tcmb meb sgk spk tuik thy
//       nato, read letter by letter: ABD'ye, CHP'nin, TBMM'de) skips gates (i) to (iii) and also
//       takes a bare a / e: abdye -> abd, chpnin -> chp, tbmmde -> tbmm, çinde -> çin. The bare a / e
//       is NOT taken for 'ab' and 'çin' (BARE_VOWEL_HOMOGRAPHS): abe, aba, çine and cina are words
//       and names of their own (Abe, Çine), and their root would be the EU or China.
//   Out of scope, because the false-positive risk is too high: the bare a / e dative, the bare ı / i
//   accusative and the bare ın / in genitive after a consonant ('trumpa', 'erdoğana' have no rule of
//   their own). The 'nın nin nun nün' and n-buffer tails can still read such a form as root + n +
//   suffix: 'erdoğanın' -> 'erdoğa', 'putinin' -> 'puti', 'mardinde' -> 'mardi', 'giresunda' -> 'giresu'
//   (the longest tail wins, and 'mardin' + 'de' reads the same letters the other way). The root is
//   then a junk lexeme (ts_lexize: erdoğa -> 'erdok', puti -> 'puti' but putin -> 'put', mardi ->
//   'mardi' but mardin -> 'mardı'), the typed call has already found the name through its own stem, and
//   the sibling finds next to nothing: replayed on production, 'mardinde kaza' 0 -> 0, 'berlinde
//   protesto' 7 -> 7, 'giresunda sel' 2 -> 3 (the extra row is unrelated), 'putinin açıklaması' 0 -> 0.
//   The cost is one extra call on a short page, which searchFoldedSibling makes for any vowel-final
//   word anyway. Over the 6,000 newest headlines (2026-11-12), 4,002 distinct words are read by rule
//   C; in 2,505 the root has the word's own stem (the sibling adds nothing), in 1,497 it does not
//   (the intended case: imamoğlu / imamoğl, türkiye / türki, ankara / ankar), and a handful are
//   wrong parses with a junk root (see the deny set).
//
//   The second half of the fix is searchFoldedSibling: a BARE vowel-final noun with no root sibling
//   ('bolu kaza', 'tarla') is searched again with its locative ('boluda kazada', 'tarlada'), as the variants AND
//   the folded text of the same second call.
//
// Not covered (on purpose): the other possessive and case endings (the instrumental -la / -le, the
// plural, the bare consonant forms), and a bare vowel-final name with no suffix. A rule is added
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

// Terms that fit rule A's or rule C's shape and are not an inflection of their 'root': 'kayısı' is
// the fruit, 'kayı' is something else; 'kanada' is Canada, not kana + da. Compared folded, so 'kayısı'
// and 'kayisi' are one entry. Add a word only with a live example of the wrong sibling.
//
// Rule C (h144-search-1; ts_lexize('turkish_stem', ...) on production, 2026-11-12, the word's stem
// / the root's stem). The root stems to a lexeme of its own that no headline of the word holds:
//   kanada -> kana: 'kana' / 'ka'         granada -> grana: 'grana' / 'gra'
//   makine -> maki: 'mak' / 'maki'        kabine -> kabi: 'kap' / 'kabi'      hazine -> hazi: 'haz' / 'hazi'
// The root is not a word, and its stem is the word's own, so a sibling would only cost a call:
//   hollanda -> hollan 'holla' / 'holla'  florida -> flori 'flori' / 'flori'  uganda -> ugan 'uga' / 'uga'
//   ruanda -> ruan 'ruan' / 'ruan'        propaganda -> propagan 'propaga' / 'propaga'
//   ajanda -> ajan 'aja' / 'aja'          veranda -> veran 'vera' / 'vera'    medine -> medi 'medi' / 'medi'
// 'suriye' is the root of 'suriyede' and itself has the shape of 'suri' + 'ye' (both stem to 'suri'):
// denied, so the sibling of 'suriyede' is a fixed point and a second pass finds nothing to do.
// Very common function words that rule C reads as root + tail, whose root stems to a 1 to 3 letter
// junk lexeme (the 6,000 newest headlines, 2026-11-12: yeniden in 70, ardından 43, nerede 15,
// konseyi 11): yeniden -> yeni ('yeni' / 'ye'), ardından -> ardı ('ardı' / 'ar'), nerede -> nere
// ([] / 'ner'), konseyi -> konse ('konse' / 'ko', the word is konsey + i). Live wrong sibling:
// 'yeniden sayım' asked for 'yeni sayım' and gained 'Yeni Zelanda'daki ... oy sayım işlemi'.
// The deny set is the TYPED word's: 'kanadada' still reaches 'kanada'.
const NO_SIBLING_TERMS: ReadonlySet<string> = new Set([
  "kayisi",
  "kanada", "hollanda", "florida", "uganda", "ruanda", "propaganda", "ajanda", "veranda", "granada",
  "makine", "kabine", "hazine", "medine",
  "suriye",
  "yeniden", "ardindan", "nerede", "konseyi",
]);

// Rule A. One unbounded quantifier, anchored on both ends: linear. The -sı / -si ending
// only (a -su / -sü word is a compound name, see the header). ASCII 'i' is in both
// classes, so an ASCII-typed term ('vergisi', 'cezasi') qualifies.
const POSSESSIVE_AFTER_VOWEL = /^(\p{L}{2,}[aeıioöuü])s[ıi]$/u;

// Rule C (h144-search-1). The case suffixes of a name typed without its apostrophe, with what each
// one needs before it. `ways` is the harmony class of its vowel (2: a / e, 4: ı i u ü); `after`
// says which sound the root must end in: "v" a vowel, "p" one of ı i u ü (the n of a possessive),
// "d" a vowel or a voiced consonant, "t" a voiceless consonant. Sorted longest first below.
type CaseAfter = "v" | "p" | "d" | "t";
const CASE_TAILS: ReadonlyArray<readonly [tail: string, ways: 2 | 4, after: CaseAfter]> = (
  [
    ["ndan", 2, "p"], ["nden", 2, "p"],
    ["nın", 4, "v"], ["nin", 4, "v"], ["nun", 4, "v"], ["nün", 4, "v"],
    ["nda", 2, "p"], ["nde", 2, "p"],
    ["dan", 2, "d"], ["den", 2, "d"], ["tan", 2, "t"], ["ten", 2, "t"],
    ["ya", 2, "v"], ["ye", 2, "v"], ["yı", 4, "v"], ["yi", 4, "v"], ["yu", 4, "v"], ["yü", 4, "v"],
    ["na", 2, "p"], ["ne", 2, "p"], ["nı", 4, "p"], ["ni", 4, "p"], ["nu", 4, "p"], ["nü", 4, "p"],
    ["da", 2, "d"], ["de", 2, "d"], ["ta", 2, "t"], ["te", 2, "t"],
  ] as const
)
  .slice()
  .sort((a, b) => b[0].length - a[0].length);

// The letters a term of rule C is made of, and the classes the gates read.
const LETTERS_ONLY = /^\p{L}+$/u;
const VOWELS = "aeıioöuü";
const VOICED_CONSONANTS = "bcdgğjlmnrvyz";
const VOICELESS_CONSONANTS = "çfhkpsşt";
const POSSESSIVE_VOWELS = "ıiuü";

// Acronyms and short names read letter by letter, whose case suffix follows the sound of the
// last LETTER (ABD'ye, CHP'nin, TBMM'de, YSK'dan), not a vowel of the word: gates (i) to (iii)
// are skipped for them. Compared folded ('çin' and 'cin' are one entry). CLOSED on purpose.
const SHORT_CASE_ROOTS: ReadonlySet<string> = new Set([
  "abd", "ab", "bm", "cin", "chp", "mhp", "akp", "ysk", "aym", "tbmm", "tcmb", "meb", "sgk", "spk",
  "tuik", "thy", "nato",
]);

// Short roots whose bare a / e form is a word or a name of its own: abe, aba (Abe), çine, cina
// (Çine, an Aydın district). The tails above still apply to them.
const BARE_VOWEL_HOMOGRAPHS: ReadonlySet<string> = new Set(["ab", "cin"]);

/** The vowel of `tail` that carries its harmony, or "" when it has none. */
function firstVowel(s: string): string {
  for (const ch of s) if (VOWELS.includes(ch)) return ch;
  return "";
}

/** The last vowel of `root`, or "" when it has none. */
function lastVowel(root: string): string {
  for (let i = root.length - 1; i >= 0; i--) if (VOWELS.includes(root[i] as string)) return root[i] as string;
  return "";
}

/** The vowel a tail of class `ways` must carry after a root whose last vowel is `v`. */
function harmonyVowel(v: string, ways: 2 | 4): string {
  if (ways === 2) return "aıou".includes(v) ? "a" : "e";
  if (v === "a" || v === "ı") return "ı";
  if (v === "e" || v === "i") return "i";
  return v === "o" || v === "u" ? "u" : "ü";
}

/** Gates (i) to (iii) of rule C for one tail: length, phonotactics, vowel harmony. */
function caseRootFits(root: string, tail: string, ways: 2 | 4, after: CaseAfter): boolean {
  if (Array.from(root).length < 4) return false;
  const end = root.slice(-1);
  const soundFits =
    after === "v"
      ? VOWELS.includes(end)
      : after === "p"
        ? POSSESSIVE_VOWELS.includes(end)
        : after === "d"
          ? VOWELS.includes(end) || VOICED_CONSONANTS.includes(end)
          : VOICELESS_CONSONANTS.includes(end);
  if (!soundFits) return false;
  const v = lastVowel(root);
  return v !== "" && firstVowel(tail) === harmonyVowel(v, ways);
}

/**
 * The root of a letters-only term that carries a case suffix typed without its apostrophe, or null
 * (rule C). `low` is the term lower-cased with the Turkish rules and already past the deny set.
 * Tails are tried longest first and the first whose gates hold wins, so 'imamoğlunda' is
 * imamoğlu + nda. A short root reads its tail without the gates, and a bare a / e after it. A handful
 * of `endsWith` and one `slice` per tail on a term of at most MAX_SEARCH_QUERY_LENGTH characters: linear.
 */
function caseSuffixRoot(low: string): string | null {
  if (!LETTERS_ONLY.test(low)) return null;
  for (const [tail, ways, after] of CASE_TAILS) {
    if (low.length <= tail.length || !low.endsWith(tail)) continue;
    const root = low.slice(0, low.length - tail.length);
    if (SHORT_CASE_ROOTS.has(foldTr(root)) || caseRootFits(root, tail, ways, after)) return root;
  }
  const bare = low.slice(-1);
  if (bare === "a" || bare === "e") {
    const root = low.slice(0, -1);
    const folded = foldTr(root);
    if (SHORT_CASE_ROOTS.has(folded) && !BARE_VOWEL_HOMOGRAPHS.has(folded)) return root;
  }
  return null;
}

/** The root of one term under rule B, then (after the deny set) rule A, then rule C, or null. The term is not cased yet. */
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
  if (match !== null) return match[1] as string;
  return caseSuffixRoot(low);
}

/**
 * The same query with every term that is a possessive-after-a-vowel, a listed
 * doubled-stem form or a case suffix typed without its apostrophe replaced by its
 * root ('elektrik zammı' -> 'elektrik zam', 'emlak vergisi' -> 'emlak vergi',
 * 'imamoğluna' -> 'imamoğlu', 'suriyede' -> 'suriye'); the other terms are kept as typed. Null when
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

// ---------------------------------------------------------------------------
// Folded sibling: the locative of a bare vowel-final noun (h144-search-1).
//
// The stemmer cuts a bare vowel-final noun one letter shorter than its inflected form
// (kaza -> kaz, but kazada and kazayı -> kaza; oylama -> oyla, but oylamada -> oylama;
// toplantı -> topla, but toplantıda -> toplantı), so the bare word the reader types never meets
// the stem that the headlines holding an inflected form carry: 'bolu kaza' found 7 stories and
// 'bolu kazada' 29 (33 against the union), 'netanyahu bloğu ilk oylama' found 0 and 2 with
// 'oylamada'. `searchFoldedSibling` gives such a term its locative, and search-query.ts makes a second
// call for it, only when the typed page is short and only when `searchSiblingQuery` found no root.
//
// The locative is BOTH arguments of that call, `p_variants` and `p_folded`: every call folds its own
// variants. Migration 166's over-stem guard (and the tiers of 172 / 194) read `p_folded` ONLY, so a call
// whose variants spell another text searches stems the guard never checked. The first version of this
// call sent the typed spelling as variants with the locative as the folded text; on production (read-only,
// search_cluster_ids at limit 24) ['tarla'] with 'tarlada' returned 24 rows where the typed call found 11,
// and of the 13 appended rows 6 held no 'tarl' word (the stemmer cuts 'tarla' to 'tar', which matches
// 'Bakan Yumaklı', 'İş cinayetleri raporu', ...), while ['tarlada'] with 'tarlada' appended 13 rows, none
// of them junk, and 'netanyahu bloğu ilk oylama' kept its 0 -> 2 with the locative as variants too. The
// typed call has already searched the typed stems, so the second call has no reason to repeat them.
//
// With a root sibling (rule A, B or C: 'tarlası' -> 'tarla') the locative is not used: that call is the
// sibling's own, the sibling as variants and folded text, exactly as before this function existed. The
// locative as variants loses proper nouns there ('boluda kazada' finds 0 where 'bolu kaza' finds 7), and
// the sibling of 'tarlası' ('tarla') would otherwise reach the same unguarded call through its own locative.
//
// KNOWN LIMIT (replayed on production, 2026-11-12, search_cluster_ids at limit 24, typed page / locative
// page / union): the stemmer also shortens a vowel-final PROPER noun when it is bare ('bolu' -> 'bol',
// 'bursa' -> 'burs') and keeps the letter in the locative ('boluda' -> 'bolu'), so giving EVERY term its
// locative asks for a stem that the Bolu headlines do not hold: 'bolu kaza' 7 / 0 / 7, 'bursa kaza' 6 / 0 / 6,
// 'manisa kaza' 11 / 0 / 11. The typed call has already listed those, and the second call only appends, so
// a name loses nothing: it gains nothing from this call, which is the price of keeping every call guarded.
// Where no term is such a name the locative page is the one that helps: 'mersin kaza' 2 / 14 / 14,
// 'meclis oylama' 16 / 24 / 38 (the page keeps 24), 'netanyahu bloğu ilk oylama' 0 / 2 / 2. A second known
// limit: the locative's stem 'kaza' is also the stem of 'kazandı' and 'kazanın', so 'van kaza' (2 / 6 / 8)
// appends rows of those words next to the 'kazada' stories.
// ---------------------------------------------------------------------------

/** The term with the locative of Turkish two-way harmony after its last vowel (a ı o u: da, e i ö ü: de), or null. */
function withLocative(term: string): string | null {
  // The same bound as siblingTerm: a longer term is not a word.
  if (term.length > MAX_SEARCH_QUERY_LENGTH) return null;
  const low = term.toLocaleLowerCase("tr");
  if (!LETTERS_ONLY.test(low) || Array.from(low).length < 4) return null;
  const last = low.slice(-1);
  if (!VOWELS.includes(last)) return null;
  return term + (harmonyVowel(last, 2) === "a" ? "da" : "de");
}

/**
 * The same query with the locative added to every term that is letters only, at least 4 letters
 * long and ends in a vowel ('bolu kaza' -> 'boluda kazada', 'meclis oylama' -> 'meclis oylamada',
 * 'toplantı' -> 'toplantıda'); the other terms are kept as typed. Null when the query uses websearch
 * syntax (`hasSearchOperator`: the reader is in charge) or when no term changes. The term count
 * never changes, so the 6-term bound holds; each changed term grows by two letters. search-query.ts
 * sends it as BOTH the variants and the folded text of the second archive call, and only when the
 * query has no root sibling (`searchSiblingQuery` is null): the guard of migration 166 reads the folded
 * text only, so the call must fold the same words its variants spell, and a sibling call keeps its own.
 */
export function searchFoldedSibling(q: string): string | null {
  if (hasSearchOperator(q)) return null;
  let changed = false;
  const terms = q
    .split(/\s+/)
    .filter((t) => t !== "")
    .map((t) => {
      const locative = withLocative(t);
      if (locative === null) return t;
      changed = true;
      return locative;
    });
  return changed ? terms.join(" ") : null;
}
