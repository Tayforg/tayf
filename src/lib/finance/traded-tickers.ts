import { cacheLife, cacheTag } from "next/cache";

import { attemptCached } from "@/lib/cache-resilience";
import { readAllPages } from "@/lib/finance/paging";
import { NON_EQUITY_TICKERS } from "@/lib/finance/ticker-index";
import { READER_TIMEOUT_MS, createFinanceServerClient } from "@/lib/supabase/server";

// The traded BIST codes the home search checks a one-word query against (h153):
// "/?q=THYAO" earns a link to /ekonomi/THYAO only when THYAO is in this set.
//
// Why a file of its own: /ekonomi/[ticker] probes one ticker at a time behind
// React `cache()`, which lives for one request, so a search cannot reuse it; and
// queries.ts holds the /ekonomi readers, which this home-page reader is not.
// tests/guards/finance-remote-cache.test.ts classifies the directive here as
// `"use cache: remote"` and fails if it is downgraded.
//
// Shape (the finance readers' and registry-query's): `attemptCached` inside the
// `"use cache: remote"` body so nothing ever throws across the cache boundary, then
// exactly ONE `cacheLife` chosen AFTER the attempt (a failed read is memoised for
// `minutes` only, a success for `hours`: the set changes when a company lists or
// delists). The public getter keeps the NULL contract of getActiveSourceSlugs: no
// live retry and no connection(), so it never reads the clock or the request scope,
// never throws, and the caller simply offers no ticker link when it is null.
//
// The getter takes NO argument, so there is exactly one cache entry however many
// distinct queries arrive. About 626 companies trade, so one page of PostgREST's
// 1,000 rows is enough; three pages are the bound, and a truncated read only means
// a code is missing from the set (no link), never a wrong one.

/** What one `bist_companies` row carries that the set needs. */
export interface TradedCompanyRow {
  tickers?: unknown;
}

/**
 * The distinct codes of the given rows, sorted, without non-equity codes (KTEST).
 * A row whose `tickers` is not an array, and an entry that is not a string, are
 * skipped. The 3-letter alias codes (TGB) are kept: the search only ever asks for
 * a 4 to 6 letter code, so they are never matched.
 */
export function tradedTickerCodes(rows: readonly TradedCompanyRow[]): string[] {
  const codes = new Set<string>();
  for (const row of rows) {
    if (!Array.isArray(row.tickers)) continue;
    for (const code of row.tickers) {
      if (typeof code === "string" && !NON_EQUITY_TICKERS.has(code)) codes.add(code);
    }
  }
  return [...codes].sort();
}

// Uncached implementation. THROWS on a read error (readAllPages does).
async function readTradedTickers(): Promise<string[]> {
  const supabase = await createFinanceServerClient({ timeoutMs: READER_TIMEOUT_MS });
  const { rows } = await readAllPages<TradedCompanyRow>(
    (from, to) =>
      supabase
        .from("bist_companies")
        .select("kap_member_oid,tickers")
        .eq("shares_traded", true)
        .order("kap_member_oid")
        .range(from, to),
    { label: "traded tickers", maxPages: 3 },
  );
  return tradedTickerCodes(rows);
}

async function getTradedTickersCached() {
  "use cache: remote";
  cacheTag("finance-companies");
  const r = await attemptCached("finance-traded-tickers", () => readTradedTickers());
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("hours");
  else cacheLife("minutes");
  return r;
}

/**
 * The traded BIST codes, sorted, or `null` when the cached read failed (the caller
 * then offers no ticker link). Never throws, no live retry.
 */
export async function getTradedTickers(): Promise<readonly string[] | null> {
  const r = await getTradedTickersCached();
  return r.ok ? r.data : null;
}
