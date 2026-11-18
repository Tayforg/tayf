"use client";
import { useMemo, useSyncExternalStore } from "react";

import { summarizeDiet } from "@/lib/diet/diet";
import {
  getServerDietSnapshot,
  readDietSnapshot,
  subscribeDiet,
} from "@/lib/diet/diet-store";

/**
 * Reads the device-local reading diet via useSyncExternalStore.
 *
 * `hydrated` is true once the client snapshot has actually been read
 * (`readAt > 0`) — the server snapshot's `readAt` is always 0 — OR once we
 * know storage is unavailable (there's nothing left to wait for in that
 * case). Callers use this to render a skeleton instead of flashing the
 * "no data" empty state during hydration.
 *
 * The 7- and 30-day windows are measured from `snap.readAt`, which the store
 * keeps within DIET_SNAPSHOT_MAX_AGE_MS of the clock (h201-diet-1): every render
 * reads the snapshot afresh, and subscribeDiet nudges this hook when the tab is
 * shown again or ticks, so a long-lived tab or a preserved route never keeps
 * counting clicks that have left the window. `summarizeDiet` stays pure; the
 * `now` it gets is the snapshot's anchor, and a new anchor is a new snapshot
 * object, which is what re-runs the memo.
 */
export function useReadingDiet() {
  const snap = useSyncExternalStore(subscribeDiet, readDietSnapshot, getServerDietSnapshot);

  const summary = useMemo(() => summarizeDiet(snap.entries, snap.readAt), [snap]);

  return {
    hydrated: snap.readAt > 0 || !snap.available,
    available: snap.available,
    summary,
  };
}
