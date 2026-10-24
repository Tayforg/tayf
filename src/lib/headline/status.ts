import { cacheLife, cacheTag } from "next/cache";

import { attemptCached } from "@/lib/cache-resilience";
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
// Never throws, and a failure is not remembered for long (the same shape as
// src/lib/sources/active-count.ts): a throw inside "use cache" during
// prerender fails the Vercel build, and a `null` memoised under a fixed
// `cluster-feed` lifetime would hide the claim copy for that whole window
// after one timeout. The Supabase read is a raw `readNeutralizedStatus` that
// THROWS (an rpc error, a malformed row, a missing env var), wrapped by
// `attemptCached` inside the `"use cache: remote"` function, and only then is
// the lifetime chosen: counts keep `cluster-feed`, a failed read is cached for
// `minutes`. The exported function maps a failed attempt to `null`, which
// every caller treats as "do not claim". No live retry: this is a null
// contract, and the next request after `minutes` reads again.

export interface NeutralizedStatus {
  neutralized: number;
  eligible: number;
}

async function readNeutralizedStatus(): Promise<NeutralizedStatus> {
  // createServerClient() throws when Supabase env vars are missing; that is
  // still a "do not claim" condition, handled by attemptCached.
  const supabase = createServerClient();

  const { data, error } = await supabase.rpc("headline_neutral_counts");

  // PII-free: Supabase's error.message is a query-level diagnostic (timeout,
  // connection refused, etc.), never row data.
  if (error) throw new Error(error.message);

  const row = Array.isArray(data) ? data[0] : data;
  const eligible = Number(row?.eligible);
  const neutralized = Number(row?.neutralized);

  if (!row || !Number.isFinite(eligible) || !Number.isFinite(neutralized)) {
    throw new Error("malformed counts");
  }

  return { eligible, neutralized };
}

async function getNeutralizedStatusCached() {
  "use cache: remote";
  cacheTag("clusters-politics");
  const r = await attemptCached("headline-status", readNeutralizedStatus);
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("cluster-feed");
  else cacheLife("minutes");
  if (!r.ok) console.warn(`[headline-status] unavailable: ${r.error}`);
  return r;
}

export async function getNeutralizedStatus(): Promise<NeutralizedStatus | null> {
  const r = await getNeutralizedStatusCached();
  return r.ok ? r.data : null;
}
