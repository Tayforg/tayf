import { createServerClient } from "@/lib/supabase/server";

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

export const ARCHIVE_STATUS_LIMIT = 7;

export async function getRecentArchiveExports(
  limit = ARCHIVE_STATUS_LIMIT,
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
