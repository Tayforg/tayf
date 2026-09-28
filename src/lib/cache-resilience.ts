// Shared resilience pattern for every `"use cache"` fetcher that reads
// from Supabase.
//
// Root cause (2026-09-28 build incidents on /trends and /rss.xml): a
// thrown error INSIDE a `"use cache"` function fails `next build`'s
// prerender for that route even when every caller wraps the call in a
// try/catch — the throw/outer-catch convention used across this codebase
// ("throw inside `use cache` so a failure is never cached, catch in an
// uncached wrapper") does not protect `next build`. `src/lib/clusters/
// feed-health.ts` already discovered and documented this the hard way
// ("Never throw — see the file header. A `use cache` throw during
// prerender fails the Vercel build even though callers catch.") — this
// module generalizes that proven-safe shape so every fetcher gets it
// consistently instead of re-deriving it (or getting it wrong) file by
// file.
//
// The pattern has two halves:
//
//   1. `attemptCached` — call THIS from inside the `"use cache"` function
//      body, wrapping the real (throwing) fetch. It never rejects: a
//      thrown error becomes `{ ok: false, error }`, logged once here so
//      every fetcher's failure shows up in server logs identically. This
//      alone is what makes `next build` unconditionally safe, independent
//      of any Next-internal behaviour around cross-environment promise
//      rejection during prerender.
//
//   2. `resolveCachedOrRetry` — the PUBLIC, uncached entry point. It reads
//      the cache attempt; on a hit, returns the cached value untouched
//      (including a legitimately empty/null value — this is not itself
//      a failure). On a miss, it retries the same fetch live (uncached)
//      once. NOTE the `{ ok: false }` sentinel returned from the `use
//      cache` body is itself memoised for the whole `cacheLife` window, so
//      while it is cached every request skips the cache and runs the
//      fetch live (uncached); the retry is what heals a transient blip
//      per request, not cache expiry. Only a genuinely sustained outage
//      (cached attempt AND live retry both fail) falls through to
//      `fallback`. This half also never throws. Callers that must not
//      degrade silently (crons, RSS) should follow the getBlindspots
//      shape instead: attempt, live retry, then let the throw propagate.
export type CacheAttempt<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run `fn` and never let it reject. Call this from inside a `"use cache"`
 * function body and return its result directly.
 */
export async function attemptCached<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<CacheAttempt<T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err) {
    const error = describeError(err);
    console.error(`[${label}] error: ${error}`);
    return { ok: false, error };
  }
}

/**
 * The uncached public entry point paired with `attemptCached`. Never
 * throws: a cache-attempt failure triggers one live retry, and a retry
 * failure (or throw) falls back to `fallback` rather than propagating.
 */
export async function resolveCachedOrRetry<T>(
  label: string,
  cached: () => Promise<CacheAttempt<T>>,
  retry: () => Promise<T>,
  fallback: T,
): Promise<T> {
  const result = await cached();
  if (result.ok) return result.data;

  try {
    return await retry();
  } catch (err) {
    console.error(`[${label}] retry also failed: ${describeError(err)}`);
    return fallback;
  }
}
