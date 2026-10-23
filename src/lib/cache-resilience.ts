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
// The pattern has two halves and a safety rule:
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
//      `fallback`. This half never throws for a DATA failure. Callers that
//      must not degrade silently (crons, RSS) should follow the
//      getBlindspots shape instead: attempt, live retry, then let the throw
//      propagate.
//
//   3. Prerender safety — `resolveCachedOrRetry` awaits `connection()`
//      (`awaitRequestScope`) before the live retry. The retry is an
//      UNCACHED fetch that may read the clock (fetchTopicCounts does,
//      topic-query.ts) and Next 16 cacheComponents fails `next build` on a
//      clock read in an uncached prerender path. When the cached attempt
//      failed during `next build` (or a background revalidation prerender),
//      the await postpones the subtree to the nearest Suspense (the root
//      src/app/loading.tsx covers every public page) instead of running the
//      retry. At request time it resolves at once and nothing changes: one
//      live retry, then `fallback`. NEVER call `resolveCachedOrRetry`, a
//      getter built on it, or `connection()` inside a `"use cache"` body:
//      there `connection()` throws AND records
//      `workStore.invalidDynamicUsageError`, which fails the build even
//      when caught. tests/guards/cache-retry-prerender.test.ts enforces
//      this, the await-before-retry order, and the call-site shape.
//      Facts, from node_modules/next/dist/server/request/connection.js:
//        - prerender / prerender-runtime / prerender-client: returns a
//          hanging promise, so the subtree postpones;
//        - request scope: resolves (crons and route handlers already await
//          `connection()` first);
//        - no work store (vitest without a mock, node scripts): throws
//          "`connection` was called outside a request scope"
//          (work-unit-async-storage.external.js), the one error
//          `awaitRequestScope` swallows;
//        - inside a `"use cache"` body: throws and records
//          `invalidDynamicUsageError`;
//        - inside `after()`: throws a different message, which propagates.
import { connection } from "next/server";

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
 * Wait until we are in a real request, so the caller may run uncached,
 * possibly clock-reading work. Wraps `connection()` from next/server. What it
 * does per scope (node_modules/next/dist/server/request/connection.js):
 *
 * - prerender / prerender-runtime / prerender-client (`next build`,
 *   background revalidation): `connection()` returns a hanging promise.
 *   This function therefore never settles, and the subtree postpones to the
 *   nearest Suspense boundary (src/app/loading.tsx covers every public page).
 * - request scope: resolves. Crons and route handlers already await
 *   `connection()` first.
 * - no work store (vitest without a mock, node scripts): `connection()`
 *   throws "`connection` was called outside a request scope"
 *   (work-unit-async-storage.external.js). That one error is swallowed and
 *   this resolves, so the caller proceeds.
 * - inside a `"use cache"` body: `connection()` throws AND records
 *   `workStore.invalidDynamicUsageError`, which fails the build even when
 *   caught. Never call this from a cache body (guarded by
 *   tests/guards/cache-retry-prerender.test.ts).
 * - inside `after()`: throws a different message; propagated.
 *
 * Only the outside-scope error is swallowed. Next control flow (the hanging
 * promise's rejection at prerender abort, the prerender-legacy interrupt)
 * and misuse (`use cache`, `after()`) propagate.
 */
export async function awaitRequestScope(): Promise<void> {
  try {
    await connection();
  } catch (err) {
    if (err instanceof Error && err.message.includes("outside a request scope")) {
      return;
    }
    throw err;
  }
}

/**
 * The uncached public entry point paired with `attemptCached`. Never throws
 * for a data failure: a cache-attempt failure triggers one live retry, and a
 * retry failure (or throw) falls back to `fallback` rather than propagating.
 * Next request-scope control flow from `awaitRequestScope` (a prerender
 * postpone, an `after()` misuse) propagates; it is deliberately kept outside
 * the try so a postpone signal can never be mistaken for `fallback`.
 */
export async function resolveCachedOrRetry<T>(
  label: string,
  cached: () => Promise<CacheAttempt<T>>,
  retry: () => Promise<T>,
  fallback: T,
): Promise<T> {
  const result = await cached();
  if (result.ok) return result.data;

  await awaitRequestScope();

  try {
    return await retry();
  } catch (err) {
    console.error(`[${label}] retry also failed: ${describeError(err)}`);
    return fallback;
  }
}
