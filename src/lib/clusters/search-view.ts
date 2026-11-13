import { ARCHIVE_MAX_PAGE } from "@/lib/seo/home-canonical";
import type { ClusterBundle } from "./politics-query";
import type { SearchResult } from "./search-query";

export interface ComposeSearchViewArgs {
  q?: string;
  /** The in-feed page (?page=N). */
  page: number;
  /**
   * The archive page (?arsiv=N, h170-roadmap-1), 1 to ARCHIVE_MAX_PAGE; absent or anything else is 1,
   * the view as it always was. 2 and later: `search` holds that page's rows (searchClusters(q, N)).
   */
  archivePage?: number;
  inFeedIds: ReadonlySet<string>;
  search: SearchResult | null;
}

export interface SearchView {
  archive: ClusterBundle[];
  archiveUnavailable: boolean;
  emptySearch: boolean;
  /**
   * The archive search filled its page (SEARCH_LIMIT), so more matches may
   * exist than are listed. True only on page 1 of an ok search that has at
   * least one archive row left after the in-feed filter.
   */
  archiveCapped: boolean;
  /**
   * Archive-only matches for the whole search: every ok-search row that is not
   * already in the feed. Unlike `archive` (page 1 only), this is the same on
   * every page, so "N sonuç" does not change when the reader pages through.
   */
  archiveTotal: number;
  /**
   * `archiveCapped` without the page-1 restriction: the archive search filled
   * its page and at least one archive-only row is left, on any page.
   */
  archiveCappedTotal: boolean;
  /**
   * A next page of the archive ranking exists (h170-roadmap-1). On page 1 only when the TYPED call alone
   * filled its page (`search.typedFull`: a sibling or locative call fills a page that has no continuation)
   * and the reader is on in-feed page 1, where the archive list shows; on a later page when the page was
   * full (`capped`) and it is not the last (ARCHIVE_MAX_PAGE). Independent of the in-feed filter: a full
   * page whose rows are all in the feed still has a next page.
   */
  archiveHasNext: boolean;
  /** A later page whose function is not in the schema cache yet (migration 211 unapplied): say so, offer page 1. */
  archivePageUnavailable: boolean;
  /** The last page (ARCHIVE_MAX_PAGE) came back full: the 96 best matches are shown, narrow the search for more. */
  archiveEnd: boolean;
}

/** The archive page a view is composed for: a whole number from 1 to ARCHIVE_MAX_PAGE, else 1. */
function viewArchivePage(archivePage: number | undefined): number {
  if (archivePage === undefined || !Number.isInteger(archivePage) || archivePage < 2) return 1;
  return Math.min(archivePage, ARCHIVE_MAX_PAGE);
}

// The pager fields of every view that has no archive page to turn (no query, too short, a plain failure on page 1).
const NO_PAGER = { archiveHasNext: false, archivePageUnavailable: false, archiveEnd: false } as const;

/**
 * Pure view-model for HomeFeed's search/archive rendering. Extracted so the
 * branch matrix below (no query / short query / rpc-or-embed failure / ok)
 * is unit-testable without rendering JSX or touching Supabase.
 *
 * `search` is `null` exactly when the query is shorter than
 * `MIN_QUERY_LENGTH` (searchClusters was never called) — distinct from
 * `{ ok: false }`, which means it WAS called and failed.
 *
 * On an archive page after the first (h170-roadmap-1) the view is the page's own rows without the in-feed
 * ids (the in-feed sections show on page 1 only, so those rows were already listed there), never an
 * "empty search" (an empty page is not a search that found nothing), and `archiveCapped`, the page-1
 * heading flag, stays false.
 */
export function composeSearchView({
  q,
  page,
  archivePage: archivePageArg,
  inFeedIds,
  search,
}: ComposeSearchViewArgs): SearchView {
  if (!q) {
    return {
      archive: [],
      archiveUnavailable: false,
      emptySearch: false,
      archiveCapped: false,
      archiveTotal: 0,
      archiveCappedTotal: false,
      ...NO_PAGER,
    };
  }

  if (search === null) {
    return {
      archive: [],
      archiveUnavailable: false,
      emptySearch: inFeedIds.size === 0,
      archiveCapped: false,
      archiveTotal: 0,
      archiveCappedTotal: false,
      ...NO_PAGER,
    };
  }

  const archivePage = viewArchivePage(archivePageArg);

  if (!search.ok) {
    return {
      archive: [],
      archiveUnavailable: true,
      emptySearch: false,
      archiveCapped: false,
      archiveTotal: 0,
      archiveCappedTotal: false,
      ...NO_PAGER,
      archivePageUnavailable: archivePage > 1 && search.unavailablePage === true,
    };
  }

  const archiveOnly = search.bundles.filter(
    (b) => !inFeedIds.has(b.cluster.id)
  );

  if (archivePage > 1) {
    const full = search.capped === true;
    return {
      archive: archiveOnly,
      archiveUnavailable: false,
      emptySearch: false,
      archiveCapped: false,
      archiveTotal: archiveOnly.length,
      archiveCappedTotal: full && archiveOnly.length > 0,
      archiveHasNext: full && archivePage < ARCHIVE_MAX_PAGE,
      archivePageUnavailable: false,
      archiveEnd: full && archivePage >= ARCHIVE_MAX_PAGE,
    };
  }

  const archive = page === 1 ? archiveOnly : [];
  const cappedTotal = search.capped === true && archiveOnly.length > 0;

  return {
    archive,
    archiveUnavailable: false,
    emptySearch: inFeedIds.size === 0 && archive.length === 0,
    archiveCapped: page === 1 && cappedTotal,
    archiveTotal: archiveOnly.length,
    archiveCappedTotal: cappedTotal,
    ...NO_PAGER,
    archiveHasNext: page === 1 && search.typedFull === true,
  };
}
