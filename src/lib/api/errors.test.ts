import { describe, it, expect, vi } from "vitest";

// errors.ts imports the Sentry capture helper; nothing here exercises it.
vi.mock("@/lib/sentry/server", () => ({ captureServerException: vi.fn() }));

import { apiError, apiTooManyRequests } from "./errors";

describe("apiTooManyRequests", () => {
  it("answers 429 with whole-second Retry-After, no-store and the canonical body", async () => {
    const res = apiTooManyRequests(1715);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: "Too many requests",
      details: { retryAfterMs: 1715 },
    });
  });

  it("rounds a fractional millisecond value up in the body", async () => {
    const res = apiTooManyRequests(999.2);
    const body = await res.json();
    expect(body.details.retryAfterMs).toBe(1000);
    expect(res.headers.get("Retry-After")).toBe("1");
  });

  it("never emits Retry-After below 1 for 0", async () => {
    const res = apiTooManyRequests(0);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect((await res.json()).details.retryAfterMs).toBe(0);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -5],
  ])("treats %s as 0 ms and a 1 s Retry-After", async (_label, value) => {
    const res = apiTooManyRequests(value);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect((await res.json()).details.retryAfterMs).toBe(0);
  });

  it("rounds Retry-After up on an exact boundary only when needed", () => {
    expect(apiTooManyRequests(1000).headers.get("Retry-After")).toBe("1");
    expect(apiTooManyRequests(1001).headers.get("Retry-After")).toBe("2");
    expect(apiTooManyRequests(60_000).headers.get("Retry-After")).toBe("60");
  });

  it("honours a custom message and code", async () => {
    const res = apiTooManyRequests(3000, {
      message: "Çok fazla istek",
      code: "ip_floor",
    });
    expect(await res.json()).toEqual({
      error: "Çok fazla istek",
      code: "ip_floor",
      details: { retryAfterMs: 3000 },
    });
    expect(res.headers.get("Retry-After")).toBe("3");
  });

  it("omits the code key entirely when none is given", async () => {
    const body = await apiTooManyRequests(10).json();
    expect("code" in body).toBe(false);
  });
});

describe("apiError headers passthrough", () => {
  it("sets init.headers on the response", async () => {
    const res = apiError(
      503,
      "down",
      { code: "x" },
      { headers: { "Retry-After": "60", "Cache-Control": "no-store" } },
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "down", code: "x" });
  });

  it("is unchanged without init: no extra headers, same body", async () => {
    const res = apiError(400, "bad", { details: { field: "a" } });
    expect(res.status).toBe(400);
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(res.headers.get("Cache-Control")).toBeNull();
    expect(await res.json()).toEqual({ error: "bad", details: { field: "a" } });
  });
});
