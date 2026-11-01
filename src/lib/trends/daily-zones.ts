import { cacheLife, cacheTag } from "next/cache";

import { attemptCached } from "@/lib/cache-resilience";
import { createReaderClient } from "@/lib/supabase/server";
import type { MediaDnaZone } from "@/types";

// Fetcher for /trends, Istanbul-day edition — reads the voting-kinds-only
// Istanbul-day counts (view of migration 087, served from its rollup table,
// see "Source table" below) instead of the old UTC-day, all-kinds
// `trends_daily_bias_counts` view (migration 023, still owned by
// src/lib/clusters/trends-query.ts, untouched by this file).
//
// Two differences from the old view/module:
//   * day bucketing is the Europe/Istanbul calendar day of
//     least(published_at, created_at) — a reader in Türkiye sees "today"
//     flip at local midnight, not at 03:00 local (UTC midnight + 3h).
//   * voting kinds only (outlet, wire) — aggregator/niche sources never
//     counted toward bias_distribution or blindspot detection, and now
//     never counted here either (src/lib/sources/kind.ts's contract).
//
// Source table: this file reads `trends_daily_zone_counts_ist_rollup`
// (migration 092), a pre-aggregated table with the same columns as the 087
// view (day, zone, count). The live view's cold-cache group-by was the root
// cause of the 2026-09-28 /trends build-timeout incident and of the 4 s
// reader timeouts hunt 16 found, so it is no longer queried from here.
//
// Freshness: pg_cron job `trends-rollup-refresh` (since 109) recomputes the
// rollup for the last 2 Istanbul days at :25 every hour. The current Istanbul
// day's bar is therefore partial and can lag by up to about 1 h behind the
// articles, plus up to 1 h of this fetcher's hourly cache. That is the same
// order as the existing hourly revalidate, and the previous days are
// complete. The live view stays the source of truth for the refresh function
// only.

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

/** One row per (day, zone) from the `trends_daily_zone_counts_ist_rollup` table. */
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
    .from("trends_daily_zone_counts_ist_rollup")
    .select("day, zone, count")
    .gte("day", cutoffKey)
    .returns<AggregateRow[]>();

  if (error) {
    throw new Error(`[trends] fetchIstanbulTimeline error: ${error.message}`);
  }

  if (!data || data.length === 0) {
    // Empty is indistinguishable here from "the rollup table doesn't exist
    // yet or was never backfilled" (local dev before 092 is applied) or a
    // genuine outage — never present either as a real "no news this month"
    // answer; the caller turns it into the `{ ok: false }` sentinel, cached
    // only for the short `minutes` lifetime.
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
