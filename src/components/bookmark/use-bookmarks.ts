"use client";
import { useCallback, useSyncExternalStore } from "react";

import { captureSnapshot, removeSnapshot } from "@/components/bookmark/bookmark-snapshots";

const KEY = "tayf:bookmarks";

const EMPTY_SET: ReadonlySet<string> = new Set();

// Module-level cache so getSnapshot returns a stable reference between
// reads when the underlying value hasn't changed (required by
// useSyncExternalStore to avoid infinite loops).
let cachedSerialized: string | null = null;
let cachedSet: Set<string> = new Set();

function readSet(): Set<string> {
  if (typeof window === "undefined") return cachedSet;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return cachedSet;
  }
  if (raw === cachedSerialized) return cachedSet;
  cachedSerialized = raw;
  try {
    cachedSet = raw ? new Set<string>(JSON.parse(raw)) : new Set<string>();
  } catch {
    cachedSet = new Set<string>();
  }
  return cachedSet;
}

function writeSet(next: Set<string>) {
  const serialized = JSON.stringify(Array.from(next));
  cachedSerialized = serialized;
  cachedSet = next;
  try {
    localStorage.setItem(KEY, serialized);
  } catch {
    // ignore storage failures
  }
  // Notify all subscribers in this tab — `storage` events only fire
  // for *other* tabs, so we dispatch a synthetic event for ourselves.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("tayf:bookmarks-change"));
  }
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

export function useBookmarks() {
  const ids = useSyncExternalStore(subscribe, readSet, getServerSnapshot);

  const toggle = useCallback(
    (id: string) => {
      const next = new Set(ids);
      if (next.has(id)) {
        next.delete(id);
        writeSet(next);
        removeSnapshot(id);
      } else {
        next.add(id);
        writeSet(next);
        void captureSnapshot(id);
      }
    },
    [ids],
  );

  const has = useCallback((id: string) => ids.has(id), [ids]);

  return { ids, has, toggle, count: ids.size };
}
