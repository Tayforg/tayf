// Search aliases for the home search (h42-search-1). Pure: its only import is
// turkish-query.ts, so the archive path (search-query.ts) and the in-feed filter
// (in-feed-match.ts) share one definition and cannot disagree.
//
// WHY. 'AKP' and 'AK Parti' are one party but two different archive searches:
// on production (2026-11-05) the two queries returned 24 ids each and shared none,
// and over the clusters updated in the last 14 days 111 headlines said only
// 'AK Parti' and 57 only 'AKP', so the abbreviation missed 60% of them. A reader
// who types the short form should find both.
//
// HOW. The existing search_cluster_ids RPC (migrations 083/129) already reads a
// websearch query, so no migration is needed: `expandAliasQuery` rewrites the
// canonical query into a two-way `or`, one disjunct per spelling of the alias:
//
//   'akp istanbul'  ->  p_variants  akp istanbul or "ak parti" istanbul
//                       p_folded    akp istanbul or ak parti istanbul
//
// The variants form quotes a multi-word alias (a phrase on search_tsv, the way
// 083 treats a quoted query). The folded form never quotes: migration 129's folded
// arm turns a double quote into a space, and a phrase that survives would drop the
// whole arm to an all-AND plainto_tsquery, losing the `or`. Unquoted, 'ak parti'
// reads as 'ak' AND 'parti' there, which is what the headlines hold.
//
// COST BOUND (h30-abuse-1). The caller passes the canonical query (at most 6
// terms and 64 characters). At most ONE alias occurrence is expanded, into at
// most TWO disjuncts, and each disjunct repeats the query's other terms: the RPC
// sees at most 2 x 6 terms plus one `or`, and one extra term in the copy that
// spells the two-word alias. A query that already uses websearch syntax (a double
// quote, a '-negated' term or a standalone `or`) is left exactly as the reader wrote it.
//
// PHRASE-MAKING TERMS (h42 review, sec-db-3). Migration 129's folded arm turns a
// double quote and a hyphen between two letters or digits into spaces, but a term
// such as 'covid_19' or 'covid--19' still parses as a phrase (<->). A phrase makes
// that arm fall back to plainto_tsquery, which is all AND: the `or` of the expanded
// query would become a required lexeme and the arm would match nothing, a recall
// regression against the unexpanded query. So when any term is not a plain word
// (letters and digits, joined by single hyphens) `foldedQuery` is the canonical query
// itself, exactly the p_folded the archive sent before the alias existed, and only
// `variantsQuery` expands.
//
// SMALL ON PURPOSE. Only pairs that are the same thing under two spellings belong
// in SEARCH_ALIAS_GROUPS. The group below is the same pair as the hubs' `akp`
// aliases in src/lib/trends/rising-entities.ts (h3-hubs-2). A new group needs its
// own check against the live archive that both spellings are in use.
//
// ONE WAY (h58-postship-4). A short province name is not the same thing as the
// official one in both directions, so SEARCH_ONE_WAY_ALIASES widens the short
// spelling only. FTS stems 'afyon' to 'afyo' but leaves 'afyonkarahisar' whole, so
// there is no prefix match between them. On production (2026-11-07) 'afyon' found 8
// clusters while 'afyonkarahisar' hit the 24 cap and the archive held 79 live
// multi-member clusters with an 'afyon...' word, among them the week's Afyonkarahisar
// killing of 8 people; 'urfa' found 7 against a capped 'sanliurfa', 'antep' 5 against a
// capped 'gaziantep'. 'afyon or afyonkarahisar', 'urfa or sanliurfa' and
// 'antep or gaziantep' returned 24 of 24 rows carrying the word. The reverse stays off:
// afyon is also opium and 'Antep fıstığı' is a product, so a reader who typed the
// official name must not be handed those. 'maraş' and 'kahramanmaraş' are left out in
// both directions: 'Kapalı Maraş' (Varosha) is a frequent KKTC topic, not Kahramanmaraş.
//
// FOREIGN NAMES (h116-search-2). A foreign name has several spellings in Turkish
// headlines, and each is a separate archive search. Live counts, 2026-11-11 (clusters
// updated in the last 45 days, article_count >= 2, word-start match on the folded title,
// neutral title and summary): erakci 31 / arakci 21 / both 3, so 'Erakçi' and 'Arakçi'
// (Iran's foreign minister) shared 0 of 24 ids on the live pages; zelenskiy 38 /
// zelenski-only 6; hamaney 11 / hamenei 0, so 'Hamenei' answered 'sonuç bulunamadı'.
// The two symmetric groups cover Erakçi / Arakçi and Zelenskiy / Zelenski; 'Hamenei' is
// one way, since only 'hamaney' is in use and the other spelling has nothing to offer a
// reader who typed 'Hamaney'. The English 'zelensky' is left out on purpose: a third form
// would be a third disjunct, and the cost bound above is at most two. ts_lexize leaves
// every one of these forms whole (erakci, arakci, zelenskiy, zelenski, hamaney, hamenei),
// so each stem is a whole word: no spelling is over-cut, the 166 over-stem guard set is
// empty for them, and the `or` expansion does not switch a guard off for these queries.
// Each future pair still needs its own check against the live archive.

import { MAX_SEARCH_TERMS, foldTr } from "./turkish-query";

/** One spelling of an alias: the terms, tr-lowercased and ASCII-folded. */
type AliasForm = readonly string[];
/** Spellings of one thing, in the order their disjuncts appear in the expanded query. */
type AliasGroup = readonly AliasForm[];

/**
 * The same pair as rising-entities.ts' `akp` aliases ['AK Parti', 'AKP']
 * (h3-hubs-2), as term sequences. Terms are ASCII-folded so a query typed with
 * Turkish letters ('AK PARTİ', 'Ak Partı') is matched through `foldTr`, the same
 * fold the archive's folded arm uses.
 */
export const SEARCH_ALIAS_GROUPS: readonly AliasGroup[] = [
  [["akp"], ["ak", "parti"]],
  [["erakci"], ["arakci"]],
  [["zelenskiy"], ["zelenski"]],
];

/** A short spelling that also searches the official one, never the other way round. */
interface OneWayAlias {
  from: AliasForm;
  to: AliasForm;
}

/**
 * Province short names that also search the official name (h58-postship-4), and the
 * unused 'hamenei' spelling that also searches 'hamaney' (h116-search-2). Terms are
 * ASCII-folded like the groups above. Only `from` triggers an expansion; a `to` form
 * typed on its own is left exactly as the reader wrote it.
 */
export const SEARCH_ONE_WAY_ALIASES: readonly OneWayAlias[] = [
  { from: ["afyon"], to: ["afyonkarahisar"] },
  { from: ["urfa"], to: ["sanliurfa"] },
  { from: ["antep"], to: ["gaziantep"] },
  { from: ["hamenei"], to: ["hamaney"] },
];

// '"' opens a phrase, a leading '-' negates and a standalone `or` joins: all
// three are websearch syntax the archive RPC reads, so the reader is in charge.
const EDGE_NON_WORD = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/**
 * True when the query already uses websearch syntax: a double quote, a term that
 * starts with '-', or a standalone `or` (any case, punctuation around it ignored,
 * so 'akp (or) chp' counts). 'orhan' and 'ak-parti' do not.
 */
export function hasSearchOperator(q: string): boolean {
  if (q.includes('"')) return true;
  for (const raw of q.split(/\s+/)) {
    if (raw.startsWith("-")) return true;
    if (raw.replace(EDGE_NON_WORD, "").toLocaleLowerCase("tr") === "or") return true;
  }
  return false;
}

interface AliasHit {
  group: AliasGroup;
  /** Index of the first term of the occurrence. */
  start: number;
  /** How many terms the occurrence spans. */
  length: number;
}

// The earliest occurrence of any form of any group, or of the `from` form of a
// one-way alias (its `to` form never triggers). Terms are compared folded, so a
// Turkish-letter spelling finds the ASCII alias; an occurrence that merely
// contains the letters ('akparti', 'akşener', 'afyonlu') is a different term and
// never hits.
function findFirstAlias(terms: readonly string[]): AliasHit | null {
  const folded = terms.map(foldTr);
  const occursAt = (form: AliasForm, start: number) =>
    form.every((term, j) => folded[start + j] === term);
  for (let start = 0; start < folded.length; start++) {
    for (const group of SEARCH_ALIAS_GROUPS) {
      for (const form of group) {
        if (occursAt(form, start)) return { group, start, length: form.length };
      }
    }
    // A one-way hit expands like a two-form group, [from, to], so everything downstream
    // (the disjunction, the term cost bound, the in-feed term lists) is one code path.
    for (const { from, to } of SEARCH_ONE_WAY_ALIASES) {
      if (occursAt(from, start)) return { group: [from, to], start, length: from.length };
    }
  }
  return null;
}

function withForm(
  terms: readonly string[],
  hit: AliasHit,
  replacement: readonly string[],
): string[] {
  return [
    ...terms.slice(0, hit.start),
    ...replacement,
    ...terms.slice(hit.start + hit.length),
  ];
}

/**
 * `terms` with the first alias occurrence replaced by each spelling of its
 * group, in group order (one term list per spelling, the spelling the reader
 * typed included). Null when no alias occurs. The in-feed filter uses it on
 * match keys; `expandAliasQuery` builds the archive query from the same hit.
 */
export function aliasTermForms(terms: readonly string[]): string[][] | null {
  const hit = findFirstAlias(terms);
  if (hit === null) return null;
  return hit.group.map((form) => withForm(terms, hit, form));
}

export interface AliasExpansion {
  /** For `p_variants`: a multi-word spelling is quoted (a phrase on search_tsv). */
  variantsQuery: string;
  /**
   * For `p_folded`: never quoted (the folded arm cannot hold a phrase). The canonical query,
   * unexpanded, when a term would make 129's folded arm parse a phrase (see PHRASE-MAKING TERMS).
   */
  foldedQuery: string;
}

// A term the folded arm reads without a phrase operator: letters and digits, joined by single
// hyphens (129 turns those hyphens into spaces). Tested on foldTr(term), the form the arm sees.
const PLAIN_FOLDED_TERM = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u;

/**
 * Rewrites a canonical query (`canonicalSearchQuery` output, 6 terms or fewer)
 * that contains an alias into a websearch disjunction over the spellings of the
 * alias, or returns null: no alias in the query, input over the term cap, or the
 * reader already used websearch syntax. Only the first occurrence is expanded.
 * Callers build the RPC arguments with `turkishQueryVariants(variantsQuery)` and
 * `foldTr(foldedQuery)`.
 */
export function expandAliasQuery(canonical: string): AliasExpansion | null {
  const terms = canonical.split(/\s+/).filter((t) => t !== "");
  if (terms.length === 0 || terms.length > MAX_SEARCH_TERMS) return null;
  if (hasSearchOperator(canonical)) return null;

  const hit = findFirstAlias(terms);
  if (hit === null) return null;

  const variants = hit.group.map((form) =>
    withForm(terms, hit, form.length > 1 ? [`"${form.join(" ")}"`] : form).join(" "),
  );
  const folded = hit.group.map((form) => withForm(terms, hit, form).join(" "));
  const plain = terms.every((term) => PLAIN_FOLDED_TERM.test(foldTr(term)));
  return {
    variantsQuery: variants.join(" or "),
    foldedQuery: plain ? folded.join(" or ") : canonical,
  };
}
