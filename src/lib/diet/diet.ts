import type { MediaDnaZone } from "@/types";
import type { TrackEvent, TrackProps } from "@/lib/track";

// "Haber diyetim" (/diyetim) — a device-local reading-balance mirror.
//
// Everything in this module is pure (no DOM, no storage access) so it can
// be unit-tested without a browser. `diet-store.ts` owns the localStorage
// plumbing and calls into these functions.

export const DIET_STORAGE_KEY = "tayf:diyet";
export const DIET_MAX_ENTRIES = 500;
export const DIET_TTL_DAYS = 30;
export const DIET_WEEK_DAYS = 7;
// Below this many 7-day clicks we show raw counts + a low-sample note
// instead of a spectrum bar — a bar built from 3 clicks would read as a
// confident ratio it isn't.
export const DIET_MIN_SAMPLE = 10;
// A second click on the same zone within this window is almost always a
// double-click / accidental re-fire, not a second read; drop it.
export const DIET_DEDUPE_MS = 2000;

// Spectrum order used everywhere a zone list is rendered (bar segments,
// tie-breaking, etc).
export const DIET_ZONES = ["iktidar", "bagimsiz", "muhalefet"] as const;

export type DietZone = MediaDnaZone;

export interface DietEntry {
  t: number;
  z: DietZone;
}

const ZONE_SET = new Set<string>(DIET_ZONES);

function isDietZone(value: unknown): value is DietZone {
  return typeof value === "string" && ZONE_SET.has(value);
}

interface StoredShapeV1 {
  v: 1;
  e: Array<{ t: unknown; z: unknown }>;
}

function isStoredShapeV1(value: unknown): value is StoredShapeV1 {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return obj.v === 1 && Array.isArray(obj.e);
}

/**
 * Parses the raw localStorage string into a sorted (ascending by `t`) list
 * of valid entries. Never throws: any parse failure, unexpected shape,
 * unknown version, non-finite timestamp or unrecognised zone is dropped
 * (or, for the whole-string case, yields an empty list).
 */
export function parseDiet(raw: string | null): DietEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isStoredShapeV1(parsed)) return [];

  const entries: DietEntry[] = [];
  for (const item of parsed.e) {
    if (typeof item !== "object" || item === null) continue;
    const t = (item as { t: unknown }).t;
    const z = (item as { z: unknown }).z;
    if (typeof t !== "number" || !Number.isFinite(t)) continue;
    if (!isDietZone(z)) continue;
    entries.push({ t, z });
  }
  entries.sort((a, b) => a.t - b.t);
  return entries;
}

/** Serializes entries, keeping only the `t`/`z` keys (no extra fields). */
export function serializeDiet(entries: readonly DietEntry[]): string {
  return JSON.stringify({ v: 1, e: entries.map(({ t, z }) => ({ t, z })) });
}

/**
 * Drops entries older than DIET_TTL_DAYS or further than 60s in the future
 * (clock skew guard), then caps the result at the newest DIET_MAX_ENTRIES.
 * Assumes `entries` is already sorted ascending by `t` (parseDiet/appendDiet
 * both guarantee this).
 */
export function pruneDiet(entries: readonly DietEntry[], nowMs: number): DietEntry[] {
  const minT = nowMs - DIET_TTL_DAYS * 24 * 60 * 60 * 1000;
  const maxT = nowMs + 60_000;
  const kept = entries.filter((e) => e.t >= minT && e.t <= maxT);
  if (kept.length <= DIET_MAX_ENTRIES) return kept;
  return kept.slice(kept.length - DIET_MAX_ENTRIES);
}

/**
 * Appends one entry, deduping an accidental double-click (same zone within
 * DIET_DEDUPE_MS of the immediately preceding entry) against the *last*
 * entry only, then prunes.
 */
export function appendDiet(
  entries: readonly DietEntry[],
  entry: DietEntry,
  nowMs: number,
): DietEntry[] {
  const last = entries[entries.length - 1];
  if (last && last.z === entry.z && Math.abs(entry.t - last.t) < DIET_DEDUPE_MS) {
    return pruneDiet(entries, nowMs);
  }
  return pruneDiet([...entries, entry], nowMs);
}

/**
 * Maps a `track()` call to a diet entry. Only `outbound` / `cta_other_side`
 * events carrying a valid `data.zone` count as a "read"; everything else
 * (share, bookmark, search, a zoneless outbound/factcheck click, or an
 * unrecognised zone string) is ignored.
 */
export function dietEntryFromTrack(
  event: TrackEvent,
  props: TrackProps | undefined,
  nowMs: number,
): DietEntry | null {
  if (event !== "outbound" && event !== "cta_other_side") return null;
  const zone = props?.zone;
  if (!isDietZone(zone)) return null;
  return { t: nowMs, z: zone };
}

export interface DietSummary {
  counts: Record<DietZone, number>;
  total: number;
  counts30d: Record<DietZone, number>;
  total30d: number;
  leastRead: DietZone | null;
  sampleOk: boolean;
}

function zeroCounts(): Record<DietZone, number> {
  return { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
}

/**
 * Summarizes entries into a 7-day window (`counts`/`total`) and a 30-day
 * window (`counts30d`/`total30d`).
 *
 * `leastRead` selection (deterministic, not editorial):
 *   1. `null` when the 7-day total is 0 (nothing to compare).
 *   2. Otherwise the zone with the minimum 7-day count.
 *   3. Ties broken by the lower 30-day count.
 *   4. Still tied: first in DIET_ZONES spectrum order.
 */
export function summarizeDiet(entries: readonly DietEntry[], nowMs: number): DietSummary {
  const weekMinT = nowMs - DIET_WEEK_DAYS * 24 * 60 * 60 * 1000;
  const monthMinT = nowMs - DIET_TTL_DAYS * 24 * 60 * 60 * 1000;

  const counts = zeroCounts();
  const counts30d = zeroCounts();
  let total = 0;
  let total30d = 0;

  for (const entry of entries) {
    if (entry.t >= monthMinT) {
      counts30d[entry.z] += 1;
      total30d += 1;
    }
    if (entry.t >= weekMinT) {
      counts[entry.z] += 1;
      total += 1;
    }
  }

  let leastRead: DietZone | null = null;
  if (total > 0) {
    leastRead = DIET_ZONES[0];
    for (const zone of DIET_ZONES) {
      if (zone === leastRead) continue;
      const currentCount = counts[leastRead];
      const candidateCount = counts[zone];
      if (candidateCount < currentCount) {
        leastRead = zone;
      } else if (candidateCount === currentCount && counts30d[zone] < counts30d[leastRead]) {
        leastRead = zone;
      }
      // Equal on both counts: keep the earlier (spectrum-order) zone —
      // `leastRead` is only replaced by a strictly-better candidate above.
    }
  }

  return {
    counts,
    total,
    counts30d,
    total30d,
    leastRead,
    sampleOk: total >= DIET_MIN_SAMPLE,
  };
}
