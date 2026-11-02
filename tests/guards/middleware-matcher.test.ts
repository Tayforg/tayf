import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
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
//   3. the matcher strings behave as intended under Next's own matcher;
//   4. (h17-contracts-1) the static route handlers (rss.xml, sitemap.xml,
//      /api/health, ...) are matched for a path that continues with an encoded
//      '/' or a backslash (`<base>%2F`) and only for that: a '<base>%:suffix'
//      entry needs a '%' and then at least one non-'/' character after the base,
//      so it never matches the bare path, `<base>/x` or `<base>x`. (The literal
//      '%' is not decoration: a plain '<base>:suffix' would match
//      '/api/admin/jev-gold/label' + 'er', which is the real handler
//      /api/admin/jev-gold/labeler.) The set of bases is read off src/app, so a
//      new static route fails until it is listed. The compiled matcher is proven
//      with Next's own helper (unstable_doesMiddlewareMatch).
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const MIDDLEWARE_SRC = readFileSync(resolve(here, "../../src/middleware.ts"), "utf8");
const APP_DIR = resolve(here, "../../src/app");
const ORIGIN = "https://www.tayfhaber.com";

const DYNAMIC_SEGMENT = /^\[\[?(?:\.\.\.)?[^\][]+\]\]?$/; // [x] [...x] [[...x]]

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/**
 * Every route.ts / route.tsx under src/app with no dynamic segment, as its URL
 * path (groups and slots dropped, private folders skipped: the same handling as
 * the bad-encoding walk). The /api/v1/<child> routes are left out: the
 * '/api/v1/:path*' wildcard and the v1 catch-all already answer them with a JSON
 * 404. The bare /api/v1 root stays in.
 */
function staticHandlerBases(): string[] {
  const bases: string[] = [];
  for (const file of walk(APP_DIR)) {
    const parts = relative(APP_DIR, file).split(sep);
    const name = parts.pop() as string;
    if (name !== "route.ts" && name !== "route.tsx") continue;
    if (parts.some((s) => s.startsWith("_"))) continue;
    const segments = parts.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"));
    if (segments.some((s) => DYNAMIC_SEGMENT.test(s))) continue;
    const base = "/" + segments.join("/");
    if (base.startsWith("/api/v1/")) continue;
    bases.push(base);
  }
  return bases.sort();
}

const STATIC_BASES = staticHandlerBases();
/** The last segment of a static-handler entry after its base: '%' + a path-to-regexp param. */
const SUFFIX = ":suffix";
const ENTRY_TAIL = "%" + SUFFIX;
/** The four encodings of a '/' or a backslash that Next falls back to a pages-router require on. */
const ENCODED_SLASHES = ["%2F", "%2f", "%5C", "%5c"];

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

/**
 * The literal part of a static-handler entry: '<literal>:suffix' as the LAST
 * segment (literal non-empty, no ':'), e.g. '/rss.xml%:suffix' -> '/rss.xml%'.
 * Anything else (including '/foo:suffix/bar' and '/foo:x') is null.
 */
function staticSuffixBase(entry: string): string | null {
  const slash = entry.lastIndexOf("/");
  const last = entry.slice(slash + 1);
  if (!last.endsWith(SUFFIX)) return null;
  const literal = last.slice(0, last.length - SUFFIX.length);
  if (literal.length === 0 || literal.includes(":")) return null;
  return entry.slice(0, slash + 1) + literal;
}

/** The call that every '<base>:suffix' entry is answered by (see middleware.ts gate 9). */
const STATIC_BASE_NEEDLE = "staticHandlerBase(pathname)";

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
    // A static-handler entry ('<literal>:suffix' as the last segment) is the one
    // place a segment may mix a literal and a param.
    const suffixBase = staticSuffixBase(entry);

    // Params must be whole, single segments (":id" between slashes or at the end).
    const segments = entry.split("/");
    segments.forEach((segment, i) => {
      if (wildcard && segment === ":path*") return;
      if (suffixBase !== null && i === segments.length - 1) return;
      if (segment.includes(":") && !/^:[A-Za-z][A-Za-z0-9_]*$/.test(segment)) {
        out.push(`${entry}: param segment "${segment}" is not a plain single-segment param`);
      }
    });

    // The admin scope is handled by the final block, not by a startsWith branch.
    if (entry === "/admin" || entry.startsWith("/admin/")) continue;

    // Static handlers share one lookup instead of one startsWith branch each.
    if (suffixBase !== null) {
      const callIdx = code.indexOf(STATIC_BASE_NEEDLE);
      if (callIdx === -1) {
        out.push(`${entry}: no ${STATIC_BASE_NEEDLE} call in middleware.ts`);
      } else if (adminIdx !== -1 && callIdx > adminIdx) {
        out.push(`${entry}: ${STATIC_BASE_NEEDLE} sits after the admin-scope line`);
      }
      continue;
    }

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
    // Every bare static handler (h17-contracts-1): the '<base>:suffix' entries must
    // never gate the handler itself. /api/v1 is the exception, the '/api/v1/:path*'
    // wildcard matches it and the middleware passes it straight through.
    for (const base of STATIC_BASES.filter((b) => b !== "/api/v1")) {
      expect(hit(base), base).toBe(false);
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

describe("middleware matcher — static route handlers (h17-contracts-1)", () => {
  const suffixEntries = config.matcher.filter((m) => m.endsWith(SUFFIX));
  const isHandlerEntry = (m: string) => m.endsWith(ENTRY_TAIL);

  it("walks a non-vacuous set of static handlers, /api/v1 children excluded", () => {
    expect(STATIC_BASES.length).toBeGreaterThanOrEqual(40);
    for (const must of ["/rss.xml", "/sitemap.xml", "/api/sources", "/api/health", "/api/oembed", "/api/timeline/head"]) {
      expect(STATIC_BASES, must).toContain(must);
    }
    // The bare v1 root is a static handler; its children are the wildcard's business.
    expect(STATIC_BASES).toContain("/api/v1");
    expect(STATIC_BASES.filter((b) => b.startsWith("/api/v1/"))).toEqual([]);
    // Dynamic routes are not static handlers.
    expect(STATIC_BASES).not.toContain("/api/sources/[slug]");
    expect(STATIC_BASES.some((b) => b.includes("["))).toBe(false);
  });

  it("the '<base>%:suffix' matcher entries are exactly the static handlers under src/app", () => {
    expect(suffixEntries.filter((m) => !isHandlerEntry(m)), "every :suffix entry is '<base>%:suffix'").toEqual([]);
    const bases = suffixEntries.map((m) => m.slice(0, m.length - ENTRY_TAIL.length));
    expect(suffixEntries.length).toBeGreaterThanOrEqual(40);
    expect([...bases].sort()).toEqual(STATIC_BASES);
    expect(new Set(bases).size, "duplicate suffix entries").toBe(bases.length);
    for (const must of ["/rss.xml", "/sitemap.xml", "/api/sources", "/api/health", "/api/oembed"]) {
      expect(bases, must).toContain(must);
    }
  });

  const doesMatch = (path: string) =>
    unstable_doesMiddlewareMatch({ config, url: ORIGIN + path, nextConfig: {} });

  for (const base of STATIC_BASES) {
    it(`${base}: matched for an encoded '/' or backslash suffix, not for the bare path`, () => {
      for (const enc of ENCODED_SLASHES) {
        expect(doesMatch(base + enc), base + enc).toBe(true);
      }
      expect(doesMatch(base + "%2Fx"), base + "%2Fx").toBe(true);
      expect(doesMatch(base + "%5Cx"), base + "%5Cx").toBe(true);
      // A malformed escape is matched too (it answers the 400 of gate 8) ...
      expect(doesMatch(base + "%ff"), base + "%ff").toBe(true);
      // ... but a plain continuation is not: Next 404s '<base>x' by itself.
      expect(doesMatch(base + "x"), base + "x").toBe(false);
      // The suffix entries never match a nested path or the bare handler. (Other
      // entries may: '/api/sources/:slug' matches '/api/sources/x', and the
      // '/api/v1/:path*' wildcard matches the bare /api/v1.)
      const own = config.matcher.filter(isHandlerEntry);
      expect(own.some((m) => getPathMatch(m)(base + "/x") !== false), base + "/x").toBe(false);
      expect(own.some((m) => getPathMatch(m)(base) !== false), base).toBe(false);
      if (base === "/api/v1") {
        // '/api/v1/:path*' already matches the bare root (the middleware passes it through).
        expect(doesMatch(base), base).toBe(true);
      } else {
        expect(doesMatch(base), base).toBe(false);
      }
    });
  }

  it("a handler that is another handler's path plus letters is not matched bare (labeler vs label)", () => {
    // A plain '<base>:suffix' would match '/api/admin/jev-gold/label' + 'er'.
    expect(STATIC_BASES).toContain("/api/admin/jev-gold/label");
    expect(STATIC_BASES).toContain("/api/admin/jev-gold/labeler");
    expect(doesMatch("/api/admin/jev-gold/labeler")).toBe(false);
    expect(doesMatch("/api/admin/jev-gold/label")).toBe(false);
    expect(doesMatch("/api/admin/jev-gold/label%2F")).toBe(true);
    expect(doesMatch("/api/admin/jev-gold/labeler%2F")).toBe(true);
    // The general rule is the per-base loop above: no bare handler is matched.
  });

  it("the bare /api/v1 root still reaches its handler through the middleware", async () => {
    const res = await middleware(new NextRequest(ORIGIN + "/api/v1"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });

  it("the suffix entries stay literal strings Next can analyse statically", () => {
    for (const m of suffixEntries) {
      expect(m.startsWith("/"), m).toBe(true);
      expect(m.split(":").length, `${m}: exactly one param`).toBe(2);
      expect(m, m).not.toMatch(/[()?+{}*]/);
    }
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

  describe("'<literal>:suffix' static-handler entries", () => {
    const WITH_CALL = [
      "export async function middleware(req) {",
      "  const base = staticHandlerBase(pathname);",
      "  if (base) return notFoundRewrite(req);",
      '  const lower = pathname.toLowerCase();',
      '  if (lower !== "/admin" && !lower.startsWith("/admin/")) return notFoundRewrite(req);',
      "}",
    ].join("\n");

    it("accepts a last-segment '<literal>:suffix' when the call sits above the admin-scope line", () => {
      expect(matcherViolations(["/admin/:path*", "/rss.xml:suffix", "/api/oyun/cerceve:suffix"], WITH_CALL)).toEqual([]);
      expect(matcherViolations(["/admin/:path*", "/rss.xml%:suffix", "/api/oyun/cerceve%:suffix"], WITH_CALL)).toEqual([]);
    });

    it("flags a '<literal>:suffix' that is not the last segment", () => {
      const v = matcherViolations(["/admin/:path*", "/foo:suffix/bar"], WITH_CALL);
      expect(v.join("|")).toContain("not a plain single-segment param");
    });

    it("flags other literal-plus-param shapes as not a plain param", () => {
      expect(matcherViolations(["/admin/:path*", "/foo:x"], WITH_CALL).join("|")).toContain(
        "not a plain single-segment param",
      );
      expect(matcherViolations(["/admin/:path*", "/foo:a:suffix"], WITH_CALL).join("|")).toContain(
        "not a plain single-segment param",
      );
      expect(matcherViolations(["/admin/:path*", "/foo:suffixes"], WITH_CALL).join("|")).toContain(
        "not a plain single-segment param",
      );
    });

    it("a bare ':suffix' param (empty literal) is not a static-handler entry", () => {
      // '/:suffix' is a plain param; it needs its own startsWith branch like any other.
      const v = matcherViolations(["/admin/:path*", "/:suffix"], WITH_CALL);
      expect(v.join("|")).toContain('pathname.startsWith("/")');
    });

    it("flags a source without the staticHandlerBase call", () => {
      const v = matcherViolations(["/admin/:path*", "/rss.xml:suffix"], SYNTHETIC);
      expect(v).toHaveLength(1);
      expect(v[0]).toContain("/rss.xml:suffix");
      expect(v[0]).toContain("staticHandlerBase(pathname)");
    });

    it("flags a call that only survives in a comment", () => {
      const commented = WITH_CALL.replace(
        "  const base = staticHandlerBase(pathname);",
        "  // const base = staticHandlerBase(pathname);",
      );
      expect(matcherViolations(["/admin/:path*", "/rss.xml:suffix"], commented)).toHaveLength(1);
    });

    it("flags a call placed after the admin-scope line", () => {
      const lines = WITH_CALL.split("\n");
      const moved = [lines[0], lines[3], lines[4], lines[1], lines[2], lines[5]].join("\n");
      const v = matcherViolations(["/admin/:path*", "/rss.xml:suffix"], moved);
      expect(v).toHaveLength(1);
      expect(v[0]).toContain("after the admin-scope line");
    });

    it("does not need a per-base startsWith branch", () => {
      // The one shared call covers every suffix entry; no branch for '/rss.xml' exists.
      expect(WITH_CALL).not.toContain('startsWith("/rss.xml")');
      expect(matcherViolations(["/admin/:path*", "/rss.xml:suffix", "/sitemap.xml:suffix"], WITH_CALL)).toEqual([]);
    });
  });

  it("flags a source with no admin-scope line", () => {
    const v = matcherViolations(["/foo/:id"], 'if (pathname.startsWith("/foo/")) return 1;');
    expect(v.join("|")).toContain("admin-scope line");
  });
});
