import { cacheLife, cacheTag } from "next/cache";

import { attemptCached } from "@/lib/cache-resilience";
import { createReaderClient } from "@/lib/supabase/server";
import { hourBucketStart, istanbulDayKey } from "@/lib/trends/daily-zones";
import {
  computeRising,
  shiftDayKey,
  type RisingResult,
  type RollupRow,
} from "@/lib/trends/rising";

// Fetcher for "Yükselen Konular" on /trends. Reads the per-entity daily rollup
// `trends_daily_entity_counts_ist_rollup` (migration 112), filled hourly by the
// existing 'trends-rollup-refresh' cron; nothing here touches `articles`.
//
// The window is today minus 8 days: today, plus yesterday's own baseline
// (D-2..D-8) in case today has nothing rising and `computeRising` falls back
// to yesterday. The rollup holds one row per vocabulary entity per day (about
// 62), so that is roughly 560 rows, well under PostgREST's max_rows (1,000).
//
// Same shape as daily-zones.ts (see its header for the full reasoning):
//   * the raw fetch THROWS on an error or an empty result, and
//     `attemptCached` turns the throw into an `{ ok: false }` value INSIDE the
//     "use cache" body, because a throw crossing the cache boundary fails the
//     `next build` prerender of /trends;
//   * the clock is read once, INSIDE the cache scope, quantized to the hour,
//     since Next 16 prerender forbids Date.now() in the uncached render path;
//   * the cache lifetime is chosen after the outcome is known, with exactly
//     one cacheLife call per invocation and a literal profile name each
//     (tests/guards/cache-life-literal.test.ts): "hours" for a result,
//     "minutes" for a failure so a cold-read blip heals in about a minute;
//   * no live retry: /trends is a static route, and a retry would put a clock
//     read outside any cache scope. A failed attempt falls back to `null`.
//
// `createReaderClient()` is the 4 s fail-fast client (tests/guards/
// public-reader-cap.test.ts pins it for this file).

/** Days of history pulled: today (D) back to D-8. */
const FETCH_DAYS_BACK = 8;
/** Generous cap; measured 558 rows on 2026-11-01, under PostgREST's 1,000 (tests/guards/postgrest-row-cap.test.ts). */
const ROW_LIMIT = 2000;

async function fetchRisingRaw(): Promise<RisingResult> {
  const nowMs = hourBucketStart(Date.now());
  const todayKey = istanbulDayKey(nowMs);

  const supabase = createReaderClient();
  const { data, error } = await supabase
    .from("trends_daily_entity_counts_ist_rollup")
    .select("day, entity, count")
    .gte("day", shiftDayKey(todayKey, -FETCH_DAYS_BACK))
    // postgrest-cap-ok: ~558 rows (8 days of rollup, measured 2026-11-01)
    .limit(ROW_LIMIT)
    .returns<RollupRow[]>();

  if (error) {
    throw new Error(`[trends] getRisingEntities error: ${error.message}`);
  }
  if (!data || data.length === 0) {
    // Empty means "migration 112 not applied / not backfilled yet" or an
    // outage; never present it as a real "nothing is rising" answer.
    throw new Error("[trends] getRisingEntities error: empty result");
  }

  return computeRising(data, todayKey);
}

async function getRisingEntitiesCached() {
  "use cache";
  cacheTag("trends");
  const r = await attemptCached("rising", fetchRisingRaw);
  if (r.ok) cacheLife("hours");
  else cacheLife("minutes");
  return r;
}

/**
 * Entities rising today (or yesterday), or `null` when the rollup could not
 * be read. Never throws.
 */
export async function getRisingEntities(): Promise<RisingResult | null> {
  const r = await getRisingEntitiesCached();
  return r.ok ? r.data : null;
}
