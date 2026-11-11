// Device-local snapshots of a saved story's zone coverage, so /saved can
// badge "a new zone started covering this" / "+N new sources". Client-safe:
// no static Supabase import (the /saved bundle loads it lazily).
import { BIAS_TO_ZONE } from "@/lib/bias/config";
import type { MediaDnaZone } from "@/types";

export const SNAPSHOT_KEY = "tayf:bookmark-snapshots:v1";
export const SNAPSHOT_MAX_ENTRIES = 500;
export const MIN_NEW_SOURCES = 2;

const BOOKMARKS_KEY = "tayf:bookmarks";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZONES: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];
const MAX_ZONE_BADGES = 2;

export type SnapshotBasis = "save" | "first-view";

export interface BookmarkSnapshot {
  v: 1;
  at: string;
  zones: Record<MediaDnaZone, number>;
  sources: number;
  basis: SnapshotBasis;
}

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

export interface SnapshotRow {
  bias_distribution: unknown;
  article_count: number;
  /**
   * saved_clusters_v4 only (migration 192): the wire-collapsed member count, the number the cards, the cluster
   * page and /api/takip print as "N kaynak". Absent on rows from the v3 / v2 / v1 fallback, null when the
   * cluster has no member rows. `article_count` is the stored raw count (6 for a story of 6 outlets that
   * reprint 3 distinct texts, whose own page says "3 kaynak").
   */
  effective_article_count?: number | null;
}

export interface SnapshotDiff {
  newZones: MediaDnaZone[];
  newSources: number;
  hadCoverage: boolean;
}

export interface SavedChange extends SnapshotDiff {
  basis: SnapshotBasis;
}

const ZONE_LABEL: Record<MediaDnaZone, string> = {
  iktidar: "İktidar medyası",
  bagimsiz: "Bağımsız medya",
  muhalefet: "Muhalefet medyası",
};

function emptyZones(): Record<MediaDnaZone, number> {
  return { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
}

function goodCount(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Bias -> zone counts. Unknown keys, non-numbers, negative/non-finite
 * values are ignored. Deliberately not zoneCountsOf (unsafe on unknown keys). */
export function safeZoneCounts(dist: unknown): Record<MediaDnaZone, number> {
  const out = emptyZones();
  if (!dist || typeof dist !== "object" || Array.isArray(dist)) return out;
  for (const [bias, count] of Object.entries(dist as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(BIAS_TO_ZONE, bias)) continue;
    if (!goodCount(count)) continue;
    const zone = (BIAS_TO_ZONE as Record<string, MediaDnaZone | undefined>)[bias];
    if (zone) out[zone] += count;
  }
  return out;
}

/** The effective count when the row carries a usable one (a positive integer), else null. */
function effectiveCountOf(row: SnapshotRow | null | undefined): number | null {
  const n = row?.effective_article_count;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * The source count /saved prints and the snapshots compare: saved_clusters_v4's wire-collapsed
 * `effective_article_count` when the row has one, else the stored `article_count` (rows from the
 * v3 / v2 / v1 fallback, or a cluster with no member rows), else 0. One definition for both, so the
 * number on the row and the "+N yeni kaynak" badge count the same thing.
 */
export function sourceCountOf(row: SnapshotRow | null | undefined): number {
  const effective = effectiveCountOf(row);
  if (effective !== null) return effective;
  const raw = row?.article_count;
  return goodCount(raw) ? raw : 0;
}

export function makeSnapshot(row: SnapshotRow, basis: SnapshotBasis, nowIso: string): BookmarkSnapshot {
  return {
    v: 1,
    at: nowIso,
    zones: safeZoneCounts(row?.bias_distribution),
    sources: sourceCountOf(row),
    basis,
  };
}

function isSnapshot(x: unknown): x is BookmarkSnapshot {
  if (!x || typeof x !== "object") return false;
  const s = x as Record<string, unknown>;
  if (s.v !== 1 || typeof s.at !== "string") return false;
  if (s.basis !== "save" && s.basis !== "first-view") return false;
  if (!goodCount(s.sources)) return false;
  const z = s.zones as Record<string, unknown> | null;
  if (!z || typeof z !== "object") return false;
  return ZONES.every((k) => goodCount(z[k]));
}

export function parseSnapshots(raw: unknown): Record<string, BookmarkSnapshot> {
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, BookmarkSnapshot> = {};
    for (const [id, v] of Object.entries(parsed)) {
      if (isSnapshot(v)) out[id] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function diffSnapshot(snap: BookmarkSnapshot, row: SnapshotRow): SnapshotDiff | null {
  try {
    const now = safeZoneCounts(row?.bias_distribution);
    const newZones = ZONES.filter((z) => snap.zones[z] === 0 && now[z] >= 1);
    const count = sourceCountOf(row);
    const delta = count - snap.sources;
    const newSources = delta >= MIN_NEW_SOURCES ? delta : 0;
    if (newZones.length === 0 && newSources === 0) return null;
    return { newZones, newSources, hadCoverage: ZONES.some((z) => snap.zones[z] > 0) };
  } catch {
    return null;
  }
}

export function changeBadgeLabels(change: SnapshotDiff): string[] {
  const suffix = change.hadCoverage ? " da yazmaya başladı" : " yazmaya başladı";
  const labels = change.newZones.slice(0, MAX_ZONE_BADGES).map((z) => ZONE_LABEL[z] + suffix);
  if (change.newSources >= MIN_NEW_SOURCES) labels.push(`+${change.newSources} yeni kaynak`);
  return labels;
}

export function reconcileSnapshots(
  rows: ReadonlyArray<SnapshotRow & { id: string }>,
  snapshots: Record<string, BookmarkSnapshot>,
  nowIso: string,
): { changes: Record<string, SavedChange>; toWrite: Record<string, BookmarkSnapshot> } {
  const changes: Record<string, SavedChange> = {};
  const toWrite: Record<string, BookmarkSnapshot> = {};
  for (const row of rows) {
    const snap = snapshots[row.id];
    if (!snap) {
      toWrite[row.id] = makeSnapshot(row, "first-view", nowIso);
      continue;
    }
    const d = diffSnapshot(snap, row);
    if (d) changes[row.id] = { ...d, basis: snap.basis };
    // A snapshot taken on the raw count (before migration 192: article_count 6 for a story whose page says
    // "3 kaynak") sits above the effective count the row now carries. Lower it silently on this first read:
    // no badge, no negative delta, so a later real growth of 2 shows up instead of hiding under the old 6.
    // Only the count moves; the zones, the time and the basis stay. A row without an effective count (v3 / v2 /
    // v1 fallback) never rewrites a baseline, as before.
    const effective = effectiveCountOf(row);
    if (effective !== null && effective < snap.sources) {
      toWrite[row.id] = { ...snap, sources: effective };
    }
  }
  return { changes, toWrite };
}

export function readSnapshots(storage: StorageLike | null = defaultStorage()): Record<string, BookmarkSnapshot> {
  try {
    return storage ? parseSnapshots(storage.getItem(SNAPSHOT_KEY)) : {};
  } catch {
    return {};
  }
}

export function writeSnapshots(
  map: Record<string, BookmarkSnapshot>,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    if (!storage) return;
    let entries = Object.entries(map);
    if (entries.length > SNAPSHOT_MAX_ENTRIES) {
      entries.sort((a, b) => (a[1].at < b[1].at ? 1 : a[1].at > b[1].at ? -1 : 0)); // newest first
      entries = entries.slice(0, SNAPSHOT_MAX_ENTRIES);
    }
    storage.setItem(SNAPSHOT_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // ignore storage failures
  }
}

export function removeSnapshot(id: string, storage: StorageLike | null = defaultStorage()): void {
  try {
    const all = readSnapshots(storage);
    if (!(id in all)) return;
    delete all[id];
    writeSnapshots(all, storage);
  } catch {
    // ignore
  }
}

export function pruneSnapshots(keepIds: Iterable<string>, storage: StorageLike | null = defaultStorage()): void {
  try {
    const keep = new Set(keepIds);
    const all = readSnapshots(storage);
    const kept = Object.fromEntries(Object.entries(all).filter(([id]) => keep.has(id)));
    if (Object.keys(kept).length === Object.keys(all).length) return;
    writeSnapshots(kept, storage);
  } catch {
    // ignore
  }
}

export interface CaptureDeps {
  fetchRow?: (id: string) => Promise<SnapshotRow | null>;
  storage?: StorageLike | null;
  isStillSaved?: (id: string) => boolean;
  nowIso?: string;
}

function defaultIsStillSaved(id: string): boolean {
  try {
    const raw = defaultStorage()?.getItem(BOOKMARKS_KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) && arr.includes(id);
  } catch {
    return false;
  }
}

async function defaultFetchRow(id: string): Promise<SnapshotRow | null> {
  // The anon key only reaches clusters through saved_clusters (migration 116),
  // whose argument is uuid[]: a malformed id would be a PostgREST 400 anyway,
  // so skip the import and the request.
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  const { createBrowserClient } = await import("@/lib/supabase/browser");
  const { data, error } = await createBrowserClient().rpc("saved_clusters", { p_ids: [id] });
  if (error) return null;
  return ((data as SnapshotRow[] | null)?.[0] ?? null) as SnapshotRow | null;
}

/** Store a 'save' baseline for a freshly bookmarked story. Never throws. */
export async function captureSnapshot(id: string, deps: CaptureDeps = {}): Promise<void> {
  try {
    const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
    const row = await (deps.fetchRow ?? defaultFetchRow)(id);
    if (!row) return;
    if (!(deps.isStillSaved ?? defaultIsStillSaved)(id)) return;
    const all = readSnapshots(storage);
    if (all[id]) return;
    all[id] = makeSnapshot(row, "save", deps.nowIso ?? new Date().toISOString());
    writeSnapshots(all, storage);
  } catch {
    // best-effort only
  }
}
