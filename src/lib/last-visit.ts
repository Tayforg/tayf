export const LAST_VISIT_KEY = "tayf:last-visit";

/**
 * What the stamped render showed (h112-follows-1): JSON `{v:1, ids, floor}`.
 * The stamp alone cannot tell "published after my visit" from "became listed
 * after my visit": every listing surface needs article_count >= 2, but
 * `first_published` is the OLDEST member's time, so a story whose second source
 * arrived after the visit (about half of them, a median of 33 min later) had a
 * first_published BEFORE the stamp, got no pill, and the next stamp consumed it.
 */
export const LAST_VISIT_SEEN_KEY = "tayf:last-visit-seen";
/**
 * At most this many cluster ids are stored. One render lists 36 or fewer (the
 * breaking strip plus the top-30 ranked set), and a record also keeps the ids of
 * the previous one (recordVisit), so this holds several visits' worth.
 */
export const LAST_VISIT_SEEN_MAX = 200;
/** A stored timestamp longer than this is not one of ours (cleanStamp's bound in follows.ts). */
const STAMP_MAX_LENGTH = 64;

/** A cluster the home page rendered: its id and the oldest member's time. */
export interface VisitItem {
  id: string;
  firstPublished: string;
}

export interface LastVisitSeen {
  v: 1;
  /** Lower-cased cluster ids the stamped render showed, newest first. */
  ids: string[];
  /** The minimum first_published among `ids`, as the API gave it. */
  floor: string;
}

/** Count ISO timestamps strictly newer than `stamp`; 0 when there is no usable stamp. */
export function countNewSince(timestamps: readonly string[], stamp: string | null): number {
  if (!stamp) return 0;
  const since = Date.parse(stamp);
  if (Number.isNaN(since)) return 0;
  let n = 0;
  for (const t of timestamps) {
    const ms = Date.parse(t);
    if (!Number.isNaN(ms) && ms > since) n += 1;
  }
  return n;
}

/**
 * The record for one render, or null when it showed nothing usable (no cluster,
 * or no parseable time). Keeps the 200 NEWEST distinct ids and takes the floor
 * from the kept ones, so every story the cut dropped is older than the floor and
 * can never be counted as new. Derived from the listed items only, never from
 * the clock or a fetch.
 */
export function buildSeenRecord(items: readonly VisitItem[]): LastVisitSeen | null {
  const byId = new Map<string, { firstPublished: string; ms: number }>();
  for (const item of items) {
    const ms = Date.parse(item.firstPublished);
    if (Number.isNaN(ms) || typeof item.id !== "string" || item.id === "") continue;
    const id = item.id.toLowerCase();
    const kept = byId.get(id);
    // A duplicate id keeps its oldest time: the floor must not rise above a row that was shown.
    if (kept === undefined || ms < kept.ms) byId.set(id, { firstPublished: item.firstPublished, ms });
  }
  // Array.prototype.sort is stable: equal times keep the page's order.
  const newest = [...byId.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, LAST_VISIT_SEEN_MAX);
  const oldest = newest[newest.length - 1];
  if (oldest === undefined) return null;
  return { v: 1, ids: newest.map(([id]) => id), floor: oldest[1].firstPublished };
}

/** Validates stored text or an already-parsed value; null when it is not exactly our record. */
export function parseLastVisitSeen(raw: unknown): LastVisitSeen | null {
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const o = data as Record<string, unknown>;
  if (o.v !== 1 || !Array.isArray(o.ids) || o.ids.length > LAST_VISIT_SEEN_MAX) return null;
  const floor = o.floor;
  if (typeof floor !== "string" || floor.length === 0 || floor.length > STAMP_MAX_LENGTH) return null;
  if (Number.isNaN(Date.parse(floor))) return null;
  const ids: string[] = [];
  for (const id of o.ids) {
    if (typeof id !== "string") return null;
    ids.push(id.toLowerCase());
  }
  return { v: 1, ids, floor };
}

/**
 * How many of `items` the reader has not seen since the stamped visit.
 *
 * With a valid `seen` record (the stored JSON text or the parsed object): the
 * unique items whose id the stamped render did not show AND whose first_published
 * is strictly newer than the record's floor. That counts a story that became
 * listed after the visit although it was first published before it, and ignores
 * an old story that merely resurfaced (older than everything shown). A tie at the
 * floor is not new (that row may have been below the cut) and an unparseable time
 * is never new.
 *
 * Without a usable record (a legacy reader, the first visit after the deploy,
 * garbage in storage): exactly countNewSince(firstPublished[], stamp).
 */
export function countNewSinceVisit(
  items: readonly VisitItem[],
  seen: unknown,
  stamp: string | null,
): number {
  const record = parseLastVisitSeen(seen);
  if (record === null) return countNewSince(items.map((i) => i.firstPublished), stamp);

  const floor = Date.parse(record.floor);
  const known = new Set(record.ids);
  const counted = new Set<string>();
  for (const item of items) {
    const id = item.id.toLowerCase();
    if (known.has(id) || counted.has(id)) continue;
    const ms = Date.parse(item.firstPublished);
    if (!Number.isNaN(ms) && ms > floor) counted.add(id);
  }
  return counted.size;
}

/**
 * Whether a home render may advance the last-visit stamp. The stamp means "the
 * reader saw the top of the feed", so only page 1 of the plain feed counts, and
 * only when the feed itself rendered: the FeedUnavailable shell shows no
 * stories, a /?q= search view shows a filtered slice, and ?page=N is deeper
 * than the top. Stamping on any of those makes the next session's pill skip
 * every story published since that render that the reader never saw. `q` is the
 * page's firstQuery() value (undefined when blank); an empty string is treated
 * the same way.
 */
export function shouldStampLastVisit({
  page,
  q,
  feedOk,
}: {
  page: number;
  q: string | undefined;
  feedOk: boolean;
}): boolean {
  return feedOk && page === 1 && !q;
}

export function readLastVisit(): string | null {
  try {
    return window.localStorage.getItem(LAST_VISIT_KEY);
  } catch {
    return null;
  }
}

export function writeLastVisit(iso: string): void {
  try {
    window.localStorage.setItem(LAST_VISIT_KEY, iso);
  } catch {
    // storage unavailable (private mode, quota) — pill simply won't show next time
  }
}

/** The stored record, or null when absent, garbage or storage is unavailable. */
export function readLastVisitSeen(): LastVisitSeen | null {
  try {
    return parseLastVisitSeen(window.localStorage.getItem(LAST_VISIT_SEEN_KEY));
  } catch {
    return null;
  }
}

/**
 * Stores `record`, or removes the stored one when there is none or the write
 * fails: a record that does not belong to the stamp just written would count
 * against the wrong render, and with no record the stamp rule applies.
 */
export function writeLastVisitSeen(record: LastVisitSeen | null): void {
  try {
    if (record !== null) {
      window.localStorage.setItem(LAST_VISIT_SEEN_KEY, JSON.stringify(record));
      return;
    }
  } catch {
    // quota / private mode: fall through and drop the older record
  }
  try {
    window.localStorage.removeItem(LAST_VISIT_SEEN_KEY);
  } catch {
    // storage unavailable: nothing to keep consistent
  }
}

/**
 * One stamped visit: the stamp (when) and the seen record (what). `listed` is
 * every cluster the plain feed lists (the breaking strip plus the whole ranked
 * set, not just the rows of page 1: page 2 is disjoint from page 1 and its
 * stories can be newer than page 1's oldest, so a record of page 1 alone made
 * them read as new, h113 correctness-1). The floor comes from this listing only.
 * The ids of the previous record that this listing does not repeat are appended,
 * current first, up to the cap: a story that dropped out of one listing and is
 * back at the next was seen, not new. The stamp is written first, so a failure of
 * the second write leaves no record rather than a record of another render.
 */
export function recordVisit(nowIso: string, listed: readonly VisitItem[]): void {
  writeLastVisit(nowIso);
  const current = buildSeenRecord(listed);
  if (current === null) {
    // No floor to pair an older record's ids with: drop it, the stamp rule applies.
    writeLastVisitSeen(null);
    return;
  }
  const ids = [...current.ids];
  const present = new Set(ids);
  for (const id of readLastVisitSeen()?.ids ?? []) {
    if (ids.length >= LAST_VISIT_SEEN_MAX) break;
    if (present.has(id)) continue;
    present.add(id);
    ids.push(id);
  }
  writeLastVisitSeen({ v: 1, ids, floor: current.floor });
}
