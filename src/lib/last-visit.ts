export const LAST_VISIT_KEY = "tayf:last-visit";

/** Count ISO timestamps strictly newer than `stamp`; 0 when there is no usable stamp. */
export function countNewSince(timestamps: readonly string[], stamp: string | null): number {
  if (!stamp) return 0;
  const since = Date.parse(stamp);
  if (Number.isNaN(since)) return 0;
  let n = 0;
  for (const t of timestamps) {
    const ms = Date.parse(t);
    if (!Number.isNaN(ms) && ms > since) n += 1;
  }
  return n;
}

/**
 * Whether a home render may advance the last-visit stamp. The stamp means "the
 * reader saw the top of the feed", so only page 1 of the plain feed counts, and
 * only when the feed itself rendered: the FeedUnavailable shell shows no
 * stories, a /?q= search view shows a filtered slice, and ?page=N is deeper
 * than the top. Stamping on any of those makes the next session's pill skip
 * every story published since that render that the reader never saw. `q` is the
 * page's firstQuery() value (undefined when blank); an empty string is treated
 * the same way.
 */
export function shouldStampLastVisit({
  page,
  q,
  feedOk,
}: {
  page: number;
  q: string | undefined;
  feedOk: boolean;
}): boolean {
  return feedOk && page === 1 && !q;
}

export function readLastVisit(): string | null {
  try {
    return window.localStorage.getItem(LAST_VISIT_KEY);
  } catch {
    return null;
  }
}

export function writeLastVisit(iso: string): void {
  try {
    window.localStorage.setItem(LAST_VISIT_KEY, iso);
  } catch {
    // storage unavailable (private mode, quota) — pill simply won't show next time
  }
}
