import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";

import { API_V1_ERROR_HEADERS } from "@/lib/api/v1-cors";
import { config, middleware } from "@/middleware";

// ---------------------------------------------------------------------------
// Permanent CI guard (hunt 12, h12-security-1): a malformed percent-encoding
// (%ff) in a dynamic segment must answer a client error from the edge, never an
// HTML 500 from the route. #148 covered five surfaces by hand and missed the
// rest (/rozet, /sitemaps, /rapor, /hikaye, /cluster/:id/kart, /source/:slug/
// opengraph-image, /embed/*, /api/v1/*, /api/admin/corrections/:id).
//
// This file removes the "by hand": it walks src/app for every page / route /
// metadata-image file below a dynamic segment ([x], [...x], [[...x]]), builds
// the URL with %ff in each dynamic segment, and requires that
//   (1) some config.matcher entry matches that URL (Next's own matcher), and
//   (2) the middleware answers it with a client error or the not-found sink,
//       never NextResponse.next().
// A new dynamic route that is not covered fails here, with its URL in the
// message. A second block pins that WELL-FORMED URLs of the same routes are
// still passed through with no I/O (the decode-only branches must not gate).
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(here, "../../src/app");
const ORIGIN = "https://www.tayfhaber.com";
const UUID = "6ea8b39a-6ca7-4efe-ab30-71fdf1a2187b";

/** File names that serve a URL; a dynamic route directory without one is not routable. */
const ROUTE_FILES = new Set([
  "page.tsx",
  "route.ts",
  "route.tsx",
  "opengraph-image.tsx",
  "twitter-image.tsx",
  "icon.tsx",
  "apple-icon.tsx",
]);

/**
 * Dynamic routes whose %ff request is deliberately NOT answered with a 400 by
 * the middleware (template path -> why). Each entry must stay true: the route
 * must still exist and the middleware must still answer an anonymous request
 * with the login redirect, never next(); otherwise the entry is stale.
 */
const EXEMPT: Record<string, string> = {
  "/admin/rapor/[clusterId]": "session-gated, only an authenticated admin reaches the route",
};

interface DynamicRoute {
  /** Template path, groups and slots removed: /cluster/[id]/kart */
  template: string;
  /** Request path with %ff in every dynamic segment: /cluster/%ff/kart */
  url: string;
}

const DYNAMIC_SEGMENT = /^\[\[?(?:\.\.\.)?[^\][]+\]\]?$/; // [x] [...x] [[...x]]
const CATCH_ALL_SEGMENT = /^\[\[?\.\.\.[^\][]+\]\]?$/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Every routable file below at least one dynamic segment, mapped to its URL. */
function dynamicRoutes(): DynamicRoute[] {
  const routes: DynamicRoute[] = [];
  for (const file of walk(APP_DIR)) {
    const parts = relative(APP_DIR, file).split(sep);
    const name = parts.pop() as string;
    if (!ROUTE_FILES.has(name)) continue;
    // A private folder (_x) opts its whole subtree out of routing.
    if (parts.some((s) => s.startsWith("_"))) continue;
    // Route groups (g) and parallel-route slots @s do not appear in the URL.
    const segments = parts.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"));
    if (!segments.some((s) => DYNAMIC_SEGMENT.test(s))) continue;

    const metadata = name === "page.tsx" || name.startsWith("route.") ? [] : [name.replace(/\.tsx$/, "")];
    const template = "/" + [...segments, ...metadata].join("/");
    const url =
      "/" +
      [
        ...segments.map((s) => (CATCH_ALL_SEGMENT.test(s) ? "%ff/x" : DYNAMIC_SEGMENT.test(s) ? "%ff" : s)),
        ...metadata,
      ].join("/");
    routes.push({ template, url });
  }
  return routes.sort((a, b) => a.template.localeCompare(b.template));
}

const matches = (source: string, path: string) => getPathMatch(source)(path) !== false;

type Outcome = "v1-400" | "json-400" | "text-400" | "not-found-rewrite" | "admin-login-307" | "next" | "other";

/** Classifies a middleware response and checks the headers that make each class what it is. */
function classify(res: Response): Outcome {
  if (res.headers.get("x-middleware-next") === "1") return "next";
  const rewrite = res.headers.get("x-middleware-rewrite");
  if (rewrite !== null) return rewrite === `${ORIGIN}/__tayf-not-found` ? "not-found-rewrite" : "other";
  if (res.status === 307) return res.headers.get("location") === `${ORIGIN}/admin/login` ? "admin-login-307" : "other";
  if (res.status !== 400) return "other";
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const isV1 = Object.entries(API_V1_ERROR_HEADERS).every(([k, v]) => res.headers.get(k) === v);
    return isV1 ? "v1-400" : res.headers.get("cache-control") === "no-store" ? "json-400" : "other";
  }
  if (
    type.includes("text/plain") &&
    res.headers.get("cache-control") === "no-store" &&
    res.headers.get("x-robots-tag") === "noindex"
  ) {
    return "text-400";
  }
  return "other";
}

function request(path: string): NextRequest {
  return new NextRequest(ORIGIN + path);
}

/** What the middleware must answer for a %ff URL on a non-exempt route. */
function allowedOutcomes(url: string): Outcome[] {
  if (url.startsWith("/api/v1/")) return ["v1-400"];
  if (url.startsWith("/api/")) return ["json-400"];
  return ["text-400", "not-found-rewrite"];
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // No gate may reach the network for a malformed URL (nor for a valid pass-through).
  fetchMock = vi.fn(() => {
    throw new Error("middleware must not call fetch for these URLs");
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("middleware bad-encoding parity: every dynamic route", () => {
  const routes = dynamicRoutes();

  it("finds a non-vacuous set of dynamic routes with a %ff segment", () => {
    expect(routes.length).toBeGreaterThanOrEqual(15);
    for (const r of routes) expect(r.url, r.template).toContain("%ff");
    // The surfaces #148 missed are in the walk.
    const urls = routes.map((r) => r.url);
    for (const must of [
      "/rozet/%ff",
      "/sitemaps/%ff",
      "/rapor/%ff",
      "/rapor/%ff/markdown",
      "/cluster/%ff/kart",
      "/source/%ff/opengraph-image",
      "/hikaye/%ff",
      "/embed/%ff/x",
      "/api/v1/%ff/x",
      "/api/admin/corrections/%ff",
    ]) {
      expect(urls, must).toContain(must);
    }
  });

  it("the walk builds URLs the way Next does (groups dropped, catch-all becomes %ff/x)", () => {
    const byTemplate = new Map(routes.map((r) => [r.template, r.url]));
    expect(byTemplate.get("/admin/rapor/[clusterId]")).toBe("/admin/rapor/%ff");
    expect(byTemplate.get("/api/v1/[...path]")).toBe("/api/v1/%ff/x");
    expect(byTemplate.get("/embed/[...rest]")).toBe("/embed/%ff/x");
  });

  for (const route of routes) {
    const exempt = EXEMPT[route.template];

    it(`${route.template} (${route.url}) is matched by config.matcher`, () => {
      const hit = config.matcher.filter((m) => matches(m, route.url));
      expect(hit, `no config.matcher entry matches ${route.url}; add one in src/middleware.ts`).not.toEqual([]);
    });

    if (exempt === undefined) {
      it(`${route.template}: ${route.url} answers a client error, never next()`, async () => {
        const res = await middleware(request(route.url));
        const outcome = classify(res);
        expect(outcome, `${route.url} -> status ${res.status}`).not.toBe("next");
        expect(allowedOutcomes(route.url), `${route.url} -> ${outcome}`).toContain(outcome);
        expect(fetchMock).not.toHaveBeenCalled();
      });
    } else {
      it(`${route.template}: exempt (${exempt}) and still redirects an anonymous request, never next()`, async () => {
        const res = await middleware(request(route.url));
        expect(classify(res), `${route.url} -> status ${res.status}`).toBe("admin-login-307");
        expect(fetchMock).not.toHaveBeenCalled();
      });
    }
  }

  it("has no stale exemption", async () => {
    const templates = new Set(routes.map((r) => r.template));
    for (const template of Object.keys(EXEMPT)) {
      expect(templates.has(template), `EXEMPT lists ${template}, which is not a dynamic route any more`).toBe(true);
      const route = routes.find((r) => r.template === template) as DynamicRoute;
      // If the middleware starts answering it with a 400/404 the exemption is dead weight.
      const outcome = classify(await middleware(request(route.url)));
      expect(outcome, `${template} no longer needs its exemption`).toBe("admin-login-307");
      expect(EXEMPT[template]?.length ?? 0, `${template}: give a reason`).toBeGreaterThan(10);
    }
  });
});

describe("middleware bad-encoding parity: answer shapes", () => {
  const body = '{"error":"Bad request: malformed URL encoding"}';

  it("/api/v1/%ff is JSON with the apiV1 CORS set and no X-Tayf-Tier", async () => {
    const res = await middleware(request("/api/v1/%ff"));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(body);
    expect(res.headers.has("X-Tayf-Tier")).toBe(false);
    for (const [k, v] of Object.entries(API_V1_ERROR_HEADERS)) expect(res.headers.get(k), k).toBe(v);
  });

  it("/api/admin/corrections/%ff is JSON, no-store, without CORS", async () => {
    const res = await middleware(request("/api/admin/corrections/%ff"));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(body);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("page and file routes answer text/plain, no-store, noindex", async () => {
    for (const path of ["/rozet/%ff.svg", "/sitemaps/%ff", "/rapor/%ff/markdown", "/embed/%ff", "/hikaye/%ff"]) {
      const res = await middleware(request(path));
      expect(res.status, path).toBe(400);
      expect(await res.text(), path).toBe("Bad request: malformed URL encoding");
      expect(res.headers.get("Content-Type"), path).toContain("text/plain");
      expect(res.headers.get("Cache-Control"), path).toBe("no-store");
      expect(res.headers.get("X-Robots-Tag"), path).toBe("noindex");
    }
  });
});

describe("middleware bad-encoding parity: well-formed URLs pass through untouched", () => {
  it.each([
    "/rozet/abc.svg",
    "/sitemaps/0.xml",
    "/rapor/tok",
    "/rapor/tok/markdown",
    `/cluster/${UUID}/kart`,
    `/cluster/${UUID}/opengraph-image`,
    "/source/cnn-turk/twitter-image",
    "/source/cnn-turk/opengraph-image",
    "/hikaye/x",
    "/embed/foo/bar",
    "/embed/foo",
    "/embed",
    "/api/v1/clusters",
    "/api/v1/foo/bar",
    "/api/v1",
    "/api/admin/corrections/abc",
    "/rozet/caf%C3%A9.svg", // a valid UTF-8 escape
  ])("%s -> NextResponse.next() with no fetch", async (path) => {
    const res = await middleware(request(path));
    expect(res.headers.get("x-middleware-next"), path).toBe("1");
    expect(res.headers.get("x-middleware-rewrite"), path).toBeNull();
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("the nested /cluster and /source branches stay decode-only (no UUID, slug or merge gate)", async () => {
    // A nested cluster path with a non-UUID id is not a 404 from the middleware.
    const res = await middleware(request("/cluster/not-a-uuid/kart"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    const res2 = await middleware(request("/source/Bad_Slug!/opengraph-image"));
    expect(res2.headers.get("x-middleware-next")).toBe("1");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
