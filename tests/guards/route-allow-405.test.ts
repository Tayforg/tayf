import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, relative, sep } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard: a public, read-only endpoint answers a wrong method with
// the canonical JSON 405 and an `Allow` header (RFC 9110 15.5.6), never Next's
// bodyless 405 without `Allow`. A route.ts that exports only GET gets that
// bodyless default, and its automatic OPTIONS would advertise methods it does
// not serve.
//
//   (1) REQUIRED routes export POST, PUT, PATCH and DELETE bound to the shared
//       refusal (`const refuse = async () => apiMethodNotAllowed(...)`) and an
//       OPTIONS, and the runtime answer is proven below.
//   (2) Every OTHER route.ts under src/app (except /api/v1, covered by
//       tests/api/v1-openapi-contract.test.ts) that exports GET and none of
//       POST/PUT/PATCH/DELETE must be listed in EXEMPT with a reason, so a new
//       GET-only route fails until somebody classifies it.
//   (3) Non-vacuity: EXEMPT lists no stale entry, and REQUIRED/EXEMPT do not
//       overlap.
//
// Why robots.txt is EXEMPT and not REQUIRED: Next 16 treats a route module that
// exports any method besides GET/HEAD (POST, PUT, PATCH, DELETE or OPTIONS) as
// dynamic, GET included. Measured with `next build` on this repo: /robots.txt is
// prerendered (o) at HEAD and becomes dynamic (f) with a single `export const
// POST`. A prerendered route already answers a wrong method with 405 and an
// `Allow: GET, HEAD` header (checked with `next start`); it is the dynamic
// routes that answer a bodyless 405 without `Allow`. Every REQUIRED route reads
// the request or the database and is dynamic anyway, so the refusals cost them
// nothing. Do not add
// `export const dynamic` to get both: cacheComponents rejects segment config.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(here, "../../src/app");

/** Route directories (relative to src/app) that must refuse the other methods. */
const REQUIRED: readonly string[] = [
  "api/health",
  "api/metrics",
  "rss.xml",
  "blindspots/rss.xml",
  // Already compliant before this guard existed.
  "api/sources",
  "api/sources/[slug]",
  "api/timeline/head",
  "api/oembed",
];

/**
 * GET-only routes that are deliberately left on Next's default answer. A key
 * ending in "/" is a prefix covering a whole group. Keep the reason honest: it
 * is the answer to "why is a bodyless 405 acceptable here".
 */
const EXEMPT: Readonly<Record<string, string>> = {
  "api/cron/": "bearer-gated cron endpoints called by Vercel Cron and ops tooling, never by a public client",
  "api/oyun/cerceve/next": "same-site game helper fetched by our own page, not a public API",
  "api/takip": "same-site follow helper fetched by our own page, not a public API",
  "robots.txt":
    "prerendered static file: Next already answers a wrong method with 405 and Allow: GET, HEAD for prerendered routes, and ANY non-GET export would make the whole route dynamic (next build: o -> f); a function failure on robots.txt reads as disallow-all to crawlers",
  "sw.js": "service worker script; the browser fetches it with GET only",
  "llms.txt": "static crawler text file",
  "indexnow-key.txt": "static IndexNow ownership file",
  "sitemap.xml": "static crawler sitemap",
  "sitemaps/[file]": "static crawler sitemap shards",
  "rss/[topic]": "per-topic feed document, fetched by feed readers with GET",
  "rozet/[file]": "badge image asset",
  "embed/": "framed widget documents served to browsers, never called as an API",
  "cluster/[id]/kart": "share-card image",
  "rapor/[token]/markdown": "token-gated markdown download",
};

const REFUSED = ["POST", "PUT", "PATCH", "DELETE"] as const;

/** Blanks // and block comments, keeping offsets (and newlines) intact. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

interface RouteFile {
  /** Directory relative to src/app, "/"-joined: "api/health", "cluster/[id]/kart". */
  key: string;
  file: string;
}

function routeFiles(): RouteFile[] {
  const out: RouteFile[] = [];
  for (const file of walk(APP_DIR)) {
    const parts = relative(APP_DIR, file).split(sep);
    const name = parts.pop() as string;
    if (name !== "route.ts" && name !== "route.tsx") continue;
    out.push({ key: parts.join("/"), file });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** /api/v1 has its own contract test (every route binds methodNotAllowed). */
const isV1 = (key: string): boolean => key === "api/v1" || key.startsWith("api/v1/");

/** Every HTTP method a route source exports, by declaration or by re-export list. */
function exportedMethods(source: string): Set<string> {
  const code = blankComments(source);
  const found = new Set<string>();
  const declRe = /export\s+(?:async\s+)?(?:const|function)\s+(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\b/g;
  for (const m of code.matchAll(declRe)) found.add(m[1]!);
  const listRe = /export\s*\{([^}]*)\}/g;
  for (const m of code.matchAll(listRe)) {
    for (const item of m[1]!.split(",")) {
      const exported = item.trim().split(/\s+as\s+/).pop() ?? "";
      if (/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(exported)) found.add(exported);
    }
  }
  return found;
}

/** Violations of the REQUIRED contract for one route source; empty means compliant. */
function refusalViolations(source: string): string[] {
  const code = blankComments(source);
  const out: string[] = [];
  if (!/const\s+refuse\s*=\s*async\s*\(\)\s*=>\s*apiMethodNotAllowed\(/.test(code)) {
    out.push("no `const refuse = async () => apiMethodNotAllowed(...)`");
  }
  for (const method of REFUSED) {
    const re = new RegExp(`export\\s+const\\s+${method}\\s*=\\s*refuse\\s*;`);
    if (!re.test(code)) out.push(`\`export const ${method} = refuse;\` is missing`);
  }
  if (!exportedMethods(source).has("OPTIONS")) out.push("OPTIONS is not exported");
  return out;
}

function exemptReason(key: string): string | undefined {
  if (Object.hasOwn(EXEMPT, key)) return EXEMPT[key];
  for (const [entry, reason] of Object.entries(EXEMPT)) {
    if (entry.endsWith("/") && key.startsWith(entry)) return reason;
  }
  return undefined;
}

const ROUTES = routeFiles().filter((r) => !isV1(r.key));

describe("route files: wrong method answers the JSON 405 with Allow", () => {
  it("scans a plausible number of routes (not vacuous)", () => {
    expect(ROUTES.length).toBeGreaterThan(40);
    for (const key of REQUIRED) {
      expect(
        ROUTES.some((r) => r.key === key),
        `REQUIRED route ${key} has no route.ts`,
      ).toBe(true);
    }
  });

  for (const key of REQUIRED) {
    it(`${key} exports POST, PUT, PATCH, DELETE bound to the refusal, and an OPTIONS`, () => {
      const route = ROUTES.find((r) => r.key === key)!;
      expect(refusalViolations(readFileSync(route.file, "utf8"))).toEqual([]);
    });
  }

  it("every other GET-only route is classified in EXEMPT", () => {
    const unclassified: string[] = [];
    for (const route of ROUTES) {
      if (REQUIRED.includes(route.key)) continue;
      const methods = exportedMethods(readFileSync(route.file, "utf8"));
      if (!methods.has("GET")) continue;
      if (REFUSED.some((m) => methods.has(m))) continue;
      if (exemptReason(route.key) === undefined) unclassified.push(route.key);
    }
    expect(
      unclassified,
      "GET-only route(s) with no refusal: add the refusals (see src/app/api/sources/route.ts) or list them in EXEMPT with a reason",
    ).toEqual([]);
  });

  it("EXEMPT has no stale entry and does not overlap REQUIRED", () => {
    for (const entry of Object.keys(EXEMPT)) {
      expect(EXEMPT[entry]!.length, `${entry} needs a reason`).toBeGreaterThan(10);
      const covered = ROUTES.filter(
        (r) => (entry.endsWith("/") ? r.key.startsWith(entry) : r.key === entry),
      );
      expect(covered.length, `EXEMPT entry ${entry} matches no route`).toBeGreaterThan(0);
      for (const route of covered) {
        expect(REQUIRED.includes(route.key), `${route.key} is both REQUIRED and EXEMPT`).toBe(false);
        const methods = exportedMethods(readFileSync(route.file, "utf8"));
        expect(methods.has("GET"), `${route.key} exports no GET`).toBe(true);
        expect(
          REFUSED.some((m) => methods.has(m)),
          `${route.key} exports a refusal; drop it from EXEMPT (its reason: ${EXEMPT[entry]})`,
        ).toBe(false);
      }
    }
  });

  it("the classifier catches a fresh GET-only route and ignores one that refuses", () => {
    expect([...exportedMethods("export async function GET() { return new Response(); }")]).toEqual(["GET"]);
    expect([...exportedMethods("// export const POST = x\nexport const GET = f;")]).toEqual(["GET"]);
    expect(refusalViolations("export const GET = f;").length).toBeGreaterThan(0);
    expect(
      refusalViolations(
        [
          "const refuse = async () => apiMethodNotAllowed(ALLOW_GET_ONLY);",
          "export const POST = refuse;",
          "export const PUT = refuse;",
          "export const PATCH = refuse;",
          "export const DELETE = refuse;",
          "export function OPTIONS(): Response { return apiOptionsAllow(ALLOW_GET_ONLY); }",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Runtime: the bindings answer what the RFC asks for. The modules are imported
// for real, with only their I/O edges stubbed, because the point is that the
// refusal needs no request, database or clock.
// ---------------------------------------------------------------------------

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: async () => {} };
});
vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("server-only", () => ({}));

type Handler = () => Response | Promise<Response>;

describe("REQUIRED routes: runtime refusal", () => {
  for (const key of REQUIRED) {
    describe(key, () => {
      const load = async (): Promise<Record<string, Handler>> =>
        (await import(`@/app/${key}/route`)) as Record<string, Handler>;

      for (const method of REFUSED) {
        it(`${method}() is a 405 with Allow, the JSON envelope and no-store`, async () => {
          const mod = await load();
          const res = await mod[method]!();
          expect(res.status).toBe(405);
          expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
          expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
          expect(res.headers.get("Cache-Control")).toBe("no-store");
          expect(await res.json()).toEqual({ error: "Method not allowed" });
        });
      }

      it("OPTIONS() is a 204 that lists only the served methods", async () => {
        const mod = await load();
        const res = await mod.OPTIONS!();
        expect(res.status).toBe(204);
        expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
      });
    });
  }
});
