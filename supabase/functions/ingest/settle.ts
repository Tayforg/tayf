// supabase/functions/ingest/settle.ts
//
// Pure helpers for "validators follow row durability" (silent-feeds). No Deno
// globals and no esm.sh imports, so vitest can import this module directly.
//
// A fetched feed's fresh validators (ETag / Last-Modified / body hash) may only
// be committed once every row of that feed is durable (upserted, or dropped
// because it is already stored). These helpers track which sources still have
// unhandled rows and split the deferred sources accordingly.

/** Adds the `source_id` of every row into `into`. */
export function collectSourceIds(
  rows: ReadonlyArray<{ source_id: string }>,
  into: Set<string>,
): void {
  for (const row of rows) into.add(row.source_id);
}

/**
 * Splits `deferredIds` into sources whose rows all settled and sources that
 * have at least one unsettled row (`withheld`). Preserves input order.
 */
export function partitionDeferred(
  deferredIds: Iterable<string>,
  unsettled: ReadonlySet<string>,
): { settled: string[]; withheld: string[] } {
  const settled: string[] = [];
  const withheld: string[] = [];
  for (const id of deferredIds) {
    (unsettled.has(id) ? withheld : settled).push(id);
  }
  return { settled, withheld };
}

/** Consecutive cycles a source may be withheld for row ERRORS alone. */
export const MAX_ROW_ERROR_WITHHOLDS = 3;

/**
 * Like `partitionDeferred`, but distinguishes transient loss from row errors.
 *
 * - `unsettled`: rows skipped / never attempted (deadline). Always withheld.
 * - `rowFailed`: rows that failed in isolation. Withheld for at most `max`
 *   consecutive cycles (tracked in `streaks`, mutated); after that the row is
 *   treated as poison and the validators are committed so the source regains
 *   304 / body-hash short-circuits. The streak stays capped while the source
 *   keeps failing and is cleared once a deferred cycle has no row error.
 * - `gaveUp`: sources committed only because the grace ran out (for logging).
 */
export function partitionWithRowErrorGrace(
  deferredIds: Iterable<string>,
  unsettled: ReadonlySet<string>,
  rowFailed: ReadonlySet<string>,
  streaks: Map<string, number>,
  max: number = MAX_ROW_ERROR_WITHHOLDS,
): { settled: string[]; withheld: string[]; gaveUp: string[]; streakOf: Map<string, number> } {
  const settled: string[] = [];
  const withheld: string[] = [];
  const gaveUp: string[] = [];
  const streakOf = new Map<string, number>();
  for (const id of deferredIds) {
    if (unsettled.has(id)) {
      withheld.push(id);
      if (rowFailed.has(id)) streakOf.set(id, streaks.get(id) ?? 0);
      continue;
    }
    if (!rowFailed.has(id)) {
      streaks.delete(id);
      settled.push(id);
      continue;
    }
    const streak = streaks.get(id) ?? 0;
    if (streak >= max) {
      gaveUp.push(id);
      settled.push(id);
      streakOf.set(id, streak);
    } else {
      streaks.set(id, streak + 1);
      withheld.push(id);
      streakOf.set(id, streak + 1);
    }
  }
  return { settled, withheld, gaveUp, streakOf };
}
