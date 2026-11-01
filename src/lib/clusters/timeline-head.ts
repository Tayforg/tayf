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
 * How many head rows the rendered page does not have: ids outside `knownIds`
 * whose first_published is at or after the newest the page shows (a tie counts:
 * a sibling minted in the same instant is still new). With no newest (the page
 * rendered empty) every unknown row counts. An unparseable `newestPublished`
 * counts nothing -- better no pill than a false one.
 */
export function countNewClusters(
  head: ReadonlyArray<TimelineHeadRow>,
  ctx: { newestPublished: string | null; knownIds: ReadonlySet<string> },
): number {
  let floor = Number.NEGATIVE_INFINITY;
  if (ctx.newestPublished !== null) {
    floor = Date.parse(ctx.newestPublished);
    if (!Number.isFinite(floor)) return 0;
  }
  const fresh = new Set<string>();
  for (const row of head) {
    if (ctx.knownIds.has(row.id)) continue;
    const t = Date.parse(row.first_published);
    if (!Number.isFinite(t) || t < floor) continue;
    fresh.add(row.id);
  }
  return fresh.size;
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
