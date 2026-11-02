import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `connection()` is the only Next API cache-resilience touches. Mocked so the
// four runtime scopes (request, prerender, no work store, after()) can each be
// simulated; the real-Next pin lives in tests/guards/cache-retry-prerender.
const h = vi.hoisted(() => ({
  order: [] as string[],
  connection: vi.fn(),
}));

vi.mock("next/server", () => ({ connection: h.connection }));

import {
  LAST_GOOD_MAX_AGE_MS,
  LAST_GOOD_MAX_KEYS,
  RETRY_COOLDOWN_MS,
  __resetCacheResilienceForTests,
  attemptCached,
  awaitRequestScope,
  coalesce,
  recallLastGood,
  rememberLastGood,
  resolveCachedOrRetry,
  resolveCachedOrThrow,
  type CacheAttempt,
} from "./cache-resilience";

const OUTSIDE_SCOPE_MESSAGE =
  "`connection` was called outside a request scope. Read more: https://nextjs.org/docs/messages/next-dynamic-api-wrong-context";
const AFTER_MESSAGE =
  "Route /x used `connection()` inside `after()` while rendering.";

beforeEach(() => {
  __resetCacheResilienceForTests();
  h.order.length = 0;
  h.connection.mockReset().mockImplementation(async () => {
    h.order.push("connection");
  });
});

describe("attemptCached", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("returns ok:true with the resolved value on success", async () => {
    const result = await attemptCached("label", async () => 42);
    expect(result).toEqual({ ok: true, data: 42 });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns ok:true even when the resolved value is falsy (null/empty array)", async () => {
    expect(await attemptCached("label", async () => null)).toEqual({
      ok: true,
      data: null,
    });
    expect(await attemptCached("label", async () => [])).toEqual({
      ok: true,
      data: [],
    });
  });

  // The whole point: this must NEVER reject/throw, no matter what `fn`
  // does — a rejection here is a thrown error inside a "use cache"
  // boundary, which fails `next build`'s prerender even when every caller
  // wraps the call in try/catch (see src/lib/clusters/feed-health.ts's
  // file header and the /trends, /rss.xml 2026-09-28 build incidents).
  it("never rejects when fn throws an Error — returns ok:false instead", async () => {
    const result = await attemptCached("my-label", async () => {
      throw new Error("db down");
    });
    expect(result).toEqual({ ok: false, error: "db down" });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[my-label] error: db down"),
    );
  });

  it("never rejects when fn throws a non-Error value", async () => {
    const result = await attemptCached("label", async () => {
      throw "stringy failure";
    });
    expect(result).toEqual({ ok: false, error: "stringy failure" });
  });

  it("never rejects when fn rejects asynchronously (statement timeout style)", async () => {
    const result = await attemptCached("trends", () =>
      Promise.reject(
        new Error("canceling statement due to statement timeout"),
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/statement timeout/);
    }
  });
});

describe("resolveCachedOrRetry", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("returns the cached value on a cache hit without calling retry", async () => {
    const retry = vi.fn(async () => "should not run");
    const result = await resolveCachedOrRetry(
      "label",
      async () => ({ ok: true as const, data: "cached" }),
      retry,
      "fallback",
    );
    expect(result).toBe("cached");
    expect(retry).not.toHaveBeenCalled();
  });

  it("calls retry and returns its value when the cache attempt failed", async () => {
    const retry = vi.fn(async () => "fresh");
    const result = await resolveCachedOrRetry(
      "label",
      async () => ({ ok: false as const, error: "db down" }),
      retry,
      "fallback",
    );
    expect(result).toBe("fresh");
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("returns fallback (never throws) when both the cache and the retry fail", async () => {
    const result = await resolveCachedOrRetry(
      "label",
      async () => ({ ok: false as const, error: "db down" }),
      async () => {
        throw new Error("retry also down");
      },
      "fallback",
    );
    expect(result).toBe("fallback");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[label] retry also failed: retry also down"),
    );
  });

  it("returns fallback when both fail with non-Error throws", async () => {
    const result = await resolveCachedOrRetry<number>(
      "label",
      async () => ({ ok: false as const, error: "db down" }),
      async () => {
        throw { weird: true };
      },
      -1,
    );
    expect(result).toBe(-1);
  });

  it("propagates a falsy-but-valid cached value (0, empty string, null) unchanged", async () => {
    const result = await resolveCachedOrRetry<number | null>(
      "label",
      async () => ({ ok: true as const, data: 0 }),
      async () => 999,
      -1,
    );
    expect(result).toBe(0);
  });

  it("never calls connection() on a cache hit", async () => {
    await resolveCachedOrRetry(
      "label",
      async () => ({ ok: true as const, data: "cached" }),
      async () => "should not run",
      "fallback",
    );
    expect(h.connection).not.toHaveBeenCalled();
  });

  it("awaits connection() BEFORE the live retry on a cache miss", async () => {
    const result = await resolveCachedOrRetry(
      "label",
      async () => ({ ok: false as const, error: "db down" }),
      async () => {
        h.order.push("retry");
        return "fresh";
      },
      "fallback",
    );
    expect(result).toBe("fresh");
    expect(h.order).toEqual(["connection", "retry"]);
  });

  // Prerender (`next build`, background revalidation): connection() returns a
  // hanging promise, so the subtree postpones to the nearest Suspense. The
  // uncached retry (which may read the clock) must never run, and the
  // never-settling promise must not be turned into `fallback`.
  it("stays pending and never runs the retry when connection() hangs (prerender)", async () => {
    h.connection.mockImplementation(() => new Promise<void>(() => {}));
    const retry = vi.fn(async () => "fresh");
    let settled = false;
    const pending = resolveCachedOrRetry(
      "label",
      async () => ({ ok: false as const, error: "db down" }),
      retry,
      "fallback",
    ).finally(() => {
      settled = true;
    });
    void pending.catch(() => {});

    await new Promise((r) => setTimeout(r, 20));

    expect(h.connection).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(settled).toBe(false);
  });

  it("still runs the retry when connection() throws synchronously outside a request scope", async () => {
    h.connection.mockImplementation(() => {
      throw new Error(OUTSIDE_SCOPE_MESSAGE);
    });
    const retry = vi.fn(async () => "fresh");
    const result = await resolveCachedOrRetry(
      "label",
      async () => ({ ok: false as const, error: "db down" }),
      retry,
      "fallback",
    );
    expect(result).toBe("fresh");
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("still runs the retry when connection() rejects outside a request scope", async () => {
    h.connection.mockImplementation(() =>
      Promise.reject(new Error(OUTSIDE_SCOPE_MESSAGE)),
    );
    const retry = vi.fn(async () => "fresh");
    const result = await resolveCachedOrRetry(
      "label",
      async () => ({ ok: false as const, error: "db down" }),
      retry,
      "fallback",
    );
    expect(result).toBe("fresh");
    expect(retry).toHaveBeenCalledTimes(1);
  });

  // Misuse (after()) and Next control flow must propagate: swallowing them
  // would run the clock-reading retry in a scope Next forbids, or turn a
  // postpone signal into `fallback`.
  it("rejects with the error, without retry or fallback, when connection() is used inside after()", async () => {
    h.connection.mockImplementation(() => {
      throw new Error(AFTER_MESSAGE);
    });
    const retry = vi.fn(async () => "fresh");
    await expect(
      resolveCachedOrRetry(
        "label",
        async () => ({ ok: false as const, error: "db down" }),
        retry,
        "fallback",
      ),
    ).rejects.toThrow(AFTER_MESSAGE);
    expect(retry).not.toHaveBeenCalled();
  });

  it("does not let a retry failure escape when connection() resolved (data failure still falls back)", async () => {
    const result = await resolveCachedOrRetry(
      "label",
      async () => ({ ok: false as const, error: "db down" }),
      async () => {
        h.order.push("retry");
        throw new Error("retry also down");
      },
      "fallback",
    );
    expect(result).toBe("fallback");
    expect(h.order).toEqual(["connection", "retry"]);
  });
});

describe("resolveCachedOrThrow", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("returns the cached value on a hit, with no retry and no connection()", async () => {
    const retry = vi.fn(async () => "should not run");
    const result = await resolveCachedOrThrow(
      "label",
      async () => ({ ok: true as const, data: "cached" }),
      retry,
    );
    expect(result).toBe("cached");
    expect(retry).not.toHaveBeenCalled();
    expect(h.connection).not.toHaveBeenCalled();
  });

  it("returns a falsy-but-valid cached value (0, null, empty array) unchanged", async () => {
    const hit = <T>(data: T) => async () => ({ ok: true as const, data });
    const retry = vi.fn(async () => 999 as number | null | never[]);
    expect(await resolveCachedOrThrow("label", hit(0), retry)).toBe(0);
    expect(await resolveCachedOrThrow("label", hit(null), retry)).toBeNull();
    expect(await resolveCachedOrThrow("label", hit([] as never[]), retry)).toEqual([]);
    expect(retry).not.toHaveBeenCalled();
  });

  it("on a miss awaits connection() and then runs the retry exactly once", async () => {
    const result = await resolveCachedOrThrow(
      "label",
      async () => ({ ok: false as const, error: "db down" }),
      async () => {
        h.order.push("retry");
        return "fresh";
      },
    );
    expect(result).toBe("fresh");
    expect(h.order).toEqual(["connection", "retry"]);
    expect(h.connection).toHaveBeenCalledTimes(1);
  });

  it("propagates a retry rejection unchanged (the same Error object, no fallback)", async () => {
    const boom = new Error("retry also down");
    await expect(
      resolveCachedOrThrow(
        "label",
        async () => ({ ok: false as const, error: "db down" }),
        async () => {
          h.order.push("retry");
          throw boom;
        },
      ),
    ).rejects.toBe(boom);
    expect(h.order).toEqual(["connection", "retry"]);
  });

  it("logs the failed retry under its label before rethrowing", async () => {
    await expect(
      resolveCachedOrThrow(
        "my-label",
        async () => ({ ok: false as const, error: "db down" }),
        async () => {
          throw new Error("retry also down");
        },
      ),
    ).rejects.toThrow("retry also down");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[my-label] retry also failed: retry also down"),
    );
  });

  it("propagates a non-Error retry rejection untouched", async () => {
    await expect(
      resolveCachedOrThrow(
        "label",
        async () => ({ ok: false as const, error: "db down" }),
        async () => {
          throw "stringy failure";
        },
      ),
    ).rejects.toBe("stringy failure");
  });

  it("propagates an awaitRequestScope error that is not outside-scope, and never runs the retry", async () => {
    h.connection.mockImplementation(() => {
      throw new Error(AFTER_MESSAGE);
    });
    const retry = vi.fn(async () => "fresh");
    await expect(
      resolveCachedOrThrow(
        "label",
        async () => ({ ok: false as const, error: "db down" }),
        retry,
      ),
    ).rejects.toThrow(AFTER_MESSAGE);
    expect(retry).not.toHaveBeenCalled();
  });

  it("still runs the retry when connection() throws the outside-request-scope error", async () => {
    h.connection.mockImplementation(() => {
      throw new Error(OUTSIDE_SCOPE_MESSAGE);
    });
    const retry = vi.fn(async () => "fresh");
    const result = await resolveCachedOrThrow(
      "label",
      async () => ({ ok: false as const, error: "db down" }),
      retry,
    );
    expect(result).toBe("fresh");
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("stays pending and never runs the retry when connection() hangs (prerender)", async () => {
    h.connection.mockImplementation(() => new Promise<void>(() => {}));
    const retry = vi.fn(async () => "fresh");
    let settled = false;
    const pending = resolveCachedOrThrow(
      "label",
      async () => ({ ok: false as const, error: "db down" }),
      retry,
    ).finally(() => {
      settled = true;
    });
    void pending.catch(() => {});

    await new Promise((r) => setTimeout(r, 20));

    expect(h.connection).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(settled).toBe(false);
  });
});

describe("awaitRequestScope", () => {
  it("resolves when connection() resolves", async () => {
    await expect(awaitRequestScope()).resolves.toBeUndefined();
    expect(h.connection).toHaveBeenCalledTimes(1);
  });

  it("resolves when connection() throws the outside-request-scope error synchronously", async () => {
    h.connection.mockImplementation(() => {
      throw new Error(OUTSIDE_SCOPE_MESSAGE);
    });
    await expect(awaitRequestScope()).resolves.toBeUndefined();
  });

  it("resolves when connection() rejects with the outside-request-scope error", async () => {
    h.connection.mockImplementation(() =>
      Promise.reject(new Error(OUTSIDE_SCOPE_MESSAGE)),
    );
    await expect(awaitRequestScope()).resolves.toBeUndefined();
  });

  it("rethrows any other Error (after(), use cache, dynamic = error)", async () => {
    h.connection.mockImplementation(() => {
      throw new Error(AFTER_MESSAGE);
    });
    await expect(awaitRequestScope()).rejects.toThrow(AFTER_MESSAGE);
  });

  it("rethrows an async rejection that is not the outside-scope error", async () => {
    const boom = new Error("NEXT_PRERENDER_INTERRUPTED");
    h.connection.mockImplementation(() => Promise.reject(boom));
    await expect(awaitRequestScope()).rejects.toBe(boom);
  });

  it("rethrows a non-Error throw untouched", async () => {
    h.connection.mockImplementation(() => {
      throw "outside a request scope";
    });
    await expect(awaitRequestScope()).rejects.toBe("outside a request scope");
  });
});

// ---------------------------------------------------------------------------
// W3 (h27-resilience-2): stale-if-error and single-flight for the uncached
// public entry points. The module keeps a per-instance LRU of last-good values
// (served for at most 60 min when the cached attempt AND the live retry both
// fail), coalesces concurrent live retries per key, and puts a 5 s negative
// cooldown behind a failed flight. Fake timers drive the clock throughout.
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-11-02T12:00:00.000Z");
const MIN = 60_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Attempt = CacheAttempt<string>;
const miss = async (): Promise<Attempt> => ({ ok: false, error: "db down" });
const hitAt =
  (data: string, at?: number) =>
  async (): Promise<Attempt> =>
    at === undefined ? { ok: true, data } : { ok: true, data, at };
const down = () => Promise.reject<string>(new Error("retry also down"));
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("last-good store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns what was remembered and undefined for an unknown key", () => {
    rememberLastGood("k", { n: 1 }, T0);
    expect(recallLastGood("k")).toEqual({ n: 1 });
    expect(recallLastGood("other")).toBeUndefined();
  });

  it("ignores null and undefined and never lets them replace a stored value", () => {
    rememberLastGood("empty", null, T0);
    rememberLastGood("empty", undefined, T0);
    expect(recallLastGood("empty")).toBeUndefined();

    rememberLastGood("k", "good", T0);
    rememberLastGood("k", null, T0 + 1);
    rememberLastGood("k", undefined, T0 + 2);
    expect(recallLastGood("k")).toBe("good");
  });

  it("replaces an older fetchedAt with a newer one but never the reverse", () => {
    rememberLastGood("k", "first", T0);
    rememberLastGood("k", "newer", T0 + 1);
    expect(recallLastGood("k")).toBe("newer");
    rememberLastGood("k", "older", T0 - 5 * MIN);
    expect(recallLastGood("k")).toBe("newer");
  });

  it("serves at 59:59 and at exactly 60:00, not at 60:01", () => {
    rememberLastGood("k", "v", T0);
    vi.setSystemTime(T0 + 59 * MIN + 59_000);
    expect(recallLastGood("k")).toBe("v");
    vi.setSystemTime(T0 + LAST_GOOD_MAX_AGE_MS);
    expect(recallLastGood("k")).toBe("v");
    vi.setSystemTime(T0 + 60 * MIN + 1_000);
    expect(recallLastGood("k")).toBeUndefined();
  });

  it("deletes an expired entry for good", () => {
    rememberLastGood("k", "v", T0);
    vi.setSystemTime(T0 + 61 * MIN);
    expect(recallLastGood("k")).toBeUndefined();
    vi.setSystemTime(T0 + MIN); // clock back inside the window: still gone
    expect(recallLastGood("k")).toBeUndefined();
  });

  it("measures age from fetchedAt, not from when it was remembered", () => {
    vi.setSystemTime(T0 + 30 * MIN);
    rememberLastGood("k", "stamped-30-min-ago", T0);
    vi.setSystemTime(T0 + 61 * MIN);
    expect(recallLastGood("k")).toBeUndefined();
  });

  it("does not trust a stamp far in the future (clock skew), but tolerates a small one", () => {
    rememberLastGood("small", "v", T0 + 30_000);
    expect(recallLastGood("small")).toBe("v");
    rememberLastGood("far", "v", T0 + 10 * MIN);
    expect(recallLastGood("far")).toBeUndefined();
  });

  it("evicts the oldest key when 201 keys are written", () => {
    expect(LAST_GOOD_MAX_KEYS).toBe(200);
    for (let i = 0; i <= LAST_GOOD_MAX_KEYS; i++) rememberLastGood(`k${i}`, i + 1, T0);
    expect(recallLastGood("k0")).toBeUndefined();
    expect(recallLastGood("k1")).toBe(2);
    expect(recallLastGood(`k${LAST_GOOD_MAX_KEYS}`)).toBe(LAST_GOOD_MAX_KEYS + 1);
  });

  it("a read re-inserts the key, so a recently read key outlives older ones", () => {
    for (let i = 0; i < LAST_GOOD_MAX_KEYS; i++) rememberLastGood(`k${i}`, i, T0);
    expect(recallLastGood("k0")).toBe(0);
    rememberLastGood("extra", "x", T0);
    expect(recallLastGood("k0")).toBe(0);
    expect(recallLastGood("k1")).toBeUndefined();
  });

  it("a write re-inserts the key, whether it replaced the value or was ignored as older", () => {
    for (let i = 0; i < LAST_GOOD_MAX_KEYS; i++) rememberLastGood(`k${i}`, i, T0);
    rememberLastGood("k0", "newer", T0 + 1);
    rememberLastGood("k1", "ignored-older", T0 - 1);
    rememberLastGood("extra", "x", T0);
    expect(recallLastGood("k0")).toBe("newer");
    expect(recallLastGood("k1")).toBe(1);
    expect(recallLastGood("k2")).toBeUndefined();
  });

  it("__resetCacheResilienceForTests empties the store", () => {
    rememberLastGood("k", "v", T0);
    __resetCacheResilienceForTests();
    expect(recallLastGood("k")).toBeUndefined();
  });
});

describe("coalesce (single-flight + negative cooldown)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("20 concurrent same-key callers run fn once and share one value", async () => {
    const gate = deferred<string>();
    const fn = vi.fn(() => gate.promise);
    const calls = Array.from({ length: 20 }, () => coalesce("k", fn));
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
    gate.resolve("shared");
    expect(await Promise.all(calls)).toEqual(Array<string>(20).fill("shared"));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("different keys never share a flight", async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    const fnA = vi.fn(() => a.promise);
    const fnB = vi.fn(() => b.promise);
    const callA = coalesce("a", fnA);
    const callB = coalesce("b", fnB);
    await flush();
    expect(fnA).toHaveBeenCalledTimes(1);
    expect(fnB).toHaveBeenCalledTimes(1);
    a.resolve("A");
    b.resolve("B");
    expect(await Promise.all([callA, callB])).toEqual(["A", "B"]);
  });

  it("a settled flight is never reused: the next call runs fn again", async () => {
    const fn = vi.fn().mockResolvedValueOnce("one").mockResolvedValueOnce("two");
    expect(await coalesce("k", fn)).toBe("one");
    expect(await coalesce("k", fn)).toBe("two");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("a rejection reaches every joiner and then arms a 5 s cooldown", async () => {
    expect(RETRY_COOLDOWN_MS).toBe(5_000);
    const gate = deferred<string>();
    const fn = vi.fn(() => gate.promise);
    const calls = Array.from({ length: 3 }, () => coalesce("k", fn).catch((e: unknown) => e));
    await flush();
    const boom = new Error("boom");
    gate.reject(boom);
    expect(await Promise.all(calls)).toEqual([boom, boom, boom]);
    expect(fn).toHaveBeenCalledTimes(1);

    // Within the cooldown fn is never invoked and the stored error is re-thrown.
    vi.setSystemTime(T0 + RETRY_COOLDOWN_MS - 1);
    await expect(coalesce("k", fn)).rejects.toBe(boom);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("lets fn run again once the 5 s cooldown has passed", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce("back");
    await expect(coalesce("k", fn)).rejects.toThrow("down");
    vi.setSystemTime(T0 + RETRY_COOLDOWN_MS + 1);
    expect(await coalesce("k", fn)).toBe("back");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("the cooldown is per key", async () => {
    const bad = vi.fn(down);
    await expect(coalesce("bad", bad)).rejects.toThrow("retry also down");
    const good = vi.fn(async () => "ok");
    expect(await coalesce("good", good)).toBe("ok");
  });

  it("a successful flight arms no cooldown", async () => {
    const fn = vi.fn(async () => "ok");
    await coalesce("k", fn);
    await coalesce("k", fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("a synchronous throw from fn is a rejection and leaves no stuck flight", async () => {
    const boom = new Error("sync boom");
    const fn = vi.fn((): Promise<string> => {
      throw boom;
    });
    await expect(coalesce("k", fn)).rejects.toBe(boom);
    vi.setSystemTime(T0 + RETRY_COOLDOWN_MS + 1);
    const ok = vi.fn(async () => "after");
    expect(await coalesce("k", ok)).toBe("after");
  });

  it("bounds the cooldown map: only the newest 200 failed keys stay in cooldown", async () => {
    const total = LAST_GOOD_MAX_KEYS + 50;
    for (let i = 0; i < total; i++) {
      await coalesce(`k${i}`, down).catch(() => {});
    }
    const probe = vi.fn(async () => "ran");
    // Oldest key fell out of the bounded map: fn runs again inside the 5 s window.
    expect(await coalesce("k0", probe)).toBe("ran");
    // The newest key is still cooling down.
    await expect(coalesce(`k${total - 1}`, probe)).rejects.toThrow("retry also down");
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe("resolveCachedOrRetry with a key (stale-if-error + single-flight)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const key = "politics:reader";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("serves the last good value when a keyed success is followed by a failed attempt and a failed retry", async () => {
    expect(
      await resolveCachedOrRetry<string>({ label: "l", key }, hitAt("good", T0), down, "fallback"),
    ).toBe("good");

    vi.setSystemTime(T0 + 10 * MIN);
    const retry = vi.fn(down);
    const result = await resolveCachedOrRetry<string>(
      { label: "l", key },
      miss,
      retry,
      "fallback",
    );
    expect(result).toBe("good");
    expect(retry).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[l] serving last-good"));
  });

  it("an unkeyed call keeps the old fallback", async () => {
    await resolveCachedOrRetry<string>("l", hitAt("good", T0), down, "fallback");
    const result = await resolveCachedOrRetry<string>("l", miss, down, "fallback");
    expect(result).toBe("fallback");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[l] retry also failed: retry also down"),
    );
  });

  it("an object label without a key behaves exactly like a string label", async () => {
    await resolveCachedOrRetry<string>({ label: "l" }, hitAt("good", T0), down, "fallback");
    expect(await resolveCachedOrRetry<string>({ label: "l" }, miss, down, "fallback")).toBe(
      "fallback",
    );
    expect(
      await resolveCachedOrRetry<string>({ label: "l" }, miss, async () => "fresh", "fallback"),
    ).toBe("fresh");
  });

  it("the last good value is per key", async () => {
    await resolveCachedOrRetry<string>({ label: "l", key: "a" }, hitAt("A", T0), down, "fallback");
    expect(
      await resolveCachedOrRetry<string>({ label: "l", key: "b" }, miss, down, "fallback"),
    ).toBe("fallback");
  });

  it("a successful live retry is remembered with the current time", async () => {
    await resolveCachedOrRetry<string>({ label: "l", key }, miss, async () => "fresh", "fallback");
    vi.setSystemTime(T0 + RETRY_COOLDOWN_MS + 1);
    expect(
      await resolveCachedOrRetry<string>({ label: "l", key }, miss, down, "fallback"),
    ).toBe("fresh");
  });

  describe("`remember` (the caller decides what counts as good)", () => {
    const notDegraded = (v: string) => v !== "degraded";

    it("a live success the predicate rejects is returned but never replaces the last good value", async () => {
      await resolveCachedOrRetry<string>({ label: "l", key, remember: notDegraded }, hitAt("good", T0), down, "fallback");
      vi.setSystemTime(T0 + RETRY_COOLDOWN_MS + 1);
      expect(
        await resolveCachedOrRetry<string>({ label: "l", key, remember: notDegraded }, miss, async () => "degraded", "fallback"),
      ).toBe("degraded");
      vi.setSystemTime(T0 + 2 * RETRY_COOLDOWN_MS + 2);
      expect(
        await resolveCachedOrRetry<string>({ label: "l", key, remember: notDegraded }, miss, down, "fallback"),
      ).toBe("good");
    });

    it("a rejected live success is not remembered even when nothing else is", async () => {
      await resolveCachedOrRetry<string>({ label: "l", key, remember: notDegraded }, miss, async () => "degraded", "fallback");
      vi.setSystemTime(T0 + RETRY_COOLDOWN_MS + 1);
      expect(
        await resolveCachedOrRetry<string>({ label: "l", key, remember: notDegraded }, miss, down, "fallback"),
      ).toBe("fallback");
    });

    it("a stamped hit the predicate rejects is not remembered either", async () => {
      expect(
        await resolveCachedOrRetry<string>({ label: "l", key, remember: notDegraded }, hitAt("degraded", T0), down, "fallback"),
      ).toBe("degraded");
      expect(
        await resolveCachedOrRetry<string>({ label: "l", key, remember: notDegraded }, miss, down, "fallback"),
      ).toBe("fallback");
    });

    it("an accepted value is remembered as before", async () => {
      await resolveCachedOrRetry<string>({ label: "l", key, remember: notDegraded }, miss, async () => "fresh", "fallback");
      vi.setSystemTime(T0 + RETRY_COOLDOWN_MS + 1);
      expect(
        await resolveCachedOrRetry<string>({ label: "l", key, remember: notDegraded }, miss, down, "fallback"),
      ).toBe("fresh");
    });

    it("a predicate that throws counts as 'not good': the value is still returned", async () => {
      const boom = () => {
        throw new Error("predicate bug");
      };
      expect(
        await resolveCachedOrRetry<string>({ label: "l", key, remember: boom }, miss, async () => "fresh", "fallback"),
      ).toBe("fresh");
      vi.setSystemTime(T0 + RETRY_COOLDOWN_MS + 1);
      expect(
        await resolveCachedOrRetry<string>({ label: "l", key, remember: boom }, miss, down, "fallback"),
      ).toBe("fallback");
    });

    it("is ignored without a key", async () => {
      const remember = vi.fn(() => true);
      await resolveCachedOrRetry<string>({ label: "l", remember }, miss, async () => "fresh", "fallback");
      expect(remember).not.toHaveBeenCalled();
    });
  });

  it("a hit without `at` records nothing", async () => {
    await resolveCachedOrRetry<string>({ label: "l", key }, hitAt("good"), down, "fallback");
    expect(
      await resolveCachedOrRetry<string>({ label: "l", key }, miss, down, "fallback"),
    ).toBe("fallback");
  });

  it("a null hit (a genuinely absent row) is never remembered or served", async () => {
    await resolveCachedOrRetry<string | null>(
      { label: "l", key },
      async () => ({ ok: true, data: null, at: T0 }),
      async () => null,
      null,
    );
    const retry = vi.fn(() => Promise.reject<string | null>(new Error("down")));
    expect(
      await resolveCachedOrRetry<string | null>({ label: "l", key }, miss, retry, "none"),
    ).toBe("none");
  });

  it("recording a hit never reads the clock (the hit path runs during prerender)", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    await resolveCachedOrRetry<string>({ label: "l", key }, hitAt("good", T0), down, "fallback");
    expect(nowSpy).not.toHaveBeenCalled();
    expect(h.connection).not.toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  it("is served at 59:59 after the stamp and not at 60:01", async () => {
    await resolveCachedOrRetry<string>({ label: "l", key }, hitAt("good", T0), down, "fallback");
    vi.setSystemTime(T0 + 59 * MIN + 59_000);
    expect(await resolveCachedOrRetry<string>({ label: "l", key }, miss, down, "fallback")).toBe(
      "good",
    );
    vi.setSystemTime(T0 + 60 * MIN + 1_000);
    expect(await resolveCachedOrRetry<string>({ label: "l", key }, miss, down, "fallback")).toBe(
      "fallback",
    );
  });

  it("never serves a cached `at` older than 60 min", async () => {
    await resolveCachedOrRetry<string>(
      { label: "l", key },
      hitAt("ancient", T0 - 61 * MIN),
      down,
      "fallback",
    );
    expect(await resolveCachedOrRetry<string>({ label: "l", key }, miss, down, "fallback")).toBe(
      "fallback",
    );
  });

  it("20 concurrent same-key calls run the live retry once and all get the same value", async () => {
    const gate = deferred<string>();
    const retry = vi.fn(() => gate.promise);
    const calls = Array.from({ length: 20 }, () =>
      resolveCachedOrRetry<string>({ label: "l", key }, miss, retry, "fallback"),
    );
    await flush();
    expect(retry).toHaveBeenCalledTimes(1);
    gate.resolve("fresh");
    expect(await Promise.all(calls)).toEqual(Array<string>(20).fill("fresh"));
  });

  it("two keys run two live retries, and the next call after the flight runs again", async () => {
    const retryA = vi.fn(async () => "A");
    const retryB = vi.fn(async () => "B");
    await Promise.all([
      resolveCachedOrRetry<string>({ label: "l", key: "a" }, miss, retryA, "fallback"),
      resolveCachedOrRetry<string>({ label: "l", key: "b" }, miss, retryB, "fallback"),
    ]);
    expect(retryA).toHaveBeenCalledTimes(1);
    expect(retryB).toHaveBeenCalledTimes(1);
    await resolveCachedOrRetry<string>({ label: "l", key: "a" }, miss, retryA, "fallback");
    expect(retryA).toHaveBeenCalledTimes(2);
  });

  it("unkeyed calls are not coalesced", async () => {
    const retry = vi.fn(async () => "fresh");
    await Promise.all(
      Array.from({ length: 5 }, () => resolveCachedOrRetry<string>("l", miss, retry, "fallback")),
    );
    expect(retry).toHaveBeenCalledTimes(5);
  });

  it("after a failed flight, calls within 5 s never invoke retry; at 5.001 s they do", async () => {
    const retry = vi.fn(down);
    const call = () =>
      resolveCachedOrRetry<string>({ label: "l", key }, miss, retry, "fallback");
    expect(await call()).toBe("fallback");
    expect(retry).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 4_999);
    expect(await call()).toBe("fallback");
    expect(retry).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 5_001);
    expect(await call()).toBe("fallback");
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("serves last-good during the cooldown without calling retry", async () => {
    await resolveCachedOrRetry<string>({ label: "l", key }, hitAt("good", T0), down, "fallback");
    const retry = vi.fn(down);
    const call = () =>
      resolveCachedOrRetry<string>({ label: "l", key }, miss, retry, "fallback");
    expect(await call()).toBe("good");
    expect(await call()).toBe("good");
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("still awaits connection() before the live retry and stays pending when it hangs (prerender)", async () => {
    await resolveCachedOrRetry<string>({ label: "l", key }, hitAt("good", T0), down, "fallback");
    h.connection.mockImplementation(() => new Promise<void>(() => {}));
    const retry = vi.fn(async () => "fresh");
    let settled = false;
    void resolveCachedOrRetry<string>({ label: "l", key }, miss, retry, "fallback").finally(() => {
      settled = true;
    });
    await flush();
    expect(retry).not.toHaveBeenCalled();
    expect(settled).toBe(false);
  });
});

describe("resolveCachedOrThrow with a key (stale-if-error + single-flight)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const key = "blindspots:reader";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("serves the last good value when a keyed success is followed by a failed attempt and a failed retry", async () => {
    await resolveCachedOrThrow<string>({ label: "l", key }, hitAt("good", T0), down);
    vi.setSystemTime(T0 + 20 * MIN);
    const retry = vi.fn(down);
    expect(await resolveCachedOrThrow<string>({ label: "l", key }, miss, retry)).toBe("good");
    expect(retry).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[l] serving last-good"));
  });

  it("an unkeyed call still rethrows the retry error unchanged", async () => {
    await resolveCachedOrThrow<string>("l", hitAt("good", T0), down);
    const boom = new Error("retry also down");
    await expect(
      resolveCachedOrThrow<string>("l", miss, () => Promise.reject<string>(boom)),
    ).rejects.toBe(boom);
  });

  it("rethrows the retry error when nothing good is remembered, or it is too old, or it had no stamp", async () => {
    const boom = new Error("boom");
    const fail = () => Promise.reject<string>(boom);
    await expect(resolveCachedOrThrow<string>({ label: "l", key }, miss, fail)).rejects.toBe(boom);

    await resolveCachedOrThrow<string>({ label: "l", key: "old" }, hitAt("v", T0 - 61 * MIN), down);
    await expect(
      resolveCachedOrThrow<string>({ label: "l", key: "old" }, miss, fail),
    ).rejects.toBe(boom);

    await resolveCachedOrThrow<string>({ label: "l", key: "nostamp" }, hitAt("v"), down);
    await expect(
      resolveCachedOrThrow<string>({ label: "l", key: "nostamp" }, miss, fail),
    ).rejects.toBe(boom);
  });

  it("20 concurrent same-key calls run the live retry once; a failure reaches all 20", async () => {
    const gate = deferred<string>();
    const retry = vi.fn(() => gate.promise);
    const calls = Array.from({ length: 20 }, () =>
      resolveCachedOrThrow<string>({ label: "l", key }, miss, retry).catch((e: unknown) => e),
    );
    await flush();
    expect(retry).toHaveBeenCalledTimes(1);
    const boom = new Error("outage");
    gate.reject(boom);
    expect(await Promise.all(calls)).toEqual(Array(20).fill(boom));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("after a failed flight, calls within 5 s never invoke retry and rethrow the same error; at 5.001 s they do", async () => {
    const boom = new Error("outage");
    const retry = vi.fn(() => Promise.reject<string>(boom));
    const call = () => resolveCachedOrThrow<string>({ label: "l", key }, miss, retry);
    await expect(call()).rejects.toBe(boom);
    vi.setSystemTime(T0 + 4_999);
    await expect(call()).rejects.toBe(boom);
    expect(retry).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + 5_001);
    await expect(call()).rejects.toBe(boom);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("a successful live retry is remembered and serves a later outage", async () => {
    await resolveCachedOrThrow<string>({ label: "l", key }, miss, async () => "fresh");
    vi.setSystemTime(T0 + RETRY_COOLDOWN_MS + 1);
    expect(await resolveCachedOrThrow<string>({ label: "l", key }, miss, down)).toBe("fresh");
  });

  describe("`remember` (the caller decides what counts as good)", () => {
    const notDegraded = (v: string) => v !== "degraded";

    it("a live success the predicate rejects is returned but never replaces the last good value", async () => {
      await resolveCachedOrThrow<string>({ label: "l", key, remember: notDegraded }, hitAt("good", T0), down);
      vi.setSystemTime(T0 + RETRY_COOLDOWN_MS + 1);
      expect(
        await resolveCachedOrThrow<string>({ label: "l", key, remember: notDegraded }, miss, async () => "degraded"),
      ).toBe("degraded");
      vi.setSystemTime(T0 + 2 * RETRY_COOLDOWN_MS + 2);
      expect(await resolveCachedOrThrow<string>({ label: "l", key, remember: notDegraded }, miss, down)).toBe("good");
    });

    it("a stamped hit the predicate rejects is not remembered either", async () => {
      expect(
        await resolveCachedOrThrow<string>({ label: "l", key, remember: notDegraded }, hitAt("degraded", T0), down),
      ).toBe("degraded");
      const boom = new Error("outage");
      await expect(
        resolveCachedOrThrow<string>({ label: "l", key, remember: notDegraded }, miss, () => Promise.reject<string>(boom)),
      ).rejects.toBe(boom);
    });

    it("an accepted value is remembered as before", async () => {
      await resolveCachedOrThrow<string>({ label: "l", key, remember: notDegraded }, miss, async () => "fresh");
      vi.setSystemTime(T0 + RETRY_COOLDOWN_MS + 1);
      expect(await resolveCachedOrThrow<string>({ label: "l", key, remember: notDegraded }, miss, down)).toBe("fresh");
    });

    it("a predicate that throws counts as 'not good': the value is still returned", async () => {
      const boom = () => {
        throw new Error("predicate bug");
      };
      expect(
        await resolveCachedOrThrow<string>({ label: "l", key, remember: boom }, miss, async () => "fresh"),
      ).toBe("fresh");
      vi.setSystemTime(T0 + RETRY_COOLDOWN_MS + 1);
      const outage = new Error("outage");
      await expect(
        resolveCachedOrThrow<string>({ label: "l", key, remember: boom }, miss, () => Promise.reject<string>(outage)),
      ).rejects.toBe(outage);
    });
  });
});
