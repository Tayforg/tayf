import type { ClusterBundle } from "./politics-query";
import type { SearchResult } from "./search-query";

export interface ComposeSearchViewArgs {
  q?: string;
  page: number;
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
}

/**
 * Pure view-model for HomeFeed's search/archive rendering. Extracted so the
 * branch matrix below (no query / short query / rpc-or-embed failure / ok)
 * is unit-testable without rendering JSX or touching Supabase.
 *
 * `search` is `null` exactly when the query is shorter than
 * `MIN_QUERY_LENGTH` (searchClusters was never called) — distinct from
 * `{ ok: false }`, which means it WAS called and failed.
 */
export function composeSearchView({
  q,
  page,
  inFeedIds,
  search,
}: ComposeSearchViewArgs): SearchView {
  if (!q) {
    return {
      archive: [],
      archiveUnavailable: false,
      emptySearch: false,
      archiveCapped: false,
    };
  }

  if (search === null) {
    return {
      archive: [],
      archiveUnavailable: false,
      emptySearch: inFeedIds.size === 0,
      archiveCapped: false,
    };
  }

  if (!search.ok) {
    return {
      archive: [],
      archiveUnavailable: true,
      emptySearch: false,
      archiveCapped: false,
    };
  }

  const archive =
    page === 1
      ? search.bundles.filter((b) => !inFeedIds.has(b.cluster.id))
      : [];

  return {
    archive,
    archiveUnavailable: false,
    emptySearch: inFeedIds.size === 0 && archive.length === 0,
    archiveCapped: page === 1 && search.capped === true && archive.length > 0,
  };
}
