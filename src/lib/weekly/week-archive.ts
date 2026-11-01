import { cacheLife, cacheTag } from "next/cache";

import { getZoneFeedHealth } from "@/lib/clusters/feed-health";
import { createReaderClient } from "@/lib/supabase/server";
import {
  DAY_MS,
  ISTANBUL_OFFSET_MS,
  WEEK_ARCHIVE_FIRST,
  parseWeekKey,
  weekKeyFromMs,
} from "@/lib/weekly/week-key";
import {
  WEEKLY_CLUSTER_LIMIT,
  WEEKLY_MIN_ARTICLES,
  type WeeklyClusterRow,
} from "@/lib/weekly/weekly-query";

// /hafta/[hafta] — ISO-week permalinks for the trailing-7-day "Medya Hava
// Durumu" (P-07). /hafta itself stays a rolling trailing-7-day page with
// canonical /hafta; this module is the ARCHIVE: one fixed [Monday 00:00,
// next Monday 00:00) window per ISO-8601 week, Istanbul time (fixed +03,
// no DST — Türkiye has run permanent +03 since 2016).
//
// /hafta shipped 2026-09-19, so the earliest week with any meaningful data
// is 2026-W38 — anything before that predates the page and would render an
// empty archive that looks like a bug rather than "before launch".

// The pure key helpers (parse/format/range check) live in week-key.ts, which has
// no imports so the Edge middleware can use it; re-exported here so every
// existing importer of this module keeps working unchanged.
export {
  WEEK_ARCHIVE_FIRST,
  isServableWeekKey,
  isoWeekKeyOf,
  parseWeekKey,
  weekKeyFromMs,
} from "@/lib/weekly/week-key";

/** How many completed weeks the "Geçmiş haftalar" nav lists. */
export const WEEK_ARCHIVE_MAX_WEEKS = 12;

const WEEK_MS = 7 * DAY_MS;

/** [Monday 00:00 +03, next Monday 00:00 +03) for an ISO week key, as UTC
 * ISO strings. Returns null for an unparseable key. */
export function weekRange(
  key: string,
): { startIso: string; endIso: string } | null {
  const parsed = parseWeekKey(key);
  if (!parsed) return null;
  const { isoYear, week } = parsed;

  // Jan 4 is always in ISO week 1; Monday of week 1 is Jan4 minus
  // (isoWeekday - 1) days. Every subsequent week's Monday is +7 days.
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
  const mondayUtcMidnight = new Date(week1Monday);
  mondayUtcMidnight.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);

  // "Monday 00:00 +03" in UTC is the UTC-midnight instant minus 3 hours.
  const startMs = mondayUtcMidnight.getTime() - ISTANBUL_OFFSET_MS;
  const endMs = startMs + WEEK_MS;
  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
  };
}

/** Adds `n` ISO weeks to `key` (n may be negative). Returns null if `key`
 * itself doesn't parse. */
export function shiftWeek(key: string, n: number): string | null {
  const range = weekRange(key);
  if (!range) return null;
  const shiftedStartMs = new Date(range.startIso).getTime() + n * WEEK_MS;
  return weekKeyFromMs(shiftedStartMs + 1); // +1ms: land inside the target week, not exactly on its boundary
}

const MONTHS_TR = [
  "Ocak",
  "Şubat",
  "Mart",
  "Nisan",
  "Mayıs",
  "Haziran",
  "Temmuz",
  "Ağustos",
  "Eylül",
  "Ekim",
  "Kasım",
  "Aralık",
];

/** '2026, 39. hafta · 21–27 Eylül'. The displayed day range is the Monday
 * through Sunday of that week, in Istanbul local dates. Returns '' for an
 * unparseable key. */
export function weekLabelTr(key: string): string {
  const parsed = parseWeekKey(key);
  const range = weekRange(key);
  if (!parsed || !range) return "";

  const start = new Date(new Date(range.startIso).getTime() + ISTANBUL_OFFSET_MS);
  // endIso is the START of next week (exclusive); the last day IN this
  // week is 1ms before that, i.e. Sunday.
  const end = new Date(
    new Date(range.endIso).getTime() + ISTANBUL_OFFSET_MS - 1,
  );

  const startDay = start.getUTCDate();
  const endDay = end.getUTCDate();
  const startMonth = MONTHS_TR[start.getUTCMonth()];
  const endMonth = MONTHS_TR[end.getUTCMonth()];

  const dayRange =
    startMonth === endMonth
      ? `${startDay}–${endDay} ${endMonth}`
      : `${startDay} ${startMonth} – ${endDay} ${endMonth}`;

  return `${parsed.isoYear}, ${parsed.week}. hafta · ${dayRange}`;
}

// ---------------------------------------------------------------------------
// Data layer — cached, never throwing (weekly-query.ts's pattern).
// ---------------------------------------------------------------------------

/** Duplicated from weekly-query.ts's (unexported) CLUSTER_SELECT — parity
 * is pinned by week-archive.test.ts reading that file's source. Kept as a
 * literal, not an import, because the constant there is intentionally
 * module-private. */
export const WEEK_ARCHIVE_CLUSTER_SELECT =
  "id, title_tr, title_tr_neutral, bias_distribution, is_blindspot, blindspot_side, blindspot_recall_veto, article_count, first_published";

/** Raw read of one archived week. `null` = could not be read (Supabase error,
 * a 4 s reader-cap abort, or a throw); `[]` = read fine, nothing in the week.
 * Never throws. Called only from `getWeekArchiveClustersCached`, i.e. from
 * inside the cache scope, which is why the clock read below is allowed. */
async function fetchWeekArchiveClusters(range: {
  startIso: string;
  endIso: string;
}): Promise<WeeklyClusterRow[] | null> {
  try {
    const supabase = createReaderClient();
    // Single clock read, same rationale as weekly-query.ts: the upper
    // bound must not let a source-controlled future first_published leak
    // a cluster into a past week.
    const nowIso = new Date(Date.now()).toISOString();

    const { data, error } = await supabase
      .from("clusters")
      .select(WEEK_ARCHIVE_CLUSTER_SELECT)
      .eq("is_archived", false)
      .gte("article_count", WEEKLY_MIN_ARTICLES)
      .gte("first_published", range.startIso)
      .lt("first_published", range.endIso)
      .lte("first_published", nowIso)
      .order("article_count", { ascending: false })
      .limit(WEEKLY_CLUSTER_LIMIT)
      .returns<WeeklyClusterRow[]>();

    if (error) {
      console.error(`[week-archive] clusters unavailable: ${error.message}`);
      return null;
    }

    return data ?? [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[week-archive] clusters unavailable: ${message}`);
    return null;
  }
}

// Cache lifetime follows the outcome (exactly one `cacheLife` call per
// invocation, after the read; `cacheTag` first): a read -- including an empty
// week -- keeps `hours`, a failed read is memoised for `minutes` only. An
// unparseable key never gets here: the exported function answers it before the
// cache, so it makes no cache entry and touches neither Supabase nor
// `cacheLife`. (`fetchWeekArchiveClusters` never throws, so no `attemptCached`
// is needed: its `null` IS the failure signal.)
async function getWeekArchiveClustersCached(
  key: string,
): Promise<WeeklyClusterRow[] | null> {
  "use cache";
  cacheTag("clusters-politics");

  const range = weekRange(key);
  const data = range ? await fetchWeekArchiveClusters(range) : null;
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (data === null) cacheLife("minutes");
  else cacheLife("hours");
  return data;
}

/** One archived week's cluster rows. `null` = could not be read (or the key
 * is not a valid ISO week); `[]` = read fine, the week produced nothing (or
 * every candidate is archived). Never throws. */
export async function getWeekArchiveClusters(
  key: string,
): Promise<WeeklyClusterRow[] | null> {
  // Pure: no Supabase, no clock, no cache entry for a key that can never match.
  if (weekRange(key) === null) return null;
  return getWeekArchiveClustersCached(key);
}

export interface RecentWeekKeys {
  current: string;
  previous: string[];
}

/** How many completed weeks the "Geçmiş haftalar" nav on /hafta lists. */
const RECENT_WEEK_NAV_COUNT = 4;

/** The current week key and the last RECENT_WEEK_NAV_COUNT completed week
 * keys at or after WEEK_ARCHIVE_FIRST, newest first. The loop is hard
 * bounded by WEEK_ARCHIVE_MAX_WEEKS as a safety cap, independent of the
 * nav's own (smaller) target count. */
export async function getRecentWeekKeys(): Promise<RecentWeekKeys> {
  "use cache";
  cacheLife("hours");

  const nowMs = Date.now();
  const current = weekKeyFromMs(nowMs);

  const previous: string[] = [];
  let cursor = current;
  for (let i = 0; i < WEEK_ARCHIVE_MAX_WEEKS && previous.length < RECENT_WEEK_NAV_COUNT; i++) {
    const shifted = shiftWeek(cursor, -1);
    if (!shifted) break;
    if (shifted < WEEK_ARCHIVE_FIRST) break;
    previous.push(shifted);
    cursor = shifted;
  }

  return { current, previous };
}

// Re-exported so callers of this module don't need a second import just
// for the health check used alongside the archive (see
// src/app/hafta/[hafta]/page.tsx).
export { getZoneFeedHealth };
