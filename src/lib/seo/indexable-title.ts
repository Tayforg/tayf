import { isQuestionTitle } from "@/lib/clusters/neutral-title";

// One definition of "the title the cluster page serves" and of "that title keeps
// the page out of the index", for the places that list cluster URLs: the month
// and news sitemaps and the IndexNow ping (h34-reader-2 follow-up). The cluster
// page serves `title_tr_neutral` when it has text and `title_tr` otherwise
// (cluster-detail-query.ts), and marks a cluster whose served title is a question
// or an SEO explainer `noindex` (isIndexableCluster in src/app/cluster/[id]/
// page.tsx). A list that still carried such a cluster would submit a URL that
// answers `noindex`: a Search Console "Submitted URL marked noindex" error and a
// wasted ping. Pure: no I/O, no clock.

/** The columns that decide the served title. Both optional: a row from a narrower select has neither. */
export interface ServedTitleRow {
  title_tr?: string | null;
  title_tr_neutral?: string | null;
}

/**
 * The headline the cluster page serves for `row`: the neutral title when it has
 * text (blank or whitespace-only counts as none), else `title_tr`, else "".
 */
export function servedClusterTitle(row: ServedTitleRow): string {
  const neutral = typeof row.title_tr_neutral === "string" ? row.title_tr_neutral.trim() : "";
  if (neutral !== "") return neutral;
  return typeof row.title_tr === "string" ? row.title_tr : "";
}

/**
 * False when the served title is a question or an SEO explainer (isQuestionTitle),
 * the cluster page's `noindex` case. True otherwise, including a row with no
 * title at all: with nothing to judge the article-count gate stays in charge.
 */
export function hasIndexableTitle(row: ServedTitleRow): boolean {
  return !isQuestionTitle(servedClusterTitle(row));
}
