import { cacheLife, cacheTag } from "next/cache";

import { createServerClient } from "@/lib/supabase/server";
import type { MediaDnaZone } from "@/types";

// Fetcher for /trends, Istanbul-day edition — reads the new
// `trends_daily_zone_counts_ist` view (migration 087) instead of the old
// UTC-day, all-kinds `trends_daily_bias_counts` view (migration 023, still
// owned by src/lib/clusters/trends-query.ts, untouched by this file).
//
// Two differences from the old view/module:
//   * day bucketing is the Europe/Istanbul calendar day of
//     least(published_at, created_at) — a reader in Türkiye sees "today"
//     flip at local midnight, not at 03:00 local (UTC midnight + 3h).
//   * voting kinds only (outlet, wire) — aggregator/niche sources never
//     counted toward bias_distribution or blindspot detection, and now
//     never counted here either (src/lib/sources/kind.ts's contract).

export const WINDOW_DAYS = 30;
export const TRENDS_TIME_ZONE = "Europe/Istanbul";

export type DayBucket = {
  /** Day key in YYYY-MM-DD form (Europe/Istanbul calendar day). */
  day: string;
  /** Per-zone article counts. */
  counts: Record<MediaDnaZone, number>;
  /** Sum of counts (cached so the renderer doesn't re-add). */
  total: number;
};

/** One row per (day, zone) from the `trends_daily_zone_counts_ist` view. */
type AggregateRow = {
  day: string; // "YYYY-MM-DD" (date → ISO string via PostgREST)
  zone: MediaDnaZone;
  count: number;
};

const DAY_MS = 24 * 3600 * 1000;

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TRENDS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The `YYYY-MM-DD` Europe/Istanbul calendar-day key for a given instant.
 * `en-CA` formats as `YYYY-MM-DD` directly — no manual field reassembly.
 */
export function istanbulDayKey(ms: number): string {
  return dayFormatter.format(new Date(ms));
}

const HOUR_MS = 3600 * 1000;

/**
 * Floor an instant to the start of its UTC hour. Used to quantize the
 * "now" instant passed into the cached fetcher below so that (a) the
 * cached function itself never reads the wall clock (Next 16
 * cacheComponents rule: no `Date.now()`/`new Date()` inside a `"use
 * cache"` function body — a raw clock read gets baked into the cache
 * entry for the whole `revalidate` window), and (b) the cache key still
 * only changes once per hour — matching `cacheLife({ revalidate: 3600
 * })` — instead of on every call, which would defeat caching entirely.
 */
export function hourBucketStart(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/**
 * Build a contiguous `WINDOW_DAYS`-day timeline (Istanbul calendar days,
 * newest last) and merge in the pre-aggregated view rows. Days with zero
 * articles are still emitted (with all-zero counts) so the chart x-axis is
 * gap-free.
 *
 * Steps back from "today" (the Istanbul day key of `nowMs`) using
 * `Date.UTC(y, m-1, d-i)` on the key's own numeric fields — not by
 * subtracting `i * DAY_MS` from a timezone-aware instant — so the emitted
 * keys stay exactly one calendar day apart even if Türkiye ever
 * reintroduces DST (it has observed none since 2016). The Y/M/D triple is
 * timezone-agnostic once extracted; stepping it in UTC and re-formatting
 * with `en-CA`(UTC) keeps every key contiguous by construction.
 */
export function bucketIstanbulDays(
  rows: AggregateRow[],
  nowMs: number,
): DayBucket[] {
  const todayKey = istanbulDayKey(nowMs);
  const [y, m, d] = todayKey.split("-").map(Number) as [number, number, number];

  const buckets = new Map<string, DayBucket>();
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const ts = Date.UTC(y, m - 1, d - i);
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

// Split into a cached inner fetcher that THROWS on failure OR on an empty
// result, and an uncached exported wrapper that catches. A `"use cache"`
// function's *return value* is what gets cached — including an empty
// array — so returning `[]` from inside the cached function would itself
// be cached as the answer for the whole `revalidate: 3600` window. Since
// `next.config.ts` has `cacheComponents: true`, `next build` prefills this
// entry, so a transient failure OR a genuinely-empty prod dataset at build
// time would ship a deployed /trends pinned on "unavailable"/"empty" for
// up to an hour with no `cacheTag` recourse until the next real request.
// Throwing here aborts this function's own cache write without aborting
// the `next build` prerender — the wrapper's try/catch swallows the throw.
//
// The clock is read once INSIDE the cache scope and quantized to the hour
// (`hourBucketStart`), so the Istanbul "today" boundary moves with the
// hourly revalidate window. It cannot be read in the uncached wrapper:
// Next 16 prerender (cacheComponents) rejects Date.now() in the uncached
// render path of a static route.
async function fetchIstanbulTimelineCached(): Promise<DayBucket[]> {
  "use cache";
  cacheLife({ revalidate: 3600 });
  // Read the clock INSIDE the cache scope (same pattern as the pre-087
  // trends-query.ts): Next 16 prerender forbids Date.now() in the uncached
  // render path, and the cached entry is refreshed hourly anyway.
  const nowMs = hourBucketStart(Date.now());
  cacheTag("trends");

  const supabase = createServerClient();

  const cutoffKey = istanbulDayKey(nowMs - WINDOW_DAYS * DAY_MS);

  const { data, error } = await supabase
    .from("trends_daily_zone_counts_ist")
    .select("day, zone, count")
    .gte("day", cutoffKey)
    .returns<AggregateRow[]>();

  if (error) {
    throw new Error(`[trends] fetchIstanbulTimeline error: ${error.message}`);
  }

  if (!data || data.length === 0) {
    // Empty is indistinguishable here from "the view doesn't exist yet"
    // (local dev before 087 is applied) or a genuine outage — never cache
    // either as if it were a real "no news this month" answer.
    throw new Error("[trends] fetchIstanbulTimeline error: empty result");
  }

  return bucketIstanbulDays(data, nowMs);
}

export async function fetchIstanbulTimeline(): Promise<DayBucket[] | null> {
  try {
    return await fetchIstanbulTimelineCached();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[trends] fetchIstanbulTimeline error: ${message}`);
    return null;
  }
}
