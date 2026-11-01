import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TIMELINE_HEAD_LIMIT,
  TIMELINE_POLL_MAX_MS,
  TIMELINE_POLL_MIN_MS,
  TIMELINE_POLL_MS,
  countNewClusters,
  newClustersLabel,
  nextPollDelay,
  parseTimelineHead,
  readHeadResponse,
  startHeadPolling,
  toTimelineHead,
  type HeadFetchResult,
  type HeadPollingDeps,
  type TimelineHeadRow,
} from "./timeline-head";

// ---------------------------------------------------------------------------
// Pure helpers behind the /timeline "N yeni küme · Yenile" pill. No React, no
// Next: the poller takes every side effect (fetch, clock, timers, visibility)
// as a dependency, so these tests drive it with fake timers and a fake tab.
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-09-18T10:00:00.000Z");

function row(i: number, minutesAgo = i): TimelineHeadRow {
  return {
    id: `c${i}`,
    first_published: new Date(T0 - minutesAgo * 60_000).toISOString(),
  };
}

describe("constants", () => {
  it("pins the documented limits", () => {
    expect(TIMELINE_HEAD_LIMIT).toBe(50);
    expect(TIMELINE_POLL_MS).toBe(120_000);
    expect(TIMELINE_POLL_MAX_MS).toBe(960_000);
    expect(TIMELINE_POLL_MIN_MS).toBe(60_000);
  });
});

describe("toTimelineHead", () => {
  it("keeps only id and first_published (titles and counts must not leak)", () => {
    const out = toTimelineHead([
      {
        id: "a",
        first_published: "2026-09-18T10:00:00.000Z",
        title_tr: "Gizli başlık",
        title_tr_neutral: null,
        article_count: 7,
      },
    ]);
    expect(out).toEqual([{ id: "a", first_published: "2026-09-18T10:00:00.000Z" }]);
    expect(Object.keys(out[0] ?? {}).sort()).toEqual(["first_published", "id"]);
    expect(JSON.stringify(out)).not.toContain("Gizli");
  });

  it("returns at most the first 50 rows, in order", () => {
    const rows = Array.from({ length: 200 }, (_, i) => row(i));
    const out = toTimelineHead(rows);
    expect(out).toHaveLength(50);
    expect(out[0]?.id).toBe("c0");
    expect(out[49]?.id).toBe("c49");
  });

  it("handles an empty list and a short list", () => {
    expect(toTimelineHead([])).toEqual([]);
    expect(toTimelineHead([row(1), row(2)])).toHaveLength(2);
  });

  it("does not mutate its input", () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(i));
    toTimelineHead(rows);
    expect(rows).toHaveLength(60);
  });
});

describe("parseTimelineHead", () => {
  const ok = { clusters: [row(1), row(2)] };

  it("accepts a well-formed body", () => {
    expect(parseTimelineHead(ok)).toEqual(ok.clusters);
  });

  it("accepts an empty list", () => {
    expect(parseTimelineHead({ clusters: [] })).toEqual([]);
  });

  it("drops unknown keys from rows it accepts", () => {
    const parsed = parseTimelineHead({
      clusters: [{ ...row(1), title_tr: "x" }],
    });
    expect(parsed).toEqual([row(1)]);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "clusters"],
    ["a number", 42],
    ["an array", [row(1)]],
    ["an object without clusters", {}],
    ["clusters that is not an array", { clusters: "nope" }],
    ["clusters that is an object", { clusters: { 0: row(1) } }],
  ])("rejects %s", (_label, input) => {
    expect(parseTimelineHead(input)).toBeNull();
  });

  it.each([
    ["a null row", [null]],
    ["a primitive row", ["c1"]],
    ["a missing id", [{ first_published: "2026-09-18T10:00:00.000Z" }]],
    ["an empty id", [{ id: "", first_published: "2026-09-18T10:00:00.000Z" }]],
    ["a numeric id", [{ id: 5, first_published: "2026-09-18T10:00:00.000Z" }]],
    [
      "an id longer than 64 chars",
      [{ id: "x".repeat(65), first_published: "2026-09-18T10:00:00.000Z" }],
    ],
    ["a missing date", [{ id: "a" }]],
    ["a non-string date", [{ id: "a", first_published: 1_700_000_000_000 }]],
    ["an unparseable date", [{ id: "a", first_published: "yesterday" }]],
    ["an empty date", [{ id: "a", first_published: "" }]],
  ])("rejects the whole body for %s", (_label, clusters) => {
    expect(parseTimelineHead({ clusters })).toBeNull();
  });

  it("rejects the whole body when ONE row among good ones is bad", () => {
    expect(
      parseTimelineHead({ clusters: [row(1), { id: "b", first_published: "nope" }, row(3)] }),
    ).toBeNull();
  });

  it("accepts an id of exactly 64 chars", () => {
    const id = "x".repeat(64);
    expect(
      parseTimelineHead({ clusters: [{ id, first_published: "2026-09-18T10:00:00.000Z" }] }),
    ).toEqual([{ id, first_published: "2026-09-18T10:00:00.000Z" }]);
  });

  it("accepts exactly 50 rows and rejects 51", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => row(i));
    expect(parseTimelineHead({ clusters: fifty })).toHaveLength(50);
    expect(parseTimelineHead({ clusters: [...fifty, row(50)] })).toBeNull();
  });
});

describe("countNewClusters", () => {
  const newest = new Date(T0).toISOString();

  it("counts unknown rows published at or after the newest the page shows", () => {
    const head = [row(1, -5), row(2, -1), row(0, 0)];
    // c0 is the one the page already shows; c1 and c2 are newer.
    expect(
      countNewClusters(head, { newestPublished: newest, knownIds: new Set(["c0"]) }),
    ).toBe(2);
  });

  it("counts a tie (same first_published, unknown id) as new", () => {
    const head = [{ id: "tie", first_published: newest }];
    expect(
      countNewClusters(head, { newestPublished: newest, knownIds: new Set() }),
    ).toBe(1);
  });

  it("does not count known ids, even if they are newer", () => {
    const head = [row(1, -10)];
    expect(
      countNewClusters(head, { newestPublished: newest, knownIds: new Set(["c1"]) }),
    ).toBe(0);
  });

  it("does not count older unknown rows (a cluster that fell out of the page)", () => {
    const head = [row(7, 30), row(8, 60)];
    expect(
      countNewClusters(head, { newestPublished: newest, knownIds: new Set() }),
    ).toBe(0);
  });

  it("when the page is empty (newest null) every unknown row counts", () => {
    const head = [row(1), row(2), row(3)];
    expect(
      countNewClusters(head, { newestPublished: null, knownIds: new Set(["c2"]) }),
    ).toBe(2);
  });

  it("returns 0 for an empty head", () => {
    expect(countNewClusters([], { newestPublished: newest, knownIds: new Set() })).toBe(0);
    expect(countNewClusters([], { newestPublished: null, knownIds: new Set() })).toBe(0);
  });

  it("returns 0 rather than a false pill when the page timestamp is unparseable", () => {
    expect(
      countNewClusters([row(1, -5)], { newestPublished: "garbage", knownIds: new Set() }),
    ).toBe(0);
  });

  it("counts an id once even if the head repeats it", () => {
    const dup = row(1, -5);
    expect(
      countNewClusters([dup, dup], { newestPublished: newest, knownIds: new Set() }),
    ).toBe(1);
  });
});

describe("newClustersLabel", () => {
  it("names the count", () => {
    expect(newClustersLabel(1)).toBe("1 yeni küme");
    expect(newClustersLabel(7)).toBe("7 yeni küme");
    expect(newClustersLabel(49)).toBe("49 yeni küme");
  });

  it("caps at 50+", () => {
    expect(newClustersLabel(50)).toBe("50+ yeni küme");
    expect(newClustersLabel(51)).toBe("50+ yeni küme");
    expect(newClustersLabel(10_000)).toBe("50+ yeni küme");
  });
});

describe("nextPollDelay", () => {
  it("doubles per failure from 120 s and caps at 960 s", () => {
    expect(nextPollDelay(0)).toBe(120_000);
    expect(nextPollDelay(1)).toBe(240_000);
    expect(nextPollDelay(2)).toBe(480_000);
    expect(nextPollDelay(3)).toBe(960_000);
    expect(nextPollDelay(4)).toBe(960_000);
    expect(nextPollDelay(50)).toBe(960_000);
  });

  it("honours a Retry-After above the backoff, capped at the max", () => {
    expect(nextPollDelay(1, 300_000)).toBe(300_000);
    expect(nextPollDelay(0, 600_000)).toBe(600_000);
    expect(nextPollDelay(1, 1e9)).toBe(960_000);
  });

  it("ignores a Retry-After below the backoff", () => {
    expect(nextPollDelay(2, 90_000)).toBe(480_000);
  });

  it("is never below 60 s whatever it is fed", () => {
    for (let failures = 0; failures <= 10; failures++) {
      for (const retryAfter of [undefined, -1, 0, Number.NaN, 1e9, Infinity, -Infinity]) {
        const d = nextPollDelay(failures, retryAfter);
        expect(d).toBeGreaterThanOrEqual(60_000);
        expect(d).toBeLessThanOrEqual(960_000);
        expect(Number.isFinite(d)).toBe(true);
      }
    }
  });

  it("treats bad failure counts as 0", () => {
    expect(nextPollDelay(-3)).toBe(120_000);
    expect(nextPollDelay(Number.NaN)).toBe(120_000);
  });
});

describe("readHeadResponse", () => {
  const body = { clusters: [row(1)] };

  function res(init: {
    ok?: boolean;
    retryAfter?: string | null;
    json?: () => Promise<unknown>;
  }) {
    return {
      ok: init.ok ?? true,
      headers: { get: (name: string) => (name === "Retry-After" ? (init.retryAfter ?? null) : null) },
      json: init.json ?? (() => Promise.resolve(body)),
    };
  }

  it("returns the parsed rows on a good 200", async () => {
    await expect(readHeadResponse(res({}))).resolves.toEqual({ ok: true, rows: body.clusters });
  });

  it("returns a failure with Retry-After in ms on a 429/503", async () => {
    await expect(readHeadResponse(res({ ok: false, retryAfter: "120" }))).resolves.toEqual({
      ok: false,
      retryAfterMs: 120_000,
    });
  });

  it("returns a failure without a usable Retry-After when the header is missing", async () => {
    const r = await readHeadResponse(res({ ok: false }));
    expect(r.ok).toBe(false);
    const ms = (r as { retryAfterMs?: number }).retryAfterMs;
    expect(ms === undefined || !(ms > 0)).toBe(true);
  });

  it("returns a failure when the 200 body does not parse", async () => {
    const r = await readHeadResponse(res({ json: () => Promise.resolve({ clusters: "x" }) }));
    expect(r.ok).toBe(false);
  });

  it("returns a failure when the body is not JSON", async () => {
    const r = await readHeadResponse(res({ json: () => Promise.reject(new SyntaxError("bad")) }));
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// startHeadPolling
// ---------------------------------------------------------------------------

interface Harness {
  deps: HeadPollingDeps;
  fetchHead: ReturnType<typeof vi.fn>;
  onRows: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  /** Time (ms since start) of each fetch. */
  fetchTimes: number[];
  signals: AbortSignal[];
  setVisible: (v: boolean, fire?: boolean) => void;
  visibilityListeners: () => number;
  start: number;
}

function harness(opts: {
  visible?: boolean;
  results?: HeadFetchResult[];
  fetchImpl?: (signal: AbortSignal) => Promise<HeadFetchResult>;
}): Harness {
  let visible = opts.visible ?? true;
  const listeners = new Set<() => void>();
  const results = [...(opts.results ?? [])];
  const start = Date.now();
  const fetchTimes: number[] = [];
  const signals: AbortSignal[] = [];
  const unsubscribe = vi.fn();

  const fetchHead = vi.fn((signal: AbortSignal) => {
    fetchTimes.push(Date.now() - start);
    signals.push(signal);
    if (opts.fetchImpl) return opts.fetchImpl(signal);
    const next = results.shift() ?? ({ ok: true, rows: [] } as HeadFetchResult);
    return Promise.resolve(next);
  });
  const onRows = vi.fn();

  const deps: HeadPollingDeps = {
    fetchHead,
    onRows,
    isVisible: () => visible,
    subscribeVisibility: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        unsubscribe();
      };
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };

  return {
    deps,
    fetchHead,
    onRows,
    unsubscribe,
    fetchTimes,
    signals,
    start,
    visibilityListeners: () => listeners.size,
    setVisible: (v, fire = true) => {
      visible = v;
      if (fire) for (const cb of [...listeners]) cb();
    },
  };
}

describe("startHeadPolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never polls on mount: the first poll waits a full POLL_MS", async () => {
    const h = harness({});
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchHead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS - 1);
    expect(h.fetchHead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchHead).toHaveBeenCalledTimes(1);
    stop();
  });

  it("10 minutes visible gives exactly 5 fetches, 120 s apart", async () => {
    const h = harness({});
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.fetchHead).toHaveBeenCalledTimes(5);
    expect(h.fetchTimes).toEqual([120_000, 240_000, 360_000, 480_000, 600_000]);
    stop();
  });

  it("hands the rows of a successful poll to onRows", async () => {
    const rows = [row(1), row(2)];
    const h = harness({ results: [{ ok: true, rows }] });
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS);
    expect(h.onRows).toHaveBeenCalledTimes(1);
    expect(h.onRows).toHaveBeenCalledWith(rows);
    stop();
  });

  it("hidden the whole time: 0 fetches", async () => {
    const h = harness({ visible: false });
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.fetchHead).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("becoming visible after 5 min fetches once immediately, then every 120 s", async () => {
    const h = harness({ visible: false });
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.fetchHead).not.toHaveBeenCalled();

    h.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchTimes).toEqual([300_000]);

    await vi.advanceTimersByTimeAsync(119_999);
    expect(h.fetchHead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchHead).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.fetchHead).toHaveBeenCalledTimes(3);
    expect(h.fetchTimes).toEqual([300_000, 420_000, 540_000]);
    stop();
  });

  it("a timer that fires while hidden fetches nothing", async () => {
    const h = harness({});
    const stop = startHeadPolling(h.deps);
    // Hidden WITHOUT a visibility event (the timer must still check).
    h.setVisible(false, false);
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS * 3);
    expect(h.fetchHead).not.toHaveBeenCalled();
    stop();
  });

  it("going hidden clears the pending timer", async () => {
    const h = harness({});
    const stop = startHeadPolling(h.deps);
    expect(vi.getTimerCount()).toBe(1);
    h.setVisible(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS * 2);
    expect(h.fetchHead).not.toHaveBeenCalled();
    stop();
  });

  it("going visible early schedules only the remaining time, not a fresh 120 s", async () => {
    const h = harness({});
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(30_000);
    h.setVisible(false);
    await vi.advanceTimersByTimeAsync(30_000);
    h.setVisible(true); // 60 s since the (mount) attempt: 60 s remain
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchHead).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.fetchHead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchTimes).toEqual([120_000]);
    stop();
  });

  it("going visible exactly POLL_MS after the last attempt polls immediately", async () => {
    const h = harness({});
    const stop = startHeadPolling(h.deps);
    h.setVisible(false);
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS);
    h.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchTimes).toEqual([TIMELINE_POLL_MS]);
    stop();
  });

  it("a redundant visible event does not stack timers or fetches", async () => {
    const h = harness({});
    const stop = startHeadPolling(h.deps);
    h.setVisible(true);
    h.setVisible(true);
    h.setVisible(true);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS);
    expect(h.fetchHead).toHaveBeenCalledTimes(1);
    stop();
  });

  it("only one request is ever in flight", async () => {
    let release: (r: HeadFetchResult) => void = () => {};
    const h = harness({
      fetchImpl: () =>
        new Promise<HeadFetchResult>((resolve) => {
          release = resolve;
        }),
    });
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS);
    expect(h.fetchHead).toHaveBeenCalledTimes(1);

    // Tab bounces while the request hangs: must NOT start a second one.
    h.setVisible(false);
    await vi.advanceTimersByTimeAsync(600_000);
    h.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchHead).toHaveBeenCalledTimes(1);

    // Once it settles the loop resumes on the normal cadence.
    release({ ok: true, rows: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchHead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS);
    expect(h.fetchHead).toHaveBeenCalledTimes(2);
    stop();
  });

  it("failures back off 240k, 480k, 960k, 960k and a success resets to 120k", async () => {
    const fail: HeadFetchResult = { ok: false };
    const ok: HeadFetchResult = { ok: true, rows: [] };
    const h = harness({ results: [fail, fail, fail, fail, ok, ok] });
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(2_880_000);
    const gaps = h.fetchTimes.map((t, i) => t - (h.fetchTimes[i - 1] ?? 0));
    expect(gaps).toEqual([120_000, 240_000, 480_000, 960_000, 960_000, 120_000]);
    stop();
  });

  it("a rejected fetch counts as a failure (and never crashes the loop)", async () => {
    const h = harness({
      fetchImpl: () => Promise.reject(new TypeError("network down")),
    });
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(120_000 + 240_000 + 480_000);
    expect(h.fetchTimes).toEqual([120_000, 360_000, 840_000]);
    expect(h.onRows).not.toHaveBeenCalled();
    stop();
  });

  it("honours a Retry-After of 300 s over the 240 s backoff", async () => {
    const h = harness({
      results: [{ ok: false, retryAfterMs: 300_000 }, { ok: true, rows: [] }],
    });
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(120_000 + 300_000);
    expect(h.fetchTimes).toEqual([120_000, 420_000]);
    stop();
  });

  it("a Retry-After is spent on one gap only; the next success goes back to 120 s", async () => {
    const h = harness({
      results: [
        { ok: false, retryAfterMs: 300_000 },
        { ok: true, rows: [] },
        { ok: true, rows: [] },
      ],
    });
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(120_000 + 300_000 + 120_000);
    expect(h.fetchTimes).toEqual([120_000, 420_000, 540_000]);
    stop();
  });

  it("does not shorten a backoff by toggling visibility", async () => {
    const h = harness({ results: [{ ok: false }, { ok: true, rows: [] }] });
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(120_000); // fetch #1 fails -> next in 240 s
    h.setVisible(false);
    await vi.advanceTimersByTimeAsync(130_000);
    h.setVisible(true); // only 130 s since the attempt: 110 s of backoff remain
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchHead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(110_000);
    expect(h.fetchHead).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stop() clears the timer, unsubscribes and stops all fetching", async () => {
    const h = harness({});
    const stop = startHeadPolling(h.deps);
    expect(h.visibilityListeners()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.visibilityListeners()).toBe(0);
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS * 10);
    expect(h.fetchHead).not.toHaveBeenCalled();
  });

  it("stop() aborts the in-flight request and drops its result", async () => {
    let release: (r: HeadFetchResult) => void = () => {};
    const h = harness({
      fetchImpl: () =>
        new Promise<HeadFetchResult>((resolve) => {
          release = resolve;
        }),
    });
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS);
    expect(h.signals[0]?.aborted).toBe(false);

    stop();
    expect(h.signals[0]?.aborted).toBe(true);

    release({ ok: true, rows: [row(1)] });
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS * 5);
    expect(h.onRows).not.toHaveBeenCalled();
    expect(h.fetchHead).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a visibility event after stop() does nothing", async () => {
    const h = harness({ visible: false });
    const stop = startHeadPolling(h.deps);
    stop();
    h.setVisible(true);
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS * 2);
    expect(h.fetchHead).not.toHaveBeenCalled();
  });

  it("stop() is idempotent", () => {
    const h = harness({});
    const stop = startHeadPolling(h.deps);
    stop();
    expect(() => stop()).not.toThrow();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("a throwing onRows does not kill the loop", async () => {
    const h = harness({});
    h.onRows.mockImplementation(() => {
      throw new Error("boom");
    });
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS * 3);
    expect(h.fetchHead).toHaveBeenCalledTimes(3);
    stop();
  });
});
