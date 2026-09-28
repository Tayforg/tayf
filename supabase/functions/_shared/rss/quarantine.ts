// supabase/functions/_shared/rss/quarantine.ts
//
// Pure feed-quarantine state machine (ingest-fixes, migration 074).
//
// 23 dead feeds (14x403, 6x404, 2x status 0, 1x530), dead since 8 Sep, cost
// ~11,000 failed fetches/day -- every one of those fetches burns a pool
// worker slot and a Sentry capture for a feed that has never come back.
// `nextQuarantineState` tracks a per-source consecutive-failure streak and
// hands back an escalating backoff once that streak crosses
// `QUARANTINE_AFTER_FAILURES`; `isQuarantined` is the pure read-side check
// the ingest cycle's fetch fan-out consults before spending a pool slot on
// a source that is still inside its backoff window.
//
// A quarantined feed is deliberately NOT fetched while quarantined, so its
// streak can only advance on a "probe" -- the one fetch attempt made the
// cycle its `fetch_quarantined_until` expires. That is why the streak
// values below step 20 -> 1h, 21 -> 6h, >=22 -> 24h instead of accumulating
// every 3-minute cycle: a quarantined source simply isn't attempted, so
// there is no way to rack up hundreds of failures while parked.

export const QUARANTINE_AFTER_FAILURES = 20;

// 1h -> 6h -> 24h cap, indexed by `streak - QUARANTINE_AFTER_FAILURES`
// (clamped to the last entry for every streak beyond the third escalation).
export const QUARANTINE_BACKOFF_MS: readonly number[] = [
  3_600_000, // 1h
  21_600_000, // 6h
  86_400_000, // 24h
];

/**
 * True when `src.fetch_quarantined_until` is a still-future timestamp.
 * `null`/`undefined`/an unparseable string all resolve to `false` (not
 * quarantined) -- `Date.parse` on garbage input is `NaN`, and `NaN > nowMs`
 * is always `false`, so this never needs a separate NaN guard.
 */
export function isQuarantined(
  src: { fetch_quarantined_until?: string | null },
  nowMs: number,
): boolean {
  const until = src.fetch_quarantined_until;
  if (until == null) return false;
  return Date.parse(until) > nowMs;
}

export interface QuarantineState {
  fetch_fail_streak: number;
  fetch_quarantined_until: string | null;
}

/**
 * Computes the next persisted quarantine state for one source given its
 * previous streak and whether this cycle's attempt succeeded.
 *
 *   - `ok` (a parsed 2xx or a 304/body-hash "not modified") resets the
 *     streak to 0 and clears any quarantine.
 *   - a failure (a fetch error, including a 2xx that failed to parse)
 *     increments the streak. Below `QUARANTINE_AFTER_FAILURES` there is no
 *     quarantine yet; at or above it, `until` is set from
 *     `QUARANTINE_BACKOFF_MS`, indexed by how far past the threshold this
 *     failure is (clamped to the last -- longest -- backoff entry).
 */
export function nextQuarantineState(
  prevStreak: number | null | undefined,
  ok: boolean,
  nowMs: number,
): QuarantineState {
  if (ok) {
    return { fetch_fail_streak: 0, fetch_quarantined_until: null };
  }

  const streak = (prevStreak ?? 0) + 1;
  if (streak < QUARANTINE_AFTER_FAILURES) {
    return { fetch_fail_streak: streak, fetch_quarantined_until: null };
  }

  const backoffIndex = Math.min(
    streak - QUARANTINE_AFTER_FAILURES,
    QUARANTINE_BACKOFF_MS.length - 1,
  );
  const backoffMs = QUARANTINE_BACKOFF_MS[backoffIndex] ?? QUARANTINE_BACKOFF_MS[QUARANTINE_BACKOFF_MS.length - 1]!;
  return {
    fetch_fail_streak: streak,
    fetch_quarantined_until: new Date(nowMs + backoffMs).toISOString(),
  };
}
