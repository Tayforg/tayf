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
