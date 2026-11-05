import { TOPIC_INDEX_MIN_CLUSTERS } from "./topic-query";

/**
 * Robots override for /konu/[slug]?sayfa=N, shared between generateMetadata and
 * the unit tests. It has no next/* import of its own; the one constant it needs
 * comes from topic-query.ts, next to TOPIC_PAGE_SIZE.
 *
 * Returns `{ index: false, follow: true }` when
 *  - the read failed (`result === null`): do not index the "unavailable" state,
 *    but keep following the links so crawlers still reach the other hubs; or
 *  - the page is past the last one (`page > 1` and no bundles): a soft-404 that
 *    must not be indexed, while its "Önceki" link stays crawlable; or
 *  - it is page 1 of a hub too thin to be a topic feed (h44-topics-3): no page 2
 *    (`!hasMore`) and fewer than TOPIC_INDEX_MIN_CLUSTERS clusters, an empty
 *    page 1 included.
 *
 * Returns `undefined` otherwise, leaving the layout's default (indexable)
 * robots in place.
 *
 * The third rule deliberately NARROWS the earlier rule that an empty page 1
 * stays indexable. Tayf clusters only articles that pass the politics gate, so
 * /konu/spor and /konu/teknoloji held 10 clusters each, the newest days old,
 * under a title that read like a sports and a tech feed. An indexable page that
 * promises more than it has is the thing to avoid, and a hub that fills up
 * again (a second page, or 20 clusters) is indexable again with no deploy:
 * the rule reads the same cached result the page renders. TOPIC_PAGE_SIZE (30)
 * is at least TOPIC_INDEX_MIN_CLUSTERS (20), so a full page needs no count read:
 * `hasMore` (the extra fetched row) already says there is more. Pages past the
 * first are unchanged: a short last page continues a list that began full.
 */
export function topicPageRobots(
  page: number,
  result: { bundles: readonly unknown[]; hasMore: boolean } | null,
): { index: false; follow: true } | undefined {
  if (result === null) return { index: false, follow: true };
  if (page > 1 && result.bundles.length === 0) {
    return { index: false, follow: true };
  }
  if (
    page === 1 &&
    !result.hasMore &&
    result.bundles.length < TOPIC_INDEX_MIN_CLUSTERS
  ) {
    return { index: false, follow: true };
  }
  return undefined;
}
