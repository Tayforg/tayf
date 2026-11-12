import type { TrackEvent, TrackProps } from "@/lib/track";
import {
  DIET_STORAGE_KEY,
  appendDiet,
  dietEntryFromTrack,
  parseDiet,
  pruneDiet,
  serializeDiet,
  type DietEntry,
} from "./diet";

// Browser plumbing for the device-local reading diet. No React here (see
// use-reading-diet.ts for the hook) — just localStorage access with the
// try/catch-everywhere discipline last-visit.ts established, plus the
// module-level snapshot cache use-bookmarks.ts established for
// useSyncExternalStore.

const CHANGE_EVENT = "tayf:diyet-change";

export interface DietSnapshot {
  available: boolean;
  entries: readonly DietEntry[];
  readAt: number;
}

const EMPTY_ENTRIES: readonly DietEntry[] = [];

// Module-level cache: readDietSnapshot recomputes (and re-stamps readAt)
// only when the raw string changes, so unchanged reads return the exact
// same object reference — required by useSyncExternalStore to avoid
// re-render loops.
let cachedRaw: string | null | undefined; // undefined = "never read"
let cachedAvailable = true;
let cachedSnapshot: DietSnapshot = { available: true, entries: EMPTY_ENTRIES, readAt: 0 };

/**
 * Accesses `window.localStorage`. The property getter itself can throw
 * (SecurityError, e.g. cookies blocked in some private-browsing modes), so
 * every access goes through this wrapper rather than a bare reference.
 */
function getStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readRaw(): { available: boolean; raw: string | null } {
  const storage = getStorage();
  if (!storage) return { available: false, raw: null };
  try {
    return { available: true, raw: storage.getItem(DIET_STORAGE_KEY) };
  } catch {
    return { available: false, raw: null };
  }
}

export function readDietSnapshot(): DietSnapshot {
  const { available, raw } = readRaw();
  if (raw === cachedRaw && available === cachedAvailable) {
    return cachedSnapshot;
  }
  cachedRaw = raw;
  cachedAvailable = available;
  cachedSnapshot = {
    available,
    entries: available ? parseDiet(raw) : EMPTY_ENTRIES,
    readAt: Date.now(),
  };
  return cachedSnapshot;
}

const SERVER_SNAPSHOT: DietSnapshot = { available: true, entries: EMPTY_ENTRIES, readAt: 0 };

export function getServerDietSnapshot(): DietSnapshot {
  return SERVER_SNAPSHOT;
}

export function subscribeDiet(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handleStorage = (e: StorageEvent) => {
    if (e.key === DIET_STORAGE_KEY || e.key === null) onChange();
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

function notifyChange(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }
}

/**
 * Records one reading-diet entry from a `track()` call. Device-local only:
 * never throws, and is a no-op on the server or whenever storage access
 * fails (quota, blocked cookies, etc) so a link's navigation is never at
 * risk.
 */
export function recordReadingClick(event: TrackEvent, props?: TrackProps): void {
  if (typeof window === "undefined") return;
  try {
    const nowMs = Date.now();
    const entry = dietEntryFromTrack(event, props, nowMs);
    if (!entry) return;
    const storage = getStorage();
    if (!storage) return;
    let raw: string | null;
    try {
      raw = storage.getItem(DIET_STORAGE_KEY);
    } catch {
      return;
    }
    const current = parseDiet(raw);
    const next = appendDiet(current, entry, nowMs);
    try {
      storage.setItem(DIET_STORAGE_KEY, serializeDiet(next));
    } catch {
      return;
    }
    notifyChange();
  } catch {
    // Belt-and-suspenders: this function must never throw.
  }
}

/**
 * Deletes the stored entries the retention rule says are gone (older than
 * DIET_TTL_DAYS, more than 60 s in the future, or beyond the newest
 * DIET_MAX_ENTRIES). recordReadingClick prunes on a counted click, and
 * DietSummary calls this when /diyetim is opened. Nothing runs in the
 * background: a reader who neither opens /diyetim nor clicks again keeps the
 * expired entries, so the privacy line "daha eskiler kendiliğinden silinir" is
 * narrowed, not yet literally true (its copy change is a separate decision).
 * The verdict comes from `pruneDiet`, the very function the click-time prune
 * uses, so both paths share one 30-day boundary.
 *
 * Returns how many entries were dropped. Writes (and notifies subscribers) only
 * when that is more than 0: an untouched, empty or unparseable store is never
 * rewritten. Never throws and is a no-op on the server or whenever storage
 * access fails; 0 is returned in each of those cases. Device-local only: no
 * network, no analytics.
 */
export function pruneStoredDiet(nowMs: number = Date.now()): number {
  if (typeof window === "undefined") return 0;
  try {
    const storage = getStorage();
    if (!storage) return 0;
    let raw: string | null;
    try {
      raw = storage.getItem(DIET_STORAGE_KEY);
    } catch {
      return 0;
    }
    const parsed = parseDiet(raw);
    const kept = pruneDiet(parsed, nowMs);
    if (kept.length === parsed.length) return 0;
    try {
      if (kept.length === 0) storage.removeItem(DIET_STORAGE_KEY);
      else storage.setItem(DIET_STORAGE_KEY, serializeDiet(kept));
    } catch {
      return 0;
    }
    notifyChange();
    return parsed.length - kept.length;
  } catch {
    // Belt-and-suspenders: this function must never throw.
    return 0;
  }
}

/** Clears the stored diet. Returns false (without throwing) if storage access fails. */
export function clearDiet(): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    storage.removeItem(DIET_STORAGE_KEY);
  } catch {
    return false;
  }
  notifyChange();
  return true;
}
