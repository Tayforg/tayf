import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { attemptCached, resolveCachedOrRetry } from "./cache-resilience";

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
});
