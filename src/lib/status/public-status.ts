import { cacheLife, cacheTag } from "next/cache";

import { attemptCached, resolveCachedOrRetry } from "@/lib/cache-resilience";
import { createReaderClient } from "@/lib/supabase/server";

import { toPublicStatusSnapshot, type PublicStatusSnapshot } from "./verdict";

// Data access for the public /durum page: one rpc to
// public.public_status_snapshot() (migration 110, service_role only), through
// the capped reader client (4 s) so a cold Micro-compute read cannot hold the
// page for the full 8 s statement_timeout. The page is public and reached by
// no cron, so there is no ReadProfile option.
//
// Safe aggregates only: the function returns timestamps, counts and booleans,
// and `toPublicStatusSnapshot` re-validates the payload with an allow-list, so
// nothing the database adds later can reach the HTML by accident.
//
// Build safety (Next 16 cacheComponents): a throw inside a `"use cache"` body
// fails `next build`'s prerender, so the cached body goes through
// `attemptCached` and returns a failure VALUE. That value is memoised under the
// built-in `minutes` profile, which is also why the public entry point retries
// live once before giving up.
//
// Freshness: every age on /durum is measured against the snapshot's own
// `generated_at`, never against "now", so a snapshot served long after it was
// taken would show a healthy verdict for a pipeline that has since stalled. A
// success therefore uses the dedicated `status` profile (next.config.ts:
// revalidate 60 s, expire 180 s), which bounds the served age to ~3 minutes;
// the built-in `minutes` profile would keep and serve an entry for an hour.
// Exactly one `cacheLife` call runs per invocation (if/else, one literal each).

/** Throws on an rpc error or an invalid payload. Never called from a
 * `"use cache"` body directly (see `getPublicStatusCached`). */
export async function fetchPublicStatus(): Promise<PublicStatusSnapshot> {
  const supabase = createReaderClient();
  const { data, error } = await supabase.rpc("public_status_snapshot");
  if (error) {
    throw new Error(`public_status_snapshot rpc error: ${error.message}`);
  }
  const snapshot = toPublicStatusSnapshot(data);
  if (snapshot === null) {
    throw new Error("public_status_snapshot returned an invalid payload");
  }
  return snapshot;
}

async function getPublicStatusCached() {
  "use cache: remote";
  cacheTag("public-status");
  const r = await attemptCached("public-status", fetchPublicStatus);
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("status");
  else cacheLife("minutes");
  return r;
}

/**
 * The snapshot, or `null` when it could not be read (the page then says so
 * honestly and shows no verdict). Never throws.
 */
export async function getPublicStatus(): Promise<PublicStatusSnapshot | null> {
  return resolveCachedOrRetry<PublicStatusSnapshot | null>(
    "public-status",
    getPublicStatusCached,
    fetchPublicStatus,
    null,
  );
}
