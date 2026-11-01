import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (perf): the font preload budget.
//
// next/font/google emits one <link rel="preload" as="font"> per subset file of
// every family that does not opt out. With serif + sans + mono and two subsets
// each (latin, latin-ext) a cold first visit preloaded six font files, and the
// mono one (data labels and badges only) competed with the LCP hero for
// bandwidth. The budget is:
//
//   - the monospace family sets `preload: false` (display: swap still applies,
//     the file is fetched when a label actually paints);
//   - at most two families (serif + sans) may omit `preload: false`;
//   - every next/font/google import lives in src/app/layout.tsx, so a font
//     added in another file cannot dodge the two checks above.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SRC_DIR = join(ROOT, "src");
const LAYOUT = join(SRC_DIR, "app", "layout.tsx");

const MAX_PRELOADED_FAMILIES = 2;

/** Blank block comments and line comments so prose cannot fake a config. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

/** `{ ... }` starting at `open` (index of the opening brace), braces balanced. */
function balancedBraces(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced braces in next/font config");
}

interface FontFamily {
  /** Name as exported by next/font/google, e.g. JetBrains_Mono. */
  imported: string;
  config: string;
  preloads: boolean;
}

function fontFamilies(src: string): FontFamily[] {
  const code = stripComments(src);
  const importMatch = code.match(/import\s*\{([^}]*)\}\s*from\s*["']next\/font\/google["']/);
  if (!importMatch) return [];
  const families: FontFamily[] = [];
  for (const spec of importMatch[1]!.split(",")) {
    const trimmed = spec.trim();
    if (!trimmed) continue;
    const [imported, local = imported] = trimmed.split(/\s+as\s+/) as [string, string?];
    const call = new RegExp(`\\b${local}\\s*\\(\\s*\\{`).exec(code);
    if (!call) throw new Error(`${imported} is imported but never called with a config object`);
    const config = balancedBraces(code, call.index + call[0].length - 1);
    families.push({
      imported,
      config,
      preloads: !/\bpreload\s*:\s*false\b/.test(config),
    });
  }
  return families;
}

const IMPORTS_GOOGLE_FONT =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["']next\/font\/google["']/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(?:[cm]?[jt]sx?)$/.test(name)) out.push(full);
  }
  return out;
}

describe("font preload budget (src/app/layout.tsx)", () => {
  const families = fontFamilies(readFileSync(LAYOUT, "utf-8"));

  it("finds the font families and their configs (the guard is not vacuous)", () => {
    expect(families.length).toBeGreaterThanOrEqual(2);
    for (const f of families) expect(f.config).toContain("subsets");
  });

  it("does not preload the monospace family", () => {
    const mono = families.filter((f) => f.imported.includes("Mono"));
    for (const f of mono) {
      expect(f.preloads, `${f.imported} must set preload: false`).toBe(false);
    }
  });

  it(`preloads at most ${MAX_PRELOADED_FAMILIES} families`, () => {
    const preloaded = families.filter((f) => f.preloads).map((f) => f.imported);
    expect(preloaded.length, `preloaded: ${preloaded.join(", ")}`).toBeLessThanOrEqual(
      MAX_PRELOADED_FAMILIES,
    );
  });

  it("is the only file under src that imports next/font/google", () => {
    const offenders = walk(SRC_DIR)
      .filter((file) => file !== LAYOUT)
      .filter((file) => IMPORTS_GOOGLE_FONT.test(stripComments(readFileSync(file, "utf-8"))))
      .map((file) => relative(ROOT, file).split(sep).join("/"));
    expect(offenders).toEqual([]);
  });
});

describe("font guard self-check", () => {
  it("reads preload: false out of a config, with or without a trailing comma", () => {
    const src = `import { A_Mono, B } from "next/font/google";
const a = A_Mono({ variable: "--a", preload: false });
const b = B({ variable: "--b", subsets: ["latin"], });`;
    const [a, b] = fontFamilies(src);
    expect(a?.preloads).toBe(false);
    expect(b?.preloads).toBe(true);
  });

  it("ignores a preload mention inside a comment", () => {
    const src = `import { A } from "next/font/google";
// preload: false would go here
const a = A({ variable: "--a" /* preload: false */ });`;
    expect(fontFamilies(src)[0]?.preloads).toBe(true);
  });

  it("detects the import forms a dodge would use", () => {
    expect(IMPORTS_GOOGLE_FONT.test(`import { X } from 'next/font/google'`)).toBe(true);
    expect(IMPORTS_GOOGLE_FONT.test(`const m = await import("next/font/google")`)).toBe(true);
    expect(IMPORTS_GOOGLE_FONT.test(`import "next/font/google"`)).toBe(true);
    expect(IMPORTS_GOOGLE_FONT.test(`import { X } from "next/font/local"`)).toBe(false);
  });
});
