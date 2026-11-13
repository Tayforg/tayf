import { normaliseSearchQuery } from "@/lib/clusters/turkish-query";
import { formatCountTr } from "@/lib/format/number-tr";

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
export function resultCountPhrase(count: number, capped: boolean): string {
  const text = `${formatCountTr(count)} sonuç`;
  return capped ? `en ilgili ${text}` : text;
}

/**
 * h170-roadmap-1: what a later page of the archive ranking (?arsiv=N, N >= 2) is called: "en ilgili
 * sonuçların 2. sayfası". It stands where `resultCountPhrase` stands, in the visible line and in the
 * live region, because the count of one page is not the count of the search.
 */
export function archivePagePhrase(archivePage: number): string {
  return `en ilgili sonuçların ${archivePage}. sayfası`;
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
}

/**
 * The sentence announced after a search, or "" when there is no search (a
 * blank q has nothing to announce, and an empty live region says nothing).
 * A too-short query asks for more characters: no search ran, so neither
 * "no results" nor "not responding" would be true, and it wins over both.
 * `unavailable` wins over `capped`: a failed archive search is never "capped".
 */
export function searchStatusText({
  q,
  count,
  capped,
  unavailable,
  archivePage,
  pageUnavailable,
}: SearchStatusArgs): string {
  const shown = displayQuery(q);
  if (!shown) return "";
  if (isTooShortQuery(q)) return `En az ${MIN_QUERY_LENGTH} karakter yazın.`;

  // h170-roadmap-1: a later page of the ranking names its page. Its count is the page's, never the search's,
  // so it is not claimed; a page that cannot be shown says so, and any other failure is the plain one.
  if (isLaterArchivePage(archivePage)) {
    if (unavailable) {
      return pageUnavailable === true ? "Bu sayfa şu an gösterilemiyor." : "Arama şu an yanıt vermiyor.";
    }
    return `“${shown}” için ${archivePagePhrase(archivePage)} gösteriliyor.`;
  }

  const results = Number.isFinite(count) && count > 0 ? count : 0;
  if (unavailable) {
    return results === 0
      ? "Arama şu an yanıt vermiyor."
      : `“${shown}” için ${resultCountPhrase(results, false)} bulundu; arşiv araması şu an yanıt vermiyor.`;
  }
  if (results === 0) return `“${shown}” için sonuç bulunamadı.`;
  if (capped) {
    return `“${shown}” için ${resultCountPhrase(results, true)} gösteriliyor.`;
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
