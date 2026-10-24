// Edge-safe existence gate for /source/<slug>, used by src/middleware.ts.
//
// Deliberately imports nothing: no next/cache, no supabase-js, no
// server-only, and not @/lib/validation/source-input (which pulls the bias
// config into the edge bundle). SOURCE_SLUG_RE mirrors that module's
// SLUG_RE and is pinned to it by source-slug-gate.test.ts, and to the SQL
// regex in migration 116 by tests/migrations/116-anon-public-rpcs.test.ts.
//
// Uses only the public anon key, and anon reaches data only through the two
// bounded SECURITY DEFINER RPCs of migration 116 (GET, both STABLE):
// source_slugs() for the full set and source_slug_exists(p_slug) for a
// targeted probe that answers a bare JSON boolean. The sources table itself
// is not anon-readable after migration 117. Every failure (including a probe
// body that is not a boolean) resolves to "unknown" so the middleware fails
// open to the page's own soft 404.
//
// Brownout backoff, mirroring merged-cluster-gate.ts (FAILURE_BACKOFF_MS):
// the gate is module-level in the middleware, so without a cool-down every
// /source/<slug> request during a Supabase outage re-hits the failing RPC and
// waits out the timeout. A failed full-set load (throw, non-OK, non-array
// body) arms `retryAt` for failureBackoffMs (default 30 s). Inside that window
// no request leaves the gate: the set check answers from the stale set when it
// is still within staleMaxMs, and an absent slug resolves "unknown" instead of
// probing, because the probe targets the same backend. A successful load clears
// it. A failed probe alone does not arm it: one bad slug lookup says nothing
// about the set endpoint.

export const SOURCE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type SlugVerdict = "exists" | "missing" | "unknown";

interface GateOptions {
  getEnv?: () => { url?: string; anonKey?: string };
  fetchImpl?: typeof fetch;
  now?: () => number;
  setTtlMs?: number;
  /** Within this window after a full-set load, an absent slug is missing with no per-slug probe. */
  freshMs?: number;
  staleMaxMs?: number;
  negativeTtlMs?: number;
  maxNegatives?: number;
  timeoutMs?: number;
  /** After a failed set load, no request is made for this long (default 30 s, as merged-cluster-gate). */
  failureBackoffMs?: number;
}

function defaultEnv(): { url?: string; anonKey?: string } {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  };
}

export function createSourceSlugGate(o: GateOptions = {}): {
  check(slug: string): Promise<SlugVerdict>;
} {
  const getEnv = o.getEnv ?? defaultEnv;
  const now = o.now ?? Date.now;
  const setTtlMs = o.setTtlMs ?? 300_000;
  const freshMs = o.freshMs ?? 60_000;
  const staleMaxMs = o.staleMaxMs ?? 3_600_000;
  const negativeTtlMs = o.negativeTtlMs ?? 60_000;
  const maxNegatives = o.maxNegatives ?? 500;
  const timeoutMs = o.timeoutMs ?? 1_500;
  const failureBackoffMs = o.failureBackoffMs ?? 30_000;

  let known: Set<string> | null = null;
  let loadedAt = 0;
  let inflight: Promise<boolean> | null = null;
  // After a failed set load, wait before touching the backend again so an
  // outage cannot turn every request into an outbound call.
  let retryAt = 0;
  // Map preserves insertion order, so the first key is the oldest.
  const negatives = new Map<string, number>();

  async function getJson(fetchFn: typeof fetch, anonKey: string, requestUrl: string): Promise<unknown> {
    const res = await fetchFn(requestUrl, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`source gate ${res.status}`);
    return res.json();
  }

  /** True when the set is loaded and not older than staleMaxMs. */
  function staleVerdict(): boolean {
    return known !== null && now() - loadedAt < staleMaxMs;
  }

  /** Resolves true when a usable set (fresh or acceptably stale) exists. */
  function ensureSet(fetchFn: typeof fetch, url: string, anonKey: string): Promise<boolean> {
    if (known && now() - loadedAt < setTtlMs) return Promise.resolve(true);
    // Cool-down after a failed load: answer from the stale set, make no request.
    if (now() < retryAt) return Promise.resolve(staleVerdict());
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const body = await getJson(fetchFn, anonKey, `${url}/rest/v1/rpc/source_slugs`);
        if (!Array.isArray(body)) throw new Error("source_slugs: bad body");
        known = new Set((body as { slug: string }[]).map((r) => r.slug));
        loadedAt = now();
        retryAt = 0;
        return true;
      } catch {
        retryAt = now() + failureBackoffMs;
        return staleVerdict();
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  async function check(slug: string): Promise<SlugVerdict> {
    if (!SOURCE_SLUG_RE.test(slug)) return "missing";
    const { url, anonKey } = getEnv();
    if (!url || !anonKey) return "unknown";
    const fetchFn = o.fetchImpl ?? fetch;

    if (!(await ensureSet(fetchFn, url, anonKey))) return "unknown";
    if (known!.has(slug)) return "exists";

    // Flood guard: a just-loaded full set is authoritative, so unique junk
    // slugs cost no outbound request and cannot churn the negative cache.
    if (now() - loadedAt < freshMs) return "missing";

    const negAt = negatives.get(slug);
    if (negAt !== undefined) {
      if (now() - negAt < negativeTtlMs) return "missing";
      negatives.delete(slug);
    }

    // The set endpoint just failed: the probe hits the same backend, so skip it
    // (fail open) until the cool-down ends.
    if (now() < retryAt) return "unknown";

    try {
      const exists = await getJson(
        fetchFn,
        anonKey,
        `${url}/rest/v1/rpc/source_slug_exists?p_slug=${encodeURIComponent(slug)}`,
      );
      // The RPC answers a bare JSON boolean; anything else is not an answer.
      if (typeof exists !== "boolean") throw new Error("source_slug_exists: bad body");
      if (exists) {
        known!.add(slug);
        return "exists";
      }
      negatives.set(slug, now());
      while (negatives.size > maxNegatives) {
        const oldest = negatives.keys().next().value as string;
        negatives.delete(oldest);
      }
      return "missing";
    } catch {
      return "unknown";
    }
  }

  return { check };
}
