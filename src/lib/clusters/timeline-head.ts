// Pure helpers behind the /timeline "N yeni küme · Yenile" pill: realtime-lite
// without Supabase Realtime. A tiny client component polls a CDN-cached head
// endpoint (/api/timeline/head) and, when it sees clusters the rendered page
// does not have, offers a one-click router.refresh().
//
// No React and no Next in here on purpose. Every side effect of the poller
// (fetch, clock, timers, tab visibility) is a dependency, so the schedule is
// unit-tested with fake timers and a fake tab instead of a DOM.
//
// Ordering and "newer" use `first_published` -- the page's own sort -- never
// `updated_at`: a cluster that merely gained an article must not light the pill.

/** Rows the head endpoint returns, and the page hands to the pill as known ids. */
export const TIMELINE_HEAD_LIMIT = 50;
/** Steady-state gap between polls while the tab is visible. */
export const TIMELINE_POLL_MS = 120_000;
/** Backoff ceiling (16 min). */
export const TIMELINE_POLL_MAX_MS = 960_000;
/** No delay is ever shorter than this, whatever a header or counter says. */
export const TIMELINE_POLL_MIN_MS = 60_000;

/**
 * Wait before the pill's one automatic retry of an unchanged refresh
 * (h76-timeline-1). A click that lands on a stale ISR copy is served the old
 * page, and that request starts the rebuild in the background; the next request
 * after the rebuild gets the new copy. Observed 2026-11-08: stale at 18:41:53Z,
 * rebuilt by 18:42:12Z (an upper bound; the rebuild time itself was not
 * measured). 4 s is a pause for the rebuild to land that still reads as one
 * click. If it has not landed, the pill says so ("unchanged") and the reader
 * clicks again. A single retry, never a loop.
 */
export const TIMELINE_REFRESH_RETRY_MS = 4000;

/** How long the pill's outcome text ("Liste güncellendi" / "Liste henüz güncellenmedi") stays up. */
export const PILL_STATUS_MS = 6000;

/**
 * Time left until `deadlineAt`, for re-arming a timer that was cleared while the
 * page sat in a hidden <Activity> boundary (react-L1): `deadlineAt - now` while
 * the deadline has not passed (0 exactly at it), and `null` once it has, so the
 * caller drops the action instead of firing it late. `null` too when either
 * input is not a finite number: no clock reading, no wait.
 */
export function remainingMs(deadlineAt: number, now: number): number | null {
  if (!Number.isFinite(deadlineAt) || !Number.isFinite(now)) return null;
  return now <= deadlineAt ? deadlineAt - now : null;
}

/** The only two fields the public head endpoint exposes. */
export type TimelineHeadRow = { id: string; first_published: string };

const MAX_ID_LENGTH = 64;

/**
 * Head of the feed for the wire: the first 50 rows, reduced to id and
 * first_published. Titles and counts must not leak through the public,
 * CDN-cached probe.
 */
export function toTimelineHead<T extends TimelineHeadRow>(
  rows: ReadonlyArray<T>,
): TimelineHeadRow[] {
  return rows
    .slice(0, TIMELINE_HEAD_LIMIT)
    .map((r) => ({ id: r.id, first_published: r.first_published }));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validates a head response body: `{ clusters: [...] }`, at most 50 rows, each
 * with a non-empty id (<= 64 chars) and a parseable first_published. ONE bad row
 * or a bad shape rejects the lot (null): a half-trusted head could light the
 * pill for a cluster the page cannot show. Unknown keys on a row are dropped.
 */
export function parseTimelineHead(json: unknown): TimelineHeadRow[] | null {
  if (!isRecord(json)) return null;
  const clusters = json.clusters;
  if (!Array.isArray(clusters) || clusters.length > TIMELINE_HEAD_LIMIT) {
    return null;
  }
  const out: TimelineHeadRow[] = [];
  for (const raw of clusters as unknown[]) {
    if (!isRecord(raw)) return null;
    const { id, first_published } = raw;
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) {
      return null;
    }
    if (
      typeof first_published !== "string" ||
      !Number.isFinite(Date.parse(first_published))
    ) {
      return null;
    }
    out.push({ id, first_published });
  }
  return out;
}

/**
 * How many head rows the rendered page does not have: unique ids outside
 * `knownIds` whose first_published is STRICTLY after `floorPublished`.
 *
 * `floorPublished` is the page's 50th row (the last row the head's 50-row window
 * can hold) when the page rendered at least TIMELINE_HEAD_LIMIT rows, and null
 * otherwise; with no floor every unknown head row counts.
 *
 * Why the 50th row and not the newest one (h103-timeline-1): a cluster enters the
 * feed when it reaches article_count >= 2, that is when its SECOND source is
 * ingested, a median of 39 min after its first_published. A newly visible cluster
 * therefore usually carries a first_published older than a cluster that is
 * already on the page, and a floor at the page's newest row skipped it (about half
 * of all new clusters): it appeared silently inside a closed hour section. The
 * head and the page read the same 24 h entry, so an unknown head row can only be
 *   - a newly minted or newly visible cluster: counts, or
 *   - page row 51+ moving up into the head's 50-row window after a row above it
 *     was archived: never newer than the page's 50th row, so it does not count.
 * The floor tells these apart; the newest row does not. The tie rule moved with
 * it: a row at exactly the floor is not counted, because it may be page row 51.
 *
 * An unparseable `floorPublished` counts nothing -- better no pill than a false
 * one.
 */
export function countNewClusters(
  head: ReadonlyArray<TimelineHeadRow>,
  ctx: { floorPublished: string | null; knownIds: ReadonlySet<string> },
): number {
  let floor = Number.NEGATIVE_INFINITY;
  if (ctx.floorPublished !== null) {
    floor = Date.parse(ctx.floorPublished);
    if (!Number.isFinite(floor)) return 0;
  }
  const fresh = new Set<string>();
  for (const row of head) {
    if (ctx.knownIds.has(row.id)) continue;
    const t = Date.parse(row.first_published);
    if (!Number.isFinite(t) || t <= floor) continue;
    fresh.add(row.id);
  }
  return fresh.size;
}

/**
 * A fingerprint of what the rendered page shows, for telling whether a
 * router.refresh() actually brought a different page: the newest
 * first_published, how many ids, and the ids themselves (the first <= 50 rows,
 * newest first). A new cluster lands at the top, so it changes the first id, the
 * length and usually the newest; anything that does not change the list leaves
 * the string alone. `null` (an empty page) is its own value, and the length sits
 * between the fields so one id list can never run into another. Pure; does not
 * mutate `knownIds`.
 */
export function pageSignature(
  newestPublished: string | null,
  knownIds: readonly string[],
): string {
  const newest = newestPublished === null ? "null" : `s:${newestPublished}`;
  return `${newest}#${knownIds.length}#${knownIds.join(",")}`;
}

/** What a finished refresh amounts to: `changed`, worth retrying once (`retry`), or `unchanged` for good. */
export type RefreshOutcome = "changed" | "retry" | "unchanged";

/**
 * Verdict on a finished router.refresh(), from the page signature before the
 * click and after the refresh settled. A different signature is `changed`. The
 * same one on the first attempt is `retry` (the stale ISR copy was served once
 * and is rebuilding); the same one on the retry is `unchanged`, which the pill
 * must say out loud instead of confirming a list that did not move. A NaN or
 * negative `attempt` counts as 0.
 */
export function refreshOutcome(
  before: string,
  after: string,
  attempt: number,
): RefreshOutcome {
  if (before !== after) return "changed";
  const n = Number.isNaN(attempt) || attempt < 0 ? 0 : attempt;
  return n >= 1 ? "unchanged" : "retry";
}

/** "7 yeni küme", capped at "50+ yeni küme" (the head holds 50 rows). */
export function newClustersLabel(n: number): string {
  return n >= TIMELINE_HEAD_LIMIT
    ? `${TIMELINE_HEAD_LIMIT}+ yeni küme`
    : `${n} yeni küme`;
}

/**
 * Delay before the next poll: 120 s doubled per consecutive failure, capped at
 * 960 s. A finite, positive Retry-After (ms) can only lengthen it (still capped
 * at 960 s). Never below 60 s, whatever it is fed.
 */
export function nextPollDelay(failures: number, retryAfterMs?: number): number {
  const f = Number.isNaN(failures) || failures < 0 ? 0 : failures;
  let delay = Math.min(TIMELINE_POLL_MS * 2 ** f, TIMELINE_POLL_MAX_MS);
  if (
    retryAfterMs !== undefined &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs > 0
  ) {
    delay = Math.min(Math.max(delay, retryAfterMs), TIMELINE_POLL_MAX_MS);
  }
  return Math.max(delay, TIMELINE_POLL_MIN_MS);
}

export type HeadFetchResult =
  | { ok: true; rows: TimelineHeadRow[] }
  | { ok: false; retryAfterMs?: number };

/** The slice of `Response` the poller reads (so tests need no real fetch). */
export interface HeadResponseLike {
  ok: boolean;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

/**
 * A fetch response as a poll result: a 2xx whose body parses is `{ ok: true }`;
 * anything else (non-2xx, bad JSON, bad shape) is `{ ok: false }`, carrying the
 * server's Retry-After (whole seconds -> ms) when it sent a usable one.
 */
export async function readHeadResponse(
  res: HeadResponseLike,
): Promise<HeadFetchResult> {
  if (res.ok) {
    try {
      const rows = parseTimelineHead(await res.json());
      if (rows !== null) return { ok: true, rows };
    } catch {
      // Not JSON: same as a bad shape.
    }
  }
  const seconds = Number(res.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds > 0
    ? { ok: false, retryAfterMs: seconds * 1000 }
    : { ok: false };
}

export interface HeadPollingDeps {
  fetchHead: (signal: AbortSignal) => Promise<HeadFetchResult>;
  onRows: (rows: TimelineHeadRow[]) => void;
  isVisible: () => boolean;
  /** Registers a visibility-change listener; returns its unsubscribe. */
  subscribeVisibility: (cb: () => void) => () => void;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

/**
 * Visibility-aware head poller. Returns `stop`.
 *
 * - The first poll is a full POLL_MS after start, never on mount.
 * - A hidden tab never fetches: going hidden clears the timer, and a timer that
 *   fires while hidden does nothing. Going visible polls at once if the next
 *   poll is already due, otherwise it schedules only the time remaining -- so
 *   flipping tabs cannot be used to dodge (or hammer) the cadence or a backoff.
 * - At most one request is in flight.
 * - Success resets the failure count and hands the rows to `onRows`; failure
 *   (a `{ ok: false }` result or a rejection) counts up. Every next poll is
 *   scheduled with `nextPollDelay`.
 * - `stop()` clears the timer, aborts the in-flight request (its result is
 *   dropped) and unsubscribes. It is idempotent.
 */
export function startHeadPolling(deps: HeadPollingDeps): () => void {
  let stopped = false;
  let timer: unknown = null;
  let timerPending = false;
  let inFlight: AbortController | null = null;
  let failures = 0;
  let retryAfterMs: number | undefined;
  // Mount counts as an attempt: that is what makes the first poll wait POLL_MS
  // even when the tab turns visible a moment after mount.
  let lastAttempt = deps.now();

  const currentDelay = () => nextPollDelay(failures, retryAfterMs);

  function clear(): void {
    if (timerPending) {
      deps.clearTimer(timer);
      timerPending = false;
      timer = null;
    }
  }

  function schedule(ms: number): void {
    clear();
    timer = deps.setTimer(onTimer, ms);
    timerPending = true;
  }

  function onTimer(): void {
    timerPending = false;
    timer = null;
    if (stopped || inFlight !== null || !deps.isVisible()) return;
    void poll();
  }

  async function poll(): Promise<void> {
    const controller = new AbortController();
    inFlight = controller;
    lastAttempt = deps.now();

    let result: HeadFetchResult;
    try {
      result = await deps.fetchHead(controller.signal);
    } catch {
      result = { ok: false };
    }

    // stop() ran (and aborted us) while the request was out: drop the result.
    if (stopped || inFlight !== controller) return;
    inFlight = null;

    if (result.ok) {
      failures = 0;
      retryAfterMs = undefined;
      try {
        deps.onRows(result.rows);
      } catch {
        // A throwing consumer must not stop the loop.
      }
    } else {
      failures += 1;
      retryAfterMs = result.retryAfterMs;
    }

    // Hidden: stay quiet; the visibility handler re-arms on return.
    if (!stopped && deps.isVisible()) schedule(currentDelay());
  }

  function onVisibilityChange(): void {
    if (stopped) return;
    if (!deps.isVisible()) {
      clear();
      return;
    }
    if (inFlight !== null || timerPending) return;
    const delay = currentDelay();
    // Clamped so a clock that jumped backwards cannot park the poller for ages.
    const remaining = Math.min(lastAttempt + delay - deps.now(), delay);
    if (remaining <= 0) void poll();
    else schedule(remaining);
  }

  const unsubscribe = deps.subscribeVisibility(onVisibilityChange);
  if (deps.isVisible()) schedule(currentDelay());

  return function stop(): void {
    if (stopped) return;
    stopped = true;
    clear();
    if (inFlight !== null) {
      inFlight.abort();
      inFlight = null;
    }
    unsubscribe();
  };
}
