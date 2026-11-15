import { canonicalSearchQuery } from "@/lib/clusters/turkish-query";

// The words an empty multi-word search offers as one-tap chips (h185-roadmap2-1).
//
// The archive search ANDs every typed word (migration 204 joins the lexemes with
// ' & '), so 'emekli bayram ikramiyesi ne zaman' finds nothing while 'emekli',
// 'bayram' and 'ikramiyesi' each have results. The empty card used to be a dead
// end; it now lists one plain search link per word so the reader can widen the
// search in one tap. No RPC, no migration, no extra read: this only picks words.
//
// canonicalSearchQuery is the one tokeniser. The words offered are exactly the
// terms the archive searched (Turkish lower-casing, edge punctuation cut, an
// apostrophe suffix dropped, at most MAX_SEARCH_TERMS words and
// MAX_SEARCH_QUERY_LENGTH characters, a word cut by the length bound dropped
// whole), never a second parser's idea of a word.

/** A word shorter than this is a particle ('ne', 'mi'), not something to search alone. */
const MIN_WORD_CODE_POINTS = 3;

/**
 * The words the search engine itself throws away: Postgres' Turkish text-search configuration has a stop list,
 * so websearch_to_tsquery('turkish', w) is an empty query for each of them. The archive search never applies one
 * (it AND-joins the lexemes of the words that are left), so a chip for such a word would run an empty search
 * and land on the same empty card.
 *
 * Derivation: `select w from unnest(array[...203 candidate words...]) w where
 * websearch_to_tsquery('turkish', w)::text = ''`, run read-only on prod on 2026-11-15; the Postgres turkish stop
 * list is the source. 51 words: 38 of 3 or more code points, and 13 shorter ones that are listed so a short
 * stop word ('ne', 've') can be told from a short word the engine does apply ('mi', 'ab').
 *
 * Compared with the canonical term after its quotes are stripped (canonicalSearchQuery already lower-cases with
 * the Turkish rules). ASCII spellings are NOT folded: 'icin', 'nasil' and 'mi' are real lexemes to the engine
 * ('için' only returns rows through the ASCII-folded arm, and those are unrelated), and 'zaman' (lexeme 'zama')
 * is not a stop word either. A constant, so this adds no read.
 */
export const ENGINE_STOP_WORDS: ReadonlySet<string> = new Set([
  // 3 or more code points (38)
  "acaba",
  "ama",
  "bazı",
  "belki",
  "biri",
  "birkaç",
  "birşey",
  "biz",
  "çok",
  "çünkü",
  "daha",
  "defa",
  "diye",
  "eğer",
  "gibi",
  "hem",
  "hep",
  "hepsi",
  "her",
  "hiç",
  "için",
  "ile",
  "ise",
  "kez",
  "kim",
  "nasıl",
  "neden",
  "nerde",
  "nerede",
  "nereye",
  "niçin",
  "niye",
  "sanki",
  "şey",
  "siz",
  "tüm",
  "veya",
  "yani",
  // shorter (13)
  "bu",
  "da",
  "de",
  "en",
  "ki",
  "mı",
  "mu",
  "mü",
  "ne",
  "o",
  "şu",
  "ve",
  "ya",
]);

/**
 * One word per distinct, meaningful term of a multi-word query, in typed order:
 *   - a negated term ('-vergi', or '"-vergi"' whose quotes hide the '-') is dropped: a chip for it would
 *     search FOR the word the reader excluded;
 *   - every '"' is stripped (a phrase's quotes), so each word of a quoted phrase
 *     is offered on its own;
 *   - one of the engine's own stop words (ENGINE_STOP_WORDS) is dropped: the engine ignores it, so a chip for
 *     it would search nothing;
 *   - a word of fewer than 3 code points is dropped;
 *   - repeats ('Kripto KRİPTO') are offered once.
 * [] when the canonical query is empty or a single term, and when only one word is left and dropping the rest
 * changed nothing: a lone chip is kept only when a negation or a short word the engine does apply ('mi', 'ab')
 * was dropped, because only then is the chip a wider search. 'kripto -vergi' gives ['kripto'] (widening drops
 * the negation); 'kripto ne' and 'Kripto KRİPTO' give [] (the chip would rerun the same search).
 *
 * Pure and linear in the query. The words are plain text; a caller that renders
 * them must escape them (React does) and build a URL from one with
 * URLSearchParams, never by concatenation.
 */
export function relaxedSearchWords(q: string): string[] {
  const terms = canonicalSearchQuery(q).split(" ");
  if (terms.length < 2) return [];

  const seen = new Set<string>();
  const words: string[] = [];
  // True when a term the archive actually applied was dropped (a negation, or a short word that is not a stop
  // word), so a single remaining chip is a real widening. Stop words and repeats never set it.
  let widens = false;
  for (const term of terms) {
    const word = term.split('"').join("");
    if (term.startsWith("-") || word.startsWith("-")) {
      widens = true;
      continue;
    }
    if (word === "") continue;
    if (ENGINE_STOP_WORDS.has(word)) continue;
    if (Array.from(word).length < MIN_WORD_CODE_POINTS) {
      widens = true;
      continue;
    }
    if (seen.has(word)) continue;
    seen.add(word);
    words.push(word);
  }
  if (words.length === 1 && !widens) return [];
  return words;
}
