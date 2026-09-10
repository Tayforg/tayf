import { cacheLife, cacheTag } from "next/cache";

import { createServerClient } from "@/lib/supabase/server";

// The live number behind the footer's "N kaynak" figure — how many active
// sources actually delivered at least one article in the last 7 days.
// Mirrors the query already proven in src/app/sources/page.tsx (id +
// aliased `stats:articles(count)` embed, filtered to `active` sources with
// a `gte` window on the embedded `articles.published_at`).

export const ACTIVE_SOURCE_WINDOW_DAYS = 7;

/**
 * Pure counter: how many rows have at least one article in the aliased
 * `stats` count embed. Exported separately from the Supabase round-trip so
 * the counting rule itself is trivially unit-testable.
 */
export function countDeliveringSources(
  rows: ReadonlyArray<{ stats: Array<{ count: number }> }>,
): number {
  let count = 0;
  for (const row of rows) {
    const articleCount = row.stats[0]?.count ?? 0;
    if (articleCount > 0) count += 1;
  }
  return count;
}

export async function getDeliveringSourceCount(): Promise<number> {
  "use cache";
  cacheLife("source-directory");
  cacheTag("sources");

  const supabase = createServerClient();

  const sevenDaysAgoIso = new Date(
    Date.now() - ACTIVE_SOURCE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await supabase
    .from("sources")
    .select("id, stats:articles(count)")
    .eq("active", true)
    .gte("stats.published_at", sevenDaysAgoIso);

  if (error) {
    // Never swallow — this fetcher is wrapped in "use cache"; returning a
    // fallback number on a transient failure would cache a wrong count for
    // the full revalidate window (see src/lib/clusters/blindspots-query.ts).
    throw new Error(`active source count query failed: ${error.message}`);
  }

  type Row = { stats: Array<{ count: number }> };
  const rows = (data ?? []) as unknown as Row[];

  return countDeliveringSources(rows);
}
