import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { middleware, config } from "@/middleware";
import { apiV1Headers } from "@/lib/api/keys";
import { API_V1_ERROR_HEADERS } from "@/lib/api/v1-cors";

// ---------------------------------------------------------------------------
// Gate 8: a malformed percent-encoding (decodeURIComponent throws URIError)
// on a dynamic-segment surface is a client error. Without this gate the route
// handlers' own decodeURIComponent threw and the request ended as a 500 (and a
// Sentry event) instead of a 400. #148 covered five surfaces; hunt 12
// (h12-security-1) closed the rest (rozet, sitemaps, rapor, hikaye, the nested
// /cluster and /source routes, /embed/*, /api/v1/*, /api/admin/corrections/:id).
// tests/guards/middleware-bad-encoding.test.ts walks src/app so a new dynamic
// route cannot be missed again; this file pins the answer shape per surface.
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

  it("/api/v1/%ff: the catch-all keeps the /api/v1 JSON + CORS contract (no X-Tayf-Tier)", async () => {
    const res = await middleware(req("/api/v1/%ff"));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(JSON_BODY);
    expect(res.headers.get("x-middleware-next")).toBeNull();
    expect(res.headers.has("X-Tayf-Tier")).toBe(false);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Type")).toContain("application/json");
    for (const [key, value] of Object.entries(apiV1Headers("free"))) {
      if (key === "X-Tayf-Tier") continue;
      expect(res.headers.get(key), key).toBe(value);
    }
  });

  it("/api/admin/corrections/%ff: JSON body, application/json, no-store", async () => {
    const res = await middleware(req("/api/admin/corrections/%ff"));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(JSON_BODY);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.has("X-Tayf-Tier")).toBe(false);
  });

  // hunt 12: the surfaces #148 left to a 500 (prod 2026-11-01: HTTP 500 text/html).
  it.each([
    "/rozet/%ff.svg",
    "/sitemaps/%ff",
    "/rapor/%ff",
    "/rapor/%ff/markdown",
    "/cluster/%ff/kart",
    `/cluster/${UUID}/%ff`,
    "/cluster/%ff/opengraph-image",
    "/source/%ff/opengraph-image",
    "/source/%ff/twitter-image",
    "/hikaye/%ff",
    "/embed/%ff",
    "/embed/%ff/x",
  ])("%s: text/plain, no-store, noindex, 400", async (path) => {
    const res = await middleware(req(path));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(TEXT_BODY);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(res.headers.get("x-middleware-next")).toBeNull();
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it.each([
    "/api/v1/%ff/x",
    "/api/v1/clusters/%ff/extra",
    "/api/v1/kap/%E0%A4%A",
  ])("%s is a /api/v1 JSON 400 too", async (path) => {
    const res = await middleware(req(path));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(JSON_BODY);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.has("X-Tayf-Tier")).toBe(false);
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
    // hunt 12: the newly matched surfaces, well-formed
    "/rozet/abc.svg",
    "/sitemaps/0.xml",
    "/rapor/tok",
    "/rapor/tok/markdown",
    `/cluster/${UUID}/kart`,
    "/source/cnn-turk/twitter-image",
    "/hikaye/x",
    "/embed/foo/bar",
    "/api/v1/clusters",
    "/api/v1/foo/bar",
    "/api/admin/corrections/abc",
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
  // The only matcher entries that may end in :path*: the admin scope and the two
  // catch-all route directories, which are answered decode-only.
  const DECODE_ONLY_WILDCARDS = ["/admin/:path*", "/api/v1/:path*", "/embed/:path*"];

  it("lists the single-segment matchers and the hunt-12 decode-only entries", () => {
    for (const m of [
      "/api/v1/clusters/:id",
      "/api/v1/sources/:slug/profile",
      "/api/sources/:slug",
      "/embed/cluster/:id",
      "/rss/:topic",
      "/cluster/:id/:sub",
      "/source/:slug/:sub",
      "/rozet/:file",
      "/sitemaps/:file",
      "/rapor/:token",
      "/rapor/:token/:sub",
      "/hikaye/:slug",
      "/api/admin/corrections/:id",
    ]) {
      expect(config.matcher, m).toContain(m);
    }
  });

  it("allows a wildcard only for the admin scope and the two catch-all route dirs", () => {
    for (const m of config.matcher) {
      if (DECODE_ONLY_WILDCARDS.includes(m)) continue;
      expect(m, m).not.toContain("*");
    }
    expect(config.matcher.filter((m) => m.includes("*")).sort()).toEqual([...DECODE_ONLY_WILDCARDS].sort());
  });
});

describe("API_V1_ERROR_HEADERS parity with apiV1Headers", () => {
  it("is apiV1Headers minus X-Tayf-Tier (edit both together)", () => {
    expect({ ...API_V1_ERROR_HEADERS, "X-Tayf-Tier": "free" }).toEqual(apiV1Headers("free"));
    expect(API_V1_ERROR_HEADERS).not.toHaveProperty("X-Tayf-Tier");
  });
});
