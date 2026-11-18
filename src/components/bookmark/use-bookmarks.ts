"use client";
import { useCallback, useSyncExternalStore } from "react";

import {
  mergeBookmarkIds,
  normaliseBookmarkId,
  normaliseBookmarkIds,
  removeBookmarkId,
  toggleBookmarkId,
  type BookmarkMerge,
  type BookmarkToggle,
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
// True from the first write localStorage refused (quota, private mode) until storage takes a
// write again or another tab changes the stored list. cachedSet is then ahead of storage and
// stays the list for this session, so a refused save is not undone by the next read.
let memoryOnly = false;
// What storage held when it was last read (undefined: never read). While memoryOnly, storage
// still answering with this value is stale, not news: the in-memory list stays.
let storedRaw: string | null | undefined;

function readSet(): Set<string> {
  if (typeof window === "undefined") return cachedSet;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return cachedSet;
  }
  // A refused write left cachedSet ahead of storage; storage has not moved since, so keep it.
  if (memoryOnly && raw === storedRaw) return cachedSet;
  // Storage answered with something new (a `storage` event from another tab), so whatever is
  // returned below mirrors it again.
  memoryOnly = false;
  storedRaw = raw;
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

/**
 * False when localStorage refused the write. The new list is still kept in memory for the
 * session (memoryOnly); toggle, remove and importBookmarkIds report the refusal.
 */
function writeSet(next: Set<string>): boolean {
  const serialized = JSON.stringify(Array.from(next));
  cachedSerialized = serialized;
  cachedSet = next;
  let stored = true;
  try {
    localStorage.setItem(KEY, serialized);
    storedRaw = serialized;
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

/** What a toggle or a remove did: the canonical key, which way it went, and whether it reached localStorage. */
export interface BookmarkChange {
  key: string;
  added: boolean;
  /** False when localStorage refused the write: the change holds for this session only (memory-only). */
  stored: boolean;
}

/**
 * Applies a change that is already in the cache's terms. The add side effects need the saved
 * list in localStorage (captureSnapshot reads it back to confirm the story is still saved, and
 * the service worker prunes what the stored list does not name), so a change storage refused
 * makes neither the saved_clusters request nor the page download.
 */
function commit(change: BookmarkToggle): BookmarkChange {
  const stored = writeSet(change.next);
  // After writeSet, so captureSnapshot's isStillSaved sees the lower-case key.
  if (change.added) {
    if (stored) {
      void captureSnapshot(change.key);
      pinForOffline(change.key);
    }
  } else {
    // Cleanup that took effect in this session, whether or not storage took the write (and it
    // frees space when storage is full).
    removeSnapshot(change.key);
    unpinForOffline(change.key);
  }
  return { key: change.key, added: change.added, stored };
}

/**
 * The store without React, exported so it can be unit-tested directly. Both mutations read
 * storage fresh (readSet) instead of closing over a render snapshot, so two taps before a
 * re-render, or a list another tab changed a moment ago, never lose or invent a write.
 */
export const bookmarksStore = {
  read: readSet,
  subscribe,
  getServerSnapshot,

  /** Adds an absent id, removes a present one; null for an empty id. */
  toggle(id: string): BookmarkChange | null {
    const change = toggleBookmarkId(readSet(), id);
    return change === null ? null : commit(change);
  },

  /**
   * Removes `id` and only that: null, with no write, no notification and no side effect, for
   * an empty id and for an id that is not saved (already removed here or in another tab), so
   * a repeated or stale removal can never add the story back or touch another one.
   */
  remove(id: string): BookmarkChange | null {
    const change = removeBookmarkId(readSet(), id);
    return change === null ? null : commit(change);
  },
};

export function useBookmarks() {
  const ids = useSyncExternalStore(subscribe, readSet, getServerSnapshot);

  const toggle = useCallback((id: string) => bookmarksStore.toggle(id), []);
  const remove = useCallback((id: string) => bookmarksStore.remove(id), []);

  const has = useCallback(
    (id: string) => {
      const key = normaliseBookmarkId(id);
      return key !== null && ids.has(key);
    },
    [ids],
  );

  return { ids, has, toggle, remove, count: ids.size };
}
