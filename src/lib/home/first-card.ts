import type {
  ClusterBundle,
  PoliticsClustersResult,
} from "@/lib/clusters/politics-query";
import { groupByDayBucket } from "@/lib/home/day-buckets";
import { HOME_PAGE_SIZE } from "@/lib/seo/home-canonical";

// h160-1: which story the home page shows FIRST, worked out without a clock so
// the prerendered shell can preload that story's banner before the feed streams
// in (HomeLcpPreload).
//
// HomeFeed (src/app/page.tsx) renders, for the plain feed (no ?q=, page 1):
//   1. the Son Dakika strip, when it is not empty: its first card is index 0;
//   2. otherwise the first page of the ranked list, grouped by Istanbul
//      calendar day at the REQUEST time, newest day first: index 0 is the first
//      card of the first non-empty bucket.
//
// The shell has no request time, so step 2 buckets at the page's own newest
// story instead. That is the same answer whenever the newest page-1 story is
// from today or yesterday (Istanbul): the first bucket is then the newest
// story's calendar day at the request time too ("Bugün", or "Dün" when no
// story has broken yet today), and its members are the page's stories of that
// day, in ranked order. A mismatch (a feed with nothing from the last two days,
// or a request just after a day boundary on a cached shell) only wastes one
// small image preload, never changes what the page shows.
//
// The Son Dakika strip is not de-duplicated against the ranked list here: that
// is only needed when the strip is empty, and then there is nothing to remove.

/**
 * The card HomeFeed renders at index 0 for the plain feed, or `null` when it
 * renders none. Pure: no clock read, no I/O, no mutation of `feed`.
 */
export function homeFirstCard(
  feed: Pick<PoliticsClustersResult, "bundles" | "breakingBundles">,
): ClusterBundle | null {
  const breaking = feed.breakingBundles[0];
  if (breaking !== undefined) return breaking;

  const paged = feed.bundles.slice(0, HOME_PAGE_SIZE);
  const first = paged[0];
  if (first === undefined) return null;

  const firstPublishedMs = (b: ClusterBundle) =>
    Date.parse(b.cluster.first_published);

  let newestMs = Number.NEGATIVE_INFINITY;
  for (const b of paged) {
    const ms = firstPublishedMs(b);
    if (Number.isFinite(ms) && ms > newestMs) newestMs = ms;
  }
  // No parseable stamp: every card would sit in the catch-all bucket, in
  // ranked order, so the first one is the first card.
  if (!Number.isFinite(newestMs)) return first;

  return (
    groupByDayBucket(paged, firstPublishedMs, newestMs)[0]?.items[0] ?? null
  );
}
