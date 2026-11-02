import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (h13-weight-2): the public client graph stays free of the
// class-merging stack.
//
// A single 1-px nav divider used to cost every public route ~32.5 KB raw
// (~10.8 KB br) of JavaScript: nav-links.tsx ("use client") rendered
// <Separator> from ui/separator, which pulls Base UI plus `cn()` ->
// tailwind-merge (its classGroups / conflictingClassGroups tables). A second
// path ran bias-spectrum -> bias-badge -> ui/badge into saved-list.tsx. The
// divider is a <span> now and BiasBadge is a plain <span>; this guard keeps the
// primitives from sneaking back.
//
//   R1  No scanned module imports the ui/separator or ui/badge primitive. This
//       also catches SERVER components (header.tsx) that pull a client primitive
//       into the tree.
//   R2  For every scanned module whose first statement is 'use client', the
//       transitive src import closure contains no src/lib/utils (cn ->
//       tailwind-merge), no ui/separator, no ui/badge, and no module that
//       imports tailwind-merge, class-variance-authority or @base-ui/react/*.
//
// Scope: every non-test .ts/.tsx under src/, EXCEPT src/components/admin/**,
// src/app/admin/** (the founder-only console may use any primitive) and
// src/components/ui/** (the primitives themselves). The closure walk does follow
// edges into those directories: a public client module that imports an admin
// component or a ui primitive inherits its weight.
//
//   R3  For every 'use client' module, the transitive src import closure reaches
//       no module that imports next/cache, next/headers, server-only or
//       @/lib/supabase/server, nor any module that declares a "use cache"
//       directive. Such a module in the client graph does not slow the page, it
//       FAILS `next build` (Turbopack: "inline use cache in Client Components",
//       "cacheLife only available in Server Components"). tsc, eslint and
//       vitest cannot see that boundary, so this is the only CI check for it.
//       A constant a client component needs (GAME_ROUND_SIZE) therefore lives
//       in a plain module (src/lib/game/round-size.ts), never in a fetcher.
//
// Type-only imports (`import type ...`, `export type ... from`) are erased at
// build time and do not count.
//
// Allowlist: EXPECTED EMPTY. Every entry needs a written reason (>= 20 chars)
// and is matched by `root -> offender`; a stale entry fails the suite.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SRC_DIR = join(ROOT, "src");

/** repo-relative posix path -> file source. */
type Files = Map<string, string>;

const UTILS = "src/lib/utils.ts";
const UI_SEPARATOR = "src/components/ui/separator.tsx";
const UI_BADGE = "src/components/ui/badge.tsx";
const BANNED_MODULES = new Set([UTILS, UI_SEPARATOR, UI_BADGE]);
// R3: server-only edges. A client module must not reach any of these.
const SUPABASE_SERVER = "src/lib/supabase/server.ts";
const SERVER_ONLY_PACKAGES = [/^next\/cache$/, /^next\/headers$/, /^server-only$/];
const BANNED_PACKAGES = [
  /^tailwind-merge$/,
  /^class-variance-authority$/,
  /^@base-ui\/react(?:\/|$)/,
];

/** `root -> offender` => reason. Expected empty. */
const ALLOWLIST: Record<string, string> = {};

const EXCLUDED_PREFIXES = [
  "src/components/admin/",
  "src/app/admin/",
  "src/components/ui/",
];

// ---------------------------------------------------------------------------
// Pure analysis (takes a file map, so the mutation tests can feed it synthetic
// sources).
// ---------------------------------------------------------------------------

/** Blanks block and line comments, keeping offsets (a `//` after `:` is a URL). */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/gm, (m, p1: string) =>
      p1 + " ".repeat(m.length - p1.length),
    );
}

/** True when the first statement is a `"use client"` directive. */
function isClientModule(src: string): boolean {
  const code = blankComments(src).replace(/^\uFEFF/, "");
  return /^\s*["']use client["']/.test(code);
}

/**
 * Runtime import specifiers of a module: static `import`/`export ... from`,
 * side-effect imports, `import("x")` and `require("x")`. Type-only forms are
 * skipped.
 */
function importSpecifiers(src: string): string[] {
  const code = blankComments(src);
  const out: string[] = [];
  // Statement-level only (`import`/`export` starts its line), so a string
  // literal that merely contains the word is not an import.
  const staticRe =
    /^[ \t]*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/gm;
  for (const m of code.matchAll(staticRe)) {
    // `import type { X }` / `export type { X } from` are erased by the compiler.
    if (m[2]) continue;
    // `export const x = "..."` cannot match: the optional `from` group is the only
    // way to cross a token, and `[^'";]` stops at the first quote.
    out.push(m[3]!);
  }
  for (const m of code.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    out.push(m[1]!);
  }
  return out;
}

/**
 * True when a line of the module is a `"use cache"` / `'use cache'` /
 * `"use cache: remote"` directive. A character scan (no regex over the whole
 * source): the directive may open the file or sit inside a function body.
 */
function hasUseCacheDirective(src: string): boolean {
  const marker = "use cache";
  for (const line of blankComments(src).split("\n")) {
    const t = line.trim();
    const quote = t[0];
    if (quote !== '"' && quote !== "'") continue;
    if (!t.startsWith(marker, 1)) continue;
    const after = t[1 + marker.length];
    if (after === quote || after === ":") return true;
  }
  return false;
}

/** `@/x` and relative specifiers -> a file in the map; anything else -> null. */
function resolveSpecifier(
  from: string,
  spec: string,
  files: Files,
): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = posix.join("src", spec.slice(2));
  else if (spec.startsWith("./") || spec.startsWith("../")) {
    base = posix.normalize(posix.join(posix.dirname(from), spec));
  } else return null;
  for (const cand of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (files.has(cand)) return cand;
  }
  return null;
}

function isScanned(path: string): boolean {
  return (
    path.startsWith("src/") &&
    !EXCLUDED_PREFIXES.some((p) => path.startsWith(p))
  );
}

interface Analysis {
  scanned: string[];
  clientRoots: string[];
  /** R1 violations: `importer -> primitive`. */
  r1: string[];
  /** R2 violations: `root -> ... -> offender (reason)`; key is `root -> offender`. */
  r2: Array<{ key: string; message: string }>;
  /** R3 violations: a client root reaches a server-only module; key is `root -> offender`. */
  r3: Array<{ key: string; message: string }>;
}

function analyze(files: Files): Analysis {
  const scanned = [...files.keys()].filter(isScanned).sort();
  const imports = new Map<
    string,
    { internal: string[]; packages: string[]; serverPackages: string[] }
  >();

  const importsOf = (path: string) => {
    let entry = imports.get(path);
    if (!entry) {
      const internal: string[] = [];
      const packages: string[] = [];
      const serverPackages: string[] = [];
      for (const spec of importSpecifiers(files.get(path) ?? "")) {
        const hit = resolveSpecifier(path, spec, files);
        if (hit) internal.push(hit);
        else if (BANNED_PACKAGES.some((re) => re.test(spec))) packages.push(spec);
        else if (SERVER_ONLY_PACKAGES.some((re) => re.test(spec))) {
          serverPackages.push(spec);
        }
      }
      entry = { internal, packages, serverPackages };
      imports.set(path, entry);
    }
    return entry;
  };

  const r1: string[] = [];
  for (const path of scanned) {
    for (const dep of importsOf(path).internal) {
      if (dep === UI_SEPARATOR || dep === UI_BADGE) r1.push(`${path} -> ${dep}`);
    }
  }

  const clientRoots = scanned.filter((p) => isClientModule(files.get(p) ?? ""));
  const r2: Array<{ key: string; message: string }> = [];
  for (const root of clientRoots) {
    // BFS keeps the shortest chain for the message.
    const parent = new Map<string, string | null>([[root, null]]);
    const queue = [root];
    const chainTo = (node: string): string[] => {
      const chain: string[] = [];
      for (let cur: string | null | undefined = node; cur; cur = parent.get(cur)) {
        chain.unshift(cur);
      }
      return chain;
    };
    const seenOffender = new Set<string>();
    while (queue.length > 0) {
      const node = queue.shift()!;
      const { internal, packages } = importsOf(node);
      for (const pkg of packages) {
        const key = `${root} -> ${pkg}`;
        if (seenOffender.has(key)) continue;
        seenOffender.add(key);
        r2.push({ key, message: `${[...chainTo(node), pkg].join(" -> ")}` });
      }
      for (const dep of internal) {
        if (BANNED_MODULES.has(dep)) {
          const key = `${root} -> ${dep}`;
          if (!seenOffender.has(key)) {
            seenOffender.add(key);
            r2.push({ key, message: [...chainTo(node), dep].join(" -> ") });
          }
          // Keep walking: the primitive's own imports are the same finding.
          continue;
        }
        if (!parent.has(dep)) {
          parent.set(dep, node);
          queue.push(dep);
        }
      }
    }
  }

  // R3: BFS again from each client root; the first server-only module on a
  // path is the offender (its own imports are the same finding, so the walk
  // stops there).
  const r3: Array<{ key: string; message: string }> = [];
  for (const root of clientRoots) {
    const parent = new Map<string, string | null>([[root, null]]);
    const queue = [root];
    const chainTo = (node: string): string[] => {
      const chain: string[] = [];
      for (let cur: string | null | undefined = node; cur; cur = parent.get(cur)) {
        chain.unshift(cur);
      }
      return chain;
    };
    while (queue.length > 0) {
      const node = queue.shift()!;
      const reasons: string[] = [];
      if (node === SUPABASE_SERVER) reasons.push("is the server Supabase client");
      for (const pkg of importsOf(node).serverPackages) {
        reasons.push(`imports ${pkg}`);
      }
      if (hasUseCacheDirective(files.get(node) ?? "")) {
        reasons.push('declares a "use cache" function');
      }
      if (reasons.length > 0) {
        r3.push({
          key: `${root} -> ${node}`,
          message: `${chainTo(node).join(" -> ")} (${reasons.join(", ")})`,
        });
        continue;
      }
      for (const dep of importsOf(node).internal) {
        if (!parent.has(dep)) {
          parent.set(dep, node);
          queue.push(dep);
        }
      }
    }
  }

  return { scanned, clientRoots, r1, r2, r3 };
}

// ---------------------------------------------------------------------------
// Real tree
// ---------------------------------------------------------------------------

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(name) && !/\.(?:test|spec)\./.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function loadRealTree(): Files {
  const files: Files = new Map();
  for (const full of walk(SRC_DIR)) {
    files.set(relative(ROOT, full).split(sep).join("/"), readFileSync(full, "utf8"));
  }
  return files;
}

const real = loadRealTree();
const analysis = analyze(real);

const allowedKeys = new Set(Object.keys(ALLOWLIST));

describe("public client weight (h13-weight-2)", () => {
  it("R1: no public module imports the ui/separator or ui/badge primitive", () => {
    expect(analysis.r1, analysis.r1.join("\n")).toEqual([]);
  });

  it("R2: no 'use client' module reaches cn() / tailwind-merge / cva / Base UI", () => {
    const offenders = analysis.r2.filter((v) => !allowedKeys.has(v.key));
    expect(
      offenders.map((v) => v.message),
      "a 'use client' module pulls the class-merging stack into the public bundle; " +
        "use literal classes (see nav-links.tsx separators, bias-badge.tsx)",
    ).toEqual([]);
  });

  it("R3: no 'use client' module reaches next/cache, next/headers, server-only, supabase/server or a \"use cache\" function", () => {
    expect(
      analysis.r3.map((v) => v.message),
      "a 'use client' module (transitively) value-imports a server-only module; " +
        "`next build` fails on it although tsc / eslint / vitest pass. Move what the " +
        "client needs (a constant, a pure helper) into a plain module, or use `import type`.",
    ).toEqual([]);
  });

  it("the allowlist is empty, or every entry carries a written reason and still matches", () => {
    for (const [key, reason] of Object.entries(ALLOWLIST)) {
      expect(reason.trim().length, `allowlist entry "${key}" needs a reason`).toBeGreaterThanOrEqual(20);
      expect(
        analysis.r2.some((v) => v.key === key),
        `stale allowlist entry "${key}"`,
      ).toBe(true);
    }
    expect(Object.keys(ALLOWLIST)).toEqual([]);
  });

  it("is not vacuous: the scan sees the real client islands and the walk resolves edges", () => {
    expect(analysis.scanned.length).toBeGreaterThan(150);
    expect(analysis.clientRoots).toContain("src/components/bookmark/saved-list.tsx");
    expect(analysis.clientRoots).toContain("src/components/layout/nav-links.tsx");
    expect(analysis.clientRoots.length).toBeGreaterThan(10);
    // The excluded directories are in the file map (the closure walks into them)
    // but never scanned as roots.
    expect(real.has(UTILS)).toBe(true);
    expect(real.has(UI_SEPARATOR)).toBe(true);
    expect(analysis.scanned.some((p) => p.startsWith("src/components/ui/"))).toBe(false);
    expect(analysis.scanned.some((p) => p.startsWith("src/components/admin/"))).toBe(false);
    expect(analysis.scanned.some((p) => p.startsWith("src/app/admin/"))).toBe(false);
    expect(analysis.scanned.some((p) => /\.test\./.test(p))).toBe(false);
  });

  it("the primitives it protects against still import what the guard says they do", () => {
    // If ui/separator stopped importing cn(), R2 would pass for the wrong
    // reason; pin the premise.
    expect(importSpecifiers(real.get(UI_SEPARATOR)!)).toContain("@/lib/utils");
    expect(importSpecifiers(real.get(UI_BADGE)!)).toContain("@/lib/utils");
    expect(importSpecifiers(real.get(UTILS)!)).toContain("tailwind-merge");
  });
});

// ---------------------------------------------------------------------------
// Mutation tests: the rules must bite on synthetic sources.
// ---------------------------------------------------------------------------

const UTILS_SRC = `import { clsx } from "clsx"\nimport { twMerge } from "tailwind-merge"\nexport const cn = (...a: unknown[]) => twMerge(clsx(a))\n`;
const BADGE_SRC = `import { cn } from "@/lib/utils"\nexport function Badge() { return null }\n`;
const SEPARATOR_SRC = `"use client"\nimport { Separator as P } from "@base-ui/react/separator"\nimport { cn } from "@/lib/utils"\nexport function Separator() { return null }\n`;

function tree(extra: Record<string, string>): Files {
  return new Map<string, string>([
    [UTILS, UTILS_SRC],
    [UI_BADGE, BADGE_SRC],
    [UI_SEPARATOR, SEPARATOR_SRC],
    ...Object.entries(extra),
  ]);
}

describe("mutation: the guard bites", () => {
  it("a client file importing '@/lib/utils' fails R2", () => {
    const a = analyze(
      tree({
        "src/components/foo/client.tsx": `"use client"\nimport { cn } from "@/lib/utils"\nexport const X = () => cn("a")\n`,
      }),
    );
    expect(a.r2.map((v) => v.key)).toEqual([
      "src/components/foo/client.tsx -> src/lib/utils.ts",
    ]);
  });

  it("a client file -> bias-spectrum -> bias-badge -> ui/badge chain fails (R2 chain, R1 at the importer)", () => {
    const a = analyze(
      tree({
        "src/components/saved/list.tsx": `"use client"\nimport { BiasSpectrum } from "@/components/story/bias-spectrum"\nexport const L = () => BiasSpectrum\n`,
        "src/components/story/bias-spectrum.tsx": `import { BIAS_BADGE_CONFIG } from "./bias-badge"\nexport const BiasSpectrum = BIAS_BADGE_CONFIG\n`,
        "src/components/story/bias-badge.tsx": `import { Badge } from "@/components/ui/badge"\nexport const BIAS_BADGE_CONFIG = Badge\n`,
      }),
    );
    const chain = a.r2.find((v) => v.key === "src/components/saved/list.tsx -> src/components/ui/badge.tsx");
    expect(chain?.message).toBe(
      "src/components/saved/list.tsx -> src/components/story/bias-spectrum.tsx -> src/components/story/bias-badge.tsx -> src/components/ui/badge.tsx",
    );
    expect(a.r1).toEqual(["src/components/story/bias-badge.tsx -> src/components/ui/badge.tsx"]);
  });

  it("a server file importing ui/separator fails R1 (and is not a client root)", () => {
    const a = analyze(
      tree({
        "src/components/layout/header.tsx": `import { Separator } from "@/components/ui/separator"\nexport const H = () => Separator\n`,
      }),
    );
    expect(a.r1).toEqual(["src/components/layout/header.tsx -> src/components/ui/separator.tsx"]);
    expect(a.clientRoots).toEqual([]);
    expect(a.r2).toEqual([]);
  });

  it("a relative import of the primitive is resolved too", () => {
    const a = analyze(
      tree({
        "src/components/layout/header.tsx": `import { Separator } from "../ui/separator"\nexport const H = Separator\n`,
      }),
    );
    expect(a.r1).toEqual(["src/components/layout/header.tsx -> src/components/ui/separator.tsx"]);
  });

  it("a client file importing tailwind-merge or Base UI directly fails R2", () => {
    const a = analyze(
      tree({
        "src/components/foo/a.tsx": `"use client"\nimport { twMerge } from "tailwind-merge"\nexport const A = twMerge\n`,
        "src/components/foo/b.tsx": `"use client"\nimport { Dialog } from "@base-ui/react/dialog"\nexport const B = Dialog\n`,
        "src/components/foo/c.tsx": `'use client';\nimport { cva } from "class-variance-authority"\nexport const C = cva\n`,
      }),
    );
    expect(a.r2.map((v) => v.key).sort()).toEqual([
      "src/components/foo/a.tsx -> tailwind-merge",
      "src/components/foo/b.tsx -> @base-ui/react/dialog",
      "src/components/foo/c.tsx -> class-variance-authority",
    ]);
  });

  it("a dynamic import() and a re-export are followed", () => {
    const a = analyze(
      tree({
        "src/components/foo/lazy.tsx": `"use client"\nexport const L = () => import("@/lib/utils")\n`,
        "src/components/foo/re.tsx": `"use client"\nexport { cn } from "@/lib/utils"\n`,
        "src/components/foo/barrel.ts": `export * from "@/lib/utils"\n`,
        "src/components/foo/viabarrel.tsx": `"use client"\nimport { cn } from "./barrel"\nexport const V = cn\n`,
      }),
    );
    expect(a.r2.map((v) => v.key).sort()).toEqual([
      "src/components/foo/lazy.tsx -> src/lib/utils.ts",
      "src/components/foo/re.tsx -> src/lib/utils.ts",
      "src/components/foo/viabarrel.tsx -> src/lib/utils.ts",
    ]);
  });

  it("an index.ts barrel directory import resolves", () => {
    const a = analyze(
      tree({
        "src/lib/helpers/index.ts": `export { cn } from "@/lib/utils"\n`,
        "src/components/foo/uses.tsx": `"use client"\nimport { cn } from "@/lib/helpers"\nexport const U = cn\n`,
      }),
    );
    expect(a.r2.map((v) => v.key)).toEqual(["src/components/foo/uses.tsx -> src/lib/utils.ts"]);
  });

  describe("R3: server-only modules stay out of the client graph", () => {
    const POOL_SRC = `import { cacheLife } from "next/cache"\nexport const GAME_ROUND_SIZE = 10\nexport async function load() {\n  "use cache"\n  cacheLife("minutes")\n}\n`;

    it("a client file value-importing a next/cache module fails R3 (the h18 zone-guess-game shape)", () => {
      const a = analyze(
        tree({
          "src/components/game/zone.tsx": `"use client"\nimport { GAME_ROUND_SIZE, type GameHeadline } from "@/lib/game/pool"\nexport const Z = GAME_ROUND_SIZE\n`,
          "src/lib/game/pool.ts": POOL_SRC,
        }),
      );
      expect(a.r3.map((v) => v.key)).toEqual([
        "src/components/game/zone.tsx -> src/lib/game/pool.ts",
      ]);
      expect(a.r3[0]!.message).toBe(
        'src/components/game/zone.tsx -> src/lib/game/pool.ts (imports next/cache, declares a "use cache" function)',
      );
    });

    it("the same client file passes once the constant lives in a plain module and the pool is type-only", () => {
      const a = analyze(
        tree({
          "src/components/game/zone.tsx": `"use client"\nimport type { GameHeadline } from "@/lib/game/pool"\nimport { GAME_ROUND_SIZE } from "@/lib/game/round-size"\nexport const Z = GAME_ROUND_SIZE\n`,
          "src/lib/game/pool.ts": POOL_SRC,
          "src/lib/game/round-size.ts": `export const GAME_ROUND_SIZE = 10\n`,
        }),
      );
      expect(a.r3).toEqual([]);
    });

    it("a transitive chain to supabase/server fails R3 and reports the chain", () => {
      const a = analyze(
        tree({
          "src/lib/supabase/server.ts": `export function createReaderClient() { return null }\n`,
          "src/lib/q.ts": `import { createReaderClient } from "@/lib/supabase/server"\nexport const q = createReaderClient\n`,
          "src/lib/mid.ts": `export { q } from "./q"\n`,
          "src/components/foo/c.tsx": `"use client"\nimport { q } from "@/lib/mid"\nexport const C = q\n`,
        }),
      );
      expect(a.r3.map((v) => v.key)).toEqual([
        "src/components/foo/c.tsx -> src/lib/supabase/server.ts",
      ]);
      expect(a.r3[0]!.message).toBe(
        "src/components/foo/c.tsx -> src/lib/mid.ts -> src/lib/q.ts -> src/lib/supabase/server.ts (is the server Supabase client)",
      );
    });

    it("next/headers, server-only and a file-level 'use cache' (with a profile) each fail R3", () => {
      const a = analyze(
        tree({
          "src/lib/h.ts": `import { cookies } from "next/headers"\nexport const h = cookies\n`,
          "src/lib/so.ts": `import "server-only"\nexport const so = 1\n`,
          "src/lib/uc.ts": `'use cache: remote'\nexport const uc = 1\n`,
          "src/components/foo/a.tsx": `"use client"\nimport { h } from "@/lib/h"\nexport const A = h\n`,
          "src/components/foo/b.tsx": `"use client"\nimport { so } from "@/lib/so"\nexport const B = so\n`,
          "src/components/foo/c.tsx": `"use client"\nimport { uc } from "@/lib/uc"\nexport const C = uc\n`,
        }),
      );
      expect(a.r3.map((v) => v.key).sort()).toEqual([
        "src/components/foo/a.tsx -> src/lib/h.ts",
        "src/components/foo/b.tsx -> src/lib/so.ts",
        "src/components/foo/c.tsx -> src/lib/uc.ts",
      ]);
    });

    it("a server file importing next/cache is fine when no client module reaches it", () => {
      const a = analyze(
        tree({
          "src/lib/game/pool.ts": POOL_SRC,
          "src/app/oyun/page.tsx": `import { load } from "@/lib/game/pool"\nexport default load\n`,
          "src/components/foo/c.tsx": `"use client"\nexport const C = () => null\n`,
        }),
      );
      expect(a.r3).toEqual([]);
    });

    it("type-only imports, comments and prose strings do not trip R3", () => {
      const a = analyze(
        tree({
          "src/lib/game/pool.ts": POOL_SRC,
          "src/components/foo/t.tsx": `"use client"\nimport type { load } from "@/lib/game/pool"\n// import { cacheLife } from "next/cache"\nexport const T = 'say "use cache" here'.length\n`,
          "src/lib/note.ts": `// "use cache"\n/* "use cache" */\nexport const note = 1\n`,
          "src/components/foo/n.tsx": `"use client"\nimport { note } from "@/lib/note"\nexport const N = note\n`,
        }),
      );
      expect(a.r3).toEqual([]);
    });

    it("hasUseCacheDirective matches directives only, not look-alikes", () => {
      expect(hasUseCacheDirective(`"use cache"\nexport const a = 1`)).toBe(true);
      expect(hasUseCacheDirective(`export async function f() {\n  "use cache";\n}`)).toBe(true);
      expect(hasUseCacheDirective(`'use cache: private'\n`)).toBe(true);
      expect(hasUseCacheDirective(`const s = "use cache"`)).toBe(false);
      expect(hasUseCacheDirective(`"use cached"\n`)).toBe(false);
      expect(hasUseCacheDirective(`// "use cache"\n`)).toBe(false);
    });
  });

  describe("negative controls (no false positives)", () => {
    it("a clean client file and a clean server file pass", () => {
      const a = analyze(
        tree({
          "src/components/foo/clean.tsx": `"use client"\nimport { useState } from "react"\nimport { x } from "@/lib/other"\nexport const C = () => useState(x)\n`,
          "src/lib/other.ts": `export const x = 1\n`,
          "src/components/foo/server.tsx": `import { x } from "@/lib/other"\nexport const S = x\n`,
        }),
      );
      expect(a.r1).toEqual([]);
      expect(a.r2).toEqual([]);
      expect(a.clientRoots).toEqual(["src/components/foo/clean.tsx"]);
    });

    it("a server module importing cn() is fine as long as no client module reaches it", () => {
      const a = analyze(
        tree({
          "src/components/foo/server.tsx": `import { cn } from "@/lib/utils"\nexport const S = () => cn("a")\n`,
          "src/components/foo/client.tsx": `"use client"\nexport const C = () => null\n`,
        }),
      );
      expect(a.r1).toEqual([]);
      expect(a.r2).toEqual([]);
    });

    it("type-only imports are erased and ignored", () => {
      const a = analyze(
        tree({
          "src/components/foo/typed.tsx": `"use client"\nimport type { ClassValue } from "@/lib/utils"\nexport type { Badge } from "@/components/ui/badge"\nexport const T = 1\n`,
        }),
      );
      expect(a.r1).toEqual([]);
      expect(a.r2).toEqual([]);
    });

    it("imports named only in comments or strings do not count", () => {
      const a = analyze(
        tree({
          "src/components/foo/prose.tsx": `"use client"\n// import { cn } from "@/lib/utils"\n/* import { Badge } from "@/components/ui/badge" */\nexport const P = 'import x from "@/lib/utils"'.length\n`,
        }),
      );
      expect(a.r1).toEqual([]);
      expect(a.r2).toEqual([]);
    });

    it("the excluded directories are not scanned, but a public client module that reaches them is flagged", () => {
      const a = analyze(
        tree({
          "src/components/admin/panel.tsx": `"use client"\nimport { Badge } from "@/components/ui/badge"\nexport const P = Badge\n`,
          "src/app/admin/page.tsx": `import { Separator } from "@/components/ui/separator"\nexport default Separator\n`,
          "src/components/foo/uses-admin.tsx": `"use client"\nimport { P } from "@/components/admin/panel"\nexport const U = P\n`,
        }),
      );
      expect(a.r1).toEqual([]);
      // (src/lib/utils.ts is scanned as a plain module, never as an admin one.)
      expect(a.scanned).toEqual(["src/components/foo/uses-admin.tsx", UTILS]);
      expect(a.r2.map((v) => v.key)).toEqual([
        "src/components/foo/uses-admin.tsx -> src/components/ui/badge.tsx",
      ]);
    });

    it("'use client' must be the first statement (a later string is not a directive)", () => {
      expect(isClientModule(`"use client"\nexport const A = 1`)).toBe(true);
      expect(isClientModule(`// header\n/* x */\n'use client';\nexport const A = 1`)).toBe(true);
      expect(isClientModule(`import x from "y"\n"use client"\n`)).toBe(false);
      expect(isClientModule(`export const A = "use client"`)).toBe(false);
    });
  });
});
