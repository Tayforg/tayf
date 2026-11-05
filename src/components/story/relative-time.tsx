"use client";

import { useEffect, useState } from "react";

import { formatTurkishTimeAgo } from "@/lib/time";

// Time-ago badge for pages whose render is CACHED (h34-perf-1).
//
// A fully static hub page (/gundem/[key]) cannot read the clock while it
// prerenders, so it measures every age against `asOfMs`, the instant its
// cached read ran. A reader who lands on a stale entry after a quiet spell
// then sees "13 saat önce" for a story that is really 14.3 h old: the stale
// PPR shell and the stale "use cache" entry stack to about an hour.
//
// This component fixes the display, not the cache:
//   - the first render (server AND first client render) is exactly the
//     server's text, so hydration cannot mismatch;
//   - after mount it re-bases to the reader's clock, but only when that clock
//     is more than DRIFT_THRESHOLD_MS ahead of `nowMs`. A fresh page keeps
//     the server string untouched (no flicker, no reflow);
//   - it then re-checks every TICK_MS, and only while the tab is visible. The
//     timer is cleared when the tab hides and on unmount.
//
// Pages that render per request (home, /blindspots, /konu) do not pass `nowMs`
// to ClusterCard and keep the plain server string; they never use this.
//
// Imports stay tiny on purpose: react plus @/lib/time, which has no imports of
// its own (guarded in relative-time.test.tsx), so the client chunk is a few
// hundred bytes.

/** The reader's clock must lead the server's by MORE than this to be used. */
export const DRIFT_THRESHOLD_MS = 120_000;

/** Re-check period while the tab is visible. */
export const TICK_MS = 60_000;

/**
 * Which "now" to print ages against. The server's `nowMs` unless the reader's
 * clock is more than DRIFT_THRESHOLD_MS ahead of it. Never returns an earlier
 * time than `serverNowMs` for a usable server clock (a reader whose clock runs
 * behind keeps the server's reading), and a non-finite input is ignored.
 */
export function pickDisplayNow(serverNowMs: number, clientNowMs: number): number {
  if (!Number.isFinite(serverNowMs)) return clientNowMs;
  if (!Number.isFinite(clientNowMs)) return serverNowMs;
  return clientNowMs - serverNowMs > DRIFT_THRESHOLD_MS ? clientNowMs : serverNowMs;
}

/** Everything `startDisplayClock` touches, injected so it runs without a DOM. */
export interface DisplayClockDeps {
  now: () => number;
  isVisible: () => boolean;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Calls `cb` on every visibility change; returns the unsubscribe. */
  subscribeVisibility: (cb: () => void) => () => void;
  /** Receives the clock to print ages against (see pickDisplayNow). */
  onNow: (ms: number) => void;
}

/**
 * Drives the badge's clock. Applies the drift check once straight away, then
 * every TICK_MS while the tab is visible. Hiding the tab clears the timer;
 * showing it again re-checks at once (the tab may have slept for hours) and
 * re-arms it. The returned `stop()` clears the timer and unsubscribes; it is
 * idempotent.
 */
export function startDisplayClock(serverNowMs: number, deps: DisplayClockDeps): () => void {
  let stopped = false;
  let timer: unknown = null;
  let armed = false;

  const check = (): void => {
    deps.onNow(pickDisplayNow(serverNowMs, deps.now()));
  };

  const disarm = (): void => {
    if (!armed) return;
    deps.clearTimer(timer);
    timer = null;
    armed = false;
  };

  const arm = (): void => {
    if (armed) return;
    timer = deps.setTimer(check, TICK_MS);
    armed = true;
  };

  const onVisibilityChange = (): void => {
    if (stopped) return;
    if (deps.isVisible()) {
      check();
      arm();
    } else {
      disarm();
    }
  };

  check();
  if (deps.isVisible()) arm();
  const unsubscribe = deps.subscribeVisibility(onVisibilityChange);

  return () => {
    if (stopped) return;
    stopped = true;
    disarm();
    unsubscribe();
  };
}

interface RelativeTimeProps {
  /** ISO timestamp the age is counted from. */
  iso: string;
  /** The server's "now" (epoch ms): the cached read's own timestamp. */
  nowMs: number;
}

export function RelativeTime({ iso, nowMs }: RelativeTimeProps) {
  // `picked` is the clock the reader's tab has settled on; it starts as the
  // server's, so the first render is the server text. Printing the larger of
  // `picked` and `nowMs` keeps a fresh `nowMs` (router.refresh brings new
  // props) from losing to an older `picked`.
  const [picked, setPicked] = useState(nowMs);

  useEffect(() => {
    return startDisplayClock(nowMs, {
      now: () => Date.now(),
      isVisible: () => document.visibilityState === "visible",
      setTimer: (fn, ms) => window.setInterval(fn, ms),
      clearTimer: (handle) => window.clearInterval(handle as number),
      subscribeVisibility: (cb) => {
        document.addEventListener("visibilitychange", cb);
        return () => document.removeEventListener("visibilitychange", cb);
      },
      onNow: setPicked,
    });
  }, [nowMs]);

  const now = picked > nowMs ? picked : nowMs;
  return <time dateTime={iso}>{formatTurkishTimeAgo(iso, { now })}</time>;
}
