// "Güncellendi" cue for the /cluster/[id] header.
//
// `clusters.updated_at` moves whenever the cluster row is recomputed (a new
// member joined, a re-score ran), so a header that only shows it reads
// "30 dakika önce" for a story that broke two hours ago. The header therefore
// shows the story's age (first_published) and, only when a member actually
// published meaningfully later, a separate "Güncellendi" cue.
//
// Pure: no clock reads. The clamp to `updatedAt` stands in for "now" — a
// member whose feed pubDate lies in the future can never push the cue past
// the moment Tayf last touched the cluster.

/** A follow-up must land more than this long after the first article to count. */
export const UPDATE_CUE_MIN_MS = 30 * 60_000;

/**
 * ISO timestamp of the latest member publication when it is strictly more
 * than `UPDATE_CUE_MIN_MS` after `firstPublished`, else `null` (no cue).
 * Returns `null` when `firstPublished` or every member time is unparseable.
 */
export function clusterUpdateCue(
  firstPublished: string,
  updatedAt: string,
  memberPublishedAts: readonly string[],
): string | null {
  const first = Date.parse(firstPublished);
  if (Number.isNaN(first)) return null;

  let latest = Number.NEGATIVE_INFINITY;
  for (const iso of memberPublishedAts) {
    const t = Date.parse(iso);
    if (!Number.isNaN(t) && t > latest) latest = t;
  }
  if (latest === Number.NEGATIVE_INFINITY) return null;

  const cap = Date.parse(updatedAt);
  if (!Number.isNaN(cap) && latest > cap) latest = cap;

  if (latest - first > UPDATE_CUE_MIN_MS) return new Date(latest).toISOString();
  return null;
}
