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
  attemptCached,
  awaitRequestScope,
  resolveCachedOrRetry,
} from "./cache-resilience";

const OUTSIDE_SCOPE_MESSAGE =
  "`connection` was called outside a request scope. Read more: https://nextjs.org/docs/messages/next-dynamic-api-wrong-context";
const AFTER_MESSAGE =
  "Route /x used `connection()` inside `after()` while rendering.";

beforeEach(() => {
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
