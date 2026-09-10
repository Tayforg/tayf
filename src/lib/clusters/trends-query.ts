import { cacheLife } from "next/cache";

import { createServerClient } from "@/lib/supabase/server";
import type { MediaDnaZone } from "@/types";

// Fetcher for /trends — extracted out of the page component so the unit
// tests can exercise it without rendering JSX (mirrors blindspots-query.ts
// / timeline-query.ts).
//
// Data path: server-side aggregation via the `trends_daily_bias_counts`
// view (see supabase/migrations/023_trends_daily_histogram.sql). PostgREST
// returns ≤ WINDOW_DAYS × 3 = 90 rows — one per (day, zone) — so egress is
// bounded regardless of how many articles the window contains.

export const WINDOW_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;

export type DayBucket = {
  /** Day key in YYYY-MM-DD form (UTC). */
  day: string;
  /** Per-zone article counts. */
  counts: Record<MediaDnaZone, number>;
  /** Sum of counts (cached so the renderer doesn't re-add). */
  total: number;
};

/** One row per (day, zone) from the `trends_daily_bias_counts` view. */
type AggregateRow = {
  day: string; // "YYYY-MM-DD" (date → ISO string via PostgREST)
  zone: MediaDnaZone;
  count: number;
};

/**
 * Build a contiguous 30-day timeline and merge in the pre-aggregated view
 * rows. Days with zero articles are still emitted (with all-zero counts)
 * so the chart x-axis is gap-free and a quiet day reads as a blank column
 * rather than a missing one.
 */
export function bucketFromAggregates(rows: AggregateRow[]): DayBucket[] {
  // Compute the inclusive [start, end] window in UTC. We anchor `end` to
  // the start of *today* UTC so the rightmost bar is always "today" and
  // the leftmost is "29 days ago".
  const now = new Date();
  const todayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );

  const buckets = new Map<string, DayBucket>();
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const ts = todayUtc - (WINDOW_DAYS - 1 - i) * DAY_MS;
    const key = new Date(ts).toISOString().slice(0, 10);
    buckets.set(key, {
      day: key,
      counts: { iktidar: 0, bagimsiz: 0, muhalefet: 0 },
      total: 0,
    });
  }

  for (const row of rows) {
    const bucket = buckets.get(row.day);
    if (!bucket) continue; // outside window — defensive against clock skew
    bucket.counts[row.zone] += row.count;
    bucket.total += row.count;
  }

  return Array.from(buckets.values());
}

export async function fetchTimeline(): Promise<DayBucket[]> {
  "use cache";
  cacheLife({ revalidate: 3600 });

  try {
    const supabase = createServerClient();

    // `day` in the view is a DATE, so we filter on a bare `YYYY-MM-DD`
    // cutoff rather than a full timestamp. This bounds the payload at
    // `WINDOW_DAYS * (# zones)` rows regardless of article volume.
    const cutoffDay = new Date(Date.now() - WINDOW_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);

    const { data, error } = await supabase
      .from("trends_daily_bias_counts")
      .select("day, zone, count")
      .gte("day", cutoffDay)
      .returns<AggregateRow[]>();

    if (error) {
      // Throw — this fetcher is wrapped in `"use cache"`; returning an
      // all-zero series on a transient failure would cache a fake "no
      // activity" month for the whole revalidate window. Same rule as
      // blindspots-query / search-query.
      throw new Error(`[trends] fetchTimeline error: ${error.message}`);
    }

    return bucketFromAggregates(data ?? []);
  } catch (err) {
    console.error("[trends] fetchTimeline failed", err);
    throw err;
  }
}
