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
//
// Cluster priority (pass 0). Only politics-gate articles (articles.category in
// 'politika' / 'son_dakika') are ever clustered, but the passes above walk
// EVERY category. At the daily cap (~9,000 scored articles/day against ~9,400
// published, of which only ~2,100 are politics) the capped budget therefore
// went mostly to articles that never reach a cluster, and late-day cluster
// members went unscored -- clusters.topic7 stayed null on about half of the
// multi-article clusters. Pass 0 runs BEFORE pass 1 when the caller supplies
// `fetchPriorityPage` (the same pending query filtered to the politics gate,
// newest-first): it collects unscored politics articles first, then pass 1 / 2
// fill whatever is left of `limit`, de-duplicated through the shared `picked`
// set so no id is fetched, anti-joined or returned twice.
//
//   * Same limit, same packing: pass 0 only REORDERS the list; it never
//     enlarges it. `priorityShare` (default 1) caps how much of `limit` it may
//     take. Politics is ~22% of volume (~15 unscored rows per 10-min tick), so
//     the default leaves the other ~78% of the budget to passes 1 / 2. If one
//     tick ever sees a politics backlog larger than `limit`, the remainder is
//     not lost -- it is still unscored on the next tick and is taken then,
//     while the rest of the stream waits (the intended starvation direction).
//   * Same page budget: pass 0's pages count against `maxPages`, so the total
//     number of page round trips per run is unchanged. `priorityMaxPages`
//     bounds pass 0 itself; pass 1 gets min(freshMaxPages, maxPages - pages
//     already read) and pass 2 the remainder.
//   * Failure-tolerant: an error thrown by fetchPriorityPage (or by seen()
//     while pass 0 is running) ends pass 0, keeps the rows it already
//     collected, reports `priorityFailed`, and lets passes 1 / 2 run exactly as
//     they did before pass 0 existed. A persistent seen() failure still
//     propagates from pass 1, as it always did.
//   * Absent `fetchPriorityPage` -> byte-identical to the two-pass pager: no
//     extra calls, and the result carries no priority fields.
//
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
  /**
   * Cluster priority: the same pending query as fetchPage("desc") restricted to
   * the politics gate (category in 'politika' / 'son_dakika'), newest-first.
   * Omit it and the pager behaves exactly as the two-pass version.
   */
  fetchPriorityPage?(from: number, to: number): Promise<R[]>;
  /** Cap on pass 0 pages (default JEV_PRIORITY_MAX_PAGES_DEFAULT); still bounded by maxPages. */
  priorityMaxPages?: number;
  /**
   * Largest share of `limit` pass 0 may take, clamped to [0, 1], default 1.
   * 0 disables pass 0 (no priority fetch at all).
   */
  priorityShare?: number;
  /** Called once if pass 0 fails and the pager falls back; must not be relied on to throw. */
  onPriorityError?: (err: unknown) => void;
}

/** Default cap on pass 0 pages: 4 x pageSize newest politics rows (~1,200 rows,
 * roughly 13 h of politics-gate articles at the production page size). */
export const JEV_PRIORITY_MAX_PAGES_DEFAULT = 4;

/**
 * Parses the JEV_PRIORITY_SHARE env value. Absent / blank / non-numeric ->
 * 1 (the default: pass 0 may fill the whole limit). A finite number is clamped
 * to [0, 1]; 0 is honoured as a kill switch that restores the legacy order.
 */
export function parsePriorityShare(raw: string | null | undefined): number {
  if (raw === undefined || raw === null || raw.trim() === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

function priorityRowCap(limit: number, share: number | undefined): number {
  const s = share === undefined || !Number.isFinite(share) ? 1 : Math.min(1, Math.max(0, share));
  return Math.floor(limit * s);
}

function priorityPageCap(requested: number | undefined, maxPages: number): number {
  const wanted =
    requested === undefined || !Number.isFinite(requested)
      ? JEV_PRIORITY_MAX_PAGES_DEFAULT
      : Math.max(0, Math.floor(requested));
  return Math.min(wanted, Math.max(0, maxPages));
}

export interface CollectPendingArticlesResult<R> {
  rows: R[];
  freshRows: number;
  backfillRows: number;
  pagesRead: number;
  /** db-1: true when isPastDeadline stopped the pager before it finished. */
  stoppedAtDeadline: boolean;
  /** Rows taken by the priority pass. Present only when fetchPriorityPage was supplied. */
  priorityRows?: number;
  /** True when the priority pass threw and the pager fell back. Present only with fetchPriorityPage. */
  priorityFailed?: boolean;
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
  let priorityRows = 0;
  let priorityFailed = false;

  // Pass 0 -- cluster priority: the politics-gate subset, newest-first, only
  // when the caller wired fetchPriorityPage. A short or empty page here ends
  // pass 0 alone; it says nothing about the whole window, so windowExhausted
  // is deliberately left untouched for passes 1 / 2.
  const fetchPriorityPage = opts.fetchPriorityPage;
  if (fetchPriorityPage) {
    const rowCap = priorityRowCap(limit, opts.priorityShare);
    const pageCap = priorityPageCap(opts.priorityMaxPages, maxPages);
    try {
      for (let page = 0; page < pageCap && priorityRows < rowCap && out.length < limit; page++) {
        if (isPastDeadline()) {
          stoppedAtDeadline = true;
          break;
        }
        const from = page * pageSize;
        const to = from + pageSize - 1;
        // Counted when attempted, not when answered: a failed round trip still
        // spent one of the maxPages.
        pagesRead++;
        const rows = await fetchPriorityPage(from, to);
        if (rows.length === 0) break;
        const ids = rows.map((r) => r.id).filter((id) => !picked.has(id));
        const seenIds = await seen(ids);
        for (const r of rows) {
          if (picked.has(r.id) || seenIds.has(r.id)) continue;
          out.push(r);
          picked.add(r.id);
          priorityRows++;
          if (priorityRows >= rowCap || out.length >= limit) break;
        }
        if (rows.length < pageSize) break;
      }
    } catch (err) {
      // Rows already collected stay; the legacy passes below carry on as if
      // pass 0 did not exist.
      priorityFailed = true;
      try {
        opts.onPriorityError?.(err);
      } catch {
        // A logging hook must never destabilise the pager.
      }
    }
  }

  // Pass 1 -- fresh: newest-first, capped at freshMaxPages (and never past
  // the overall maxPages budget, which pass 0 already drew on).
  const freshCap = Math.min(freshMaxPages, maxPages - pagesRead);
  for (let page = 0; page < freshCap && out.length < limit && !stoppedAtDeadline; page++) {
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

  return {
    rows: out,
    freshRows,
    backfillRows,
    pagesRead,
    stoppedAtDeadline,
    ...(fetchPriorityPage ? { priorityRows, priorityFailed } : {}),
  };
}
