import { cacheLife, cacheTag } from "next/cache";

import { createServerClient } from "@/lib/supabase/server";
import { HEADLINE_MIN_ARTICLE_COUNT } from "@/lib/headline/prompt";

// Live "has the neutralizer actually produced anything?" readout, reused by
// every reader-facing surface that would otherwise assert AI-neutralization
// unconditionally (rss.xml, /metodoloji). Mirrors the exact two head-count
// queries `/api/metrics` already computes for `neutralizedEligible` /
// `neutralized` (src/app/api/metrics/route.ts's `clustersNeutralizedEligible`
// / `clustersNeutralized` queries) — same table, same
// `.gte("article_count", ...)` floor (metrics hardcodes the literal `3`;
// HEADLINE_MIN_ARTICLE_COUNT is that same constant), same
// `.not("title_neutral_at", "is", null)` predicate for "actually rewritten".
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
  "use cache";
  cacheLife("cluster-feed");
  cacheTag("clusters-politics");

  try {
    const supabase = createServerClient();

    const [eligibleRes, neutralizedRes] = await Promise.all([
      supabase
        .from("clusters")
        .select("*", { count: "exact", head: true })
        .gte("article_count", HEADLINE_MIN_ARTICLE_COUNT),
      supabase
        .from("clusters")
        .select("*", { count: "exact", head: true })
        .gte("article_count", HEADLINE_MIN_ARTICLE_COUNT)
        .not("title_neutral_at", "is", null),
    ]);

    if (eligibleRes.error || neutralizedRes.error) {
      // PII-free: Supabase's error.message is a query-level diagnostic
      // (timeout, connection refused, etc.), never row data. Logged so a
      // silent "do not claim" degradation is at least visible in Vercel
      // function logs instead of vanishing indistinguishably from "0
      // clusters neutralized yet".
      const message =
        eligibleRes.error?.message ?? neutralizedRes.error?.message ?? "unknown error";
      console.warn(`[headline-status] unavailable: ${message}`);
      return null;
    }

    return {
      eligible: eligibleRes.count ?? 0,
      neutralized: neutralizedRes.count ?? 0,
    };
  } catch (err) {
    // createServerClient() throws when Supabase env vars are missing; that
    // is still a "do not claim" condition, not a build-time failure.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[headline-status] unavailable: ${message}`);
    return null;
  }
}
