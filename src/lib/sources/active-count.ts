import { cacheLife, cacheTag } from "next/cache";

import { attemptCached } from "@/lib/cache-resilience";
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
// Never throws, and a failure is not remembered for long (2026-10-24 /sources
// '—' incident). A throw inside "use cache" during static prerender fails the
// Vercel build even though the footer catches, so the Supabase read is a raw
// `fetchDeliveringSourceCount` that throws, wrapped by `attemptCached` inside
// `getDeliveringSourceCountCached`, and only then is the cache lifetime chosen:
// a count keeps the 1 h `source-directory` window, a failed read is cached for
// `minutes`. (`cacheLife` used to run before the query, so one timeout hid the
// chip for the whole hour.) A Supabase error still resolves to null, which
// hides the chip instead of showing a wrong number. No live retry: the fetch
// reads `Date.now()`, which is only allowed inside the cache scope (same shape
// as src/lib/clusters/timeline-query.ts, guarded by
// tests/guards/cache-life-after-attempt.test.ts).

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

// Raw read: THROWS on a Supabase error so a failure can never be mistaken for
// "0 sources delivered".
async function fetchDeliveringSourceCount(): Promise<number> {
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
    throw new Error(`delivering source count query failed: ${error.message}`);
  }

  type Row = { recent: Array<{ id: string }> };
  const rows = (data ?? []) as unknown as Row[];

  return countDeliveringSources(rows);
}

// `attemptCached` keeps the throw from crossing the `"use cache"` boundary.
// Lifetime follows the outcome: a count keeps `source-directory`, a failed
// attempt is memoised for `minutes` only. Exactly one `cacheLife` call per
// invocation, after the attempt; `cacheTag` first.
async function getDeliveringSourceCountCached() {
  "use cache";
  cacheTag("sources");
  const r = await attemptCached("active-count", fetchDeliveringSourceCount);
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("source-directory");
  else cacheLife("minutes");
  return r;
}

/**
 * Active sources that delivered an article in the last 7 days. `null` =
 * unknown (the read failed; the footer hides the chip); `0` = it read fine and
 * nothing delivered. Never throws.
 */
export async function getDeliveringSourceCount(): Promise<number | null> {
  const r = await getDeliveringSourceCountCached();
  return r.ok ? r.data : null;
}
