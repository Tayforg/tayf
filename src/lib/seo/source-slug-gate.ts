// Edge-safe existence gate for /source/<slug>, used by src/middleware.ts.
//
// Deliberately imports nothing: no next/cache, no supabase-js, no
// server-only, and not @/lib/validation/source-input (which pulls the bias
// config into the edge bundle). SOURCE_SLUG_RE mirrors that module's
// SLUG_RE and is pinned to it by source-slug-gate.test.ts.
//
// Uses only the public anon key against PostgREST (sources rows are
// anon-readable, migration 017). Every failure resolves to "unknown" so the
// middleware fails open to the page's own soft 404.

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

  let known: Set<string> | null = null;
  let loadedAt = 0;
  let inflight: Promise<boolean> | null = null;
  // Map preserves insertion order, so the first key is the oldest.
  const negatives = new Map<string, number>();

  async function get(
    fetchFn: typeof fetch,
    url: string,
    anonKey: string,
    path: string,
  ): Promise<{ slug: string }[]> {
    const res = await fetchFn(`${url}/rest/v1/sources?${path}`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`sources ${res.status}`);
    const body: unknown = await res.json();
    if (!Array.isArray(body)) throw new Error("sources: bad body");
    return body as { slug: string }[];
  }

  /** Resolves true when a usable set (fresh or acceptably stale) exists. */
  function ensureSet(fetchFn: typeof fetch, url: string, anonKey: string): Promise<boolean> {
    if (known && now() - loadedAt < setTtlMs) return Promise.resolve(true);
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const rows = await get(fetchFn, url, anonKey, "select=slug");
        known = new Set(rows.map((r) => r.slug));
        loadedAt = now();
        return true;
      } catch {
        return known !== null && now() - loadedAt < staleMaxMs;
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

    try {
      const rows = await get(
        fetchFn,
        url,
        anonKey,
        `select=slug&slug=eq.${encodeURIComponent(slug)}&limit=1`,
      );
      if (rows.length > 0) {
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
