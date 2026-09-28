import { cacheLife, cacheTag } from "next/cache";

import { createServerClient } from "@/lib/supabase/server";

// Live "has the neutralizer actually produced anything?" readout, reused by
// every reader-facing surface that would otherwise assert AI-neutralization
// unconditionally (rss.xml, /metodoloji).
//
// reader-queries F1 fix: the previous implementation ran TWO exact
// `count: "exact", head: true` aggregates over the whole `clusters` table
// (one for "eligible", one for "neutralized"). The audit measured ~5.6k
// calls of each, ~1.75s mean — a full sequential scan per call, twice.
// This now calls the 083 migration's `headline_neutral_counts()` RPC,
// which computes both counts in a single index-friendly scan (see 083's
// header). The `article_count >= 3` floor is the SAME constant as before
// (HEADLINE_MIN_ARTICLE_COUNT, src/lib/headline/prompt.ts) — it is now a
// literal `3` baked into the RPC body rather than imported here, so this
// file no longer needs the import; the literal is guarded by the 083
// migration's own SQL-contract test (tests/migrations/083-reader-query-rpcs.test.ts),
// which parses HEADLINE_MIN_ARTICLE_COUNT out of prompt.ts and asserts the
// two agree.
//
// `cacheTag("clusters-politics")` is the same tag the headline cron
// revalidates on a successful rewrite (src/app/api/cron/headline/route.ts,
// `revalidateTag("clusters-politics", "max")`) so every copy that reads this
// helper flips to the truth on the very next cron tick, with no redeploy.
//
// Never throws — copied verbatim from the never-throw/return-null discipline
// in src/lib/sources/active-count.ts: a throw inside "use cache" during
// prerender fails the Vercel build. A Supabase error (or anything else going
// wrong) resolves to `null`, which every caller treats as "do not claim".
export async function getNeutralizedStatus(): Promise<{
  neutralized: number;
  eligible: number;
} | null> {
  "use cache: remote";
  cacheLife("cluster-feed");
  cacheTag("clusters-politics");

  try {
    const supabase = createServerClient();

    const { data, error } = await supabase.rpc("headline_neutral_counts");

    if (error) {
      // PII-free: Supabase's error.message is a query-level diagnostic
      // (timeout, connection refused, etc.), never row data.
      console.warn(`[headline-status] unavailable: ${error.message}`);
      return null;
    }

    const row = Array.isArray(data) ? data[0] : data;
    const eligible = Number(row?.eligible);
    const neutralized = Number(row?.neutralized);

    if (!row || !Number.isFinite(eligible) || !Number.isFinite(neutralized)) {
      console.warn("[headline-status] unavailable: malformed counts");
      return null;
    }

    return { eligible, neutralized };
  } catch (err) {
    // createServerClient() throws when Supabase env vars are missing; that
    // is still a "do not claim" condition, not a build-time failure.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[headline-status] unavailable: ${message}`);
    return null;
  }
}
