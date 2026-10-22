// supabase/functions/_shared/jev-pending.ts
//
// Pack "jev-pipeline" (migration 073 era). Pure pager for jev-shadow's
// articles stage -- no Deno APIs, no Supabase client, importable by vitest
// the same way _shared/jev.ts is.
//
// Root cause this replaces: the old fetchPendingArticles paged the 24h
// window OLDEST-first (published_at asc). At ~5,400 articles/day against a
// 300-row page and a 10-page cap, only the oldest ~3,000 rows were ever
// scanned in a run -- a fresh article was invisible to Jev until the
// backlog ahead of it drained, which measured as an 8.7h p50 / 15.3h p90
// prediction lag on topic7.
//
// The fix flips the priority: score what just landed FIRST (pass 1,
// newest-first, bounded to freshMaxPages), then spend whatever page budget
// remains draining the oldest unscored backlog (pass 2, oldest-first, only
// when pass 1 didn't already fill the limit and the window isn't already
// exhausted). Total fetchPage calls never exceed maxPages.
//
// db-1: `isPastDeadline` (optional) is consulted before EVERY fetchPage in both
// passes. Once it is true the pager stops and returns what it has collected
// so far (stoppedAtDeadline = true), so a cold-cache page fetch can no longer
// start after the run's deadline and drag the response past the caller's
// timeout. The caller still gets a usable partial list.
export type PendingOrder = "desc" | "asc";

export interface CollectPendingArticlesOpts<R extends { id: string }> {
  limit: number;
  pageSize: number;
  maxPages: number;
  freshMaxPages: number;
  fetchPage(order: PendingOrder, from: number, to: number): Promise<R[]>;
  seen(ids: string[]): Promise<Set<string>>;
  /** db-1: true once the run's deadline has passed; checked before every page. */
  isPastDeadline?: () => boolean;
}

export interface CollectPendingArticlesResult<R> {
  rows: R[];
  freshRows: number;
  backfillRows: number;
  pagesRead: number;
  /** db-1: true when isPastDeadline stopped the pager before it finished. */
  stoppedAtDeadline: boolean;
}

export async function collectPendingArticles<R extends { id: string }>(
  opts: CollectPendingArticlesOpts<R>,
): Promise<CollectPendingArticlesResult<R>> {
  const { limit, pageSize, maxPages, freshMaxPages, fetchPage, seen } = opts;
  const isPastDeadline = opts.isPastDeadline ?? (() => false);

  const out: R[] = [];
  const picked = new Set<string>();
  let pagesRead = 0;
  let freshRows = 0;
  let backfillRows = 0;
  let windowExhausted = false;
  let stoppedAtDeadline = false;

  // Pass 1 -- fresh: newest-first, capped at freshMaxPages (and never past
  // the overall maxPages budget).
  const freshCap = Math.min(freshMaxPages, maxPages);
  for (let page = 0; page < freshCap && out.length < limit; page++) {
    if (isPastDeadline()) {
      stoppedAtDeadline = true;
      break;
    }
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const rows = await fetchPage("desc", from, to);
    pagesRead++;
    if (rows.length === 0) {
      windowExhausted = true;
      break;
    }
    const ids = rows.map((r) => r.id).filter((id) => !picked.has(id));
    const seenIds = await seen(ids);
    for (const r of rows) {
      if (picked.has(r.id) || seenIds.has(r.id)) continue;
      out.push(r);
      picked.add(r.id);
      freshRows++;
      if (out.length >= limit) break;
    }
    if (rows.length < pageSize) {
      windowExhausted = true;
      break;
    }
  }

  // Pass 2 -- backlog: oldest-first, only when pass 1 didn't fill the
  // limit and the window isn't already known-exhausted, with whatever page
  // budget pass 1 left behind.
  if (out.length < limit && !windowExhausted && !stoppedAtDeadline) {
    const remainingPages = maxPages - pagesRead;
    for (let page = 0; page < remainingPages && out.length < limit; page++) {
      if (isPastDeadline()) {
        stoppedAtDeadline = true;
        break;
      }
      const from = page * pageSize;
      const to = from + pageSize - 1;
      const rows = await fetchPage("asc", from, to);
      pagesRead++;
      if (rows.length === 0) break;
      const ids = rows.map((r) => r.id).filter((id) => !picked.has(id));
      const seenIds = await seen(ids);
      for (const r of rows) {
        if (picked.has(r.id) || seenIds.has(r.id)) continue;
        out.push(r);
        picked.add(r.id);
        backfillRows++;
        if (out.length >= limit) break;
      }
      if (rows.length < pageSize) break;
    }
  }

  return { rows: out, freshRows, backfillRows, pagesRead, stoppedAtDeadline };
}
