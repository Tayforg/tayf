import { describe, it, expect, vi } from "vitest";

import {
  DRAW_RETRY_DEFAULT_MS,
  DRAW_RETRY_MAX_MS,
  classifyDrawResponse,
  drawRetryDelayMs,
  fetchDrawResponse,
  startRoundClock,
} from "./framing-draw";

describe("classifyDrawResponse", () => {
  it("treats a 500 response as an error", () => {
    expect(classifyDrawResponse({ ok: false, body: null })).toEqual({
      kind: "error",
    });
  });

  it("treats a 429 response as an error, not pool-empty", () => {
    expect(
      classifyDrawResponse({ ok: false, body: { article_id: null } }),
    ).toEqual({ kind: "error" });
  });

  it("treats a thrown fetch (represented as null) as an error", () => {
    expect(classifyDrawResponse(null)).toEqual({ kind: "error" });
  });

  it("treats malformed JSON (article_id/title missing or wrong type) as an error", () => {
    expect(classifyDrawResponse({ ok: true, body: {} })).toEqual({
      kind: "error",
    });
    expect(
      classifyDrawResponse({ ok: true, body: { article_id: 123, title: "x" } }),
    ).toEqual({ kind: "error" });
    expect(classifyDrawResponse({ ok: true, body: null })).toEqual({
      kind: "error",
    });
    expect(classifyDrawResponse({ ok: true, body: "not an object" })).toEqual({
      kind: "error",
    });
  });

  it("treats article_id: null on a 2xx as pool-empty", () => {
    expect(
      classifyDrawResponse({ ok: true, body: { article_id: null, title: null } }),
    ).toEqual({ kind: "pool-empty" });
  });

  it("treats a valid string article_id + title on a 2xx as a headline", () => {
    expect(
      classifyDrawResponse({
        ok: true,
        body: { article_id: "abc-123", title: "Başlık" },
      }),
    ).toEqual({ kind: "headline", articleId: "abc-123", title: "Başlık" });
  });
});

describe("startRoundClock", () => {
  it("starts the clock at now + roundSeconds when currentEndsAtMs is 0", () => {
    const now = 1_000_000;
    expect(startRoundClock(0, now, 60)).toBe(now + 60_000);
  });

  it("keeps an already-set deadline unchanged", () => {
    const now = 1_000_000;
    const existing = 999_999;
    expect(startRoundClock(existing, now, 60)).toBe(existing);
  });
});

describe("drawRetryDelayMs", () => {
  it("exports the 5 s cap and the 2 s fallback", () => {
    expect(DRAW_RETRY_MAX_MS).toBe(5000);
    expect(DRAW_RETRY_DEFAULT_MS).toBe(2000);
  });

  it("honours an integer Retry-After in seconds", () => {
    expect(drawRetryDelayMs(503, "5")).toBe(5000);
    expect(drawRetryDelayMs(503, "2")).toBe(2000);
    expect(drawRetryDelayMs(503, "0")).toBe(0);
  });

  it("caps a long Retry-After at 5 s", () => {
    expect(drawRetryDelayMs(503, "30")).toBe(5000);
  });

  it("falls back to 2 s when the header is missing or invalid", () => {
    expect(drawRetryDelayMs(503, null)).toBe(2000);
    expect(drawRetryDelayMs(503, "abc")).toBe(2000);
    expect(drawRetryDelayMs(503, "")).toBe(2000);
    expect(drawRetryDelayMs(503, "-3")).toBe(2000);
    expect(drawRetryDelayMs(503, "1.5")).toBe(2000);
    expect(drawRetryDelayMs(503, "Wed, 21 Oct 2026 07:28:00 GMT")).toBe(2000);
  });

  it("never retries a non-503 status", () => {
    expect(drawRetryDelayMs(500, "5")).toBeNull();
    expect(drawRetryDelayMs(429, "5")).toBeNull();
    expect(drawRetryDelayMs(200, null)).toBeNull();
    expect(drawRetryDelayMs(404, null)).toBeNull();
  });
});

describe("fetchDrawResponse", () => {
  const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  const HEADLINE = { article_id: "abc-123", title: "Başlık" };

  it("retries once after a 503, sleeping for Retry-After, and returns the second response", async () => {
    const doFetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        json({ error: "Service unavailable" }, { status: 503, headers: { "Retry-After": "5" } }),
      )
      .mockResolvedValueOnce(json(HEADLINE));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const out = await fetchDrawResponse(doFetch, sleep);

    expect(out).toEqual({ ok: true, body: HEADLINE });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(5000);
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it("uses the 2 s default when the 503 carries no Retry-After", async () => {
    const doFetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(json(HEADLINE));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    await fetchDrawResponse(doFetch, sleep);

    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("gives up after two consecutive 503s: {ok:false}, exactly 2 fetches", async () => {
    const doFetch = vi
      .fn<() => Promise<Response>>()
      .mockImplementation(async () =>
        json({ error: "Service unavailable" }, { status: 503, headers: { "Retry-After": "5" } }),
      );
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const out = await fetchDrawResponse(doFetch, sleep);

    expect(out).toEqual({ ok: false, body: null });
    expect(doFetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 500", async () => {
    const doFetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValue(json({ error: "Internal server error" }, { status: 500 }));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    const out = await fetchDrawResponse(doFetch, sleep);

    expect(out).toEqual({ ok: false, body: null });
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry a 429", async () => {
    const doFetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValue(json({ error: "Too many requests" }, { status: 429 }));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    expect(await fetchDrawResponse(doFetch, sleep)).toEqual({ ok: false, body: null });
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns null when the first fetch throws (network failure / client timeout) and never retries", async () => {
    const doFetch = vi.fn<() => Promise<Response>>().mockRejectedValue(new TypeError("fetch failed"));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    expect(await fetchDrawResponse(doFetch, sleep)).toBeNull();
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns null when the retry itself throws", async () => {
    const doFetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response("{}", { status: 503, headers: { "Retry-After": "1" } }))
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    expect(await fetchDrawResponse(doFetch, sleep)).toBeNull();
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it("returns {ok:true, body:null} for a 200 whose body is not valid JSON", async () => {
    const doFetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValue(new Response("<html>not json</html>", { status: 200 }));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    expect(await fetchDrawResponse(doFetch, sleep)).toEqual({ ok: true, body: null });
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("a 200 on the first try neither sleeps nor refetches", async () => {
    const doFetch = vi.fn<() => Promise<Response>>().mockResolvedValue(json(HEADLINE));
    const sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);

    expect(await fetchDrawResponse(doFetch, sleep)).toEqual({ ok: true, body: HEADLINE });
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("uses a real timer by default (default sleep is awaited, not skipped)", async () => {
    vi.useFakeTimers();
    try {
      const doFetch = vi
        .fn<() => Promise<Response>>()
        .mockResolvedValueOnce(new Response("{}", { status: 503, headers: { "Retry-After": "2" } }))
        .mockResolvedValueOnce(json(HEADLINE));
      const pending = fetchDrawResponse(doFetch);
      await vi.advanceTimersByTimeAsync(1999);
      expect(doFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ ok: true, body: HEADLINE });
      expect(doFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
