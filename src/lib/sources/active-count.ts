import { cacheLife, cacheTag } from "next/cache";

import { createServerClient } from "@/lib/supabase/server";

// The live number behind the footer's "N kaynak" figure: active sources that
// delivered at least one article in the last 7 days.
//
// Existence probe, not a count: `recent:articles(id)` with
// `.limit(1, { referencedTable: "recent" })` yields at most one embedded row
// per source, served by idx_articles_source_published (migration 044) as a
// single index range scan (~11 ms) instead of the ~4.5 s per-source
// `stats:articles(count)` aggregate. /sources keeps the real count.
//
// Never throws: a throw inside "use cache" during static prerender fails the
// Vercel build even though the footer catches. A Supabase error resolves to
// null, which hides the chip for at most one cache window (300 s) instead of
// showing a wrong number.

export const ACTIVE_SOURCE_WINDOW_DAYS = 7;

/**
 * Pure counter: how many rows have at least one article in the aliased
 * `recent` existence-probe embed. Exported separately from the Supabase
 * round-trip so the counting rule itself is trivially unit-testable.
 */
export function countDeliveringSources(
  rows: ReadonlyArray<{ recent: Array<{ id: string }> }>,
): number {
  let count = 0;
  for (const row of rows) {
    if (row.recent.length > 0) count += 1;
  }
  return count;
}

export async function getDeliveringSourceCount(): Promise<number | null> {
  "use cache";
  cacheLife("source-directory");
  cacheTag("sources");

  const supabase = createServerClient();

  const sevenDaysAgoIso = new Date(
    Date.now() - ACTIVE_SOURCE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await supabase
    .from("sources")
    .select("id, recent:articles(id)")
    .eq("active", true)
    .gte("recent.published_at", sevenDaysAgoIso)
    .limit(1, { referencedTable: "recent" });

  if (error) {
    // Never throw — see the file header. Swallow and return null so the
    // "use cache" prerender never fails the build on a Supabase hiccup.
    return null;
  }

  type Row = { recent: Array<{ id: string }> };
  const rows = (data ?? []) as unknown as Row[];

  return countDeliveringSources(rows);
}
