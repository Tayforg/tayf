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

/**
 * Is page 1 of a hub with `count` clusters in the 7-day window indexable? The
 * third rule of `topicPageRobots` stated on the cluster COUNT (getTopicCounts,
 * the same filter the page reads with), for a caller that has the count and no
 * page: the static sitemap, which lists a /konu/<slug> hub only when this holds
 * (h114-consumers-1), so it never submits a URL the page itself marks `noindex`
 * (a Search Console "Submitted URL marked noindex" error).
 *
 * `count >= TOPIC_INDEX_MIN_CLUSTERS`. It agrees with
 * `topicPageRobots(1, { bundles: min(count, TOPIC_PAGE_SIZE) of them, hasMore:
 * count > TOPIC_PAGE_SIZE })` for every count: a count past one page means a
 * page 2 exists (`hasMore`, indexable however few cards survive), and a count
 * of at most one page IS the page's bundle count, which must reach the minimum.
 * The parity test in topic-page-robots.test.ts pins that. One gap by design: a
 * cluster with no readable member is dropped from the page's cards but still
 * counted, so a hub sitting at 20 to 30 can serve `noindex` while this says
 * true; the page rule reads the cards, this reads the count.
 *
 * Anything that is not a count at or above the minimum (0, negative, NaN) is
 * `false`.
 */
export function topicHubIndexable(count: number): boolean {
  return count >= TOPIC_INDEX_MIN_CLUSTERS;
}
