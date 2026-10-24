// Page-side half of "save for offline": tells the service worker which
// bookmarked stories to keep, and removes the offline copy again on unbookmark.
// Client-safe and total: every function swallows browser errors (Firefox throws
// SecurityError on blocked storage, Safari private mode on localStorage) because
// offline pinning is a progressive enhancement and must never break bookmarking.
import {
  CACHE_NAMES,
  CLUSTER_ID_RE,
  SW_READY_TIMEOUT_MS,
  SYNC_MAX_IDS,
  clusterPath,
  type SwMessage,
} from "./sw-contract";

// Same literal as src/components/bookmark/use-bookmarks.ts (pinned by a test).
const BOOKMARKS_KEY = "tayf:bookmarks";

export interface StorageLike {
  getItem(key: string): string | null;
}

interface ControllerLike {
  postMessage(message: unknown): void;
}

/** The slice of `navigator.serviceWorker` that can yield the registration's active worker. */
interface ReadyContainerLike {
  ready?: PromiseLike<{ active: ControllerLike | null }>;
}

export interface NavigatorLike {
  serviceWorker?: { controller: ControllerLike | null } & ReadyContainerLike;
}

export interface SavedCacheStorageLike {
  has(name: string): Promise<boolean>;
  open(name: string): Promise<{ delete(request: string): Promise<boolean> }>;
}

function globalNavigator(): NavigatorLike | undefined {
  try {
    return typeof navigator === "undefined" ? undefined : navigator;
  } catch {
    return undefined;
  }
}

function globalCaches(): SavedCacheStorageLike | undefined {
  try {
    return typeof caches === "undefined" ? undefined : caches;
  } catch {
    return undefined;
  }
}

function controllerOf(nav: NavigatorLike | undefined): ControllerLike | null {
  try {
    return nav?.serviceWorker?.controller ?? null;
  } catch {
    return null;
  }
}

/**
 * The bookmarked cluster ids, newest last, capped at the worker's sync limit.
 * `[]` means "no bookmarks" (key absent). `null` means "could not read them":
 * the caller must NOT sync, because an empty sync prunes every pinned story.
 */
export function readBookmarkIds(storage?: StorageLike | null): string[] | null {
  try {
    const store = storage === undefined ? globalThis.localStorage : storage;
    if (!store) return null;
    const raw = store.getItem(BOOKMARKS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const valid = parsed.filter(
      (value): value is string => typeof value === "string" && CLUSTER_ID_RE.test(value),
    );
    return valid.slice(-SYNC_MAX_IDS);
  } catch {
    return null;
  }
}

export function syncMessage(ids: string[]): SwMessage {
  return { type: "tayf:sync", ids: [...ids] };
}

/**
 * The registration's active worker, or null. For an uncontrolled page (first visit): the worker no longer claims
 * clients, so `controller` stays null until the next navigation, but the registration's active worker can still be
 * messaged. `ready` never settles when there is no registration, so it is only ever raced against a timeout; any
 * failure (rejection, a getter that throws, no active worker, timeout) resolves null and never rejects.
 */
export async function activeWorkerWithin(
  container: ReadyContainerLike | undefined,
  ms: number,
): Promise<ControllerLike | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Read inside the try: the getter itself can throw (SecurityError on blocked storage).
    const ready = container?.ready;
    if (!ready) return null;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    });
    return await Promise.race([ready.then((r) => r?.active ?? null), timeout]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Fire-and-forget: posts `message` to the active worker once there is one. Never rejects. */
async function postWhenActive(nav: NavigatorLike | undefined, message: SwMessage): Promise<void> {
  try {
    const active = await activeWorkerWithin(nav?.serviceWorker, SW_READY_TIMEOUT_MS);
    active?.postMessage(message);
  } catch {
    // Best effort: the next document's sync pins everything that is bookmarked.
  }
}

/**
 * Asks the controlling worker to download and keep this story. Returns true
 * only when the message was posted to the controller right now. On a first,
 * uncontrolled visit (the worker does not claim clients) it instead posts to the
 * registration's active worker as soon as there is one, fire-and-forget, and
 * returns false. If the worker only activates later than SW_READY_TIMEOUT_MS,
 * or there is no worker at all (dev, browser without service workers), it is a
 * no-op: the next document's sync pins everything that is bookmarked. An
 * invalid id is a no-op returning false.
 */
export function pinForOffline(id: string, nav?: NavigatorLike): boolean {
  if (clusterPath(id) === null) return false;
  const target = nav ?? globalNavigator();
  const controller = controllerOf(target);
  if (!controller) {
    void postWhenActive(target, { type: "tayf:pin", id } satisfies SwMessage);
    return false;
  }
  try {
    controller.postMessage({ type: "tayf:pin", id } satisfies SwMessage);
    return true;
  } catch {
    return false;
  }
}

async function deleteSavedCopy(
  path: string,
  cacheStorage: SavedCacheStorageLike | undefined,
): Promise<void> {
  if (!cacheStorage) return;
  try {
    // `has` first: opening would create an empty cache as a side effect.
    if (!(await cacheStorage.has(CACHE_NAMES.saved))) return;
    const cache = await cacheStorage.open(CACHE_NAMES.saved);
    await cache.delete(path);
  } catch {
    // Best effort: the next sync prunes anything that is no longer bookmarked.
  }
}

/**
 * Removes the offline copy of an unbookmarked story. Returns true when the
 * request went to the controlling worker. Without a controller (a first visit,
 * or the worker cannot be reached) the page asks the registration's active
 * worker as soon as there is one (waiting at most SW_READY_TIMEOUT_MS) AND
 * deletes the entry from the saved cache itself, both fire-and-forget, so
 * unbookmarking removes the copy even when the worker does not control this
 * page; that path returns false. If the worker activates later than the
 * timeout, the next document's sync prunes the story.
 */
export function unpinForOffline(
  id: string,
  nav?: NavigatorLike,
  cacheStorage?: SavedCacheStorageLike,
): boolean {
  const path = clusterPath(id);
  if (path === null) return false;
  const target = nav ?? globalNavigator();
  const controller = controllerOf(target);
  if (controller) {
    try {
      controller.postMessage({ type: "tayf:unpin", id } satisfies SwMessage);
      return true;
    } catch {
      // fall through to the direct cache delete
    }
  } else {
    void postWhenActive(target, { type: "tayf:unpin", id } satisfies SwMessage);
  }
  void deleteSavedCopy(path, cacheStorage ?? globalCaches());
  return false;
}
