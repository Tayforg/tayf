import { cacheLife, cacheTag } from "next/cache";

import { attemptCached } from "@/lib/cache-resilience";
import { createReaderClient } from "@/lib/supabase/server";
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
//
// Deferred follow-up (NOT done in this change): migration 092 adds
// `trends_daily_zone_counts_ist_rollup`, a pre-aggregated table meant to
// replace the live `trends_daily_zone_counts_ist` view this file still
// reads — the view's cold-cache group-by is the root cause of the
// 2026-09-28 /trends build-timeout incident this branch otherwise makes
// non-fatal (via `attemptCached` below), but does not make faster or less
// likely to time out on a cold cache. 092's own header requires a strict
// deploy order (apply migration → run the 32-day backfill → THEN ship the
// code repoint below) that this branch has not executed against
// production, so repointing this fetcher now would query a table that may
// not exist yet in every environment. Track the repoint
// (`.from("trends_daily_zone_counts_ist_rollup")` instead of the view,
// same `AggregateRow` shape) as an explicit follow-up PR once 092 is
// applied and backfilled in production.

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
// result, and an uncached exported wrapper that unwraps the result.
//
// Build-safety (2026-09-28 incident: `next build` failed with "Error
// occurred prerendering page /trends" after a Supabase statement timeout
// thrown here): a throw crossing the `"use cache"` boundary fails the
// build's prerender even when every caller wraps the call in a try/catch.
// See src/lib/cache-resilience.ts's file header and src/lib/clusters/
// feed-health.ts's file header for the confirmed root cause.
// `attemptCached` below swallows the throw INSIDE the cache boundary so it
// can never escape into the prerender.
//
// The `{ ok: false }` sentinel IS memoised: a `"use cache"` function's
// return value is what gets cached, and a failure result is a return value
// like any other. What keeps a transient failure from pinning /trends on
// "unavailable" is the cache LIFETIME, chosen after the outcome is known
// (Next's "Conditional cache lifetimes" shape, exactly one `cacheLife` call
// per invocation): a success keeps the hourly `revalidate: 3600` window, a
// failure gets the built-in `minutes` profile (revalidate 60 s, expire
// 1 h) so it is short-lived but still prerender-safe. `next build` prefills
// this entry, so without the short failure lifetime a build-time blip would
// ship an hour-long "unavailable".
//
// There is still no live retry (unlike politics-query.ts, blindspots-
// query.ts, etc.): the raw fetch reads `Date.now()`, and /trends is a
// static route, where Next 16 prerender (cacheComponents) rejects a clock
// read in the uncached render path. A bypass-retry would put that clock
// read outside any cache scope. A failed attempt therefore falls straight
// back to `null`, and the next revalidation (~60 s) tries again.
//
// The clock is read once INSIDE the cache scope and quantized to the hour
// (`hourBucketStart`), so the Istanbul "today" boundary moves with the
// hourly revalidate window. It cannot be read in the uncached wrapper.
async function fetchIstanbulTimelineRaw(): Promise<DayBucket[]> {
  // Read the clock INSIDE the cache scope (same pattern as the pre-087
  // trends-query.ts): Next 16 prerender forbids Date.now() in the uncached
  // render path, and the cached entry is refreshed hourly anyway.
  const nowMs = hourBucketStart(Date.now());

  const supabase = createReaderClient();

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
    // (local dev before 087 is applied) or a genuine outage — never present
    // either as a real "no news this month" answer; the caller turns it
    // into the `{ ok: false }` sentinel, cached only for the short
    // `minutes` lifetime.
    throw new Error("[trends] fetchIstanbulTimeline error: empty result");
  }

  return bucketIstanbulDays(data, nowMs);
}

async function fetchIstanbulTimelineCached() {
  "use cache";
  cacheTag("trends");
  const r = await attemptCached("trends", fetchIstanbulTimelineRaw);
  if (!r.ok) {
    cacheLife("minutes");
    return r;
  }
  cacheLife({ revalidate: 3600 });
  return r;
}

export async function fetchIstanbulTimeline(): Promise<DayBucket[] | null> {
  const result = await fetchIstanbulTimelineCached();
  return result.ok ? result.data : null;
}
