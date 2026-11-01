import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// Reader-facing Turkish copy writes a percent with a PREFIX ("%88"), never
// "88%", and groups thousands with a dot ("1.689"; a bare template
// interpolation prints "1689"). hunt-8 found the English suffix form on the
// cluster spectrum bar and bare counts on /sources, /source/[slug], the karne,
// /hafta and /trends. The helpers live in src/lib/format/number-tr.ts; this
// guard keeps the suffix form from coming back and pins the call sites that
// were migrated.
//
// What the scan flags: "}%" -- a closing interpolation / JSX expression
// directly followed by a percent sign -- unless the percent closes a string
// ("}%`", '}%"', "}%'"), which is how CSS lengths are written
// (`width: ${x}%`). Prefix copy ("%${pct}") never has "}%" at all.

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

/** Suffix percent right after an interpolation, not closing a string literal. */
const SUFFIX_PERCENT = /\}%(?![`"'])/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function importsFrom(src: string, specifier: string): boolean {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(`from\\s+["']${escaped}["']`).test(stripComments(src));
}

describe("tr-TR percent / count formatting", () => {
  it("no non-test source writes a suffix percent after an interpolation", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const code = stripComments(readFileSync(file, "utf8"));
      code.split("\n").forEach((line, i) => {
        if (SUFFIX_PERCENT.test(line)) {
          offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the scan regex is not vacuous", () => {
    // JSX text node and a parenthesised template: both are the English form.
    expect(SUFFIX_PERCENT.test("<span>{pct}%</span>")).toBe(true);
    expect(SUFFIX_PERCENT.test("title={`(${pct}%)`}")).toBe(true);
    expect(SUFFIX_PERCENT.test("kaynak (${pct}%)")).toBe(true);
    // CSS lengths close their string right after the percent sign.
    expect(SUFFIX_PERCENT.test("style={{ width: `${x}%` }}")).toBe(false);
    expect(SUFFIX_PERCENT.test('const w = "${x}%"')).toBe(false);
    expect(SUFFIX_PERCENT.test("const w = '${x}%'")).toBe(false);
    // The Turkish prefix form never matches.
    expect(SUFFIX_PERCENT.test("`%${pct} (${num}/${den})`")).toBe(false);
    expect(SUFFIX_PERCENT.test("{formatPctTr(pct)}")).toBe(false);
  });

  it("the migrated reader surfaces import the shared formatter", () => {
    const NUMBER_TR = "@/lib/format/number-tr";
    for (const rel of [
      "src/app/sources/page.tsx",
      "src/app/source/[slug]/page.tsx",
      "src/components/source/source-karne.tsx",
      "src/components/weekly/week-sections.tsx",
      "src/components/story/bias-spectrum.tsx",
      "src/app/cluster/[id]/opengraph-image.tsx",
      "src/app/trends/page.tsx",
    ]) {
      expect(importsFrom(read(rel), NUMBER_TR), rel).toBe(true);
    }
  });

  it("/trends words its aria-label total with the shared count formatter", () => {
    const code = stripComments(read("src/app/trends/page.tsx"));
    expect(code).toContain("Toplam ${formatCountTr(totalArticles)} haber.");
    expect(code).not.toContain("Toplam ${totalArticles} haber.");
  });

  it("/source/[slug] hides RSS boilerplate excerpts", () => {
    const src = read("src/app/source/[slug]/page.tsx");
    expect(
      importsFrom(src, "@/lib/articles/description-boilerplate"),
      "imports isBoilerplateDescription",
    ).toBe(true);
    expect(src).toMatch(/import\s*\{[^}]*\bisBoilerplateDescription\b[^}]*\}\s*from/);
    // The excerpt paragraph is gated on it, not merely imported.
    expect(stripComments(src)).toMatch(
      /articleExcerptEligible\(article,\s*source\)\s*&&\s*!isBoilerplateDescription\(article\.description\)/,
    );
  });
});
