// PostgREST truncates EVERY response at its `max_rows` (1,000 on Supabase)
// whatever `.limit(N)` asks for, so a read that can exceed 1,000 rows has to
// page with `.range()`. This is the one shared loop for that: pure (no
// next/cache, no client), so it can be used from inside a `readX` function that
// a `"use cache"` body wraps in `attemptCached`.
//
// tests/guards/postgrest-row-cap.test.ts fails on a `.limit(N)` above 1,000 in
// the read layers it scans (finance, weekly, trends, cron routes), which is what
// keeps new reads from drifting back to the silent clamp.

export const POSTGREST_MAX_ROWS = 1000;

interface PageEnvelope<T> {
  data: T[] | null;
  error: { message: string } | null;
}

export interface ReadAllPagesOptions {
  /** Names the read in the error and the truncation warning, e.g. `fetchTickerPage coverage TURSG`. */
  label: string;
  /** Hard bound on the number of requests; reaching it with a full last page truncates. */
  maxPages: number;
  /** Rows per request; defaults to (and must not exceed) PostgREST's 1,000. */
  pageSize?: number;
}

/**
 * Read every page of an ordered query. `fetchPage(from, to)` must issue the
 * query with `.range(from, to)` (both inclusive) and a DETERMINISTIC order that
 * is unique per row (add a tiebreaker column), otherwise rows can be skipped or
 * repeated across pages.
 *
 * A page shorter than `pageSize` ends the loop, so a table of exactly N pages
 * costs one extra (empty) request. Reaching `maxPages` with a full last page
 * means the result may be cut off: it returns what was read with
 * `truncated: true` and warns once. THROWS `[paging] <label>: <message>` on a
 * Supabase error, discarding earlier pages (a partial result would be a wrong
 * number presented as a right one).
 */
export async function readAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<PageEnvelope<T>>,
  opts: ReadAllPagesOptions,
): Promise<{ rows: T[]; truncated: boolean }> {
  const { label, maxPages } = opts;
  const pageSize = opts.pageSize ?? POSTGREST_MAX_ROWS;
  // A page size above max_rows would come back short, and a short page reads as "the end".
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > POSTGREST_MAX_ROWS) {
    throw new RangeError(`[paging] ${label}: pageSize must be an integer in 1..${POSTGREST_MAX_ROWS}, got ${pageSize}`);
  }
  const rows: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw new Error(`[paging] ${label}: ${error.message}`);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < pageSize) return { rows, truncated: false };
  }
  console.warn(`[paging] ${label}: page cap ${maxPages}x${pageSize} reached, result truncated`);
  return { rows, truncated: true };
}
