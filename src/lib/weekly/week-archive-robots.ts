/**
 * Robots override for /hafta/[hafta], shared between generateMetadata and the
 * unit tests. It has no import of its own (so no next/* either), which keeps it
 * a plain function of the week read the page already has.
 *
 * Returns `{ index: false, follow: true }` when
 *  - the read failed (`read === null`: a Supabase error on any page, or the
 *    reader's 4 s abort, so the page renders its "özet hesaplanamıyor" shell); or
 *  - the read worked but the week holds no rows (the page renders its empty
 *    shell, which promises a weekly summary it does not have).
 * Neither state should be indexed, but the links in the shell (previous and
 * next week, /hafta) stay crawlable, hence `follow: true`.
 *
 * Returns `undefined` otherwise, leaving the layout's default (indexable)
 * robots in place.
 *
 * Same shape as topicPageRobots (src/lib/clusters/topic-page-robots.ts) for
 * /konu. The caller passes the page body's own cached read, so the verdict costs
 * no extra round trip.
 */
export function weekArchiveRobots(
  read: { rows: readonly unknown[] } | null,
): { index: false; follow: true } | undefined {
  if (read === null || read.rows.length === 0) {
    return { index: false, follow: true };
  }
  return undefined;
}
