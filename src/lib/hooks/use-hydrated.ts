"use client";
import { useSyncExternalStore } from "react";

// Module-level, so the references are stable: a new subscribe function on every
// render would make React resubscribe each time.
const subscribeNever = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

/**
 * false while server-rendering and during hydration, true afterwards.
 *
 * Lets a page whose real content lives in localStorage (/takip follows, /saved
 * bookmarks) paint a neutral placeholder first, instead of flashing its empty
 * state at every reader who does have data: the server snapshot of those stores
 * is always empty. No effect and no extra state, and the server markup and the
 * hydration pass agree (both read the server snapshot), so there is no
 * hydration mismatch; the client snapshot is read in the commit right after.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribeNever, getClientSnapshot, getServerSnapshot);
}
