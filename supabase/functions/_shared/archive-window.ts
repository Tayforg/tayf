// supabase/functions/_shared/archive-window.ts
//
// The pure date arithmetic of the archive catch-up (migration 131). ZERO
// imports on purpose: src/lib/admin/archive-status.ts imports this file
// directly (Next resolves extensionless specifiers, Deno needs `.ts`), and a
// file with no imports of its own cannot drag a `.ts`-suffixed specifier into
// the Next build. _shared/archive.ts re-exports everything below.
//
// Why it exists (hunt 10, h10-silent-2): the nightly export only ever exports
// "yesterday". 2026-10-12..17 never ran, nothing retried and nothing flagged
// it. The cure is a second nightly job (pg_cron `archive-export-catchup`,
// 05:12 UTC) that re-exports the OLDEST missing day inside a window, one day
// per run.
//
// The ceiling: jev-shadow-prune (migration 061, '50 4 * * *') keeps 45 days of
// jev_shadow_predictions. A day exported after its labels are pruned is
// exported WITHOUT them (docs/migration-guide.md), so the window must stay
// strictly inside the keep window: 45 - 1 = 44 is the hard maximum. The default
// is 40, not 30: a 30 day window drops 2026-10-12 on 2026-11-11, two weeks
// before its labels are pruned (about 2026-11-26).

/** jev-shadow-prune keeps this many days of Jev predictions (the label source). */
export const ARCHIVE_LABEL_KEEP_DAYS = 45;
/** The widest catch-up window that still re-exports with labels. */
export const ARCHIVE_CATCHUP_MAX_WINDOW_DAYS = 44;
/** The window the nightly catch-up, the SQL gap counter and the /admin card use. */
export const ARCHIVE_CATCHUP_WINDOW_DAYS = 40;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Epoch ms of the UTC midnight that starts `day`, or NaN for a non-day. */
function dayToMs(day: unknown): number {
  if (typeof day !== "string" || !DAY_RE.test(day)) return Number.NaN;
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return Number.NaN;
  // Date.parse rolls impossible days (02-30) forward; only a round trip is a real day.
  return new Date(ms).toISOString().slice(0, 10) === day ? ms : Number.NaN;
}

function msToDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The `[today - windowDays, today - 2]` window of UTC days a catch-up looks at.
 * `today - 1` (yesterday) is left to the 03:40 job; `today` has no export yet.
 * Throws a RangeError for a window that is not an integer in [2, 44].
 */
export function catchupWindow(now: Date, windowDays: number): { from: string; to: string } {
  if (
    !Number.isInteger(windowDays) ||
    windowDays < 2 ||
    windowDays > ARCHIVE_CATCHUP_MAX_WINDOW_DAYS
  ) {
    throw new RangeError(
      `catchup window must be an integer in [2, ${ARCHIVE_CATCHUP_MAX_WINDOW_DAYS}] (Jev keep ${ARCHIVE_LABEL_KEEP_DAYS} - 1), got ${String(windowDays)}`,
    );
  }
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) throw new RangeError("catchup window needs a valid Date");
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { from: msToDay(todayMs - windowDays * DAY_MS), to: msToDay(todayMs - 2 * DAY_MS) };
}

/**
 * Ascending UTC days inside the window that have no ledger row.
 *
 * `existingDays` is the exported-day ledger. Strings that are not real
 * `YYYY-MM-DD` days are ignored. The window start is clamped to the earliest
 * ledger day (the archive began there: days before it are not "missing"), so an
 * empty ledger has no known start and yields []. Callers that fetch only the
 * window from the database must include the first-ever ledger day as an anchor,
 * otherwise a hole that touches the window start would clamp itself away
 * (see ArchivePorts.listExportedDays).
 */
export function missingArchiveDays(existingDays: readonly string[], now: Date, windowDays: number): string[] {
  const window = catchupWindow(now, windowDays);
  const present = new Set<string>();
  let first = Number.POSITIVE_INFINITY;
  for (const day of existingDays) {
    const ms = dayToMs(day);
    if (Number.isNaN(ms)) continue;
    present.add(day);
    if (ms < first) first = ms;
  }
  if (present.size === 0) return [];

  const start = Math.max(dayToMs(window.from), first);
  const end = dayToMs(window.to);
  const missing: string[] = [];
  for (let ms = start; ms <= end; ms += DAY_MS) {
    const day = msToDay(ms);
    if (!present.has(day)) missing.push(day);
  }
  return missing;
}

/** The oldest missing day of the window, or null when the ledger is complete. */
export function pickCatchupDay(existingDays: readonly string[], now: Date, windowDays: number): string | null {
  return missingArchiveDays(existingDays, now, windowDays)[0] ?? null;
}
