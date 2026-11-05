// supabase/functions/ingest/order.ts
//
// Fair fetch/upsert ordering + a bisecting-fallback upsert for the ingest
// Edge Function (ingest-health). Every export here is pure — no Deno
// globals, no `esm.sh` imports — so this module is both Deno- and
// vitest-importable.
//
// Why this exists: a fixed `.order("slug")` fetch order plus a single
// batched-then-per-row upsert fallback starves tail-alphabet sources when a
// cycle hits its deadline (the earliest-slug sources' rows always land in
// the first upsert chunk) and turns one poisoned row into an O(n) per-row
// retry storm. `rotateForCycle` + `interleaveBySource` spread both the fetch
// order and the upsert order fairly across sources; `upsertWithBisect`
// isolates a bad row in O(log n) upsert calls instead of O(n).

/** One ingest cycle's nominal wall-clock period (matches the 3-minute cron). */
export const CYCLE_PERIOD_MS = 180_000;

/**
 * Rotates `items` by an offset derived from `startedAtMs`, so a fixed base
 * order (e.g. `.order("slug")`) doesn't always place the same items first —
 * over `periodMs`-spaced cycles the rotation walks all the way around the
 * array. `n` of 0 or 1 is returned as a (new) copy — there's nothing to
 * rotate.
 */
export function rotateForCycle<T>(
  items: readonly T[],
  startedAtMs: number,
  periodMs: number = CYCLE_PERIOD_MS,
): T[] {
  const n = items.length;
  if (n <= 1) return [...items];
  const offset = Math.floor(startedAtMs / periodMs) % n;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

interface SourceKeyed {
  source_id: string;
}

interface Dated {
  published_at: string;
}

/**
 * Groups `rows` by `source_id` (first-seen order of the source ids),
 * sorts each group by `published_at` descending (stable — `Array.sort` is
 * spec-stable since ES2019), then round-robins across the groups. The
 * result holds every source's newest item first, then every source's
 * second-newest item, and so on — so a deadline cut into the FRONT of this
 * array drops each source's OLDEST rows instead of dropping whole
 * late-in-the-array sources entirely.
 */
export function interleaveBySource<T extends SourceKeyed & Dated>(
  rows: readonly T[],
): T[] {
  const order: string[] = [];
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    let group = groups.get(row.source_id);
    if (!group) {
      group = [];
      groups.set(row.source_id, group);
      order.push(row.source_id);
    }
    group.push(row);
  }
  for (const id of order) {
    const group = groups.get(id);
    if (group) {
      group.sort(
        (a, b) => Date.parse(b.published_at) - Date.parse(a.published_at),
      );
    }
  }

  const out: T[] = [];
  const cursors = new Map<string, number>(order.map((id) => [id, 0]));
  let remaining = rows.length;
  while (remaining > 0) {
    for (const id of order) {
      const group = groups.get(id);
      if (!group) continue;
      const idx = cursors.get(id) ?? 0;
      if (idx >= group.length) continue;
      const item = group[idx];
      if (item !== undefined) {
        out.push(item);
        remaining--;
      }
      cursors.set(id, idx + 1);
    }
  }
  return out;
}

/**
 * Stable sort of `rows` by `source_id`. Applied to each upsert chunk BEFORE
 * the (source_id, content_hash) pre-filter: an interleaved chunk can carry
 * up to `chunk.length` distinct source ids in the worst case (one per row),
 * which blows up the pre-filter's `.in("source_id", ids)` query string
 * (migration 074's proxy-limit failure mode); grouped, each `PREFILTER_CHUNK`
 * slice of a grouped chunk spans far fewer distinct sources.
 */
export function groupChunkBySource<T extends SourceKeyed>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => {
    if (a.source_id < b.source_id) return -1;
    if (a.source_id > b.source_id) return 1;
    return 0;
  });
}

export interface BisectUpsertResult {
  inserted: number;
  rowErrors: number;
  skipped: number;
  calls: number;
  firstError: string | null;
}

export interface BisectUpsertOptions<T> {
  /** Returns true once the caller's cycle deadline has passed. */
  isPastDeadline: () => boolean;
  /** Called once per row that fails in isolation (a length-1 batch). */
  onRowError?: (row: T, error: string) => void;
  /**
   * Called once per batch popped after the deadline and therefore never
   * attempted (silent-feeds: lets the caller mark those rows' sources as not
   * fully settled). The summed lengths equal `result.skipped`.
   */
  onSkipped?: (batch: readonly T[]) => void;
}

/**
 * Upserts `rows` via `upsert`, bisecting any batch that errors instead of
 * falling back to a full per-row retry. On success a batch's `inserted`
 * count is added to the total. On error, a length-1 batch counts as a row
 * error (and calls `onRowError`); a longer batch is split at the midpoint
 * and BOTH halves are retried, left half first. `isPastDeadline()` is
 * checked before every call — any batch popped once the deadline has
 * passed is counted as `skipped` rather than attempted or retried.
 *
 * Bound: at most `1 + 2*ceil(log2(n))` upsert calls are needed to isolate
 * one bad row out of `n` (each bisection level calls upsert on BOTH
 * resulting halves) — 7 for n=8, at most 19 for n=500, versus up to `n+1`
 * calls for the old batched-then-per-row-fallback approach.
 */
export async function upsertWithBisect<T>(
  rows: readonly T[],
  upsert: (batch: T[]) => Promise<{ inserted: number; error: string | null }>,
  opts: BisectUpsertOptions<T>,
): Promise<BisectUpsertResult> {
  const result: BisectUpsertResult = {
    inserted: 0,
    rowErrors: 0,
    skipped: 0,
    calls: 0,
    firstError: null,
  };
  if (rows.length === 0) return result;

  const stack: T[][] = [[...rows]];
  while (stack.length > 0) {
    const batch = stack.pop();
    if (!batch || batch.length === 0) continue;

    if (opts.isPastDeadline()) {
      result.skipped += batch.length;
      opts.onSkipped?.(batch);
      continue;
    }

    result.calls++;
    const { inserted, error } = await upsert(batch);
    if (!error) {
      result.inserted += inserted;
      continue;
    }

    if (result.firstError === null) result.firstError = error;

    if (batch.length === 1) {
      result.rowErrors++;
      const row = batch[0];
      if (row !== undefined) opts.onRowError?.(row, error);
      continue;
    }

    const mid = Math.ceil(batch.length / 2);
    const left = batch.slice(0, mid);
    const right = batch.slice(mid);
    // Push right then left so `stack.pop()` processes the left half FIRST.
    stack.push(right, left);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Parse budget (twin-articles item, part B)
// ---------------------------------------------------------------------------
//
// Edge Functions are killed when one invocation burns too much CPU (HTTP 546,
// reason CPUTime), and a killed cycle loses everything it fetched. The CPU of
// a cycle is dominated by decoding, XML-parsing and normalising the feeds that
// CHANGED (a 304 or a body-hash hit costs almost nothing). The budget caps how
// many changed feeds, and how many body bytes, one cycle parses; the feeds it
// refuses are deferred, not dropped (see `prioritizeIds`).

export interface ParseBudget {
  /**
   * Asks whether a changed feed with a body of `bytes` may be parsed now, and
   * if so books it. `priority` marks a feed deferred by the previous cycle.
   * Rules, in order:
   *   1. `maxParses` reached -> refuse.
   *   2. nothing parsed yet this cycle -> admit, however big the body (a feed
   *      bigger than the byte budget would otherwise never be parsed).
   *   3. it fits (`bytes so far + bytes <= maxBytes`) -> admit.
   *   4. `priority` and no overshoot yet this cycle -> admit, once.
   *   5. otherwise refuse.
   * A refusal changes nothing. Pure and synchronous: it never throws.
   */
  admit(bytes: number, priority?: boolean): boolean;
  /** Parses admitted so far. */
  readonly parses: number;
  /** Body bytes admitted so far. */
  readonly bytes: number;
}

export function createParseBudget(maxParses: number, maxBytes: number): ParseBudget {
  let parses = 0;
  let used = 0;
  let overshot = false;
  return {
    admit(bytes: number, priority = false): boolean {
      if (parses >= maxParses) return false;
      if (parses === 0 || used + bytes <= maxBytes) {
        parses++;
        used += bytes;
        return true;
      }
      if (priority && !overshot) {
        overshot = true;
        parses++;
        used += bytes;
        return true;
      }
      return false;
    },
    get parses() {
      return parses;
    },
    get bytes() {
      return used;
    },
  };
}

/**
 * Stable reorder of `rows`: the rows whose `id` is in `ids` first, then the
 * rest, each group in its original order. Used to put the feeds the previous
 * cycle deferred at the front of this cycle's fetch order, so a deferred feed
 * is not starved by the rotation. Returns a new array; ids that match no row
 * are ignored.
 */
export function prioritizeIds<T extends { id: string }>(
  rows: readonly T[],
  ids: Iterable<string>,
): T[] {
  const first = new Set(ids);
  if (first.size === 0) return [...rows];
  const head: T[] = [];
  const tail: T[] = [];
  for (const row of rows) (first.has(row.id) ? head : tail).push(row);
  return [...head, ...tail];
}

/**
 * Stable reorder of `rows` for a fresh isolate: the sources whose
 * `fetch_last_at` is null (never fetched, or unparseable) or older than
 * `staleMs` go first, oldest first (a null counts as the oldest), then the rest
 * in their original order. Ties among the stale keep their input order.
 *
 * Why: a feed the parse or isolate budget refuses writes no fetch state, so the
 * age of `fetch_last_at` is the only deferral signal that outlives an isolate
 * (`parseDeferredIds` is module scope and is lost when the isolate recycles).
 * Put in front, the first stale feed meets a fresh isolate's `used === 0`
 * admission instead of waiting for the rotation to place it early. The default
 * is three cycle periods: a healthy feed is fetched, 200 or 304, every cycle, so
 * 9 minutes without a write means it was skipped or deferred. A future timestamp
 * (clock skew) is fresh. Returns a new array; the rows are the same objects.
 * Compose it BEFORE `prioritizeIds`, so a deferral remembered in memory still
 * goes first within an isolate.
 */
export function prioritizeStale<T extends { id: string; fetch_last_at?: string | null }>(
  rows: readonly T[],
  nowMs: number,
  staleMs: number = 3 * CYCLE_PERIOD_MS,
): T[] {
  const stale: Array<{ row: T; at: number }> = [];
  const fresh: T[] = [];
  for (const row of rows) {
    const raw = row.fetch_last_at;
    const parsed = typeof raw === "string" ? Date.parse(raw) : Number.NaN;
    if (Number.isNaN(parsed)) {
      stale.push({ row, at: Number.NEGATIVE_INFINITY });
    } else if (nowMs - parsed > staleMs) {
      stale.push({ row, at: parsed });
    } else {
      fresh.push(row);
    }
  }
  // Array.prototype.sort is stable (ES2019): equal ages keep their input order.
  // The comparison avoids -Infinity - -Infinity (NaN).
  stale.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1));
  return [...stale.map((s) => s.row), ...fresh];
}

// ---------------------------------------------------------------------------
// Isolate item budget (hunt-11, A-ingest-cpu)
// ---------------------------------------------------------------------------
//
// The parse budget above is per CYCLE. But the platform's 2 s CPU allowance is
// cumulative per ISOLATE, and an isolate is reused for several cycles: on
// 2026-11-01 (10:00-14:00 UTC) 12 isolates served two requests, and 7 of them
// were shut down (reason CPUTime, 2000-2176 ms) on the second one, always the
// later request; isolates that served one request were never killed. Nothing
// carried cost from one invocation to the next, so a cycle that fit its own
// budget still died on the CPU an earlier cycle of the same isolate had spent.
//
// The cost that matters is per ITEM (parse, prepare, lookup, and for the few
// new items the full normalisation), not per feed or per byte, so this budget
// counts items. A changed feed's item count is only known after the parse, so
// it is estimated from the body size beforehand (`estimateItems`) and replaced
// by the real count afterwards (`settle`). The state lives at module scope: it
// survives exactly as long as the isolate does and starts again at zero on a
// cold one. A feed that does not fit is deferred through the parse-deferral
// path the parse budget already uses (validators restored, first in line next
// cycle).

/**
 * Items one isolate may parse in total before it refuses more changed feeds.
 * Overridable per deployment with INGEST_ISOLATE_ITEM_BUDGET (read once per
 * cycle in index.ts); see the cost-model comment there for where the number
 * comes from.
 */
export const ISOLATE_ITEM_BUDGET = 5000;

/** Average bytes per feed item the estimate assumes (feed bodies carry about 1.5 kB per item). */
export const ESTIMATED_BYTES_PER_ITEM = 1500;

export interface IsolateItemState {
  /** Items booked on this isolate so far (estimates settled to real counts). */
  used: number;
  /** Cycles that ran on this isolate (information only). */
  cycles: number;
}

/** The module-scope state of THIS isolate. Tests pass their own object instead. */
export const isolateItems: IsolateItemState = { used: 0, cycles: 0 };

/**
 * Headroom over a feed's last known item count: the estimate may be at most
 * this much above what the feed held when it was last parsed (a feed grows a
 * little between polls; `settle` replaces the booking with the real count).
 */
export const KNOWN_ITEMS_HEADROOM = 1.25;

/**
 * The largest ratio of the size estimate to the capped known count that is still
 * read as "the same feed with fatter items" (BHA: 2,833 by size against a cap of
 * 1,250, a ratio of 2.27) rather than a feed that changed shape. Past it the
 * stored count is not believed and the size-only estimate stands, because the
 * body size is third-party input to the CPU guard and a stale count must not
 * shrink it (estimateItems(4_000_000, 12) is 2,666, not 15).
 */
export const KNOWN_ITEMS_MAX_SIZE_RATIO = 4;

/**
 * Items a feed body of `bytes` bytes is assumed to hold: `max(1, floor(bytes /
 * 1500))`. Never below 1, so even an empty-looking body books something; a
 * non-finite or negative size counts as 1.
 *
 * `knownItems` is the feed's last parsed item count (`sources.fetch_items_count`,
 * migration 119). When it is a positive integer the size estimate is capped at
 * `cap = ceil(knownItems * 1.25)`: a feed whose items are far bigger than 1.5 kB
 * (BHA: 4.25 MB for 1000 items, 4.2 kB each) would otherwise book 2,833 items
 * for a parse that costs 1,000, and `fits()` would refuse it on every isolate
 * that already holds more than 2,167 items (h36-pipeline-1). The cap is applied
 * only while the size estimate is at most `cap * KNOWN_ITEMS_MAX_SIZE_RATIO` (4):
 * a body far larger than the known count can explain is a feed that changed
 * shape, or one whose stored count is stale, and keeps the size-only estimate.
 * Anything else (null, undefined, 0, a fraction, NaN) also leaves the size-only
 * estimate. The cap only ever lowers an estimate, never raises it.
 */
export function estimateItems(bytes: number, knownItems?: number | null): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 1;
  const bySize = Math.max(1, Math.floor(bytes / ESTIMATED_BYTES_PER_ITEM));
  if (typeof knownItems === "number" && Number.isInteger(knownItems) && knownItems > 0) {
    const cap = Math.ceil(knownItems * KNOWN_ITEMS_HEADROOM);
    if (bySize <= cap * KNOWN_ITEMS_MAX_SIZE_RATIO) {
      return Math.max(1, Math.min(bySize, cap));
    }
  }
  return bySize;
}

export interface ItemBudget {
  /**
   * True when `n` more items may be parsed on this isolate: either nothing was
   * booked yet (a fresh isolate admits any one feed, however big, otherwise a
   * feed bigger than the whole budget would never be parsed), or the booked
   * items plus `n` stay within the limit. There is no priority exemption: a
   * feed the previous cycle deferred is first in line, but it still has to
   * fit. Pure; books nothing.
   */
  fits(n: number): boolean;
  /** Books `n` items (the estimate, before the parse). */
  book(n: number): void;
  /**
   * Replaces a booking of `booked` items with the `actual` count: adjusts
   * `used` by `actual - booked`, never below zero.
   */
  settle(booked: number, actual: number): void;
  /** Items booked on the shared state so far. */
  readonly used: number;
  readonly limit: number;
}

/**
 * A view of `state` with a `limit`. Several budgets over one state object add
 * up, which is how two cycles on one isolate share the allowance; the limit is
 * per budget, so a changed INGEST_ISOLATE_ITEM_BUDGET applies from the next
 * cycle.
 */
export function createItemBudget(limit: number, state: IsolateItemState): ItemBudget {
  return {
    fits(n: number): boolean {
      return state.used === 0 || state.used + n <= limit;
    },
    book(n: number): void {
      state.used += n;
    },
    settle(booked: number, actual: number): void {
      state.used = Math.max(0, state.used + (actual - booked));
    },
    get used() {
      return state.used;
    },
    limit,
  };
}
