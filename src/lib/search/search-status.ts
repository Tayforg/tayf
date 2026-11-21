import { canonicalSearchQuery, normaliseSearchQuery } from "@/lib/clusters/turkish-query";
import { formatCountTr } from "@/lib/format/number-tr";
import { ENGINE_STOP_WORDS } from "@/lib/search/relaxed-search";
import { SEARCH_SORT_NEW, type SearchSort } from "@/lib/search/search-sort";

// Reader-facing sentences for the home search (h10-a11y-2): the text of the
// always-mounted sr-only live region on "/" and the <title> of "/?q=".
//
// Pure and string-only on purpose. The callers hand the result to React as a
// text child (escaped) and to Next as a metadata title (escaped), so a query
// like `<script>` comes back verbatim here and is never turned into markup.

/** Longest query, in code points, quoted in an announcement or a title. */
export const SEARCH_QUERY_DISPLAY_MAX = 60;

/**
 * The shortest query the archive search runs, after normalising. Mirrors
 * MIN_QUERY_LENGTH in src/lib/clusters/search-query.ts, which is a 'use cache'
 * server module and so is not imported here; search-status.test.ts reads that
 * file and fails if the two numbers drift.
 */
export const MIN_QUERY_LENGTH = 2;

/**
 * True for a query that was typed but is too short to search: its normalised
 * form (the same cleaning searchClusters applies: Unicode cleaned, control
 * characters out, a Turkish apostrophe suffix dropped, whitespace collapsed)
 * has fewer than
 * MIN_QUERY_LENGTH characters. A blank or missing q is "no search", not "too
 * short", so it is false. Callers use it to say "type more" instead of
 * claiming a search found nothing when none ran.
 */
export function isTooShortQuery(q: string | undefined): boolean {
  const raw = (q ?? "").trim();
  return raw !== "" && normaliseSearchQuery(raw).length < MIN_QUERY_LENGTH;
}

/**
 * h206-search-3: true when the query has at least one term and EVERY term is one of the words the search engine
 * throws away (ENGINE_STOP_WORDS: 've', 'bu', 'daha', 'için'). The turkish config drops these words in their Turkish
 * spelling, so most of them ('ve', 'bu', 'daha') find nothing in the archive; 14 hold ç/ğ/ı/ş/ü, and their ASCII fold,
 * which the archive's folded arm also searches (p_folded), is an ordinary lexeme (için -> 'iç', şu -> 'su', tüm ->
 * 'tum', nasıl -> 'nasil', ...). Prod 2026-11-21 returned 24 (capped) rows of noise for için, şu and nasıl, so these
 * queries are blocked on purpose, and the check removes those archive rows. The in-feed title filter would also answer
 * with the few cards that happen to hold the word ('“ve” için 3 sonuç bulundu' while hundreds of live headlines
 * contain 've'). Callers treat it like a too-short query: no search runs and the reader is asked for a more
 * distinctive word.
 *
 * The terms are the canonical ones (canonicalSearchQuery: the exact words the archive searches, Turkish
 * lower-cased, edge punctuation and an apostrophe suffix cut, at most the first six), with the quotes of a phrase
 * stripped, and compared as relaxedSearchWords compares them: NOT ASCII-folded, per the contract of
 * ENGINE_STOP_WORDS ('icin' and 'nasil' are real lexemes and stay searchable). A negated term ('-ve') is not a
 * stop word, so 've -erdoğan' is searched as before. Pure and linear in the query.
 */
export function isStopWordOnlyQuery(q: string): boolean {
  const terms = canonicalSearchQuery(q).split('"').join("").split(" ").filter((term) => term !== "");
  return terms.length > 0 && terms.every((term) => ENGINE_STOP_WORDS.has(term));
}

/** The sentence for a stop-word-only query (the live region, and the empty card on "/"): `“ve” tek başına aranamıyor: ...`. */
export function stopWordOnlyStatus(q: string | undefined): string {
  return `“${displayQuery(q)}” tek başına aranamıyor: daha belirgin bir kelime yazın.`;
}

/**
 * The query as it is shown back to the reader: trimmed, runs of whitespace
 * collapsed to one space, and capped at SEARCH_QUERY_DISPLAY_MAX code points
 * (59 characters plus "…" when longer). Truncation walks code points, so an
 * emoji at the boundary is never cut into a lone surrogate.
 */
export function displayQuery(q: string | undefined): string {
  const clean = (q ?? "").trim().replace(/\s+/g, " ");
  const points = Array.from(clean);
  if (points.length <= SEARCH_QUERY_DISPLAY_MAX) return clean;
  return `${points.slice(0, SEARCH_QUERY_DISPLAY_MAX - 1).join("")}…`;
}

/**
 * The result count as a reader-facing phrase, shared by the visible line under
 * the search box and the screen-reader sentence so the two cannot word it
 * differently (h50-search-3). "2 sonuç" when the list is complete; "en ilgili 24
 * sonuç" when the archive search filled its page (SEARCH_LIMIT) and more matches
 * may exist, because a bare "24 sonuç" would read as the total. The count has
 * Turkish dot grouping ("1.234") and a non-finite count reads as 0.
 */
export function resultCountPhrase(count: number, capped: boolean, sort?: SearchSort | null): string {
  const text = `${formatCountTr(count)} sonuç`;
  return capped ? `${rankWord(sort)} ${text}` : text;
}

/**
 * h191: "en ilgili" (most relevant) is the word of the ranked order; the newest-first order (?sirala=yeni) says "en yeni".
 * The one place the two words are chosen, so the visible line, the live region and the page headings cannot disagree.
 */
export function rankWord(sort?: SearchSort | null): string {
  return sort === SEARCH_SORT_NEW ? "en yeni" : "en ilgili";
}

/**
 * h170-roadmap-1: what a later page of the archive ranking (?arsiv=N, N >= 2) is called: "en ilgili
 * sonuçların 2. sayfası". It stands where `resultCountPhrase` stands, in the visible line and in the
 * live region, because the count of one page is not the count of the search.
 */
export function archivePagePhrase(archivePage: number, sort?: SearchSort | null): string {
  return `${rankWord(sort)} sonuçların ${archivePage}. sayfası`;
}

/** An archive page after the first: a whole number from 2 up. Anything else is page 1's wording. */
function isLaterArchivePage(archivePage: number | undefined): archivePage is number {
  return archivePage !== undefined && Number.isInteger(archivePage) && archivePage >= 2;
}

export interface SearchStatusArgs {
  q: string | undefined;
  /** Results for the whole search, all pages: in-feed matches plus archive-only rows. */
  count: number;
  /** The archive search filled its page, so more matches may exist. */
  capped: boolean;
  /** The archive search failed or timed out. */
  unavailable: boolean;
  /**
   * The archive page being shown (?arsiv=N). Absent or 1: the sentences below as they always were. 2 and
   * later: the page is named and no count is claimed (h170-roadmap-1).
   */
  archivePage?: number;
  /** `unavailable` because migration 211 is not applied: this page cannot be shown, the search can. */
  pageUnavailable?: boolean;
  /** The order the results are shown in (h191): "yeni" says "en yeni", absent or null keeps the ranked "en ilgili". */
  sort?: SearchSort | null;
}

/**
 * The sentence announced after a search, or "" when there is no search (a
 * blank q has nothing to announce, and an empty live region says nothing).
 * A too-short query asks for more characters: no search ran, so neither
 * "no results" nor "not responding" would be true, and it wins over both.
 * A query of engine stop words only asks for a more distinctive word, for the
 * same reason and with the same precedence (h206-search-3).
 * `unavailable` wins over `capped`: a failed archive search is never "capped".
 */
export function searchStatusText({
  q,
  count,
  capped,
  unavailable,
  archivePage,
  pageUnavailable,
  sort,
}: SearchStatusArgs): string {
  const shown = displayQuery(q);
  if (!shown) return "";
  if (isTooShortQuery(q)) return `En az ${MIN_QUERY_LENGTH} karakter yazın.`;
  // h206-search-3: a query of engine stop words only is not searched either, so no count and no "not found".
  if (isStopWordOnlyQuery(q ?? "")) return stopWordOnlyStatus(q);

  // h170-roadmap-1: a later page of the ranking names its page. Its count is the page's, never the search's,
  // so it is not claimed; a page that cannot be shown says so, and any other failure is the plain one.
  if (isLaterArchivePage(archivePage)) {
    if (unavailable) {
      return pageUnavailable === true ? "Bu sayfa şu an gösterilemiyor." : "Arama şu an yanıt vermiyor.";
    }
    return `“${shown}” için ${archivePagePhrase(archivePage, sort)} gösteriliyor.`;
  }

  const results = Number.isFinite(count) && count > 0 ? count : 0;
  if (unavailable) {
    return results === 0
      ? "Arama şu an yanıt vermiyor."
      : `“${shown}” için ${resultCountPhrase(results, false)} bulundu; arşiv araması şu an yanıt vermiyor.`;
  }
  // h191 review ui-2: a zero in the newest order is not a ranked zero (its literal-title filter is stricter than the ranked
  // order, so the ranked order can hold results), and the reader who hears "no results" has no reason to open the sort toggle.
  if (results === 0) {
    return sort === SEARCH_SORT_NEW
      ? `“${shown}” için en yeni sıralamada sonuç bulunamadı. En alakalı sıralamayı deneyin.`
      : `“${shown}” için sonuç bulunamadı.`;
  }
  if (capped) {
    return `“${shown}” için ${resultCountPhrase(results, true, sort)} gösteriliyor.`;
  }
  return `“${shown}” için ${resultCountPhrase(results, false)} bulundu.`;
}

/**
 * Page title for "/?q=…". The root layout's title template appends " — Tayf".
 * A blank query falls back to "Arama" rather than an empty pair of quotes. A later
 * archive page (?arsiv=N, N >= 2) adds " — N. sayfa".
 */
export function searchTitle(q: string | undefined, archivePage = 1): string {
  const shown = displayQuery(q);
  if (!shown) return "Arama";
  // h170-roadmap-1: a later archive page says which page it is (WCAG 2.4.2: the tab and the route announcer change).
  return isLaterArchivePage(archivePage)
    ? `“${shown}” araması — ${archivePage}. sayfa`
    : `“${shown}” araması`;
}
