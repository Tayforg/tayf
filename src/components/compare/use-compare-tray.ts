"use client";
import { useCallback, useSyncExternalStore } from "react";

import {
  COMPARE_TRAY_EVENT,
  COMPARE_TRAY_KEY,
  addToTray,
  parseTray,
  removeFromTray,
} from "@/lib/compare/compare-tray";

// The compare tray lives in sessionStorage: it should survive navigating
// between the two cluster pages, but not outlive the tab. Same
// useSyncExternalStore shape as use-bookmarks.ts.

const EMPTY_TRAY: readonly string[] = Object.freeze([]);

// Module-level cache so getSnapshot returns a stable reference while the
// underlying value is unchanged (useSyncExternalStore requires it, or React
// loops). The cache also keeps the tray working for the page's lifetime when
// storage itself is blocked (Safari private mode, disabled cookies).
let cachedSerialized: string | null = null;
let cachedTray: readonly string[] = EMPTY_TRAY;

function readTray(): readonly string[] {
  if (typeof window === "undefined") return cachedTray;
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(COMPARE_TRAY_KEY);
  } catch {
    return cachedTray;
  }
  if (raw === cachedSerialized) return cachedTray;
  cachedSerialized = raw;
  const parsed = parseTray(raw);
  cachedTray = parsed.length > 0 ? Object.freeze(parsed) : EMPTY_TRAY;
  return cachedTray;
}

function writeTray(next: readonly string[]): void {
  const serialized = JSON.stringify(next);
  cachedSerialized = serialized;
  cachedTray = next.length > 0 ? Object.freeze([...next]) : EMPTY_TRAY;
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(COMPARE_TRAY_KEY, serialized);
  } catch {
    // ignore storage failures; the in-memory cache above still holds the tray
  }
  // `storage` events never fire in the tab that wrote, so notify ourselves.
  window.dispatchEvent(new Event(COMPARE_TRAY_EVENT));
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(COMPARE_TRAY_EVENT, onChange);
  return () => window.removeEventListener(COMPARE_TRAY_EVENT, onChange);
}

function getServerSnapshot(): readonly string[] {
  return EMPTY_TRAY;
}

export function useCompareTray() {
  const tray = useSyncExternalStore(subscribe, readTray, getServerSnapshot);

  // Each action reads the live tray rather than closing over `tray`, so two
  // quick clicks can never act on a stale snapshot.
  const add = useCallback((id: string) => {
    writeTray(addToTray(readTray(), id));
  }, []);
  const remove = useCallback((id: string) => {
    writeTray(removeFromTray(readTray(), id));
  }, []);
  const clear = useCallback(() => {
    writeTray([]);
  }, []);

  return { tray, add, remove, clear };
}
