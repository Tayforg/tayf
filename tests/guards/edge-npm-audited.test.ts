import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, basename } from "node:path";

// ---------------------------------------------------------------------------
// h31-deps-1: the npm packages the Edge Functions really run were never
// audited. The functions import `npm:@supabase/supabase-js@2.115.0` and
// `npm:@sentry/deno@10.73.0` (Deno resolves them at deploy time, deno.lock is
// never committed) and fast-xml-parser through esm.sh; package.json carries
// supabase-js ^2.118.0 and no @sentry/deno at all, so `npm audit` in
// dep-audit.yml never looked at the versions that hold the service-role key.
//
// scripts/edge-audit/package.json lists exactly those versions, and the
// `edge-audit` job of dep-audit.yml runs `npm install --package-lock-only
// --ignore-scripts` + `npm audit --audit-level=high` there. This guard keeps
// the two in step in BOTH directions:
//   * every `npm:<name>@<x.y.z>` specifier and every `https://esm.sh/<name>@<x.y.z>`
//     specifier (with each `?deps=<name>@<x.y.z>` pin) under supabase/functions/**
//     (sources and the deno.json `imports` maps) must be a dependency of
//     scripts/edge-audit/package.json at that exact version (nothing missing);
//   * every dependency of scripts/edge-audit/package.json must still be used
//     by the edge code (nothing stale).
// The expected list is also written out below, so a blind extractor (one that
// finds nothing) fails instead of passing an empty-equals-empty comparison.
//
// Bump procedure: change the pin in the edge source (edge-deps-pinned.test.ts
// keeps it exact), the same version in scripts/edge-audit/package.json, and
// the EXPECTED list here, in one commit.
//
// blankComments and the specifier extraction are copied from
// edge-deps-pinned.test.ts: a test file cannot be imported without
// registering its tests.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const FUNCTIONS = resolve(ROOT, "supabase/functions");
const AUDIT_DIR = resolve(ROOT, "scripts/edge-audit");

/** The edge npm packages, written out so an extractor that finds nothing cannot pass. */
const EXPECTED = ["@sentry/deno@10.73.0", "@supabase/supabase-js@2.115.0", "fast-xml-parser@4.5.7", "strnum@1.1.2"];

/** Blanks // and block comments, keeping offsets (and newlines) intact. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

// --- specifier extraction (copied from edge-deps-pinned.test.ts) --------------

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
    for (const scoped of Object.values(cfg.scopes as Record<string, unknown>)) addMap(scoped);
  }
  return out;
}

// --- name@version parsing (character scans) -------------------------------------

function isExactVersion(v: string): boolean {
  const parts = v.split(".");
  if (parts.length !== 3) return false;
  return parts.every((p) => p !== "" && [...p].every((ch) => ch >= "0" && ch <= "9"));
}

/** Splits `name@x.y.z` (scoped names included) at the last @; null when it is not an exact pin. */
function parseNameAtVersion(text: string): { name: string; version: string } | null {
  const at = text.lastIndexOf("@");
  if (at <= 0) return null;
  const name = text.slice(0, at);
  const version = text.slice(at + 1);
  if (name === "" || name.includes("/") !== name.startsWith("@") || !isExactVersion(version)) return null;
  if (name.startsWith("@") && name.split("/").length !== 2) return null;
  return { name, version };
}

/** `name@version` head of a path like `fast-xml-parser@4.5.7/sub` or `@scope/pkg@1.2.3/sub`. */
function headOf(path: string): string {
  const segments = path.split("/");
  return path.startsWith("@") ? `${segments[0]}/${segments[1] ?? ""}` : (segments[0] ?? "");
}

interface Collected {
  /** `name@version` for every audited npm pin. */
  pins: Set<string>;
  /** Specifiers that look like an npm dependency but are not an exact pin. */
  problems: string[];
}

/** Collects the npm-registry pins out of import specifiers (npm: and esm.sh only). */
function collectPins(specs: string[]): Collected {
  const pins = new Set<string>();
  const problems: string[] = [];
  const add = (text: string, spec: string) => {
    const parsed = parseNameAtVersion(text);
    if (parsed === null) problems.push(`${spec}: not an exact name@x.y.z pin (${text})`);
    else pins.add(`${parsed.name}@${parsed.version}`);
  };
  for (const spec of specs) {
    if (spec.startsWith("npm:")) {
      add(headOf(spec.slice("npm:".length)), spec);
      continue;
    }
    let url: URL;
    try {
      url = new URL(spec);
    } catch {
      continue; // relative path, bare alias, node: builtin
    }
    if (url.protocol !== "https:" || url.hostname !== "esm.sh") continue;
    add(headOf(url.pathname.slice(1)), spec);
    for (const dep of (url.searchParams.get("deps") ?? "").split(",")) {
      if (dep !== "") add(dep, spec);
    }
  }
  return { pins, problems };
}

/** Pins found in one source text (comments blanked first). */
function pinsInSource(src: string): Collected {
  return collectPins(extractSpecifiers(blankComments(src)));
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

const ALL_FILES = walk(FUNCTIONS);
const SOURCES = ALL_FILES.filter((f) => SOURCE_FILE.test(f));
const DENO_CONFIGS = ALL_FILES.filter((f) => DENO_CONFIG.test(basename(f)));

function edgeSpecifiers(): string[] {
  const specs: string[] = [];
  for (const file of SOURCES) specs.push(...extractSpecifiers(blankComments(readFileSync(file, "utf8"))));
  for (const file of DENO_CONFIGS) {
    const raw = readFileSync(file, "utf8");
    const text = file.endsWith(".jsonc") ? blankComments(raw) : raw;
    specs.push(...importMapSpecifiers(JSON.parse(text)));
  }
  return specs;
}

const EDGE = collectPins(edgeSpecifiers());

const auditPkgPath = resolve(AUDIT_DIR, "package.json");
const auditPkg = JSON.parse(readFileSync(auditPkgPath, "utf8")) as {
  name?: string;
  private?: boolean;
  description?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const AUDITED = new Set(Object.entries(auditPkg.dependencies ?? {}).map(([name, version]) => `${name}@${version}`));

describe("scripts/edge-audit lists exactly the npm packages the edge functions pin", () => {
  it("finds the edge pins (the extractor is not blind)", () => {
    expect([...EDGE.pins].sort()).toEqual(EXPECTED);
  });

  it("every npm: / esm.sh specifier under supabase/functions is an exact name@x.y.z pin", () => {
    expect(EDGE.problems).toEqual([]);
  });

  it("nothing is missing: every edge pin is in scripts/edge-audit/package.json at that version", () => {
    const missing = [...EDGE.pins].filter((p) => !AUDITED.has(p)).sort();
    expect(missing).toEqual([]);
  });

  it("nothing is stale: every scripts/edge-audit dependency is still pinned by the edge code", () => {
    const stale = [...AUDITED].filter((p) => !EDGE.pins.has(p)).sort();
    expect(stale).toEqual([]);
  });

  it("the audit manifest lists exact versions only (no ^ ~ * ranges, no tags)", () => {
    const deps = Object.entries(auditPkg.dependencies ?? {});
    expect(deps.length).toBeGreaterThanOrEqual(EXPECTED.length);
    for (const [name, version] of deps) expect(isExactVersion(version), `${name}@${version}`).toBe(true);
  });

  it("the audit manifest is private, named, documents its guard and has no dev dependencies", () => {
    expect(auditPkg.name).toBe("tayf-edge-audit");
    expect(auditPkg.private).toBe(true);
    expect(auditPkg.description ?? "").toContain("edge-npm-audited.test.ts");
    expect(auditPkg.devDependencies).toBeUndefined();
  });

  it("ignores the lockfile and node_modules it generates (nothing but package.json is committed)", () => {
    const gitignore = resolve(AUDIT_DIR, ".gitignore");
    expect(existsSync(gitignore)).toBe(true);
    const lines = readFileSync(gitignore, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim());
    expect(lines).toContain("package-lock.json");
    expect(lines).toContain("node_modules/");
    expect(existsSync(resolve(AUDIT_DIR, "package-lock.json"))).toBe(false);
  });
});

describe("the guard's own extractor (mutation tests)", () => {
  it("finds a synthetic npm: import", () => {
    const found = pinsInSource('import x from "npm:foo@1.2.3";');
    expect([...found.pins]).toEqual(["foo@1.2.3"]);
    expect(found.problems).toEqual([]);
  });

  it("does not find a commented-out one (line and block comments)", () => {
    expect(pinsInSource('// import x from "npm:foo@1.2.3";').pins.size).toBe(0);
    expect(pinsInSource('/* import x from "npm:foo@1.2.3"; */').pins.size).toBe(0);
    expect(pinsInSource('/*\n import x from "npm:foo@1.2.3";\n*/\nimport y from "npm:bar@2.0.0";').pins).toEqual(
      new Set(["bar@2.0.0"]),
    );
  });

  it("finds a dynamic import, a scoped package and a sub-path", () => {
    const src = 'const m = await import("npm:@sentry/deno@10.73.0");\nimport { c } from "npm:@scope/pkg@1.0.0/sub";';
    expect([...pinsInSource(src).pins].sort()).toEqual(["@scope/pkg@1.0.0", "@sentry/deno@10.73.0"]);
  });

  it("finds an esm.sh pin and each of its ?deps= pins", () => {
    const src = 'import { XMLParser } from "https://esm.sh/fast-xml-parser@4.5.7?deps=strnum@1.1.2";';
    expect([...pinsInSource(src).pins].sort()).toEqual(["fast-xml-parser@4.5.7", "strnum@1.1.2"]);
    const several = pinsInSource('import a from "https://esm.sh/p@1.0.0?target=es2022&deps=q@2.0.0,@s/r@3.0.0";');
    expect([...several.pins].sort()).toEqual(["@s/r@3.0.0", "p@1.0.0", "q@2.0.0"]);
  });

  it("reports a floating or unversioned npm: / esm.sh specifier instead of ignoring it", () => {
    for (const spec of ["npm:foo@^1.2.3", "npm:foo@1", "npm:foo", "npm:foo@latest", "npm:@scope/pkg"]) {
      const found = pinsInSource(`import x from "${spec}";`);
      expect(found.problems, spec).toHaveLength(1);
      expect(found.pins.size, spec).toBe(0);
    }
    expect(pinsInSource('import x from "https://esm.sh/foo@4";').problems).toHaveLength(1);
    expect(pinsInSource('import x from "https://esm.sh/foo@4.5.7?deps=bar@^1.0.0";').problems).toHaveLength(1);
  });

  it("ignores specifiers that are not npm-registry packages", () => {
    const src = [
      'import a from "node:crypto";',
      'import b from "./local.ts";',
      'import c from "jsr:@std/path@1.0.0";',
      'import d from "https://deno.land/std@0.224.0/path/mod.ts";',
      'import e from "bare-alias";',
    ].join("\n");
    const found = pinsInSource(src);
    expect(found.pins.size).toBe(0);
    expect(found.problems).toEqual([]);
  });

  it("reads the values of a deno.json import map", () => {
    const specs = importMapSpecifiers({ imports: { a: "npm:foo@1.2.3" }, scopes: { "./x/": { b: "npm:bar@2.0.0" } } });
    expect([...collectPins(specs).pins].sort()).toEqual(["bar@2.0.0", "foo@1.2.3"]);
  });
});
