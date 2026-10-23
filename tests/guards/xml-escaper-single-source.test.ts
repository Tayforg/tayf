import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard: ONE XML escaper. src/lib/feeds/rss-builder.ts owns
// `escapeXml` and strips every character XML 1.0 forbids (C0 controls,
// U+FFFE/U+FFFF, lone surrogates) before escaping the five entities. Two
// drifted copies used to exist (src/app/rss.xml/route.ts escaped entities only;
// src/lib/seo/sitemaps.ts stripped C0 only), and a single bad character in a
// feed-sourced title makes the whole document unparseable for every
// subscriber. A new local copy would silently reintroduce that failure, so
// every other module imports or re-exports the shared one.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(here, "../../src");
const CANONICAL = resolve(SRC_DIR, "lib/feeds/rss-builder.ts");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

/** Blanks // and block comments, keeping offsets (and newlines) intact. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) =>
      p1 + " ".repeat(m.length - p1.length),
    );
}

// A declaration, not a use: `function escapeXml(`, or a `const escapeXml =`
// arrow/function-expression binding. Re-exports (`export { escapeXml } from`)
// and imports deliberately do not match.
const DEFINITION_RE =
  /\bfunction\s+escapeXml\b|\b(?:const|let|var)\s+escapeXml\s*(?::[^=]+)?=/;

function definingFiles(): string[] {
  const files: string[] = [];
  for (const file of walk(SRC_DIR)) {
    if (DEFINITION_RE.test(blankComments(readFileSync(file, "utf8")))) {
      files.push(file);
    }
  }
  return files;
}

describe("XML escaper single source", () => {
  it("defines escapeXml in exactly one non-test src file: the RSS builder", () => {
    const defining = definingFiles().map((f) => relative(SRC_DIR, f));
    expect(defining).toEqual(["lib/feeds/rss-builder.ts"]);
  });

  it("sanity floor: the pattern really matches the canonical definition", () => {
    const src = blankComments(readFileSync(CANONICAL, "utf8"));
    expect(DEFINITION_RE.test(src)).toBe(true);
  });

  it("the pattern ignores commented-out copies and re-exports", () => {
    const commented = blankComments(
      "// function escapeXml(s) {}\n/* function escapeXml(s) {} */\nexport { escapeXml } from \"@/lib/feeds/rss-builder\";\n",
    );
    expect(DEFINITION_RE.test(commented)).toBe(false);
  });

  it("the pattern catches a local arrow-function copy", () => {
    expect(DEFINITION_RE.test("const escapeXml = (s: string) => s;")).toBe(true);
    expect(DEFINITION_RE.test("function escapeXml(s: string) { return s; }")).toBe(true);
  });
});
