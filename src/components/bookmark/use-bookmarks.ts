"use client";
import { useCallback, useSyncExternalStore } from "react";

import {
  mergeBookmarkIds,
  normaliseBookmarkId,
  normaliseBookmarkIds,
  toggleBookmarkId,
  type BookmarkMerge,
} from "@/components/bookmark/bookmark-ids";
import { captureSnapshot, removeSnapshot } from "@/components/bookmark/bookmark-snapshots";
import { pinForOffline, unpinForOffline } from "@/lib/pwa/offline-pins";

const KEY = "tayf:bookmarks";

const EMPTY_SET: ReadonlySet<string> = new Set();

// Module-level cache so getSnapshot returns a stable reference between
// reads when the underlying value hasn't changed (required by
// useSyncExternalStore to avoid infinite loops).
let cachedSerialized: string | null = null;
let cachedSet: Set<string> = new Set();
// true while cachedSet holds ids localStorage refused
let memoryOnly = false;

function readSet(): Set<string> {
  if (typeof window === "undefined") return cachedSet;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return cachedSet;
  }
  // Storage answered, so whatever is returned below mirrors it.
  memoryOnly = false;
  if (raw === cachedSerialized) return cachedSet;
  cachedSerialized = raw;
  try {
    // Folded to lower case and de-duplicated (h32-livebk-1): an entry saved from
    // an upper-case /cluster/<ID> URL becomes the same key /saved removes by.
    cachedSet = raw ? new Set<string>(normaliseBookmarkIds(JSON.parse(raw))) : new Set<string>();
  } catch {
    cachedSet = new Set<string>();
  }
  return cachedSet;
}

/** False when localStorage refused the write; toggle ignores it, importBookmarkIds reports it. */
function writeSet(next: Set<string>): boolean {
  const serialized = JSON.stringify(Array.from(next));
  cachedSerialized = serialized;
  cachedSet = next;
  let stored = true;
  try {
    localStorage.setItem(KEY, serialized);
  } catch {
    // refused (private mode, quota): reported through the return value
    stored = false;
  }
  memoryOnly = !stored;
  // Notify all subscribers in this tab — `storage` events only fire
  // for *other* tabs, so we dispatch a synthetic event for ourselves.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("tayf:bookmarks-change"));
  }
  return stored;
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handleStorage = (e: StorageEvent) => {
    if (e.key === KEY) onChange();
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener("tayf:bookmarks-change", onChange);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener("tayf:bookmarks-change", onChange);
  };
}

function getServerSnapshot(): ReadonlySet<string> {
  return EMPTY_SET;
}

/**
 * Merges ids from a transfer code into the saved list: adds what is missing,
 * removes nothing, stays within `max` (see mergeBookmarkIds). Reads storage fresh,
 * not a render snapshot.
 *
 * Deliberately NOT toggle: toggle calls captureSnapshot (a saved_clusters RPC) and
 * pinForOffline (asks the service worker to download the page), and both make
 * requests, and an import makes none. SwRegistrar pins the imported ids on the
 * next page load by itself.
 *
 * `stored` is false when a write is refused, or when nothing was added while the
 * list is memory-only (memoryOnly): ids that exist only in memory are not saved,
 * so a retry must not say they are. An empty `incoming` (a follows-only code) is
 * always stored.
 */
export function importBookmarkIds(
  incoming: readonly string[],
  max: number,
): BookmarkMerge & { stored: boolean } {
  const merge = mergeBookmarkIds(Array.from(readSet()), incoming, max);
  if (merge.added === 0) return { ...merge, stored: incoming.length === 0 || !memoryOnly };
  return { ...merge, stored: writeSet(new Set(merge.next)) };
}

export function useBookmarks() {
  const ids = useSyncExternalStore(subscribe, readSet, getServerSnapshot);

  const toggle = useCallback(
    (id: string) => {
      const r = toggleBookmarkId(ids, id);
      if (r === null) return;
      writeSet(r.next);
      // After writeSet, so captureSnapshot's isStillSaved sees the lower-case key.
      if (r.added) {
        void captureSnapshot(r.key);
        pinForOffline(r.key);
      } else {
        removeSnapshot(r.key);
        unpinForOffline(r.key);
      }
    },
    [ids],
  );

  const has = useCallback(
    (id: string) => {
      const key = normaliseBookmarkId(id);
      return key !== null && ids.has(key);
    },
    [ids],
  );

  return { ids, has, toggle, count: ids.size };
}
