import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware, config } from "@/middleware";
import { apiV1Headers } from "@/lib/api/keys";
import { API_V1_ERROR_HEADERS } from "@/lib/api/v1-cors";

// ---------------------------------------------------------------------------
// Gate 8: a malformed percent-encoding (decodeURIComponent throws URIError)
// on the five dynamic-segment surfaces is a client error. Without this gate
// the route handlers' own decodeURIComponent threw and the request ended as a
// 500 (and a Sentry event) instead of a 400.
// ---------------------------------------------------------------------------

const ORIGIN = "https://www.tayfhaber.com";
const UUID = "6ea8b39a-6ca7-4efe-ab30-71fdf1a2187b";
const JSON_BODY = '{"error":"Bad request: malformed URL encoding"}';
const TEXT_BODY = "Bad request: malformed URL encoding";

/** `new URL(path, ORIGIN)` keeps "%ff" verbatim, as the Edge runtime hands it over. */
function req(path: string): NextRequest {
  return new NextRequest(new URL(path, ORIGIN));
}

describe("middleware — malformed percent-encoding returns 400", () => {
  it("/api/v1/clusters/%ff: JSON body with the apiV1Headers set minus X-Tayf-Tier", async () => {
    const res = await middleware(req("/api/v1/clusters/%ff"));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(JSON_BODY);
    expect(res.headers.get("x-middleware-next")).toBeNull();
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();

    expect(res.headers.has("X-Tayf-Tier")).toBe(false);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    for (const [key, value] of Object.entries(apiV1Headers("free"))) {
      if (key === "X-Tayf-Tier") continue;
      expect(res.headers.get(key), key).toBe(value);
    }
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Access-Control-Expose-Headers")).toBe("X-Tayf-Tier, Retry-After");
  });

  it("/api/v1/sources/%ff/profile: same /api/v1 error contract", async () => {
    const res = await middleware(req("/api/v1/sources/%ff/profile"));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(JSON_BODY);
    expect(res.headers.has("X-Tayf-Tier")).toBe(false);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Vary")).toBe("Origin, Authorization");
  });

  it("/api/sources/%ff: JSON body, application/json, no-store", async () => {
    const res = await middleware(req("/api/sources/%ff"));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(JSON_BODY);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.has("X-Tayf-Tier")).toBe(false);
  });

  it("/embed/cluster/%ff: text/plain, no-store, noindex", async () => {
    const res = await middleware(req("/embed/cluster/%ff"));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(TEXT_BODY);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("/rss/%ff.xml: text/plain, no-store, noindex", async () => {
    const res = await middleware(req("/rss/%ff.xml"));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(TEXT_BODY);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it.each([
    "/api/v1/clusters/%E0%A4%A", // truncated multi-byte sequence
    "/api/v1/clusters/%",
    "/api/sources/%zz",
    "/embed/cluster/%c0%af", // overlong encoding
    "/rss/%ed%a0%80.xml", // lone surrogate
  ])("%s is a 400 too", async (path) => {
    const res = await middleware(req(path));
    expect(res.status).toBe(400);
  });
});

describe("middleware — well-formed encoded paths pass through untouched", () => {
  it.each([
    "/api/sources/on-haber",
    `/api/v1/clusters/${UUID}`,
    "/api/v1/sources/on-haber/profile",
    `/embed/cluster/${UUID}`,
    "/rss/dunya.xml",
    "/rss/%C5%9Fu.xml", // a valid UTF-8 escape
    "/api/sources/caf%C3%A9",
  ])("%s -> NextResponse.next()", async (path) => {
    const res = await middleware(req(path));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("does no network I/O on either outcome", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      await middleware(req("/api/sources/on-haber"));
      await middleware(req("/api/sources/%ff"));
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("middleware config — encoding gate matchers", () => {
  it("lists the five single-segment matchers and no wildcard for them", () => {
    for (const m of [
      "/api/v1/clusters/:id",
      "/api/v1/sources/:slug/profile",
      "/api/sources/:slug",
      "/embed/cluster/:id",
      "/rss/:topic",
    ]) {
      expect(config.matcher, m).toContain(m);
    }
    for (const m of config.matcher) {
      if (m === "/admin/:path*") continue;
      expect(m, m).not.toContain("*");
    }
  });
});

describe("API_V1_ERROR_HEADERS parity with apiV1Headers", () => {
  it("is apiV1Headers minus X-Tayf-Tier (edit both together)", () => {
    expect({ ...API_V1_ERROR_HEADERS, "X-Tayf-Tier": "free" }).toEqual(apiV1Headers("free"));
    expect(API_V1_ERROR_HEADERS).not.toHaveProperty("X-Tayf-Tier");
  });
});
