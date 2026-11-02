import { describe, it, expect, vi, afterEach } from "vitest";

// errors.ts imports the Sentry capture helper; the withApiErrors cases below
// only check that it still runs for an outage.
const captureServerException = vi.hoisted(() => vi.fn());
vi.mock("@/lib/sentry/server", () => ({ captureServerException }));

import {
  ALLOW_GET_ONLY,
  ALLOW_GET_POST,
  ALLOW_POST_ONLY,
  apiError,
  apiMethodNotAllowed,
  apiOptionsAllow,
  apiServerError,
  apiTooManyRequests,
  apiUnavailable,
  isUpstreamUnavailable,
  withApiErrors,
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

  it("exports the write-route Allow lists (POST-only, and GET+POST for the token links)", () => {
    expect(ALLOW_POST_ONLY).toBe("POST, OPTIONS");
    expect(ALLOW_GET_POST).toBe("GET, HEAD, POST, OPTIONS");
  });

  it("carries the write-route Allow lists through the 405 and the OPTIONS 204 unchanged", () => {
    for (const allow of [ALLOW_POST_ONLY, ALLOW_GET_POST]) {
      const refusal = apiMethodNotAllowed(allow);
      expect(refusal.status).toBe(405);
      expect(refusal.headers.get("Allow")).toBe(allow);
      const options = apiOptionsAllow(allow);
      expect(options.status).toBe(204);
      expect(options.headers.get("Allow")).toBe(allow);
    }
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

// ---------------------------------------------------------------------------
// hunt-27 resilience-3: a Supabase outage is a 503 + Retry-After, not a bug.
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
  captureServerException.mockReset();
});

/** A cause chain `depth` links deep, ending in `leaf`. */
function chain(depth: number, leaf: unknown): Error {
  let err: unknown = leaf;
  for (let i = 0; i < depth; i += 1) err = new Error(`wrapper ${i}`, { cause: err });
  return err as Error;
}

describe("isUpstreamUnavailable", () => {
  it.each([
    ["AbortError", new DOMException("aborted", "AbortError")],
    ["TimeoutError", new DOMException("timed out", "TimeoutError")],
    ["an Error named AbortError", Object.assign(new Error("x"), { name: "AbortError" })],
    ["PGRST000", { code: "PGRST000", message: "could not connect" }],
    ["PGRST001", { code: "PGRST001", message: "internal connection error" }],
    ["PGRST002", { code: "PGRST002", message: "schema cache" }],
    ["PGRST003", { code: "PGRST003", message: "pool timeout" }],
    ["57014 (statement timeout)", { code: "57014", message: "canceling statement" }],
    ["status 502", { status: 502, message: "bad gateway" }],
    ["status 503", { status: 503, message: "unavailable" }],
    ["status 504", { status: 504, message: "gateway timeout" }],
    ["status 520 (the gateway's unknown error, which postgrest-js also retries)", { status: 520, message: "origin error" }],
    ["status 521 (origin down)", { status: 521, message: "" }],
    ["status 522 (connection timed out)", { status: 522, message: "" }],
    ["status 523 (origin unreachable)", { status: 523, message: "" }],
    ["status 524 (a timeout occurred)", { status: 524, message: "" }],
    [
      "a postgrest-js abort transport error",
      { message: "AbortError: This operation was aborted", details: "", hint: "", code: "" },
    ],
    [
      "a postgrest-js fetch-failed transport error",
      { message: "TypeError: fetch failed", details: "", hint: "", code: "" },
    ],
    [
      "a postgrest-js body-phase timeout (AbortSignal.timeout rejecting res.text(), status 0)",
      { message: "TimeoutError: The operation was aborted due to timeout", code: "", status: 0 },
    ],
  ])("is true for %s", (_label, err) => {
    expect(isUpstreamUnavailable(err)).toBe(true);
  });

  it("finds a classified error through err.cause", () => {
    expect(isUpstreamUnavailable(chain(1, { code: "PGRST002", message: "x" }))).toBe(true);
    expect(isUpstreamUnavailable(chain(1, new DOMException("a", "AbortError")))).toBe(true);
    expect(
      isUpstreamUnavailable(chain(1, { message: "TypeError: fetch failed", code: "" })),
    ).toBe(true);
    expect(
      isUpstreamUnavailable(
        chain(1, {
          message: "TimeoutError: The operation was aborted due to timeout",
          code: "",
          status: 0,
        }),
      ),
    ).toBe(true);
  });

  it("follows err.cause up to depth 3 and no further", () => {
    const leaf = { code: "57014", message: "canceling statement" };
    expect(isUpstreamUnavailable(chain(3, leaf))).toBe(true);
    expect(isUpstreamUnavailable(chain(4, leaf))).toBe(false);
  });

  it("survives a cause cycle", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    const b: Error & { cause?: unknown } = new Error("b");
    a.cause = b;
    b.cause = a;
    expect(isUpstreamUnavailable(a)).toBe(false);
  });

  it.each([
    ["a plain Error", new Error("boom")],
    ["PGRST116 (no rows)", { code: "PGRST116", message: "no rows" }],
    ["23505 (unique violation)", { code: "23505", message: "duplicate key" }],
    ["status 500", { status: 500, message: "oops" }],
    ["status 404", { status: 404, message: "nope" }],
    ["status 429 (rate limited, not an outage)", { status: 429, message: "slow down" }],
    ["status 525 (a TLS handshake fault is not retried)", { status: 525, message: "ssl" }],
    ["a message that only contains the transport text", { message: "wrapped: TypeError: fetch failed" }],
    ["a message that merely starts with the word TimeoutError", { message: "TimeoutError is a word", code: "XX000" }],
    ["a message that only contains the timeout text", { message: "wrapped: TimeoutError: it timed out", code: "" }],
    ["a bare string", "AbortError"],
    ["null", null],
    ["undefined", undefined],
  ])("is false for %s", (_label, err) => {
    expect(isUpstreamUnavailable(err)).toBe(false);
  });
});

describe("apiUnavailable", () => {
  it("answers 503 with Retry-After: 30, no-store and the exact stable body", async () => {
    const res = apiUnavailable("req-1");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({
      error: "Service temporarily unavailable",
      code: "upstream_unavailable",
      details: { request_id: "req-1" },
    });
  });

  it("mints a request_id when none is given", async () => {
    const body = await apiUnavailable().json();
    expect(typeof body.details.request_id).toBe("string");
    expect(body.details.request_id.length).toBeGreaterThan(8);
    expect(Object.keys(body).sort()).toEqual(["code", "details", "error"]);
    expect(Object.keys(body.details)).toEqual(["request_id"]);
  });
});

describe("apiServerError classification", () => {
  it("answers apiUnavailable for a classified error and logs [api] <request_id> with the raw error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = { code: "PGRST002", message: "relation secret_table schema cache", details: "d" };

    const res = apiServerError(raw);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(body.code).toBe("upstream_unavailable");
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith("[api]", body.details.request_id, raw);
  });

  it("answers the 503 for a body-phase TimeoutError (status 0, empty code), not a 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = apiServerError({
      message: "TimeoutError: The operation was aborted due to timeout",
      code: "",
      status: 0,
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.json()).code).toBe("upstream_unavailable");
  });

  it("never serialises err.message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = apiServerError({ code: "57014", message: "SECRET relation foo_bar timed out" });
    expect(await res.text()).not.toContain("SECRET");
  });

  it("keeps a generic Error a 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = apiServerError(new Error("SECRET constraint users_pkey"));
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(text).toContain("Internal server error");
    expect(text).not.toContain("SECRET");
  });

  it("still honours a caller-supplied code on a 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = apiServerError(new Error("boom"), "custom_code");
    expect((await res.json()).code).toBe("custom_code");
  });
});

describe("withApiErrors classification", () => {
  it("turns a thrown classified error into the 503 and still reports it", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const thrown = new Error("[registry] sources read failed: x", {
      cause: new DOMException("aborted", "AbortError"),
    });
    const handler = withApiErrors(async () => {
      throw thrown;
    });

    const res = await handler();

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({
      error: "Service temporarily unavailable",
      code: "upstream_unavailable",
      details: { request_id: body.details.request_id },
    });
    expect(errSpy).toHaveBeenCalledWith("[api]", body.details.request_id, thrown);
    expect(captureServerException).toHaveBeenCalledWith(thrown);
  });

  it("keeps a thrown generic Error a 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = withApiErrors(async () => {
      throw new Error("boom");
    });
    const res = await handler();
    expect(res.status).toBe(500);
    expect(res.headers.get("Retry-After")).toBeNull();
  });

  it("passes a healthy response through untouched", async () => {
    const handler = withApiErrors(async () => new Response("ok", { status: 200 }));
    const res = await handler();
    expect(res.status).toBe(200);
  });
});
