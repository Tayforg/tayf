// Production-only service worker registration. Pure and injectable: the React
// registrar (components/pwa/sw-registrar.tsx) passes the real browser objects,
// tests pass fakes. Never throws, never logs (the bookmark ids are personal data).
import { activeWorkerWithin, syncMessage } from "./offline-pins";
import { CACHE_PREFIX, SW_READY_TIMEOUT_MS, SW_SCOPE, SW_URL } from "./sw-contract";

export interface SwContainerLike {
  controller: { postMessage(m: unknown): void } | null;
  /** Only ever raced against a timeout (activeWorkerWithin): it never settles without a registration. */
  ready?: PromiseLike<{ active: { postMessage(m: unknown): void } | null }>;
  register(url: string, o: { scope: string; updateViaCache: "none" }): Promise<unknown>;
  getRegistrations(): Promise<ReadonlyArray<{ unregister(): Promise<boolean> }>>;
}

/** The slice of CacheStorage the kill switch needs. */
export interface CacheStorageLike {
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

export type RegisterOutcome = "skipped-env" | "unsupported" | "killed" | "registered" | "failed";

async function unregisterAll(container: SwContainerLike): Promise<boolean> {
  try {
    const registrations = await container.getRegistrations();
    const results = await Promise.allSettled(registrations.map((r) => r.unregister()));
    return !results.some((r) => r.status === "rejected");
  } catch {
    return false;
  }
}

/** Deletes every cache this site's worker owns (CACHE_PREFIX); foreign caches are never touched. */
async function purgeOwnCaches(cachesLike: CacheStorageLike | undefined): Promise<boolean> {
  if (!cachesLike) return true;
  try {
    const names = (await cachesLike.keys()).filter((name) => name.startsWith(CACHE_PREFIX));
    const results = await Promise.allSettled(names.map((name) => cachesLike.delete(name)));
    return !results.some((r) => r.status === "rejected");
  } catch {
    return false;
  }
}

export async function registerServiceWorker(d: {
  nodeEnv: string | undefined;
  container: SwContainerLike | undefined;
  kill: boolean;
  readIds: () => string[] | null;
  /** The page's CacheStorage. Only the kill switch uses it, to delete every "tayf-" cache. */
  cachesLike?: CacheStorageLike;
}): Promise<RegisterOutcome> {
  // Checked before `d.container` is read: dev/test must not touch the browser API.
  if (d.nodeEnv !== "production") return "skipped-env";
  try {
    const container = d.container;
    if (!container) return "unsupported";

    if (d.kill) {
      // Unregister first, then purge. The kill worker's own activate-time purge is not enough: it only runs when
      // the browser re-fetches /sw.js for a registration, and an unregistered registration is never updated, so
      // most clients would keep tayf-saved-v1 (no expiry) and the cached pages on disk. Each step is
      // independent: one failing does not skip the other, and both are retried on every page load.
      const unregistered = await unregisterAll(container);
      const purged = await purgeOwnCaches(d.cachesLike);
      return unregistered && purged ? "killed" : "failed";
    }

    // updateViaCache "none": the browser re-fetches /sw.js on every check, so a
    // kill-switch or version bump is never hidden behind the HTTP cache.
    await container.register(SW_URL, { scope: SW_SCOPE, updateViaCache: "none" });

    // The worker does not claim clients, so a first visit has no controller. Its registration's active worker
    // is the sync target instead, waited for at most SW_READY_TIMEOUT_MS: ready never settles without a
    // registration, so it is only ever raced against a timeout, inside activeWorkerWithin. Past the timeout the
    // next document (controlled) syncs. Read the ids only once the target is known, so a story bookmarked while
    // waiting is included.
    const target = container.controller ?? (await activeWorkerWithin(container, SW_READY_TIMEOUT_MS));
    if (target) {
      // null = ids unreadable: skip, because an empty sync would prune every pin.
      const ids = d.readIds();
      if (ids !== null) target.postMessage(syncMessage(ids));
    }
    return "registered";
  } catch {
    return "failed";
  }
}
