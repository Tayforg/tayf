import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, relative, sep } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (api-hygiene): every rate-limited answer is built by the
// ONE shared helper, `apiTooManyRequests` (src/lib/api/errors.ts). It owns the
// three things hand-rolled 429s kept getting wrong: `Retry-After` in whole
// seconds (never below 1), `Cache-Control: no-store` (a CDN must not pin a
// throttle for every client behind the same edge), and the canonical
// `{ error, details: { retryAfterMs } }` body.
//
// Three sweeps, all source-text (same technique as public-reader-cap.test.ts,
// whose comment-blanking helper is copied below because a test file cannot be
// imported without registering its tests):
//
//   (a) no non-test .ts/.tsx under src/ builds a 429 with `apiError(429, ...)`;
//   (b) each file in PUBLIC_LIMITER_FILES exists (a rename cannot turn the
//       guard vacuous) and calls `apiTooManyRequests(`;
//   (c) discovery: a NEW public route that calls `createRateLimiter(` must be
//       added to PUBLIC_LIMITER_FILES, i.e. it cannot ship its own 429.
//       /api/admin/** and /api/cron/** are exempt from the list (they are
//       auth-gated and swept by (a) only); cron/social and
//       cron/alerts-webhooks answer a bearer-gated 429 with a non-error body.
//
// Comments are blanked first, so prose that mentions `apiError(429` does not
// trip (a) and a comment cannot satisfy (b).
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SRC = resolve(ROOT, "src");
const APP = resolve(SRC, "app");

const PUBLIC_LIMITER_FILES = [
  "src/app/api/sources/route.ts",
  "src/app/api/sources/[slug]/route.ts",
  "src/app/api/timeline/head/route.ts",
  "src/app/api/oyun/route.ts",
  "src/app/api/oyun/cerceve/route.ts",
  "src/app/api/oyun/cerceve/next/route.ts",
  "src/app/api/corrections/route.ts",
  "src/app/api/newsletter/route.ts",
  "src/app/api/newsletter/confirm/route.ts",
  "src/app/api/newsletter/unsubscribe/route.ts",
  "src/app/api/revalidate/route.ts",
  "src/app/api/takip/route.ts",
  "src/app/api/health/route.ts",
  "src/app/rapor/[token]/markdown/route.ts",
  "src/app/cluster/[id]/kart/route.tsx",
  "src/lib/api/keys.ts",
] as const;

/** Blanks // and block comments, keeping offsets (and newlines) intact. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) =>
      p1 + " ".repeat(m.length - p1.length),
    );
}

const HAND_ROLLED_429 = /\bapiError\s*\(\s*429\b/;
const HELPER_CALL = /\bapiTooManyRequests\s*\(/;
const LIMITER_CALL = /\bcreateRateLimiter\s*\(/;
const ROUTE_FILE = /(^|\/)route\.(ts|tsx)$/;
const EXEMPT_DIRS = ["src/app/api/admin/", "src/app/api/cron/"] as const;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** Repo-relative path with forward slashes, whatever the platform. */
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");
const isTestFile = (p: string) => /\.test\.(ts|tsx)$/.test(p);
const read = (relPath: string) =>
  blankComments(readFileSync(resolve(ROOT, relPath), "utf8"));

const NON_TEST_SOURCES = walk(SRC).filter((f) => !isTestFile(f));

/** Public route files that own a limiter, as the discovery sweep sees them. */
function discoverPublicLimiterRoutes(): string[] {
  return walk(APP)
    .filter((f) => !isTestFile(f))
    .map(rel)
    .filter((p) => ROUTE_FILE.test(p))
    .filter((p) => !EXEMPT_DIRS.some((d) => p.startsWith(d)))
    .filter((p) => LIMITER_CALL.test(read(p)))
    .sort();
}

describe("(a) no hand-rolled apiError(429, ...) anywhere in src/", () => {
  it("scans a plausible number of source files (the walk is not blind)", () => {
    expect(NON_TEST_SOURCES.length).toBeGreaterThan(200);
  });

  it("finds no non-test file that builds a 429 with apiError", () => {
    const offenders = NON_TEST_SOURCES.filter((f) =>
      HAND_ROLLED_429.test(blankComments(readFileSync(f, "utf8"))),
    ).map(rel);
    expect(offenders).toEqual([]);
  });
});

describe("(b) every public limiter file uses apiTooManyRequests", () => {
  it("lists each file once", () => {
    expect(new Set(PUBLIC_LIMITER_FILES).size).toBe(PUBLIC_LIMITER_FILES.length);
  });

  it.each(PUBLIC_LIMITER_FILES)("%s exists (the sweep is not vacuous)", (p) => {
    expect(existsSync(resolve(ROOT, p))).toBe(true);
  });

  it.each(PUBLIC_LIMITER_FILES)("%s calls apiTooManyRequests()", (p) => {
    expect(read(p)).toMatch(HELPER_CALL);
  });
});

describe("(c) a public route with a limiter is on the list", () => {
  it("discovers the known limiter routes (the walk is not blind)", () => {
    const found = discoverPublicLimiterRoutes();
    expect(found).toContain("src/app/api/sources/route.ts");
    expect(found).toContain("src/app/api/health/route.ts");
    expect(found.length).toBeGreaterThanOrEqual(10);
  });

  it("every discovered route appears in PUBLIC_LIMITER_FILES", () => {
    const listed = new Set<string>(PUBLIC_LIMITER_FILES);
    const unlisted = discoverPublicLimiterRoutes().filter((p) => !listed.has(p));
    expect(unlisted).toEqual([]);
  });

  it("never discovers an admin or cron route", () => {
    const found = discoverPublicLimiterRoutes();
    expect(found.filter((p) => EXEMPT_DIRS.some((d) => p.startsWith(d)))).toEqual(
      [],
    );
  });
});

describe("(d) the sweep's own matchers", () => {
  it("flags a real hand-rolled 429, with or without whitespace or a line break", () => {
    expect(HAND_ROLLED_429.test('return apiError(429, "Too many requests");')).toBe(true);
    expect(HAND_ROLLED_429.test("apiError( 429, 'x')")).toBe(true);
    expect(HAND_ROLLED_429.test("apiError(\n  429,\n  'x',\n)")).toBe(true);
  });

  it("does not flag other statuses, longer numbers or longer identifiers", () => {
    expect(HAND_ROLLED_429.test('apiError(400, "bad")')).toBe(false);
    expect(HAND_ROLLED_429.test('apiError(4290, "bad")')).toBe(false);
    expect(HAND_ROLLED_429.test('myapiError(429, "bad")')).toBe(false);
    expect(HAND_ROLLED_429.test("apiTooManyRequests(1000)")).toBe(false);
  });

  it("ignores prose in comments but not code", () => {
    const src = [
      "// do not call apiError(429, ...) here",
      "/* apiError(429, 'x') */",
      "return apiTooManyRequests(rl.retryAfterMs);",
    ].join("\n");
    const blanked = blankComments(src);
    expect(blanked).not.toMatch(HAND_ROLLED_429);
    expect(blanked).toMatch(HELPER_CALL);
    expect(blankComments("return apiError(429, 'x'); // legacy")).toMatch(
      HAND_ROLLED_429,
    );
  });

  it("does not let a comment satisfy the helper-call check", () => {
    const src = "// TODO use apiTooManyRequests(ms)\nreturn new Response(null, { status: 429 });";
    expect(blankComments(src)).not.toMatch(HELPER_CALL);
  });

  it("does not mistake an import specifier or a longer identifier for a call", () => {
    expect(HELPER_CALL.test('import { apiTooManyRequests } from "@/lib/api/errors";')).toBe(false);
    expect(HELPER_CALL.test("const x = v1apiTooManyRequests(1);")).toBe(false);
    expect(HELPER_CALL.test("return apiTooManyRequests(1)")).toBe(true);
    expect(LIMITER_CALL.test('const l = createRateLimiter("x", { capacity: 1 });')).toBe(true);
    expect(LIMITER_CALL.test('import { createRateLimiter } from "@/lib/rate-limit";')).toBe(false);
  });

  it("recognises route files only", () => {
    expect(ROUTE_FILE.test("src/app/api/sources/route.ts")).toBe(true);
    expect(ROUTE_FILE.test("src/app/cluster/[id]/kart/route.tsx")).toBe(true);
    expect(ROUTE_FILE.test("src/app/api/sources/registry-route.ts")).toBe(false);
    expect(ROUTE_FILE.test("src/app/rapor/[token]/page.tsx")).toBe(false);
  });
});
