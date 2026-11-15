// The order of the archive search results (h191). Pure and string-only, shared by the home page, its toggle, the chips of
// an empty search and the archive search itself (src/lib/clusters/search-query.ts).
//
// ?sirala=yeni is the newest-first order: the newest clusters whose title literally holds the query, one page per call to
// migration 215's search_cluster_ids_new. Anything else (no parameter, an empty one, an unknown value, another case, a
// repeated parameter, which Next gives as an array) is the ranked order the page always had. Only the exact value selects
// the new order, and the raw parameter is never passed on: the parser returns the constant or null.

/** The one value of ?sirala= that selects the newest-first order. */
export const SEARCH_SORT_NEW = "yeni";

/** The order of a search that is not the ranked default. */
export type SearchSort = typeof SEARCH_SORT_NEW;

/** `?sirala=` -> "yeni" for exactly that value, null (the ranked order) for everything else. */
export function parseSearchSort(raw: string | string[] | undefined): SearchSort | null {
  return raw === SEARCH_SORT_NEW ? SEARCH_SORT_NEW : null;
}

/**
 * The address of a search: the query, then `sirala=yeni` when the newest-first order is asked for, then `arsiv` from the
 * second archive page. Built with URLSearchParams from scratch, so the ranked first page is the plain "/?q=" the search
 * box makes, the query is encoded and cannot add a parameter, and neither `page` nor any other parameter rides along.
 */
export function searchHref(
  q: string,
  options: { sort?: SearchSort | null; archivePage?: number } = {},
): string {
  const params = new URLSearchParams();
  params.set("q", q);
  if (options.sort === SEARCH_SORT_NEW) params.set("sirala", SEARCH_SORT_NEW);
  const page = options.archivePage ?? 1;
  if (page > 1) params.set("arsiv", String(page));
  return `/?${params.toString()}`;
}
