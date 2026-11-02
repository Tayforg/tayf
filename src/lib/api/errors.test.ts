import { describe, it, expect, vi } from "vitest";

// errors.ts imports the Sentry capture helper; nothing here exercises it.
vi.mock("@/lib/sentry/server", () => ({ captureServerException: vi.fn() }));

import {
  ALLOW_GET_ONLY,
  apiError,
  apiMethodNotAllowed,
  apiOptionsAllow,
  apiTooManyRequests,
} from "./errors";

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

  it("always carries the charset-qualified JSON content type, with or without init", () => {
    const plain = apiError(400, "bad");
    expect(plain.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    const withHeaders = apiError(503, "down", {}, { headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
    expect(withHeaders.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(withHeaders.headers.get("Retry-After")).toBe("60");
    expect(withHeaders.headers.get("Cache-Control")).toBe("no-store");
  });

  it("keeps a caller-supplied Content-Type and accepts every HeadersInit shape", () => {
    const own = apiError(400, "bad", {}, { headers: { "content-type": "application/problem+json" } });
    expect(own.headers.get("Content-Type")).toBe("application/problem+json");

    const fromTuples = apiError(400, "bad", {}, { headers: [["Retry-After", "5"]] });
    expect(fromTuples.headers.get("Retry-After")).toBe("5");
    expect(fromTuples.headers.get("Content-Type")).toBe("application/json; charset=utf-8");

    const fromHeaders = apiError(400, "bad", {}, { headers: new Headers({ "Retry-After": "7" }) });
    expect(fromHeaders.headers.get("Retry-After")).toBe("7");
    expect(fromHeaders.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  });

  it("does not mutate the caller's headers object", () => {
    const headers = { "Retry-After": "9" };
    apiError(429, "slow", {}, { headers });
    expect(headers).toEqual({ "Retry-After": "9" });
  });

  it("the 429 helper inherits the content type and keeps Retry-After and Cache-Control", () => {
    const res = apiTooManyRequests(2500);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Retry-After")).toBe("3");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("apiMethodNotAllowed", () => {
  it("exports the read-only Allow list", () => {
    expect(ALLOW_GET_ONLY).toBe("GET, HEAD, OPTIONS");
  });

  it("answers a JSON 405 with Allow, no-store and the canonical body, and no CORS", async () => {
    const res = apiMethodNotAllowed("GET, HEAD, OPTIONS");
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await res.text()).toBe('{"error":"Method not allowed"}');
  });

  it("adds Access-Control-Allow-Origin: * only when cors is requested", () => {
    const open = apiMethodNotAllowed("GET, HEAD, OPTIONS", { cors: true });
    expect(open.status).toBe(405);
    expect(open.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(open.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    expect(open.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(open.headers.get("Cache-Control")).toBe("no-store");

    expect(apiMethodNotAllowed("GET", { cors: false }).headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(apiMethodNotAllowed("GET", {}).headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("echoes whatever Allow list the caller passes", () => {
    expect(apiMethodNotAllowed("POST, OPTIONS").headers.get("Allow")).toBe("POST, OPTIONS");
  });
});

describe("apiOptionsAllow", () => {
  it("answers a bodyless 204 with the Allow header and no CORS", async () => {
    const res = apiOptionsAllow("GET, HEAD, OPTIONS");
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    expect(await res.text()).toBe("");
    expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("adds Access-Control-Allow-Origin: * when cors is requested", () => {
    const res = apiOptionsAllow("GET, HEAD, OPTIONS", { cors: true });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
