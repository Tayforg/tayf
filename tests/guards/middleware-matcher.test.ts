import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";

import { config, middleware } from "@/middleware";

// ---------------------------------------------------------------------------
// Permanent CI guard. src/middleware.ts is one function behind one matcher
// list. Every entry in `config.matcher` makes Next invoke the function for
// that path, and any path the function does not recognise falls to the
// admin-scope line, which answers notFoundRewrite (a real 404). So a matcher
// entry added WITHOUT a matching `pathname.startsWith("<prefix>")` branch above
// that line would silently 404 a whole surface (an API, the RSS feeds, the
// embed widget). This guard fails the build instead.
//
// Rules pinned here:
//   1. every entry is a literal path whose params are single-segment; a
//      wildcard (`:path*`) is allowed only for the admin scope and the two
//      catch-all route directories that the middleware answers decode-only
//      (DECODE_ONLY_WILDCARDS: /api/v1/[...path] and /embed/[...rest]). A
//      wildcard must never be added for a route that has a gate (/cluster/:id,
//      /source/:slug): that would run the gate on its sub-routes;
//   2. every non-admin entry has its static prefix handled in middleware.ts as
//      pathname.startsWith("<prefix>"), BEFORE the admin-scope line;
//   3. the matcher strings behave as intended under Next's own matcher.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const MIDDLEWARE_SRC = readFileSync(resolve(here, "../../src/middleware.ts"), "utf8");

/**
 * The only matcher entries that may end in `:path*`. The admin scope is handled
 * by the final block; the other two sit in the decode-only branch (a malformed
 * percent-encoding answers 400, anything else is NextResponse.next()).
 */
const DECODE_ONLY_WILDCARDS = ["/admin/:path*", "/api/v1/:path*", "/embed/:path*"];

/** The one line every public gate must sit above (see middleware-routing.test.ts). */
const ADMIN_SCOPE_NEEDLE = 'lower.startsWith("/admin/")';

/** Blanks // and block comments (keeps offsets); same helper as the other guards. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

/** Static prefix of a matcher entry: everything before the first ':'. */
function staticPrefix(entry: string): string {
  const i = entry.indexOf(":");
  return i === -1 ? entry : entry.slice(0, i);
}

/** Offset of `pathname.startsWith("<prefix>")` in comment-blanked code, or -1. */
function findStartsWith(code: string, prefix: string): number {
  return code.indexOf(`pathname.startsWith(${JSON.stringify(prefix)})`);
}

/** Every rule violation for a (matcher, middleware source) pair. */
function matcherViolations(matcher: readonly string[], source: string): string[] {
  const out: string[] = [];
  const code = blankComments(source);
  const adminIdx = code.indexOf(ADMIN_SCOPE_NEEDLE);
  if (adminIdx === -1) out.push(`admin-scope line ${ADMIN_SCOPE_NEEDLE} not found`);

  for (const entry of matcher) {
    if (!entry.startsWith("/")) out.push(`${entry}: not an absolute literal path`);
    if (/[()?+{}]/.test(entry.replace(":path*", ""))) {
      out.push(`${entry}: uses regexp/modifier syntax`);
    }
    const wildcard = entry.includes(":path*");
    if (wildcard) {
      if (!DECODE_ONLY_WILDCARDS.includes(entry)) {
        out.push(`${entry}: only ${DECODE_ONLY_WILDCARDS.join(", ")} may be a wildcard`);
        continue;
      }
    } else if (entry.includes("*")) {
      out.push(`${entry}: wildcard`);
    }
    // Params must be whole, single segments (":id" between slashes or at the end).
    for (const segment of entry.split("/")) {
      if (wildcard && segment === ":path*") continue;
      if (segment.includes(":") && !/^:[A-Za-z][A-Za-z0-9_]*$/.test(segment)) {
        out.push(`${entry}: param segment "${segment}" is not a plain single-segment param`);
      }
    }

    // The admin scope is handled by the final block, not by a startsWith branch.
    if (entry === "/admin" || entry.startsWith("/admin/")) continue;

    const prefix = staticPrefix(entry);
    const idx = findStartsWith(code, prefix);
    if (idx === -1) {
      out.push(`${entry}: no pathname.startsWith("${prefix}") branch in middleware.ts`);
    } else if (adminIdx !== -1 && idx > adminIdx) {
      out.push(`${entry}: pathname.startsWith("${prefix}") sits after the admin-scope line`);
    }
  }
  return out;
}

describe("middleware matcher — every entry has a gate", () => {
  it("has no rule violations in the real middleware.ts", () => {
    expect(matcherViolations(config.matcher, MIDDLEWARE_SRC)).toEqual([]);
  });

  it("every entry is a literal path with single-segment params; :path* only in DECODE_ONLY_WILDCARDS", () => {
    const wildcards = config.matcher.filter((m) => m.includes("*"));
    expect([...wildcards].sort()).toEqual([...DECODE_ONLY_WILDCARDS].sort());
    for (const m of config.matcher) {
      expect(m.startsWith("/"), m).toBe(true);
      expect(m, m).not.toMatch(/[()?+{}]/);
    }
  });

  it("covers every dynamic surface the edge gates guard", () => {
    for (const m of [
      "/ekonomi/:ticker",
      "/konu/:slug",
      "/cluster/:id",
      "/source/:slug",
      "/gundem/:key",
      "/hafta/:hafta",
      "/api/v1/clusters/:id",
      "/api/v1/sources/:slug/profile",
      "/api/sources/:slug",
      "/embed/cluster/:id",
      "/rss/:topic",
      // hunt 12 (h12-security-1): the surfaces #148 missed, decode-only
      "/cluster/:id/:sub",
      "/source/:slug/:sub",
      "/rozet/:file",
      "/sitemaps/:file",
      "/rapor/:token",
      "/rapor/:token/:sub",
      "/hikaye/:slug",
      "/api/admin/corrections/:id",
      "/api/v1/:path*",
      "/embed/:path*",
    ]) {
      expect(config.matcher, m).toContain(m);
    }
  });

  it("never widens the gated routes to their sub-routes", () => {
    for (const m of ["/cluster/:path*", "/source/:path*", "/rapor/:path*", "/ekonomi/:path*", "/gundem/:path*"]) {
      expect(config.matcher, m).not.toContain(m);
    }
  });
});

describe("middleware matcher — behaviour under Next's own matcher (getPathMatch)", () => {
  const matches = (source: string, path: string) => getPathMatch(source)(path) !== false;

  it("/rss/:topic matches a feed file name", () => {
    expect(matches("/rss/:topic", "/rss/dunya.xml")).toBe(true);
    expect(matches("/rss/:topic", "/rss/%ff.xml")).toBe(true);
    expect(matches("/rss/:topic", "/rss")).toBe(false);
    expect(matches("/rss/:topic", "/rss/a/b")).toBe(false);
  });

  it("/api/v1/clusters/:id does not match the list route or a nested path", () => {
    expect(matches("/api/v1/clusters/:id", "/api/v1/clusters/6ea8b39a")).toBe(true);
    expect(matches("/api/v1/clusters/:id", "/api/v1/clusters")).toBe(false);
    expect(matches("/api/v1/clusters/:id", "/api/v1/clusters/x/y")).toBe(false);
  });

  it("the other new entries stay single-segment", () => {
    expect(matches("/api/sources/:slug", "/api/sources")).toBe(false);
    expect(matches("/api/sources/:slug", "/api/sources/on-haber")).toBe(true);
    expect(matches("/api/v1/sources/:slug/profile", "/api/v1/sources/on-haber/profile")).toBe(true);
    expect(matches("/api/v1/sources/:slug/profile", "/api/v1/sources")).toBe(false);
    expect(matches("/embed/cluster/:id", "/embed/cluster/x")).toBe(true);
    expect(matches("/embed/cluster/:id", "/embed/cluster")).toBe(false);
    expect(matches("/embed/cluster/:id", "/embed/foo")).toBe(false);
    expect(matches("/hafta/:hafta", "/hafta")).toBe(false);
    expect(matches("/hafta/:hafta", "/hafta/2026-W43")).toBe(true);
  });

  it("the real matcher list leaves the bare list/index routes alone", () => {
    const hit = (path: string) => config.matcher.some((m) => matches(m, path));
    for (const path of ["/hafta", "/api/sources", "/rss", "/rozet", "/sitemaps", "/rapor", "/hikaye"]) {
      expect(hit(path), path).toBe(false);
    }
    for (const path of [
      "/hafta/2026-W43",
      "/api/sources/x",
      "/rss/dunya.xml",
      "/embed/cluster/x",
      "/rozet/x.svg",
      "/rapor/tok/markdown",
      "/cluster/x/kart",
      "/source/x/opengraph-image",
    ]) {
      expect(hit(path), path).toBe(true);
    }
  });

  it("the catch-all route dirs are matched, and pass through when the URL is well-formed", async () => {
    // /api/v1/:path* and /embed/:path* also match the bare list routes and the
    // root of each catch-all; the middleware must not 404 or gate any of them.
    for (const path of [
      "/api/v1/clusters",
      "/api/v1/sources",
      "/api/v1/clusters/6ea8b39a",
      "/api/v1",
      "/embed/anything",
      "/embed",
    ]) {
      expect(
        config.matcher.some((m) => matches(m, path)),
        path,
      ).toBe(true);
      const res = await middleware(new NextRequest(`https://www.tayfhaber.com${path}`));
      expect(res.headers.get("x-middleware-next"), path).toBe("1");
      expect(res.headers.get("x-middleware-rewrite"), path).toBeNull();
    }
  });

  it("the new wildcards match their root and every depth; the single-segment entries do not", () => {
    expect(matches("/api/v1/:path*", "/api/v1/a/b/c")).toBe(true);
    expect(matches("/embed/:path*", "/embed/a/b")).toBe(true);
    expect(matches("/cluster/:id/:sub", "/cluster/x/kart")).toBe(true);
    expect(matches("/cluster/:id/:sub", "/cluster/x")).toBe(false);
    expect(matches("/cluster/:id/:sub", "/cluster/x/y/z")).toBe(false);
    expect(matches("/source/:slug/:sub", "/source/x/opengraph-image")).toBe(true);
    expect(matches("/rapor/:token", "/rapor/tok/markdown")).toBe(false);
    expect(matches("/rapor/:token/:sub", "/rapor/tok/markdown")).toBe(true);
  });
});

describe("middleware matcher guard — the finder itself (mutation tests)", () => {
  const SYNTHETIC = [
    "export async function middleware(req) {",
    '  if (pathname.startsWith("/foo/")) return NextResponse.next();',
    '  const lower = pathname.toLowerCase();',
    '  if (lower !== "/admin" && !lower.startsWith("/admin/")) return notFoundRewrite(req);',
    "}",
  ].join("\n");

  it("accepts a well-formed synthetic source", () => {
    expect(matcherViolations(["/admin", "/admin/:path*", "/foo/:id"], SYNTHETIC)).toEqual([]);
  });

  it("flags a matcher entry whose startsWith branch is missing", () => {
    const v = matcherViolations(["/admin/:path*", "/foo/:id", "/bar/:id"], SYNTHETIC);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('/bar/:id');
    expect(v[0]).toContain('pathname.startsWith("/bar/")');
  });

  it("flags a branch that only survives in a comment", () => {
    const commented = SYNTHETIC.replace(
      '  if (pathname.startsWith("/foo/")) return NextResponse.next();',
      '  // if (pathname.startsWith("/foo/")) return NextResponse.next();',
    );
    expect(matcherViolations(["/admin/:path*", "/foo/:id"], commented)).toHaveLength(1);
    const blockCommented = SYNTHETIC.replace(
      '  if (pathname.startsWith("/foo/")) return NextResponse.next();',
      '  /* if (pathname.startsWith("/foo/")) return NextResponse.next(); */',
    );
    expect(matcherViolations(["/admin/:path*", "/foo/:id"], blockCommented)).toHaveLength(1);
  });

  it("flags a branch placed after the admin-scope line", () => {
    const lines = SYNTHETIC.split("\n");
    const moved = [lines[0], lines[2], lines[3], lines[1], lines[4]].join("\n");
    const v = matcherViolations(["/admin/:path*", "/foo/:id"], moved);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("after the admin-scope line");
  });

  it("flags a prefix that is only a longer or shorter near-miss", () => {
    expect(matcherViolations(["/admin/:path*", "/fo/:id"], SYNTHETIC)).toHaveLength(1);
    expect(matcherViolations(["/admin/:path*", "/foo/bar/:id"], SYNTHETIC)).toHaveLength(1);
  });

  it("flags a stray :path* wildcard, a regexp modifier and a multi-segment-looking param", () => {
    expect(matcherViolations(["/admin/:path*", "/foo/:path*"], SYNTHETIC).join("|")).toContain(
      "may be a wildcard",
    );
    expect(matcherViolations(["/admin/:path*", "/foo/:id(.*)"], SYNTHETIC).join("|")).toContain(
      "regexp/modifier syntax",
    );
    expect(matcherViolations(["/admin/:path*", "/foo/x:id"], SYNTHETIC).join("|")).toContain(
      "not a plain single-segment param",
    );
  });

  it("an allowed decode-only wildcard still needs its startsWith branch above the admin-scope line", () => {
    const v = matcherViolations(["/admin/:path*", "/embed/:path*"], SYNTHETIC);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('pathname.startsWith("/embed/")');
    const withBranch = SYNTHETIC.replace("/foo/", "/embed/");
    expect(matcherViolations(["/admin/:path*", "/embed/:path*"], withBranch)).toEqual([]);
  });

  it("a wildcard outside DECODE_ONLY_WILDCARDS is flagged even when its branch exists", () => {
    expect(matcherViolations(["/admin/:path*", "/foo/:path*"], SYNTHETIC)).toHaveLength(1);
    expect(matcherViolations(["/admin/:path*", "/cluster/:path*"], SYNTHETIC.replace("/foo/", "/cluster/"))).toHaveLength(1);
  });

  it("flags a source with no admin-scope line", () => {
    const v = matcherViolations(["/foo/:id"], 'if (pathname.startsWith("/foo/")) return 1;');
    expect(v.join("|")).toContain("admin-scope line");
  });
});
