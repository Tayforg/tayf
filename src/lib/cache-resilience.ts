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
//      `fallback` (or, for a keyed call, to the last good value; section 4).
//      This half never throws for a DATA failure. Callers that
//      must not degrade silently (finance pages, sitemaps, crons, RSS) use
//      `resolveCachedOrThrow` instead: attempt, live retry, then let the
//      retry's error propagate (the getBlindspots shape, plus the
//      prerender-safe await below).
//
//   3. Prerender safety — `resolveCachedOrRetry` and `resolveCachedOrThrow`
//      await `connection()` (`awaitRequestScope`) before the live retry. The retry is an
//      UNCACHED fetch that may read the clock (fetchTopicCounts does,
//      topic-query.ts) and Next 16 cacheComponents fails `next build` on a
//      clock read in an uncached prerender path. When the cached attempt
//      failed during `next build` (or a background revalidation prerender),
//      the await postpones the subtree to the nearest Suspense (the root
//      src/app/loading.tsx covers every public page) instead of running the
//      retry. At request time it resolves at once and nothing changes: one
//      live retry, then `fallback` (or the retry's error). NEVER call
//      `resolveCachedOrRetry`, `resolveCachedOrThrow`, a getter built on
//      either, or `connection()` inside a `"use cache"` body:
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
//
//   4. Stale-if-error and single-flight (h27-resilience-2, opt-in per call).
//      Both resolvers take `label` as a string OR `{ label, key }`. Without a
//      `key` they behave exactly as in sections 2 and 3. With a `key`:
//        - Last-good: a per-instance LRU (LAST_GOOD_MAX_KEYS entries) of the
//          most recent good value per key. It is filled from a cache HIT that
//          carries `at` (the epoch ms of the database read, stamped inside the
//          `"use cache"` body, see below) and from a successful live retry. It
//          is served ONLY when the cached attempt AND the live retry both
//          failed, and only while younger than LAST_GOOD_MAX_AGE_MS (60 min,
//          measured from the read, never from when it was remembered). Why it
//          exists: a stale-while-revalidate refresh that fails stores the
//          `{ ok: false }` sentinel under the same key, on top of the last
//          good entry, and Next does NOT serve the previous entry past it; the
//          live retry and this map cover that gap. `null`/`undefined` values
//          (a genuinely absent row) are never remembered.
//        - Single-flight: concurrent live retries for one key share ONE
//          in-flight promise, so an outage costs one upstream read instead of
//          one per visitor. A settled flight is never reused. A rejected
//          flight arms a RETRY_COOLDOWN_MS (5 s) negative cooldown for that
//          key: calls inside it do not call `retry` and reject with the stored
//          error, which then flows into the last-good / fallback / rethrow path.
//      Crons and other callers that must never send stale data pass no key.
//        - `remember` (optional, in the label object): the caller's say on what
//          counts as GOOD. A degraded-but-served value (cluster detail with
//          `sourcesUnavailable`) is returned to the request that fetched it
//          but must not become, or replace, the last good value: a newer
//          degraded copy would otherwise win over the complete one and be
//          what an outage later serves. The cache-hit path already keeps such
//          a value out by omitting `at`; `remember` covers the live-retry path,
//          which has no stamp to omit.
//
//      Clock rules, which keep this prerender-safe:
//        - NEVER read the clock on the cache-hit path: a hit runs during
//          prerender, where an uncached `Date.now()` fails `next build`. The
//          hit only records `result.at`, which was stamped elsewhere.
//        - `at` is stamped with `Date.now()` INSIDE the `"use cache"` body
//          (the only new logic allowed there; compare getKarneFreshnessCached
//          in src/lib/sources/karne.ts), after `attemptCached` and after the
//          single `cacheLife` call, and only for a result worth serving later.
//        - Every other clock read here (recall, cooldown, the stamp on a live
//          success) happens after `awaitRequestScope()`, i.e. at request time.
//      The helpers keep the argument counts tests/guards/cache-retry-prerender
//      enforces (4 and 3): the key rides inside the first argument.
import { connection } from "next/server";

/**
 * `at` (optional) is the epoch ms of the database read behind `data`. Stamp it
 * inside the `"use cache"` body (`{ ...r, at: Date.now() }`) to make a hit
 * eligible as a keyed last-good value; omit it and a hit records nothing.
 */
export type CacheAttempt<T> =
  | { ok: true; data: T; at?: number }
  | { ok: false; error: string };

/** Bound on remembered last-good keys (and on tracked cooldown keys). */
export const LAST_GOOD_MAX_KEYS = 200;
/** A last-good value older than this (from the database read) is never served. */
export const LAST_GOOD_MAX_AGE_MS = 3_600_000;
/** Negative cooldown after a failed live flight, per key. */
export const RETRY_COOLDOWN_MS = 5_000;
// A stamp this far ahead of our clock is another instance's skew, not a read
// from the future; do not trust it past this.
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

const lastGood = new Map<string, { value: unknown; fetchedAt: number }>();
const flights = new Map<string, Promise<unknown>>();
const cooldown = new Map<string, { error: unknown; until: number }>();

/** Test hook: forget every last-good value, flight and cooldown. */
export function __resetCacheResilienceForTests(): void {
  lastGood.clear();
  flights.clear();
  cooldown.clear();
}

/**
 * Remember `value` as the last good answer for `key`, read from the database at
 * `fetchedAt` (epoch ms). `null`/`undefined` are ignored, and an entry is never
 * replaced by an older one (it only becomes the most recently used). Never
 * reads the clock. LRU: the oldest key is evicted past LAST_GOOD_MAX_KEYS.
 */
export function rememberLastGood<T>(
  key: string,
  value: T,
  fetchedAt: number,
): void {
  if (value === null || value === undefined) return;
  if (!Number.isFinite(fetchedAt)) return;
  const existing = lastGood.get(key);
  if (existing !== undefined) {
    lastGood.delete(key);
    if (existing.fetchedAt > fetchedAt) {
      lastGood.set(key, existing);
      return;
    }
  }
  lastGood.set(key, { value, fetchedAt });
  while (lastGood.size > LAST_GOOD_MAX_KEYS) {
    const oldest = lastGood.keys().next();
    if (oldest.done) break;
    lastGood.delete(oldest.value);
  }
}

/**
 * The last good value for `key`, or `undefined` when there is none, it is
 * older than LAST_GOOD_MAX_AGE_MS, or its stamp is implausibly far in the
 * future. A rejected entry is deleted. Reads the clock: call it only after
 * `awaitRequestScope()`.
 */
export function recallLastGood<T>(key: string): T | undefined {
  const entry = lastGood.get(key);
  if (entry === undefined) return undefined;
  const age = Date.now() - entry.fetchedAt;
  lastGood.delete(key);
  if (age > LAST_GOOD_MAX_AGE_MS || age < -CLOCK_SKEW_TOLERANCE_MS) {
    return undefined;
  }
  lastGood.set(key, entry);
  return entry.value as T;
}

function armCooldown(key: string, error: unknown): void {
  const now = Date.now();
  cooldown.delete(key);
  if (cooldown.size >= LAST_GOOD_MAX_KEYS) {
    for (const [k, v] of cooldown) if (v.until <= now) cooldown.delete(k);
  }
  while (cooldown.size >= LAST_GOOD_MAX_KEYS) {
    const oldest = cooldown.keys().next();
    if (oldest.done) break;
    cooldown.delete(oldest.value);
  }
  cooldown.set(key, { error, until: now + RETRY_COOLDOWN_MS });
}

/**
 * Single-flight per key. Concurrent callers share one in-flight `fn()`; the
 * flight is removed in `finally`, so a settled flight is never reused. A
 * rejection arms a RETRY_COOLDOWN_MS cooldown: until it passes, calls reject
 * with the stored error without calling `fn`. Different keys never share a
 * flight. Reads the clock: call it only after `awaitRequestScope()`.
 */
export function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const cooling = cooldown.get(key);
  if (cooling !== undefined) {
    if (Date.now() < cooling.until) return Promise.reject(cooling.error);
    cooldown.delete(key);
  }
  const running = flights.get(key);
  if (running !== undefined) return running as Promise<T>;

  // The cleanup handlers are attached AFTER `flights.set` has run (handlers
  // never run synchronously), so a synchronous throw from `fn` cannot leave a
  // settled flight behind.
  const flight: Promise<T> = (async () => fn())()
    .catch((err: unknown) => {
      armCooldown(key, err);
      throw err;
    })
    .finally(() => {
      if (flights.get(key) === flight) flights.delete(key);
    });
  flights.set(key, flight);
  return flight;
}

/**
 * `label` alone, or `label` plus the key that opts a call into section 4.
 * `remember` (keyed calls only) lets the caller say which values count as a
 * GOOD answer to keep for stale-if-error: it is consulted for a cache hit with
 * an `at` stamp and for a live success, and a value it rejects is still
 * returned to this caller but never becomes (or replaces) the last good value.
 * Without it every non-null value is remembered, as before. A throwing
 * predicate counts as "not good".
 */
export type ResolveLabel<T = unknown> =
  | string
  | { label: string; key?: string; remember?: (value: T) => boolean };

function splitLabel<T>(input: ResolveLabel<T>): {
  name: string;
  key?: string;
  remember?: (value: T) => boolean;
} {
  return typeof input === "string"
    ? { name: input }
    : { name: input.label, key: input.key, remember: input.remember };
}

/** `remember?.(value) ?? true`, with a throwing predicate read as "not good". */
function isRememberable<T>(remember: ((value: T) => boolean) | undefined, value: T): boolean {
  if (remember === undefined) return true;
  try {
    return remember(value) === true;
  } catch {
    return false;
  }
}

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
 * retry failure (or throw) falls back to the last good value (keyed calls
 * only, section 4 of the file header) or else to `fallback`, rather than
 * propagating. Next request-scope control flow from `awaitRequestScope` (a
 * prerender postpone, an `after()` misuse) propagates; it is deliberately kept
 * outside the try so a postpone signal can never be mistaken for `fallback`.
 *
 * `label` is a string, or `{ label, key }` to opt in to last-good serving and
 * single-flight for that key. Without a key nothing changes.
 */
export async function resolveCachedOrRetry<T>(
  label: ResolveLabel<T>,
  cached: () => Promise<CacheAttempt<T>>,
  retry: () => Promise<T>,
  fallback: T,
): Promise<T> {
  const { name, key, remember } = splitLabel(label);
  const result = await cached();
  if (result.ok && key !== undefined && result.at !== undefined && isRememberable(remember, result.data)) {
    rememberLastGood(key, result.data, result.at);
  }
  if (result.ok) return result.data;

  await awaitRequestScope();

  try {
    const value = await (key === undefined ? retry() : coalesce(key, () => retry()));
    if (key !== undefined && isRememberable(remember, value)) rememberLastGood(key, value, Date.now());
    return value;
  } catch (err) {
    console.error(`[${name}] retry also failed: ${describeError(err)}`);
    const stale = key === undefined ? undefined : recallLastGood<T>(key);
    if (stale !== undefined) {
      console.warn(`[${name}] serving last-good`);
      return stale;
    }
    return fallback;
  }
}

/**
 * The throw-contract twin of `resolveCachedOrRetry`, for fetchers whose callers
 * must NOT degrade silently (the /ekonomi pages, whose error.tsx renders
 * instead of a cached empty page; the sitemap route, which maps a throw to a
 * 503 so a failed read is never served as an empty urlset). It is the
 * getBlindspots shape (attempt, one live retry, then let the failure
 * propagate) plus the prerender-safe `awaitRequestScope()`, so the uncached
 * retry may read the clock.
 *
 * A cache hit returns untouched (a legitimately empty value included). On a
 * miss it awaits the request scope, then runs `retry` once, uncached. The
 * retry's error propagates unchanged after one log line under `label` (parity
 * with `resolveCachedOrRetry`'s "retry also failed"); there is no `fallback`.
 * The one exception is a call with a `key` (`label` as `{ label, key }`, see
 * section 4 of the file header): when the retry fails and this instance holds a
 * last good value for the key that is under 60 min old, that value is returned
 * instead of the error. Crons and other callers that must not send stale data
 * pass no key.
 * The `awaitRequestScope` call sits outside the try, so Next control flow (a
 * prerender postpone, an `after()` misuse) is never logged as a data failure
 * and the retry is not run.
 *
 * `cached` is the `<name>Cached` function whose `"use cache"` body wraps the
 * raw read in `attemptCached` and chooses `cacheLife` AFTER the outcome;
 * `retry` is the raw, uncached read. Never call this from a `"use cache"` body
 * (tests/guards/cache-retry-prerender.test.ts).
 */
export async function resolveCachedOrThrow<T>(
  label: ResolveLabel<T>,
  cached: () => Promise<CacheAttempt<T>>,
  retry: () => Promise<T>,
): Promise<T> {
  const { name, key, remember } = splitLabel(label);
  const result = await cached();
  if (result.ok && key !== undefined && result.at !== undefined && isRememberable(remember, result.data)) {
    rememberLastGood(key, result.data, result.at);
  }
  if (result.ok) return result.data;

  await awaitRequestScope();

  try {
    const value = await (key === undefined ? retry() : coalesce(key, () => retry()));
    if (key !== undefined && isRememberable(remember, value)) rememberLastGood(key, value, Date.now());
    return value;
  } catch (err) {
    console.error(`[${name}] retry also failed: ${describeError(err)}`);
    const stale = key === undefined ? undefined : recallLastGood<T>(key);
    if (stale !== undefined) {
      console.warn(`[${name}] serving last-good`);
      return stale;
    }
    throw err;
  }
}
