import { createServerClient } from "@/lib/supabase/server";
import {
  ARCHIVE_CATCHUP_WINDOW_DAYS,
  missingArchiveDays,
} from "../../../supabase/functions/_shared/archive-window";

// M-10 (Tayf Arşiv) — the /admin status card's reader for the
// `archive_exports` ledger written by the `archive-export` Edge Function
// (migration 060). Deliberately NOT a "use cache" fetcher: /admin is
// cookie-gated and dynamic, so this runs per request and must never be
// cached or tagged.
//
// Never throws: the admin page is the one place an operator looks when the
// nightly export is broken, so a missing table (060 not applied yet) or a
// Supabase hiccup has to render as a status line, not a 500. `null` means
// "could not read", `[]` means "no export has run yet" — the page renders
// a different sentence for each.

export interface ArchiveExportRow {
  day: string;
  object_path: string;
  sha256: string;
  rows: number;
  bytes: number;
  created_at: string;
}

/** Rows the card's table lists (the newest week). */
export const ARCHIVE_STATUS_LIMIT = 7;

/**
 * How far back the card looks for missing nights: the same 40 day window the
 * nightly catch-up (migration 131, pg_cron `archive-export-catchup`) and the
 * SQL gap counter `ops_archive_gap_days` use. One source of truth:
 * supabase/functions/_shared/archive-window.ts.
 */
export const ARCHIVE_GAP_WINDOW_DAYS = ARCHIVE_CATCHUP_WINDOW_DAYS;

/** How many missing days the card names before it counts the rest. */
const ARCHIVE_GAP_LIST_MAX = 10;

/**
 * Missing UTC days in the gap window, ascending. `rows` is the ledger as
 * getRecentArchiveExports returns it (newest first; 41 rows cover the window
 * plus yesterday, and an older row in the list is the clamp anchor).
 */
export function archiveGapDays(rows: readonly ArchiveExportRow[], nowMs: number): string[] {
  return missingArchiveDays(
    rows.map((r) => r.day),
    new Date(nowMs),
    ARCHIVE_GAP_WINDOW_DAYS,
  );
}

/** "Eksik günler: a, b, … (+N gün daha)"; "" when nothing is missing. */
export function formatGapDays(days: readonly string[]): string {
  if (days.length === 0) return "";
  const shown = days.slice(0, ARCHIVE_GAP_LIST_MAX).join(", ");
  const rest = days.length - ARCHIVE_GAP_LIST_MAX;
  return `Eksik günler: ${shown}${rest > 0 ? ` (+${rest} gün daha)` : ""}`;
}

export async function getRecentArchiveExports(
  limit = ARCHIVE_GAP_WINDOW_DAYS + 1,
): Promise<ArchiveExportRow[] | null> {
  try {
    const supabase = createServerClient();

    const { data, error } = await supabase
      .from("archive_exports")
      .select("day, object_path, sha256, rows, bytes, created_at")
      .order("day", { ascending: false })
      .limit(limit)
      .returns<ArchiveExportRow[]>();

    if (error) {
      console.error(`[admin] archive exports unavailable: ${error.message}`);
      return null;
    }

    return data ?? [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] archive exports unavailable: ${message}`);
    return null;
  }
}
