"use client";
import { useCallback, useSyncExternalStore } from "react";

import {
  addFollow,
  canonicalFollow,
  FOLLOWS_CHANGE_EVENT,
  FOLLOWS_KEY,
  followKey,
  hasFollow,
  markSeen as markSeenIn,
  MAX_FOLLOWS,
  mergeFollows,
  parseStoredFollows,
  removeFollow,
  serializeFollows,
  type AddFollowResult,
  type Follow,
  type FollowKind,
  type FollowMerge,
  type SeenRows,
} from "@/lib/follows/follows";

// Same structure as ../bookmark/use-bookmarks.ts: a localStorage-backed
// external store read through useSyncExternalStore. Three deliberate
// differences from the bookmark hook:
//   - mutations re-read storage (readList) instead of closing over the render
//     snapshot, so two clicks before a re-render never lose a write;
//   - getSnapshot (readList) NEVER writes -- it only parses;
//   - a failing setItem (Safari private mode, quota) keeps the list alive in
//     memory for the session instead of snapping back to empty on the next read.

export type ToggleResult = AddFollowResult | "removed";

const EMPTY: readonly Follow[] = Object.freeze([]);

// Module-level cache so readList returns a stable reference while the
// underlying string is unchanged (useSyncExternalStore requires that, or it
// loops).
let cachedSerialized: string | null = null;
let cachedList: readonly Follow[] = EMPTY;
let storageBroken = false;

function readList(): readonly Follow[] {
  if (typeof window === "undefined") return cachedList;
  if (storageBroken) return cachedList;
  let raw: string | null;
  try {
    raw = localStorage.getItem(FOLLOWS_KEY);
  } catch {
    return cachedList;
  }
  if (raw === cachedSerialized) return cachedList;
  cachedSerialized = raw;
  const parsed = parseStoredFollows(raw);
  cachedList = parsed.length === 0 ? EMPTY : Object.freeze(parsed);
  return cachedList;
}

/** True when nothing changed or the list was written; false when localStorage refused it (the list lives on in memory). */
function commit(next: readonly Follow[]): boolean {
  const serialized = serializeFollows(next);
  // Nothing changed (e.g. removing an unknown key): no write, no notification.
  if (serialized === cachedSerialized) return true;
  cachedSerialized = serialized;
  cachedList = next.length === 0 ? EMPTY : Object.freeze([...next]);
  try {
    localStorage.setItem(FOLLOWS_KEY, serialized);
    storageBroken = false;
  } catch {
    storageBroken = true;
  }
  // `storage` events only fire in OTHER tabs; notify this one ourselves.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(FOLLOWS_CHANGE_EVENT));
  }
  return !storageBroken;
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handleStorage = (e: StorageEvent) => {
    // key === null is localStorage.clear() in another tab.
    if (e.key === FOLLOWS_KEY || e.key === null) onChange();
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener(FOLLOWS_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(FOLLOWS_CHANGE_EVENT, onChange);
  };
}

function getServerSnapshot(): readonly Follow[] {
  return EMPTY;
}

/** The store without React, exported so it can be unit-tested directly. */
export const followsStore = {
  read: readList,
  subscribe,
  getServerSnapshot,

  toggle(kind: FollowKind, value: string): ToggleResult {
    // Canonical, so a keyword that is a hub's label ("deva") finds, adds and
    // removes the hub follow -- the same identity parseStoredFollows gives it.
    const canonical = canonicalFollow(kind, value);
    if (canonical === null) return "invalid";
    const current = readList();
    const key = followKey(canonical);
    if (current.some((f) => followKey(f) === key)) {
      commit(removeFollow(current, key));
      return "removed";
    }
    const { list, result } = addFollow(current, canonical, new Date().toISOString());
    if (result === "added") commit(list);
    return result;
  },

  remove(key: string): void {
    commit(removeFollow(readList(), key));
  },

  /**
   * Records a /takip visit for the given follows (key -> the rows rendered for
   * it): seenAt = nowIso plus those rows' ids and oldest firstPublished.
   */
  markSeen(
    shown: ReadonlyMap<string, SeenRows>,
    nowIso: string = new Date().toISOString(),
  ): void {
    if (shown.size === 0) return;
    commit(markSeenIn(readList(), shown, nowIso));
  },

  /**
   * Merges follows from a transfer code (mergeFollows): adds what is missing,
   * removes nothing, stays within MAX_FOLLOWS. Reads storage fresh. Nothing is
   * written when nothing is added. `stored` is false when a write is refused, or
   * when nothing was added while the store is memory-only (storageBroken): the
   * "existing" follows then live only in memory, so a retry must not claim they
   * are saved. An empty `incoming` (a bookmarks-only code) is always stored.
   */
  importMany(
    incoming: ReadonlyArray<{ kind: FollowKind; value: string }>,
    nowIso: string = new Date().toISOString(),
  ): FollowMerge & { stored: boolean } {
    const merge = mergeFollows(readList(), incoming, nowIso);
    if (merge.added === 0) return { ...merge, stored: incoming.length === 0 || !storageBroken };
    return { ...merge, stored: commit(merge.list) };
  },
};

export function useFollows() {
  const follows = useSyncExternalStore(subscribe, readList, getServerSnapshot);

  const has = useCallback(
    (kind: FollowKind, value: string) => hasFollow(follows, kind, value),
    [follows],
  );
  const toggle = useCallback(
    (kind: FollowKind, value: string) => followsStore.toggle(kind, value),
    [],
  );
  const remove = useCallback((key: string) => followsStore.remove(key), []);
  const markSeen = useCallback(
    (shown: ReadonlyMap<string, SeenRows>, nowIso?: string) =>
      followsStore.markSeen(shown, nowIso),
    [],
  );

  return {
    follows,
    has,
    toggle,
    remove,
    markSeen,
    count: follows.length,
    isFull: follows.length >= MAX_FOLLOWS,
  };
}
