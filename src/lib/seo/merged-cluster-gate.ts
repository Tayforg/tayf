// Edge-safe merged-cluster lookup for /cluster/<id>, used by src/middleware.ts.
//
// Deliberately imports nothing (no next/cache, no supabase-js): it runs in the
// Edge bundle. Modeled on source-slug-gate.ts, with one difference: lookup()
// is SYNCHRONOUS and never waits on the network. The middleware kicks off
// refreshIfStale() in the background (event.waitUntil), so a request adds zero
// latency; a cold isolate simply does not redirect and the page's own
// permanentRedirect() is the fallback.
//
// The map holds merged ids only (clusters.merged_into is not null, migration
// 099), newest 1000 by updated_at (PostgREST max-rows). Older merges rely on
// the page fallback. Anon key only: clusters is anon-readable (017,
// using (true)). Every failure keeps the previous map (fail open).

export interface MergedClusterGate {
  lookup(id: string): string | null;
  refreshIfStale(): Promise<void>;
}

interface GateOptions {
  getEnv?: () => { url?: string; anonKey?: string };
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FAILURE_BACKOFF_MS = 30_000;

function defaultEnv(): { url?: string; anonKey?: string } {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  };
}

export function createMergedClusterGate(o: GateOptions = {}): MergedClusterGate {
  const getEnv = o.getEnv ?? defaultEnv;
  const now = o.now ?? Date.now;
  const ttlMs = o.ttlMs ?? 300_000;
  const timeoutMs = o.timeoutMs ?? 1_500;

  let map: Map<string, string> = new Map();
  let loadedAt: number | null = null;
  // After a failed load, wait before retrying so an outage cannot turn every
  // request into an outbound probe.
  let retryAt = 0;
  let inflight: Promise<void> | null = null;

  function lookup(id: string): string | null {
    if (typeof id !== "string") return null;
    return map.get(id.toLowerCase()) ?? null;
  }

  async function load(url: string, anonKey: string, fetchFn: typeof fetch): Promise<void> {
    try {
      const res = await fetchFn(
        `${url}/rest/v1/clusters?select=id,merged_into&merged_into=not.is.null&order=updated_at.desc&limit=1000`,
        {
          headers: {
            apikey: anonKey,
            Authorization: `Bearer ${anonKey}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (!res.ok) {
        retryAt = now() + FAILURE_BACKOFF_MS;
        return;
      }
      const body: unknown = await res.json();
      if (!Array.isArray(body)) {
        retryAt = now() + FAILURE_BACKOFF_MS;
        return;
      }
      const next = new Map<string, string>();
      for (const row of body) {
        if (!row || typeof row !== "object") continue;
        const { id, merged_into } = row as { id?: unknown; merged_into?: unknown };
        if (typeof id !== "string" || typeof merged_into !== "string") continue;
        if (!UUID_RE.test(id) || !UUID_RE.test(merged_into)) continue;
        const k = id.toLowerCase();
        const v = merged_into.toLowerCase();
        if (k === v) continue;
        next.set(k, v);
      }
      map = next;
      loadedAt = now();
    } catch {
      // Keep the old map.
      retryAt = now() + FAILURE_BACKOFF_MS;
    }
  }

  function refreshIfStale(): Promise<void> {
    const { url, anonKey } = getEnv();
    if (!url || !anonKey) return Promise.resolve();
    if (loadedAt !== null && now() - loadedAt < ttlMs) return Promise.resolve();
    if (now() < retryAt) return Promise.resolve();
    if (inflight) return inflight;
    const fetchFn = o.fetchImpl ?? fetch;
    inflight = load(url, anonKey, fetchFn).finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return { lookup, refreshIfStale };
}
