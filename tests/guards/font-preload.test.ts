import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
//   - next/font/google is imported by an allow-list of exactly two files
//     (src/app/layout.tsx and the named exception below), so a font added in
//     any other file cannot dodge the two checks above.
//
// Named exception (h21-perf-1): src/app/ekonomi/layout.tsx declares a SECOND
// JetBrains_Mono instance, route-scoped. /ekonomi is mostly mono text, and with
// the root mono at `preload: false` the late font swap produced a 0.229 CLS on
// a cold mobile load, because next/font's automatic fallback is Arial scaled to
// the mono average width (size-adjust 134.59%) and its glyph widths differ from
// the real font, so the flex-wrap rows reflowed on swap. Two fixes were
// measured (next build + next start, 390x844 DPR3, Slow 4G, 4x CPU, 3 cold
// runs each):
//
//   - preload: true     CLS 0, but FCP +360 ms (two more files on a 1.4 Mbps
//                       link compete with the CSS and JS);
//   - monospace fallback  CLS 0, FCP +72 ms. SHIPPED. The instance sets
//                       `adjustFontFallback: false` and a fixed-width
//                       `fallback` list, so the swap is between two ~0.6 em
//                       faces and nothing reflows. It keeps `/` at 4 preloads
//                       and /ekonomi at 4.
//
// The guard therefore does not require preload on this instance (re-measure
// FCP before turning it on); it requires the monospace fallback, which is what
// removes the shift.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SRC_DIR = join(ROOT, "src");
const LAYOUT = join(SRC_DIR, "app", "layout.tsx");
const EKONOMI_LAYOUT = join(SRC_DIR, "app", "ekonomi", "layout.tsx");

/**
 * Every file under src allowed to import next/font/google. The second entry is
 * the single, named exception for h21-perf-1 (route-scoped preloaded mono for
 * /ekonomi); do not add a third without a measured reason.
 */
const ALLOWED_FONT_IMPORTERS = ["src/app/layout.tsx", "src/app/ekonomi/layout.tsx"] as const;

const MAX_PRELOADED_FAMILIES = 2;

/** Escape every RegExp metacharacter so `text` matches literally. */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Named fixed-width faces a mono fallback list may use before the generic `monospace`. */
const FIXED_WIDTH_FACES: ReadonlySet<string> = new Set([
  "ui-monospace",
  "SF Mono",
  "Menlo",
  "Monaco",
  "Consolas",
  "Courier New",
  "Courier",
]);

/** The entries of `fallback: [...]` in a next/font config, quotes stripped; [] when absent. */
function fallbackFamilies(config: string): string[] {
  const match = /\bfallback\s*:\s*\[([^\]]*)\]/.exec(config);
  if (!match) return [];
  return (match[1] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.slice(1, -1));
}

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
  /** Local name of the imported function (the `as` alias when there is one). */
  local: string;
  /** Variable the call result is assigned to (`const <binding> = Font({...})`), or "" if none. */
  binding: string;
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
    const call = new RegExp(`\\b${escapeRegExp(local)}\\s*\\(\\s*\\{`).exec(code);
    if (!call) throw new Error(`${imported} is imported but never called with a config object`);
    const config = balancedBraces(code, call.index + call[0].length - 1);
    const assigned = new RegExp(
      `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escapeRegExp(local)}\\s*\\(`,
    ).exec(code);
    families.push({
      imported,
      local,
      binding: assigned?.[1] ?? "",
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

  it("is imported only by the allow-listed files (root layout + the named /ekonomi exception)", () => {
    const importers = walk(SRC_DIR)
      .filter((file) => IMPORTS_GOOGLE_FONT.test(stripComments(readFileSync(file, "utf-8"))))
      .map((file) => relative(ROOT, file).split(sep).join("/"))
      .sort();
    expect(importers).toEqual([...ALLOWED_FONT_IMPORTERS].sort());
  });
});

describe("route-scoped mono for /ekonomi (h21-perf-1)", () => {
  const read = (): string => readFileSync(EKONOMI_LAYOUT, "utf-8");
  const families = (): FontFamily[] => fontFamilies(read());

  it("src/app/ekonomi/layout.tsx exists", () => {
    expect(existsSync(EKONOMI_LAYOUT)).toBe(true);
  });

  it("declares exactly one family: JetBrains_Mono", () => {
    const found = families();
    expect(found).toHaveLength(1);
    expect(found[0]?.imported).toBe("JetBrains_Mono");
  });

  it("uses the same variable, subsets and display as the root mono", () => {
    const config = families()[0]?.config ?? "";
    expect(config).toContain('variable: "--font-mono"');
    expect(config).toContain('"latin"');
    expect(config).toContain('"latin-ext"');
    expect(config).toContain('display: "swap"');
  });

  it("turns off the proportional auto-fallback (the Arial face behind the 0.229 shift)", () => {
    const config = families()[0]?.config ?? "";
    expect(config).toMatch(/\badjustFontFallback\s*:\s*false\b/);
  });

  it("falls back to fixed-width faces, ending in the generic monospace", () => {
    const config = families()[0]?.config ?? "";
    const list = fallbackFamilies(config);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[list.length - 1]).toBe("monospace");
    const named = list.slice(0, -1);
    expect(named.some((name) => FIXED_WIDTH_FACES.has(name))).toBe(true);
    expect(named.every((name) => FIXED_WIDTH_FACES.has(name))).toBe(true);
  });

  it("applies the font variable to the wrapper element", () => {
    const binding = families()[0]?.binding ?? "";
    expect(binding, "the font call result must be bound to a const").not.toBe("");
    const wrapper = new RegExp(`className=\\{\\s*${escapeRegExp(binding)}\\.variable\\s*\\}`);
    expect(wrapper.test(stripComments(read()))).toBe(true);
  });

  it("does not hardcode a hashed /_next/static/media font URL", () => {
    expect(read()).not.toContain("/_next/static/media");
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

  it("captures the local binding of an aliased import", () => {
    const src = `import { A as Local, B } from "next/font/google";
const a = Local({ variable: "--a" });
const b = B({ variable: "--b" });`;
    expect(fontFamilies(src).map((f) => [f.imported, f.local, f.binding])).toEqual([
      ["A", "Local", "a"],
      ["B", "B", "b"],
    ]);
  });

  it("escapeRegExp matches every metacharacter literally", () => {
    const text = "a.b*c+d?e^f${g}h(i)j|k[l]m\\n";
    expect(new RegExp(`^${escapeRegExp(text)}$`).test(text)).toBe(true);
    expect(new RegExp(`^${escapeRegExp("a.b")}$`).test("axb")).toBe(false);
  });

  it("reads a fallback list, and returns [] when there is none", () => {
    expect(fallbackFamilies(`{ fallback: ["Menlo", 'Courier New', "monospace"], }`)).toEqual([
      "Menlo",
      "Courier New",
      "monospace",
    ]);
    expect(fallbackFamilies(`{ variable: "--a" }`)).toEqual([]);
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
