import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";

import { API_FALLBACK_REWRITES } from "@/lib/api/fallback-rewrites";

// ---------------------------------------------------------------------------
// An unknown /api/* path outside /api/v1 used to answer Next's 44 KB HTML 404
// (the site's not-found page), which breaks a JSON client. The fix is a
// FALLBACK rewrite, not an `src/app/api/[...slug]` catch-all: fallback rewrites
// only run after every filesystem and dynamic route has failed to match, so
// they cannot shadow a real route, and a new catch-all directory would be
// walked by tests/guards/middleware-bad-encoding.test.ts and force an
// '/api/:path*' wildcard into the middleware matcher.
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const API_DIR = path.join(ROOT, "src/app/api");

describe("API_FALLBACK_REWRITES", () => {
  it("is one fallback rewrite of /api/:path* to /api/unmatched and nothing in the earlier phases", () => {
    expect(API_FALLBACK_REWRITES).toEqual({
      beforeFiles: [],
      afterFiles: [],
      fallback: [{ source: "/api/:path*", destination: "/api/unmatched" }],
    });
  });

  it("matches /api and every unknown path under it, and nothing outside /api", () => {
    const rule = API_FALLBACK_REWRITES.fallback[0]!;
    const matches = (p: string) => getPathMatch(rule.source)(p) !== false;
    expect(matches("/api")).toBe(true);
    expect(matches("/api/source")).toBe(true);
    expect(matches("/api/a/b")).toBe(true);
    expect(matches("/apix")).toBe(false);
    expect(matches("/source")).toBe(false);
  });

  it("is wired into next.config.ts through rewrites(), beside redirects()", () => {
    const config = readFileSync(path.join(ROOT, "next.config.ts"), "utf8");
    expect(config).toContain('from "./src/lib/api/fallback-rewrites"');
    expect(config).toContain("async rewrites()");
    expect(config).toContain("return API_FALLBACK_REWRITES;");
  });

  it("is not a catch-all directory: src/app/api has no [...x] segment outside /api/v1", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (!statSync(full).isDirectory()) continue;
        if (entry.startsWith("[...") || entry.startsWith("[[...")) {
          offenders.push(path.relative(API_DIR, full));
        }
        walk(full);
      }
    };
    walk(API_DIR);
    expect(offenders).toEqual([path.join("v1", "[...path]")]);
  });
});

describe("/api/unmatched route handler", () => {
  const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

  for (const method of METHODS) {
    it(`${method} answers the JSON not_found envelope with a short public cache`, async () => {
      const mod = await import("@/app/api/unmatched/route");
      const handler = mod[method];
      expect(handler, `${method} is not exported`).toBeTypeOf("function");
      // Called with no arguments: a handler that read the request would throw
      // here, and one that does not keeps GET prerenderable.
      const res = await handler();
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=60, s-maxage=300");
      expect(await res.json()).toEqual({ error: "Not found", code: "not_found" });
    });
  }
});
