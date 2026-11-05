import { unstable_rethrow } from "next/navigation";

// h41-resilience-3: a read that only decorates a page (circuit breakers, quote
// stats, reference prices, intraday bars) must not take the whole page to
// error.tsx when it fails. The finance fetchers in queries.ts deliberately
// THROW on a Supabase error (see that file's header), so the page decides
// which of its reads are essential and wraps the rest in optionalRead.
//
// Where the catch lives matters. Pass the EXPORTED, uncached fetcher's promise
// (`optionalRead("x", fetchX(...), fallback)`), never anything inside a
// `"use cache"` body: the fetchers already park a failure under a short
// `minutes` sentinel (attemptCached) and retry live once, outside the cache.
// Swallowing here, in the request-time page body, means the fallback value is
// only ever rendered, never stored, so a blip cannot be cached for a full
// cacheLife. Both /ekonomi bodies run after connection(), so a degraded render
// is not prerendered either.
//
// The warning names the read and nothing else: the first failure is already
// logged with its message by attemptCached, and a log line must never carry
// row data.

export interface OptionalRead<T> {
  /** The read's value, or the caller's fallback when it failed. */
  value: T;
  /** True when the read rejected and `value` is the fallback. */
  failed: boolean;
}

/**
 * Settles `p` into `{ value, failed }` instead of rejecting. A rejection logs
 * one `console.warn` with `label` and resolves to `fallback`. A legitimately
 * empty value is a success (`failed: false`).
 *
 * Next control-flow signals (notFound, redirect, dynamic-usage bailouts) are
 * not read failures and keep propagating via `unstable_rethrow`; every other
 * rejection, whatever its type, is swallowed.
 */
export async function optionalRead<T>(label: string, p: Promise<T>, fallback: T): Promise<OptionalRead<T>> {
  try {
    return { value: await p, failed: false };
  } catch (err) {
    unstable_rethrow(err);
    console.warn(`[ekonomi] optional read failed: ${label}`);
    return { value: fallback, failed: true };
  }
}
