import { cacheLife, cacheTag } from "next/cache";

import { getZoneFeedHealth } from "@/lib/clusters/feed-health";
import { createServerClient } from "@/lib/supabase/server";
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

/** The earliest week /hafta/[hafta] will serve. /hafta shipped 2026-09-19. */
export const WEEK_ARCHIVE_FIRST = "2026-W38";

/** How many completed weeks the "Geçmiş haftalar" nav lists. */
export const WEEK_ARCHIVE_MAX_WEEKS = 12;

const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

const WEEK_KEY_RE = /^(\d{4})-W(\d{2})$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** ISO week number of a UTC-midnight `Date`, ISO-8601 (Monday start, week 1
 * contains the year's first Thursday). Ambient timezone-agnostic: the
 * input must already be the calendar date to key on (see
 * `weekKeyFromMs`, which does the Istanbul conversion first). */
function isoWeekOf(date: Date): { isoYear: number; week: number } {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return { isoYear: d.getUTCFullYear(), week };
}

/** 'YYYY-Www' for a plain `YYYY-MM-DD` date key (no timezone conversion —
 * the caller already picked the calendar date). */
export function isoWeekKeyOf(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const { isoYear, week } = isoWeekOf(new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1)));
  return `${isoYear}-W${pad2(week)}`;
}

/** Takes the Istanbul (fixed +03) calendar date for `ms`, then the ISO
 * week of that date. Türkiye has run permanent +03 (no DST) since 2016,
 * so a fixed offset is correct year-round. */
export function weekKeyFromMs(ms: number): string {
  const istanbul = new Date(ms + ISTANBUL_OFFSET_MS);
  const { isoYear, week } = isoWeekOf(istanbul);
  return `${isoYear}-W${pad2(week)}`;
}

/** Number of ISO weeks in `isoYear` — 52 unless the year (or the year
 * before it) has a long year per the 4/Thursday rule; computed directly
 * from whether Dec 28 lands in week 53. */
function weeksInIsoYear(isoYear: number): number {
  const dec28 = new Date(Date.UTC(isoYear, 11, 28));
  return isoWeekOf(dec28).week;
}

/** Parses 'YYYY-Www', rejecting W00, W54+, and W53 in a 52-week year.
 * Returns null on any malformed or out-of-range key. */
export function parseWeekKey(
  raw: string,
): { isoYear: number; week: number } | null {
  const m = WEEK_KEY_RE.exec(raw);
  if (!m) return null;
  const isoYear = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  if (week === 53 && weeksInIsoYear(isoYear) < 53) return null;
  return { isoYear, week };
}

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

/** One archived week's cluster rows. `null` = could not be read; `[]` =
 * read fine, the week produced nothing (or every candidate is archived). */
export async function getWeekArchiveClusters(
  key: string,
): Promise<WeeklyClusterRow[] | null> {
  "use cache";
  cacheLife("hours");
  cacheTag("clusters-politics");

  const range = weekRange(key);
  if (!range) return null;

  try {
    const supabase = createServerClient();
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
