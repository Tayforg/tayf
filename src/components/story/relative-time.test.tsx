import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatTurkishTimeAgo } from "@/lib/time";

import {
  DRIFT_THRESHOLD_MS,
  RelativeTime,
  TICK_MS,
  pickDisplayNow,
  startDisplayClock,
  type DisplayClockDeps,
} from "./relative-time";

// h34-perf-1: a fully static hub page (/gundem/[key]) prints "N saat önce"
// against the cached render's own clock, so a reader who lands on a stale
// entry sees ages up to an hour too young. RelativeTime renders the server
// text first (no hydration mismatch) and re-bases to the reader's clock after
// mount, only when the page is clearly old (> 120 s).
//
// The repo has no DOM test environment, so: the clock choice is a pure
// function, the effect logic is `startDisplayClock` driven with injected
// deps, and the server pass is rendered with react-dom/server.

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 5, 12, 0, 0); // 2026-11-05T12:00:00Z

describe("pickDisplayNow", () => {
  it("keeps the server clock while the client clock is within the threshold", () => {
    expect(pickDisplayNow(T0, T0)).toBe(T0);
    expect(pickDisplayNow(T0, T0 + 60_000)).toBe(T0);
  });

  it("keeps the server clock at exactly 120 s of drift and switches strictly above it", () => {
    expect(DRIFT_THRESHOLD_MS).toBe(120_000);
    expect(pickDisplayNow(T0, T0 + 120_000)).toBe(T0);
    expect(pickDisplayNow(T0, T0 + 120_001)).toBe(T0 + 120_001);
  });

  it("switches to the client clock for a page cached an hour ago", () => {
    expect(pickDisplayNow(T0, T0 + HOUR)).toBe(T0 + HOUR);
  });

  it("never moves backwards when the reader's clock is behind the server's", () => {
    expect(pickDisplayNow(T0, T0 - HOUR)).toBe(T0);
  });

  it("ignores a non-finite client clock", () => {
    expect(pickDisplayNow(T0, Number.NaN)).toBe(T0);
    expect(pickDisplayNow(T0, Number.POSITIVE_INFINITY)).toBe(T0);
  });

  it("falls back to the client clock when the server clock is not usable", () => {
    expect(pickDisplayNow(Number.NaN, T0)).toBe(T0);
  });
});

describe("RelativeTime server pass", () => {
  const iso = new Date(T0 - 13 * HOUR).toISOString();

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a <time dateTime> holding the Turkish age against nowMs", () => {
    vi.setSystemTime(T0);
    const html = renderToStaticMarkup(<RelativeTime iso={iso} nowMs={T0} />);
    expect(html).toBe(`<time dateTime="${iso}">13 saat önce</time>`);
    expect(html).toContain(formatTurkishTimeAgo(iso, { now: T0 }));
  });

  it("ignores the reader's clock on the server pass (identical markup, no hydration mismatch)", () => {
    vi.setSystemTime(T0);
    const atServer = renderToStaticMarkup(<RelativeTime iso={iso} nowMs={T0} />);
    // The reader opens the same cached HTML an hour later: the first client
    // render must still produce the server's markup byte for byte.
    vi.setSystemTime(T0 + HOUR);
    const atReader = renderToStaticMarkup(<RelativeTime iso={iso} nowMs={T0} />);
    expect(atReader).toBe(atServer);
    expect(atReader).toContain("13 saat önce");
  });

  it("renders an empty <time> for an unparseable timestamp, like the plain badge did", () => {
    expect(renderToStaticMarkup(<RelativeTime iso="not-a-date" nowMs={T0} />)).toBe(
      '<time dateTime="not-a-date"></time>',
    );
  });

  it("uses an absolute date past 48 h, as formatTurkishTimeAgo does", () => {
    const old = new Date(T0 - 72 * HOUR).toISOString();
    const html = renderToStaticMarkup(<RelativeTime iso={old} nowMs={T0} />);
    expect(html).toBe(`<time dateTime="${old}">${formatTurkishTimeAgo(old, { now: T0 })}</time>`);
    expect(html).not.toContain("önce");
  });
});

// A fake document: visibility flag plus the listeners subscribed to it.
function harness(startVisible = true) {
  let visible = startVisible;
  const listeners = new Set<() => void>();
  const seen: number[] = [];
  const deps: DisplayClockDeps = {
    now: () => Date.now(),
    isVisible: () => visible,
    setTimer: (fn, ms) => setInterval(fn, ms),
    clearTimer: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    subscribeVisibility: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onNow: (ms) => seen.push(ms),
  };
  return {
    deps,
    seen,
    listeners,
    setVisible(next: boolean) {
      visible = next;
      for (const cb of [...listeners]) cb();
    },
  };
}

describe("startDisplayClock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the server clock on mount when the page is fresh", () => {
    vi.setSystemTime(T0 + 30_000);
    const h = harness();
    const stop = startDisplayClock(T0, h.deps);
    expect(h.seen).toEqual([T0]);
    stop();
  });

  it("re-bases to Date.now() on mount when the page is older than 120 s", () => {
    vi.setSystemTime(T0 + HOUR);
    const h = harness();
    const stop = startDisplayClock(T0, h.deps);
    expect(h.seen).toEqual([T0 + HOUR]);
    stop();
  });

  it("ticks every 60 s while the tab is visible", () => {
    vi.setSystemTime(T0 + HOUR);
    const h = harness();
    const stop = startDisplayClock(T0, h.deps);
    expect(TICK_MS).toBe(60_000);
    vi.advanceTimersByTime(TICK_MS);
    vi.advanceTimersByTime(TICK_MS);
    expect(h.seen).toEqual([T0 + HOUR, T0 + HOUR + 60_000, T0 + HOUR + 120_000]);
    stop();
  });

  it("starts on the server clock and re-bases once the open tab drifts past 120 s", () => {
    vi.setSystemTime(T0 + 60_000);
    const h = harness();
    const stop = startDisplayClock(T0, h.deps);
    vi.advanceTimersByTime(TICK_MS); // drift 120 s: not strictly above
    vi.advanceTimersByTime(TICK_MS); // drift 180 s
    expect(h.seen).toEqual([T0, T0, T0 + 180_000]);
    stop();
  });

  it("arms no timer while the tab is hidden, and a hidden mount still re-bases once", () => {
    vi.setSystemTime(T0 + HOUR);
    const h = harness(false);
    const stop = startDisplayClock(T0, h.deps);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5 * TICK_MS);
    expect(h.seen).toEqual([T0 + HOUR]);
    stop();
  });

  it("clears the interval when the tab goes hidden and catches up when it is visible again", () => {
    vi.setSystemTime(T0 + HOUR);
    const h = harness();
    const stop = startDisplayClock(T0, h.deps);
    expect(vi.getTimerCount()).toBe(1);

    h.setVisible(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * TICK_MS);
    expect(h.seen).toEqual([T0 + HOUR]); // nothing ticked while hidden

    const back = Date.now();
    h.setVisible(true);
    // Immediate catch-up with the current clock, then the interval is armed again.
    expect(h.seen).toEqual([T0 + HOUR, back]);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(TICK_MS);
    expect(h.seen).toEqual([T0 + HOUR, back, back + TICK_MS]);
    stop();
  });

  it("does not stack intervals on repeated visible events", () => {
    vi.setSystemTime(T0 + HOUR);
    const h = harness();
    const stop = startDisplayClock(T0, h.deps);
    h.setVisible(true);
    h.setVisible(true);
    expect(vi.getTimerCount()).toBe(1);
    stop();
  });

  it("stop() clears the interval and unsubscribes, and is idempotent", () => {
    vi.setSystemTime(T0 + HOUR);
    const h = harness();
    const stop = startDisplayClock(T0, h.deps);
    expect(h.listeners.size).toBe(1);

    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.listeners.size).toBe(0);

    const before = h.seen.length;
    h.setVisible(false);
    h.setVisible(true);
    vi.advanceTimersByTime(5 * TICK_MS);
    expect(h.seen.length).toBe(before);
    expect(() => stop()).not.toThrow();
  });
});

// The hook wiring (useState seed, the document listener, the unmount cleanup)
// needs a browser; pin it by source text, comments blanked (house pattern, see
// kbd-shortcuts.test.tsx).
describe("relative-time.tsx wiring", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(join(here, "relative-time.tsx"), "utf8");
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));

  it("is a client module", () => {
    expect(raw.trimStart().startsWith('"use client"')).toBe(true);
  });

  it("seeds its state with the server's nowMs so the first render is the server text", () => {
    expect(code).toMatch(/useState\(\s*nowMs\s*\)/);
  });

  it("gates the clock on document.visibilityState and returns the cleanup from the effect", () => {
    expect(code).toContain('document.visibilityState === "visible"');
    expect(code).toMatch(/return\s+startDisplayClock\(/);
  });

  it("emits <time dateTime={iso}>", () => {
    expect(code).toMatch(/<time\s+dateTime=\{iso\}/);
  });

  it("only imports react and the dependency-free time helper (client bundle stays tiny)", () => {
    const imports = [...code.matchAll(/^import[^;]*?from\s+"([^"]+)";/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["@/lib/time", "react"]);
    const timeSrc = readFileSync(join(here, "..", "..", "lib", "time.ts"), "utf8");
    expect(timeSrc).not.toMatch(/^\s*import\s/m);
    expect(timeSrc).not.toMatch(/\brequire\(/);
  });
});
