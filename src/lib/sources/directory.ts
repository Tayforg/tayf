// Pure helpers for /sources' non-blocking weekly-count enrichment
// (perf/reader-queries G). Extracted so the arithmetic and the sort order
// are unit-testable without Supabase or JSX.

/**
 * `getSourceItemsPerDay()` (feed-status.ts) already rounds the 7-day
 * items/day figure to one decimal place before returning it. Multiplying
 * that rounded value by 7 and rounding again is exact for every integer
 * weekly count: the rounding step introduces at most 0.05 of error in the
 * per-day figure, so the reconstructed weekly figure is off by at most
 * 0.05 * 7 = 0.35 — always comfortably below the 0.5 needed to round to
 * the wrong integer.
 */
export function weeklyCountFromPerDay(perDay: number): number {
  return Math.round(perDay * 7);
}

/**
 * Returns a NEW grouped object (never mutates `grouped` or its arrays) with
 * each group's sources re-ordered by weekly activity. `counts` maps a
 * source's `slug` to its weekly count; entries missing from `counts` sort
 * as 0. With `counts === null` (the weekly aggregate hasn't resolved yet,
 * or is unavailable), every group falls back to Turkish-locale name order
 * instead of fabricating an activity ranking from no data.
 */
export function sortGroupedByActivity<
  K extends string,
  T extends { slug: string; name: string },
>(
  grouped: Record<K, T[]>,
  counts: Record<string, number> | null,
): Record<K, T[]> {
  const result = {} as Record<K, T[]>;
  for (const key of Object.keys(grouped) as K[]) {
    const list = [...grouped[key]];
    if (counts === null) {
      list.sort((a, b) => a.name.localeCompare(b.name, "tr"));
    } else {
      list.sort((a, b) => {
        const ca = counts[a.slug] ?? 0;
        const cb = counts[b.slug] ?? 0;
        if (cb !== ca) return cb - ca;
        return a.name.localeCompare(b.name, "tr");
      });
    }
    result[key] = list;
  }
  return result;
}
