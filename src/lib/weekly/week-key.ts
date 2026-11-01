// ISO-week keys ('YYYY-Www', Istanbul time) — the pure part of the /hafta
// archive, split out of week-archive.ts so the Edge middleware can import it.
//
// ZERO IMPORTS, on purpose: week-archive.ts pulls in next/cache, the Supabase
// reader client and the weekly query module, none of which belong in the Edge
// middleware bundle. week-key.test.ts pins that this file has no import
// statement. Everything here is a pure function of its arguments (no clock
// read, no I/O); callers pass `nowMs` in.

/** The earliest week /hafta/[hafta] will serve. /hafta shipped 2026-09-19, so
 * anything before 2026-W38 predates the page and would render an empty archive
 * that looks like a bug rather than "before launch". */
export const WEEK_ARCHIVE_FIRST = "2026-W38";

/** Türkiye has run permanent +03 (no DST) since 2016. */
export const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

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

/** Whether /hafta/[key] has anything to serve at `nowMs`: a well-formed key
 * from WEEK_ARCHIVE_FIRST through the current Istanbul week. Everything else
 * (garbage, W4, lower-case w, before launch, a future week) can never resolve.
 * The string compare is sound because a parsed key is always 'YYYY-Www' with
 * fixed-width digits, so lexicographic order is chronological order. */
export function isServableWeekKey(key: string, nowMs: number): boolean {
  return parseWeekKey(key) !== null && key >= WEEK_ARCHIVE_FIRST && key <= weekKeyFromMs(nowMs);
}
