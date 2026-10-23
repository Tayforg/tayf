// Page-side half of "save for offline": tells the service worker which
// bookmarked stories to keep, and removes the offline copy again on unbookmark.
// Client-safe and total: every function swallows browser errors (Firefox throws
// SecurityError on blocked storage, Safari private mode on localStorage) because
// offline pinning is a progressive enhancement and must never break bookmarking.
import {
  CACHE_NAMES,
  CLUSTER_ID_RE,
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

export interface NavigatorLike {
  serviceWorker?: { controller: ControllerLike | null };
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
 * Asks the controlling worker to download and keep this story. Returns true
 * when the message was posted. With no controller (dev, first visit, browser
 * without service workers) or an invalid id it is a no-op returning false; the
 * next page load's sync pins everything that is bookmarked.
 */
export function pinForOffline(id: string, nav?: NavigatorLike): boolean {
  if (clusterPath(id) === null) return false;
  const controller = controllerOf(nav ?? globalNavigator());
  if (!controller) return false;
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
 * request went to the controlling worker. Without a controller (or when it
 * cannot be reached) the page deletes the entry from the saved cache itself,
 * fire-and-forget, so unbookmarking removes the copy even when the worker is
 * not controlling this page; that path returns false.
 */
export function unpinForOffline(
  id: string,
  nav?: NavigatorLike,
  cacheStorage?: SavedCacheStorageLike,
): boolean {
  const path = clusterPath(id);
  if (path === null) return false;
  const controller = controllerOf(nav ?? globalNavigator());
  if (controller) {
    try {
      controller.postMessage({ type: "tayf:unpin", id } satisfies SwMessage);
      return true;
    } catch {
      // fall through to the direct cache delete
    }
  }
  void deleteSavedCopy(path, cacheStorage ?? globalCaches());
  return false;
}
