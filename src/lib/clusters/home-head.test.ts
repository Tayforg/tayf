import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HOME_HEAD_LIMIT,
  HOME_HEAD_URL,
  countNewBreaking,
  fetchHomeHead,
  newBreakingLabel,
  parseHomeHead,
  readHomeHeadResponse,
  toHomeHead,
} from "./home-head";
import {
  TIMELINE_POLL_MS,
  startHeadPolling,
  type HeadFetchResult,
  type HeadPollingDeps,
} from "./timeline-head";

// ---------------------------------------------------------------------------
// h170-roadmap-2: the home page's "N yeni son dakika haberi · Yenile" pill. The
// pure half lives here: what counts as a NEW breaking story (an id the rendered
// page does not know), the label, the wire shape of /api/home/head and its
// parser. The poll schedule itself is startHeadPolling's (timeline-head.ts,
// tested in timeline-head.test.ts); the replay at the bottom only proves that
// the home head rides that schedule unchanged.
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 10, 13, 9, 0, 0);

function row(i: number) {
  return { id: `b${i}`, first_published: new Date(T0 - i * 60_000).toISOString() };
}

describe("constants", () => {
  it("pins the head's size and URL (a query string would mint CDN cache entries)", () => {
    expect(HOME_HEAD_LIMIT).toBe(6);
    expect(HOME_HEAD_URL).toBe("/api/home/head");
    expect(HOME_HEAD_URL).not.toContain("?");
  });
});

describe("countNewBreaking", () => {
  it("counts an id the page does not know", () => {
    expect(countNewBreaking([row(1), row(2)], new Set(["b1"]))).toBe(1);
    expect(countNewBreaking([row(1), row(2)], new Set())).toBe(2);
  });

  it("does not count an id the page already lists (a story that only moved from the ranked list into the strip)", () => {
    expect(countNewBreaking([row(1), row(2), row(3)], new Set(["b1", "b2", "b3"]))).toBe(0);
  });

  it("a head with one new story among known ones counts exactly one", () => {
    expect(countNewBreaking([row(9), row(1), row(2)], new Set(["b1", "b2"]))).toBe(1);
  });

  it("counts a repeated id once", () => {
    expect(countNewBreaking([row(7), row(7), row(7)], new Set())).toBe(1);
  });

  it("an empty head is 0", () => {
    expect(countNewBreaking([], new Set())).toBe(0);
    expect(countNewBreaking([], new Set(["b1"]))).toBe(0);
  });

  it("a malformed head is 0, never a false pill", () => {
    const known = new Set<string>();
    for (const bad of [
      null,
      undefined,
      "b1",
      42,
      {},
      { breaking: [row(1)] },
      [null],
      [row(1), null],
      [row(1), "x"],
      [row(1), {}],
      [row(1), { id: "" }],
      [row(1), { id: 7 }],
      [row(1), { id: null }],
    ]) {
      expect(countNewBreaking(bad, known), JSON.stringify(bad)).toBe(0);
    }
  });

  it("a head longer than the strip's cap is malformed", () => {
    const seven = Array.from({ length: HOME_HEAD_LIMIT + 1 }, (_, i) => row(i + 1));
    expect(countNewBreaking(seven, new Set())).toBe(0);
    expect(countNewBreaking(seven.slice(0, HOME_HEAD_LIMIT), new Set())).toBe(HOME_HEAD_LIMIT);
  });

  it("takes the known ids as a Set or as the plain array the page hands the client", () => {
    expect(countNewBreaking([row(1), row(2)], ["b1"])).toBe(1);
    expect(countNewBreaking([row(1), row(2)], [])).toBe(2);
  });

  it("does not mutate the head or the known set", () => {
    const head = [row(1), row(2)];
    const before = JSON.stringify(head);
    const known = new Set(["b1"]);
    countNewBreaking(head, known);
    expect(JSON.stringify(head)).toBe(before);
    expect([...known]).toEqual(["b1"]);
  });

  it("replay: the strip has A and B, C is a ranked story in the window; N arrives and C moves into the strip", () => {
    // knownIds = ids of the page's listed stories first published inside the 2 h window.
    const knownIds = new Set(["A", "B", "C"]);
    const stamp = (id: string) => ({ id, first_published: new Date(T0).toISOString() });
    // Head 2 minutes later: N is new, C was ranked and is now in the strip, A aged out of the strip.
    expect(countNewBreaking([stamp("N"), stamp("C"), stamp("B")], knownIds)).toBe(1);
    // Nothing changed except the order and C's move: no pill.
    expect(countNewBreaking([stamp("C"), stamp("A"), stamp("B")], knownIds)).toBe(0);
  });
});

describe("newBreakingLabel", () => {
  it("names the count in Turkish", () => {
    expect(newBreakingLabel(1)).toBe("1 yeni son dakika haberi");
    expect(newBreakingLabel(3)).toBe("3 yeni son dakika haberi");
    expect(newBreakingLabel(HOME_HEAD_LIMIT)).toBe("6 yeni son dakika haberi");
  });

  it("never prints NaN or a negative number", () => {
    expect(newBreakingLabel(Number.NaN)).toBe("0 yeni son dakika haberi");
    expect(newBreakingLabel(-2)).toBe("0 yeni son dakika haberi");
  });
});

describe("toHomeHead", () => {
  it("keeps only id and first_published (titles and counts must not leak)", () => {
    const rows = [
      { id: "a", first_published: "2026-11-13T08:00:00.000Z", title_tr: "Gizli", article_count: 4 },
    ];
    const head = toHomeHead(rows);
    expect(head).toEqual([{ id: "a", first_published: "2026-11-13T08:00:00.000Z" }]);
    expect(JSON.stringify(head)).not.toContain("Gizli");
    expect(JSON.stringify(head)).not.toContain("article_count");
  });

  it("returns at most 6 rows, in order", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i + 1));
    expect(toHomeHead(rows).map((r) => r.id)).toEqual(["b1", "b2", "b3", "b4", "b5", "b6"]);
  });

  it("handles an empty list and does not mutate its input", () => {
    expect(toHomeHead([])).toEqual([]);
    const rows = [row(1)];
    const copy = JSON.stringify(rows);
    toHomeHead(rows);
    expect(JSON.stringify(rows)).toBe(copy);
  });
});

describe("parseHomeHead", () => {
  it("accepts a well-formed body, an empty one and exactly 6 rows", () => {
    expect(parseHomeHead({ breaking: [row(1)] })).toEqual([row(1)]);
    expect(parseHomeHead({ breaking: [] })).toEqual([]);
    const six = Array.from({ length: 6 }, (_, i) => row(i + 1));
    expect(parseHomeHead({ breaking: six })).toEqual(six);
  });

  it("rejects 7 rows", () => {
    const seven = Array.from({ length: 7 }, (_, i) => row(i + 1));
    expect(parseHomeHead({ breaking: seven })).toBeNull();
  });

  it("rejects the timeline's shape and every other bad shape", () => {
    for (const bad of [null, undefined, "x", 1, [], {}, { clusters: [row(1)] }, { breaking: "x" }, { breaking: {} }]) {
      expect(parseHomeHead(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("rejects the whole body when one row is bad", () => {
    expect(parseHomeHead({ breaking: [row(1), { id: "x", first_published: "not a date" }] })).toBeNull();
    expect(parseHomeHead({ breaking: [row(1), { id: "", first_published: row(2).first_published }] })).toBeNull();
    expect(parseHomeHead({ breaking: [row(1), null] })).toBeNull();
  });

  it("drops unknown keys from rows it accepts", () => {
    const parsed = parseHomeHead({ breaking: [{ ...row(1), title_tr: "leak" }] });
    expect(parsed).toEqual([row(1)]);
  });
});

describe("readHomeHeadResponse", () => {
  function res(init: { ok?: boolean; retryAfter?: string | null; json?: () => Promise<unknown> }) {
    return {
      ok: init.ok ?? true,
      headers: { get: (name: string) => (name === "Retry-After" ? (init.retryAfter ?? null) : null) },
      json: init.json ?? (() => Promise.resolve({ breaking: [row(1)] })),
    };
  }

  it("returns the rows of a good 200", async () => {
    await expect(readHomeHeadResponse(res({}))).resolves.toEqual({ ok: true, rows: [row(1)] });
  });

  it("returns an empty list for a quiet hour (200, no breaking story)", async () => {
    await expect(
      readHomeHeadResponse(res({ json: () => Promise.resolve({ breaking: [] }) })),
    ).resolves.toEqual({ ok: true, rows: [] });
  });

  it("a 503 carries its Retry-After in ms", async () => {
    await expect(readHomeHeadResponse(res({ ok: false, retryAfter: "120" }))).resolves.toEqual({
      ok: false,
      retryAfterMs: 120_000,
    });
  });

  it("a 200 whose body is the timeline shape, too long, not JSON or throws is a failure", async () => {
    const seven = Array.from({ length: 7 }, (_, i) => row(i + 1));
    for (const json of [
      () => Promise.resolve({ clusters: [row(1)] }),
      () => Promise.resolve({ breaking: seven }),
      () => Promise.resolve("x"),
      () => Promise.reject(new SyntaxError("bad")),
    ]) {
      const r = await readHomeHeadResponse(res({ json }));
      expect(r.ok).toBe(false);
    }
  });
});

describe("fetchHomeHead", () => {
  it("requests exactly /api/home/head (no query string) with the caller's abort signal", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve({
        ok: true,
        headers: { get: () => null },
        json: () => Promise.resolve({ breaking: [row(1)] }),
      }),
    );
    const controller = new AbortController();
    const result = await fetchHomeHead(controller.signal, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: true, rows: [row(1)] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/home/head");
    expect(init.signal).toBe(controller.signal);
    expect(init.headers).toEqual({ accept: "application/json" });
  });
});

// ---------------------------------------------------------------------------
// The home head rides startHeadPolling unchanged: first poll after 120 s, never
// on mount, no poll while hidden, backoff on a 503 (with its Retry-After).
// ---------------------------------------------------------------------------

describe("the home head on startHeadPolling", () => {
  let visible = true;
  const listeners = new Set<() => void>();
  let start = 0;
  let fetchTimes: number[] = [];
  let responses: Array<{ ok: boolean; retryAfter?: string; body?: unknown }> = [];
  let onRows: ReturnType<typeof vi.fn>;
  let stop: () => void = () => {};

  const fetchImpl = vi.fn((url: string) => {
    expect(url).toBe("/api/home/head");
    fetchTimes.push(Date.now() - start);
    const next = responses.shift() ?? { ok: true, body: { breaking: [] } };
    return Promise.resolve({
      ok: next.ok,
      headers: { get: (n: string) => (n === "Retry-After" ? (next.retryAfter ?? null) : null) },
      json: () => Promise.resolve(next.body ?? { breaking: [] }),
    });
  });

  function begin(): void {
    const deps: HeadPollingDeps = {
      fetchHead: (signal) =>
        fetchHomeHead(signal, fetchImpl as unknown as typeof fetch) as Promise<HeadFetchResult>,
      onRows,
      isVisible: () => visible,
      subscribeVisibility: (cb) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    stop = startHeadPolling(deps);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    visible = true;
    listeners.clear();
    start = Date.now();
    fetchTimes = [];
    responses = [];
    fetchImpl.mockClear();
    onRows = vi.fn();
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("never polls on mount: the first request is a full 120 s away", async () => {
    begin();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS - 1);
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchTimes).toEqual([120_000]);
  });

  it("a hidden tab never polls", async () => {
    visible = false;
    begin();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("hands the parsed rows to onRows, and a new id among them is one new story", async () => {
    responses = [{ ok: true, body: { breaking: [row(9), row(1)] } }];
    begin();
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS);
    expect(onRows).toHaveBeenCalledTimes(1);
    const rows = onRows.mock.calls[0]?.[0];
    expect(countNewBreaking(rows, new Set(["b1"]))).toBe(1);
  });

  it("backs off after a 503: 240 s, then 480 s, and a success goes back to 120 s", async () => {
    responses = [
      { ok: false },
      { ok: false },
      { ok: true, body: { breaking: [] } },
      { ok: true, body: { breaking: [] } },
    ];
    begin();
    await vi.advanceTimersByTimeAsync(120_000 + 240_000 + 480_000 + 120_000);
    expect(fetchTimes).toEqual([120_000, 360_000, 840_000, 960_000]);
  });

  it("honours the Retry-After of a 503 (300 s beats the 240 s backoff)", async () => {
    responses = [{ ok: false, retryAfter: "300" }];
    begin();
    await vi.advanceTimersByTimeAsync(120_000 + 300_000);
    expect(fetchTimes).toEqual([120_000, 420_000]);
  });

  it("a malformed 200 body is a failure and backs off", async () => {
    responses = [{ ok: true, body: { clusters: [row(1)] } }];
    begin();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchTimes).toEqual([120_000]);
    expect(onRows).not.toHaveBeenCalled();
    // The next poll waits the doubled 240 s (it would be 120 s after a success) and then succeeds.
    await vi.advanceTimersByTimeAsync(239_999);
    expect(fetchTimes).toEqual([120_000]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchTimes).toEqual([120_000, 360_000]);
    expect(onRows).toHaveBeenCalledTimes(1);
    expect(onRows).toHaveBeenCalledWith([]);
  });
});
