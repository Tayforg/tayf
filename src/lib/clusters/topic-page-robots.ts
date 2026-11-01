/**
 * Robots override for /konu/[slug]?sayfa=N, kept free of next/* imports so it
 * is unit-testable and shared between generateMetadata and the page body.
 *
 * Returns `{ index: false, follow: true }` when
 *  - the read failed (`result === null`): do not index the "unavailable" state,
 *    but keep following the links so crawlers still reach the other hubs; or
 *  - the page is past the last one (`page > 1` and no bundles): a soft-404 that
 *    must not be indexed, while its "Önceki" link stays crawlable.
 *
 * Returns `undefined` otherwise, leaving the layout's default (indexable)
 * robots in place. An empty page 1 is a real answer ("no clusters this week")
 * and stays indexable.
 */
export function topicPageRobots(
  page: number,
  result: { bundles: readonly unknown[] } | null,
): { index: false; follow: true } | undefined {
  if (result === null) return { index: false, follow: true };
  if (page > 1 && result.bundles.length === 0) {
    return { index: false, follow: true };
  }
  return undefined;
}
