import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// h108-mobilelayout-1: no loading skeleton is wider than its container at
// phone widths.
//
// /blindspots and /trends drew their subtitle placeholder as
// `h-4 w-96 ...` (a fixed 24rem = 384 px bar) inside `container mx-auto
// px-4`. The content box is 328 px at a 360 px viewport (358 px at 390), so the
// bar ended at x = 400 and the document scrolled sideways for as long as the
// Suspense fallback was mounted (scrollWidth 401 against 360, 400 against 390).
//
// The fix keeps the desktop look and caps instead of fixing the width:
// `w-full max-w-96` is 384 px where it fits and the container width below that.
//
// This guard globs src/app/**/loading.tsx and fails on any class token that
// pins an un-prefixed width wider than the narrowest content box:
//   - `w-96` (384 px), and
//   - `w-[Npx]` with N >= 330.
// `w-80` (320 px) fits in 328 px and stays allowed, and so does every token
// with a variant prefix (`lg:w-96` on cluster/[id] is breakpoint-gated and
// safe). `max-w-*` and `min-w-*` are different utilities and never match.
//
// Source-text guard, no render of server components. Comments are stripped
// first so prose cannot satisfy (or trip) an assertion.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const APP = join(ROOT, "src/app");

/** Widest fixed width (px) that still fits the 328 px content box at 360 px. */
const MAX_SAFE_PX = 329;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name === "loading.tsx") out.push(full);
  }
  return out.sort();
}

/**
 * Blanks block and line comments (keeping newlines, so line numbers hold). A
 * `//` only starts a comment at the start of a line or after whitespace, so
 * `https://` inside a string survives.
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|\s)\/\/[^\n]*/g, (_m, lead: string) => lead);
}

/**
 * True when `token` is a bare (un-prefixed) width utility that is wider than
 * the narrowest phone content box. Tolerates the important modifier in both
 * Tailwind spellings (`!w-96`, `w-96!`).
 */
export function isWideFixedWidth(token: string): boolean {
  const bare = token.replace(/^!/, "").replace(/!$/, "");
  if (bare === "w-96") return true;
  const px = /^w-\[(\d+(?:\.\d+)?)px\]$/.exec(bare);
  return px !== null && Number.parseFloat(px[1]!) > MAX_SAFE_PX;
}

/** Offending `line: token` pairs in one loading file's source. */
export function wideFixedWidths(source: string): string[] {
  const out: string[] = [];
  stripComments(source)
    .split("\n")
    .forEach((line, i) => {
      for (const token of line.split(/[\s"'`{}()]+/)) {
        if (token && isWideFixedWidth(token)) out.push(`${i + 1}: ${token}`);
      }
    });
  return out;
}

const FILES = walk(APP);
const rel = (file: string) => relative(ROOT, file).split(sep).join("/");
const read = (file: string) => readFileSync(file, "utf8");

describe("loading skeleton width: detector", () => {
  it.each([
    ["w-96", true],
    ["!w-96", true],
    ["w-96!", true],
    ["w-[330px]", true],
    ["w-[384px]", true],
    ["w-[400px]", true],
    ["w-[1200px]", true],
    ["w-[400.5px]", true],
    ["w-[329px]", false],
    ["w-[100px]", false],
    ["w-80", false],
    ["w-48", false],
    ["w-full", false],
    ["w-3/4", false],
    ["max-w-96", false],
    ["max-w-[400px]", false],
    ["min-w-96", false],
    ["sm:w-96", false],
    ["md:w-[400px]", false],
    ["lg:w-96", false],
    ["xl:w-[500px]", false],
    ["h-96", false],
    ["h-[400px]", false],
  ])("%s -> %s", (token, wide) => {
    expect(isWideFixedWidth(token)).toBe(wide);
  });

  it("reports the line and token, across quote styles", () => {
    const src = [
      "export default function X() {",
      '  return <div className="h-4 w-96 rounded" />;',
      "}",
      "const a = `h-4 w-[400px]`;",
    ].join("\n");
    expect(wideFixedWidths(src)).toEqual(["2: w-96", "4: w-[400px]"]);
  });

  it("accepts the capped form and ignores commented-out classes", () => {
    const src = [
      "// was: h-4 w-96",
      "/* h-4 w-[400px] */",
      '<div className="h-4 w-full max-w-96 rounded" />',
      '<div className="h-48 w-full md:w-72 lg:w-96" />',
    ].join("\n");
    expect(wideFixedWidths(src)).toEqual([]);
  });
});

describe("loading skeleton width: src/app/**/loading.tsx", () => {
  it("finds the loading files, so the guard is not vacuous", () => {
    const names = FILES.map(rel);
    expect(names.length).toBeGreaterThanOrEqual(10);
    expect(names).toContain("src/app/blindspots/loading.tsx");
    expect(names).toContain("src/app/trends/loading.tsx");
    expect(names).toContain("src/app/cluster/[id]/loading.tsx");
    expect(names).toContain("src/app/timeline/loading.tsx");
  });

  it.each(FILES.map((f) => [rel(f), f] as const))(
    "%s pins no un-prefixed width wider than a phone content box",
    (_name, file) => {
      expect(wideFixedWidths(read(file))).toEqual([]);
    },
  );

  it.each(["src/app/blindspots/loading.tsx", "src/app/trends/loading.tsx"])(
    "%s subtitle placeholder is w-full capped at max-w-96 (384 px on desktop)",
    (name) => {
      const src = stripComments(read(join(ROOT, name)));
      const line = src
        .split("\n")
        .find((l) => l.includes("h-4") && l.includes("bg-muted/40"));
      expect(line).toBeDefined();
      const tokens = line!.split(/[\s"'`{}()]+/);
      expect(tokens).toContain("w-full");
      expect(tokens).toContain("max-w-96");
      expect(tokens).not.toContain("w-96");
    },
  );
});
