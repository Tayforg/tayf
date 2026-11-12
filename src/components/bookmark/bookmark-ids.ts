// Pure id handling for the device-local bookmark list (tayf:bookmarks). No
// browser APIs, so it is unit-tested directly and safe to import anywhere.
//
// Ids are folded to lower case (h32-livebk-1). The /saved RPC answers with
// lower-case uuids, while a bookmark saved from an upper-case /cluster/<ID> URL
// used to be stored as written, so removing it from /saved ADDED a lower-case
// phantom ([upper, lower]) instead of removing the entry. Middleware now 308s
// every non-lower-case cluster URL, but entries already in localStorage stay:
// they are folded on read, on toggle and in has().
//
// Deliberately NO UUID requirement: a legacy or hand-edited id is kept (only
// lower-cased), never dropped. toLowerCase is locale independent on purpose
// (toLocaleLowerCase would turn 'I' into a dotless 'ı' under a Turkish locale).

/** The canonical key for an id, or null when it is not a non-empty string. */
export function normaliseBookmarkId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  return trimmed === "" ? null : trimmed.toLowerCase();
}

/**
 * Parsed localStorage content to canonical ids: non-strings and empty strings
 * dropped, case folded, de-duplicated in first-seen order. A non-array is [].
 */
export function normaliseBookmarkIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const key = normaliseBookmarkId(entry);
    if (key !== null) seen.add(key);
  }
  return Array.from(seen);
}

export interface BookmarkToggle {
  /** A new set; the input is never mutated. */
  next: Set<string>;
  /** True when the id was added, false when it was removed. */
  added: boolean;
  /** The canonical key that was added or removed. */
  key: string;
}

export interface BookmarkMerge {
  /** `current` as it was, then the ids that were added. */
  next: string[];
  added: number;
  /** Incoming ids (distinct) that were already in `current`. */
  existing: number;
  /** New incoming ids left out because the list is at `max`. */
  skipped: number;
}

/**
 * Merge `incoming` ids into `current` without ever removing one. `current` is kept
 * exactly as it is, even when it is already longer than `max` (a legacy list). New
 * ids go on the end, and when they do not all fit the NEWEST ones are kept. The
 * inputs are never mutated.
 */
export function mergeBookmarkIds(
  current: readonly string[],
  incoming: readonly string[],
  max: number,
): BookmarkMerge {
  const have = new Set(current);
  const distinct = normaliseBookmarkIds(incoming);
  const candidates = distinct.filter((id) => !have.has(id));
  const room = Math.max(0, max - current.length);
  // Not slice(-room): slice(-0) returns everything.
  const toAdd = room === 0 ? [] : candidates.slice(Math.max(0, candidates.length - room));
  return {
    next: [...current, ...toAdd],
    added: toAdd.length,
    existing: distinct.length - candidates.length,
    skipped: candidates.length - toAdd.length,
  };
}

/** Add or remove `id` (canonicalised) and return the new set, or null for an empty id. */
export function toggleBookmarkId(current: ReadonlySet<string>, id: string): BookmarkToggle | null {
  const key = normaliseBookmarkId(id);
  if (key === null) return null;
  const next = new Set(current);
  if (next.has(key)) {
    next.delete(key);
    return { next, added: false, key };
  }
  next.add(key);
  return { next, added: true, key };
}
