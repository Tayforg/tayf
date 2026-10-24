import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, relative, sep, basename } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (edge-hardening, sup-1): every external dependency an
// Edge Function pulls in is pinned to an EXACT version.
//
// Why: `deno.lock` is never committed (repo rule), so a floating specifier such
// as `npm:@supabase/supabase-js@2` or a bare `npm:@sentry/deno` resolves to
// whatever is newest at deploy time. A compromised or simply broken release
// would ship straight into functions that hold the service-role key. With no
// lockfile, the exact pin IS the supply-chain control; this file enforces it.
//
// Two sweeps over supabase/functions/**:
//
//   (a) source files (.ts/.tsx/.js/.mjs): comments are blanked first (the
//       URL-safe helper below is copied from rate-limit-429.test.ts because a
//       test file cannot be imported without registering its tests; jev-shadow
//       and the _shared comments mention `npm:ai` and `npm:@sentry/deno` in
//       prose), then static `from '...'`, side-effect `import '...'` and
//       dynamic `import('...')` specifiers are extracted;
//   (b) every deno.json / deno.jsonc: the values under `imports` and `scopes`.
//
// Only npm:, jsr:, http:// and https:// specifiers are checked; node: builtins,
// relative paths and import-map aliases (whose VALUES are checked in (b)) are
// not remote dependencies. `isPinned` is a strict allow-list: anything it does
// not positively recognise (bare names, `@2`, ^, ~, *, x-ranges, `latest`,
// unknown hosts, plain http) is a failure.
//
// Bump procedure (kept next to the guard so the next person finds it): change
// the exact pin deliberately (monthly), run `deno check --no-lock index.ts` in
// all 7 functions, then `npm test`, then redeploy with --no-verify-jwt.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const FUNCTIONS = resolve(ROOT, "supabase/functions");

/** Blanks // and block comments, keeping offsets (and newlines) intact. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) =>
      p1 + " ".repeat(m.length - p1.length),
    );
}

// --- the pin matcher --------------------------------------------------------

const PKG = String.raw`(?:@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*`;
const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;

const PINNED_NPM_JSR = new RegExp(`^(?:npm|jsr):${PKG}@${SEMVER}(?:/\\S*)?$`);
const PINNED_ESM_SH = new RegExp(`^https://esm\\.sh/${PKG}@${SEMVER}(?:[/?]\\S*)?$`);
const PINNED_DENO_LAND = new RegExp(
  `^https://deno\\.land/(?:std|x/[A-Za-z0-9_]+)@v?${SEMVER}(?:/\\S*)?$`,
);

/** Only remote dependencies are subject to the pin rule. */
function needsPin(spec: string): boolean {
  return /^(?:npm:|jsr:|https?:\/\/)/.test(spec);
}

/** True only for a specifier that names an exact version on an allowed host. */
function isPinned(spec: string): boolean {
  return (
    PINNED_NPM_JSR.test(spec) ||
    PINNED_ESM_SH.test(spec) ||
    PINNED_DENO_LAND.test(spec)
  );
}

// --- specifier extraction ---------------------------------------------------

const STATIC_FROM = /\bfrom\s*(["'`])([^"'`\n]+)\1/g;
const SIDE_EFFECT_IMPORT = /\bimport\s*(["'`])([^"'`\n]+)\1/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(["'`])([^"'`\n]+)\1/g;

/** Specifiers of a source file's imports; comments must already be blanked. */
function extractSpecifiers(blanked: string): string[] {
  const out: string[] = [];
  for (const re of [STATIC_FROM, SIDE_EFFECT_IMPORT, DYNAMIC_IMPORT]) {
    for (const m of blanked.matchAll(re)) out.push(m[2] as string);
  }
  return out;
}

/** The string values under `imports` and `scopes` of a parsed deno.json. */
function importMapSpecifiers(config: unknown): string[] {
  const out: string[] = [];
  if (typeof config !== "object" || config === null) return out;
  const cfg = config as Record<string, unknown>;
  const addMap = (map: unknown) => {
    if (typeof map !== "object" || map === null) return;
    for (const v of Object.values(map as Record<string, unknown>)) {
      if (typeof v === "string") out.push(v);
    }
  };
  addMap(cfg.imports);
  if (typeof cfg.scopes === "object" && cfg.scopes !== null) {
    for (const scoped of Object.values(cfg.scopes as Record<string, unknown>)) {
      addMap(scoped);
    }
  }
  return out;
}

// --- the walk ---------------------------------------------------------------

const SOURCE_FILE = /\.(?:ts|tsx|js|mjs)$/;
const DENO_CONFIG = /^deno\.jsonc?$/;
const SKIP_DIRS = new Set(["node_modules", ".git"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...walk(p));
    } else {
      out.push(p);
    }
  }
  return out;
}

/** Repo-relative path with forward slashes, whatever the platform. */
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");
/** Path relative to supabase/functions, as the failure list prints it. */
const relFn = (p: string) =>
  relative(FUNCTIONS, p).split(sep).join("/");

const ALL_FILES = walk(FUNCTIONS);
const SOURCES = ALL_FILES.filter((f) => SOURCE_FILE.test(f));
const DENO_CONFIGS = ALL_FILES.filter((f) => DENO_CONFIG.test(basename(f)));

interface Found {
  file: string;
  spec: string;
}

function parseDenoConfig(file: string): unknown {
  const raw = readFileSync(file, "utf8");
  // .jsonc may carry comments; plain .json never does, so blanking is a no-op.
  const text = file.endsWith(".jsonc") ? blankComments(raw) : raw;
  return JSON.parse(text);
}

function collectAll(): Found[] {
  const found: Found[] = [];
  for (const file of SOURCES) {
    const blanked = blankComments(readFileSync(file, "utf8"));
    for (const spec of extractSpecifiers(blanked)) {
      found.push({ file: relFn(file), spec });
    }
  }
  for (const file of DENO_CONFIGS) {
    for (const spec of importMapSpecifiers(parseDenoConfig(file))) {
      found.push({ file: relFn(file), spec });
    }
  }
  return found;
}

const FOUND = collectAll();
const CHECKED = FOUND.filter((f) => needsPin(f.spec));

describe("(a) every remote Edge Function dependency is pinned to an exact version", () => {
  it("lists no floating specifier (file: specifier)", () => {
    const offenders = [
      ...new Set(
        CHECKED.filter((f) => !isPinned(f.spec)).map((f) => `${f.file}: ${f.spec}`),
      ),
    ].sort();
    expect(offenders).toEqual([]);
  });

  it("scans every function entrypoint (the walk is not blind)", () => {
    const entrypoints = SOURCES.filter((f) => basename(f) === "index.ts");
    expect(entrypoints.length).toBeGreaterThanOrEqual(7);
  });

  it("reads the per-function deno.json files (the config sweep is not blind)", () => {
    expect(DENO_CONFIGS.length).toBeGreaterThanOrEqual(6);
    const configSpecs = FOUND.filter((f) => DENO_CONFIG.test(basename(f.file)));
    expect(configSpecs.some((f) => needsPin(f.spec))).toBe(true);
  });

  it("actually checks remote specifiers from both source files and configs", () => {
    expect(CHECKED.length).toBeGreaterThanOrEqual(8);
    expect(CHECKED.some((f) => SOURCE_FILE.test(f.file))).toBe(true);
    expect(CHECKED.some((f) => DENO_CONFIG.test(basename(f.file)))).toBe(true);
  });
});

describe("(b) deno.lock is never committed", () => {
  it(".gitignore keeps the supabase/functions/**/deno.lock rule", () => {
    const lines = readFileSync(resolve(ROOT, ".gitignore"), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim());
    expect(lines).toContain("supabase/functions/**/deno.lock");
  });

  it("git ignores a lockfile in any function folder", () => {
    // Exit 0 = ignored. --no-index so the verdict is about the rules alone.
    expect(() =>
      execFileSync(
        "git",
        ["check-ignore", "-q", "--no-index", "supabase/functions/ingest/deno.lock"],
        { cwd: ROOT, stdio: "ignore" },
      ),
    ).not.toThrow();
  });

  it("no deno.lock is tracked under supabase/functions", () => {
    const tracked = execFileSync("git", ["ls-files", "supabase/functions"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
      .split("\n")
      .filter((l) => l.length > 0);
    expect(tracked.length).toBeGreaterThan(0); // the listing is not empty
    expect(tracked.filter((p) => basename(p) === "deno.lock")).toEqual([]);
  });
});

describe("(c) the guard's own matchers", () => {
  it.each([
    "npm:@supabase/supabase-js@2",
    "npm:@sentry/deno",
    "npm:x@^1.2.3",
    "jsr:@std/assert@1",
    "https://esm.sh/foo",
    "https://cdn.example.com/x@1.2.3",
    // more floating shapes
    "npm:x@~1.2.3",
    "npm:x@*",
    "npm:x@latest",
    "npm:x@1.x",
    "npm:x@1.2",
    "npm:x@1.2.3.4",
    "npm:x@1.2.3||2.0.0",
    "npm:x@>=1.2.3",
    "npm:@supabase/supabase-js@2.x",
    "jsr:@std/assert",
    "http://esm.sh/foo@1.2.3",
    "http://example.com/x@1.2.3",
    "https://esm.sh/foo@2",
    "https://esm.sh/foo@1.2.3x",
    "https://deno.land/std/path/mod.ts",
    "https://deno.land/std@0.224/path/mod.ts",
    "https://deno.land/x/oak/mod.ts",
    "https://raw.githubusercontent.com/o/r/main/x.ts",
  ])("rejects %s", (spec) => {
    expect(isPinned(spec)).toBe(false);
    expect(needsPin(spec)).toBe(true);
  });

  it.each([
    "npm:@supabase/supabase-js@2.115.0",
    "npm:@sentry/deno@10.73.0",
    "https://esm.sh/@supabase/supabase-js@2.45.4",
    "https://esm.sh/fast-xml-parser@4.5.0",
    // other legitimate exact shapes
    "npm:x@1.2.3-beta.1",
    "npm:@scope/pkg@0.0.1/subpath/mod.ts",
    "jsr:@std/assert@1.0.8",
    "jsr:@std/path@1.0.0/posix",
    "https://esm.sh/foo@1.2.3/sub",
    "https://esm.sh/foo@1.2.3?target=deno",
    "https://deno.land/std@0.224.0/path/mod.ts",
    "https://deno.land/x/oak@v12.6.1/mod.ts",
  ])("accepts %s", (spec) => {
    expect(isPinned(spec)).toBe(true);
    expect(needsPin(spec)).toBe(true);
  });

  it.each([
    "node:crypto",
    "../_shared/auth.ts",
    "./local.ts",
    "_shared/",
    "supabase-js", // an import-map alias; its VALUE is checked in the config sweep
    "data:text/javascript,export{}",
  ])("does not treat %s as a remote dependency", (spec) => {
    expect(needsPin(spec)).toBe(false);
  });

  it("extracts static, side-effect, dynamic and multi-line specifiers", () => {
    const src = [
      'import a from "npm:a@1.0.0";',
      "import { b } from 'jsr:@std/b@1.0.0';",
      'import "https://esm.sh/c@1.0.0";',
      'const d = await import("npm:d@1.0.0");',
      "import {",
      "  e,",
      "  f,",
      '} from "npm:e@1.0.0";',
      'export * from "../_shared/x.ts";',
      'export { g } from "npm:g";',
    ].join("\n");
    expect(extractSpecifiers(src).sort()).toEqual(
      [
        "npm:a@1.0.0",
        "jsr:@std/b@1.0.0",
        "https://esm.sh/c@1.0.0",
        "npm:d@1.0.0",
        "npm:e@1.0.0",
        "../_shared/x.ts",
        "npm:g",
      ].sort(),
    );
  });

  it("does not mistake a table accessor or a call for an import", () => {
    const src = [
      'const rows = await sb.from("articles").select("*");',
      'const x = Array.from("npm:nope");',
      'const url = "https://example.com/x";',
    ].join("\n");
    expect(extractSpecifiers(src)).toEqual([]);
  });

  it("keeps URLs inside strings but ignores prose in comments", () => {
    const src = [
      "// the `npm:ai` package is deliberately NOT imported here",
      "/* import x from 'npm:@sentry/deno'; */",
      'import { XMLParser } from "https://esm.sh/fast-xml-parser@4.5.0";',
      'const mod = await import("npm:@sentry/deno@10.73.0"); // pinned',
    ].join("\n");
    expect(extractSpecifiers(blankComments(src))).toEqual([
      "https://esm.sh/fast-xml-parser@4.5.0",
      "npm:@sentry/deno@10.73.0",
    ]);
  });

  it("flags a floating specifier even when a comment next to it looks pinned", () => {
    const src = 'import { c } from "npm:pkg"; // was npm:pkg@1.2.3';
    const specs = extractSpecifiers(blankComments(src));
    expect(specs).toEqual(["npm:pkg"]);
    expect(specs.filter((s) => needsPin(s) && !isPinned(s))).toEqual(["npm:pkg"]);
  });

  it("collects deno.json imports AND scopes values, skipping non-strings", () => {
    const cfg = {
      imports: { a: "npm:a@1.0.0", "_shared/": "../_shared/", n: 3 },
      scopes: {
        "https://example.com/": { b: "npm:b@^2.0.0" },
        "./vendor/": { c: "https://esm.sh/c@1.0.0" },
      },
      tasks: { serve: "deno run npm:not-an-import" },
    };
    expect(importMapSpecifiers(cfg).sort()).toEqual(
      [
        "npm:a@1.0.0",
        "../_shared/",
        "npm:b@^2.0.0",
        "https://esm.sh/c@1.0.0",
      ].sort(),
    );
  });

  it("tolerates a config with no import map, or a non-object", () => {
    expect(importMapSpecifiers({ nodeModulesDir: "none" })).toEqual([]);
    expect(importMapSpecifiers(null)).toEqual([]);
    expect(importMapSpecifiers("npm:x")).toEqual([]);
    expect(importMapSpecifiers({ imports: null, scopes: "x" })).toEqual([]);
  });

  it("repo-relative path helper agrees with the failure format", () => {
    expect(rel(resolve(ROOT, "supabase/functions/_shared/supabase.ts"))).toBe(
      "supabase/functions/_shared/supabase.ts",
    );
    expect(relFn(resolve(FUNCTIONS, "_shared/supabase.ts"))).toBe("_shared/supabase.ts");
  });
});
