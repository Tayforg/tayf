// supabase/functions/ingest/order.ts
//
// Fair fetch/upsert ordering + a bisecting-fallback upsert for the ingest
// Edge Function (ingest-health). Every export here is pure — no Deno
// globals, no `esm.sh` imports — so this module is both Deno- and
// vitest-importable.
//
// Why this exists: a fixed `.order("slug")` fetch order plus a single
// batched-then-per-row upsert fallback starves tail-alphabet sources when a
// cycle hits its deadline (the earliest-slug sources' rows always land in
// the first upsert chunk) and turns one poisoned row into an O(n) per-row
// retry storm. `rotateForCycle` + `interleaveBySource` spread both the fetch
// order and the upsert order fairly across sources; `upsertWithBisect`
// isolates a bad row in O(log n) upsert calls instead of O(n).

/** One ingest cycle's nominal wall-clock period (matches the 3-minute cron). */
export const CYCLE_PERIOD_MS = 180_000;

/**
 * Rotates `items` by an offset derived from `startedAtMs`, so a fixed base
 * order (e.g. `.order("slug")`) doesn't always place the same items first —
 * over `periodMs`-spaced cycles the rotation walks all the way around the
 * array. `n` of 0 or 1 is returned as a (new) copy — there's nothing to
 * rotate.
 */
export function rotateForCycle<T>(
  items: readonly T[],
  startedAtMs: number,
  periodMs: number = CYCLE_PERIOD_MS,
): T[] {
  const n = items.length;
  if (n <= 1) return [...items];
  const offset = Math.floor(startedAtMs / periodMs) % n;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

interface SourceKeyed {
  source_id: string;
}

interface Dated {
  published_at: string;
}

/**
 * Groups `rows` by `source_id` (first-seen order of the source ids),
 * sorts each group by `published_at` descending (stable — `Array.sort` is
 * spec-stable since ES2019), then round-robins across the groups. The
 * result holds every source's newest item first, then every source's
 * second-newest item, and so on — so a deadline cut into the FRONT of this
 * array drops each source's OLDEST rows instead of dropping whole
 * late-in-the-array sources entirely.
 */
export function interleaveBySource<T extends SourceKeyed & Dated>(
  rows: readonly T[],
): T[] {
  const order: string[] = [];
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    let group = groups.get(row.source_id);
    if (!group) {
      group = [];
      groups.set(row.source_id, group);
      order.push(row.source_id);
    }
    group.push(row);
  }
  for (const id of order) {
    const group = groups.get(id);
    if (group) {
      group.sort(
        (a, b) => Date.parse(b.published_at) - Date.parse(a.published_at),
      );
    }
  }

  const out: T[] = [];
  const cursors = new Map<string, number>(order.map((id) => [id, 0]));
  let remaining = rows.length;
  while (remaining > 0) {
    for (const id of order) {
      const group = groups.get(id);
      if (!group) continue;
      const idx = cursors.get(id) ?? 0;
      if (idx >= group.length) continue;
      const item = group[idx];
      if (item !== undefined) {
        out.push(item);
        remaining--;
      }
      cursors.set(id, idx + 1);
    }
  }
  return out;
}

/**
 * Stable sort of `rows` by `source_id`. Applied to each upsert chunk BEFORE
 * the (source_id, content_hash) pre-filter: an interleaved chunk can carry
 * up to `chunk.length` distinct source ids in the worst case (one per row),
 * which blows up the pre-filter's `.in("source_id", ids)` query string
 * (migration 074's proxy-limit failure mode); grouped, each `PREFILTER_CHUNK`
 * slice of a grouped chunk spans far fewer distinct sources.
 */
export function groupChunkBySource<T extends SourceKeyed>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => {
    if (a.source_id < b.source_id) return -1;
    if (a.source_id > b.source_id) return 1;
    return 0;
  });
}

export interface BisectUpsertResult {
  inserted: number;
  rowErrors: number;
  skipped: number;
  calls: number;
  firstError: string | null;
}

export interface BisectUpsertOptions<T> {
  /** Returns true once the caller's cycle deadline has passed. */
  isPastDeadline: () => boolean;
  /** Called once per row that fails in isolation (a length-1 batch). */
  onRowError?: (row: T, error: string) => void;
  /**
   * Called once per batch popped after the deadline and therefore never
   * attempted (silent-feeds: lets the caller mark those rows' sources as not
   * fully settled). The summed lengths equal `result.skipped`.
   */
  onSkipped?: (batch: readonly T[]) => void;
}

/**
 * Upserts `rows` via `upsert`, bisecting any batch that errors instead of
 * falling back to a full per-row retry. On success a batch's `inserted`
 * count is added to the total. On error, a length-1 batch counts as a row
 * error (and calls `onRowError`); a longer batch is split at the midpoint
 * and BOTH halves are retried, left half first. `isPastDeadline()` is
 * checked before every call — any batch popped once the deadline has
 * passed is counted as `skipped` rather than attempted or retried.
 *
 * Bound: at most `1 + 2*ceil(log2(n))` upsert calls are needed to isolate
 * one bad row out of `n` (each bisection level calls upsert on BOTH
 * resulting halves) — 7 for n=8, at most 19 for n=500, versus up to `n+1`
 * calls for the old batched-then-per-row-fallback approach.
 */
export async function upsertWithBisect<T>(
  rows: readonly T[],
  upsert: (batch: T[]) => Promise<{ inserted: number; error: string | null }>,
  opts: BisectUpsertOptions<T>,
): Promise<BisectUpsertResult> {
  const result: BisectUpsertResult = {
    inserted: 0,
    rowErrors: 0,
    skipped: 0,
    calls: 0,
    firstError: null,
  };
  if (rows.length === 0) return result;

  const stack: T[][] = [[...rows]];
  while (stack.length > 0) {
    const batch = stack.pop();
    if (!batch || batch.length === 0) continue;

    if (opts.isPastDeadline()) {
      result.skipped += batch.length;
      opts.onSkipped?.(batch);
      continue;
    }

    result.calls++;
    const { inserted, error } = await upsert(batch);
    if (!error) {
      result.inserted += inserted;
      continue;
    }

    if (result.firstError === null) result.firstError = error;

    if (batch.length === 1) {
      result.rowErrors++;
      const row = batch[0];
      if (row !== undefined) opts.onRowError?.(row, error);
      continue;
    }

    const mid = Math.ceil(batch.length / 2);
    const left = batch.slice(0, mid);
    const right = batch.slice(mid);
    // Push right then left so `stack.pop()` processes the left half FIRST.
    stack.push(right, left);
  }

  return result;
}
