import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// Reader-facing copy defects hunt 27 found on production (h27-copy-1):
//   - the home hero said "Ensemble kümeleme", the only English jargon on the
//     site (the meta description and the footer say "otomatik kümelenmiş");
//   - the footer hard-coded "2026 Tayf", wrong from 2027-01-01. The footer is
//     part of the cached shell, so it cannot read the clock either: it carries
//     no year at all;
//   - the RSS channel description said "Türkiye haber kaynaklarından" where the
//     page metadata says "Türk haber kaynaklarından";
//   - the /konu index printed `${counts[slug]} küme` raw.
// The scans run on the source with comments blanked, so a comment that explains
// the old wording does not trip them. Blanking is a character scan (no regex
// over the source), and a quote inside JSX text ends at the line break.

const ROOT = join(__dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/**
 * The source with every comment replaced by spaces (newlines kept, so line
 * numbers survive). Quoted strings are skipped so "https://" is not a comment;
 * a ' or " ends at the line break, which keeps an apostrophe in JSX text
 * ("Tayf'ın") from swallowing the rest of the file.
 */
function blankComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    const next = src.charAt(i + 1);
    if (ch === "/" && next === "/") {
      while (i < src.length && src.charAt(i) !== "\n") {
        out += " ";
        i++;
      }
    } else if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < src.length && !(src.charAt(i) === "*" && src.charAt(i + 1) === "/")) {
        out += src.charAt(i) === "\n" ? "\n" : " ";
        i++;
      }
      if (i < src.length) {
        out += "  ";
        i += 2;
      }
    } else if (ch === '"' || ch === "'" || ch === "`") {
      out += ch;
      i++;
      while (i < src.length) {
        const c = src.charAt(i);
        if (c === "\\") {
          out += c + src.charAt(i + 1);
          i += 2;
          continue;
        }
        if (c === "\n" && ch !== "`") break;
        out += c;
        i++;
        if (c === ch) break;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** A standalone 19xx / 20xx number: a hard-coded year. */
function hasYearLiteral(code: string): boolean {
  const re = /(?<![\p{L}\p{N}.])(?:19|20)\d{2}(?![\p{L}\p{N}])/u;
  return re.test(code);
}

describe("blankComments", () => {
  it("blanks line and block comments, keeps strings and line count", () => {
    const src = 'const a = "http://x.test"; // 2026 Tayf\n/* 2026\n 2027 */ const b = 1;\n';
    const out = blankComments(src);
    expect(out.length).toBe(src.length);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out).toContain('"http://x.test"');
    expect(out).not.toContain("2026");
    expect(out).not.toContain("2027");
    expect(out).toContain("const b = 1;");
  });

  it("an apostrophe in JSX text does not swallow the next line", () => {
    const out = blankComments("<p>Tayf'ın haberi</p>\n<p>2026 Tayf</p>\n");
    expect(out).toContain("2026 Tayf");
  });
});

describe("hasYearLiteral", () => {
  it("flags a standalone year and nothing else", () => {
    expect(hasYearLiteral("2026 Tayf")).toBe(true);
    expect(hasYearLiteral("(c) 1999")).toBe(true);
    expect(hasYearLiteral("© Tayf")).toBe(false);
    expect(hasYearLiteral("w-12345")).toBe(false);
    expect(hasYearLiteral("z-2026a")).toBe(false);
    expect(hasYearLiteral("v1.2026")).toBe(false);
    expect(hasYearLiteral("12026")).toBe(false);
  });
});

describe("reader copy", () => {
  it("the home page carries no 'ensemble' jargon", () => {
    const code = blankComments(read("src/app/page.tsx"));
    expect(/\bensemble\b/i.test(code)).toBe(false);
  });

  it("the footer hard-codes no year", () => {
    const code = blankComments(read("src/components/layout/footer.tsx"));
    expect(hasYearLiteral(code)).toBe(false);
  });

  it("the footer shows the brand mark and no clock read", () => {
    const code = blankComments(read("src/components/layout/footer.tsx"));
    expect(code).toContain("© Tayf");
    expect(/\bDate\.now\(|\bnew Date\(|\bcurrentTimeMs\(/.test(code)).toBe(false);
  });

  it("the RSS channel description says 'Türk haber kaynaklarından', like the page metadata", () => {
    const code = blankComments(read("src/app/rss.xml/route.ts"));
    expect(code).toContain("Türk haber kaynaklarından");
    expect(code).not.toContain("Türkiye haber kaynaklarından");
  });

  it("the /konu index formats its küme count with formatCountTr", () => {
    const code = blankComments(read("src/app/konu/page.tsx"));
    expect(code).toContain('from "@/lib/format/number-tr"');
    const lines = code.split("\n").filter((line) => line.includes("küme"));
    const labelLines = lines.filter((line) => line.includes("son 7 günde"));
    expect(labelLines).toHaveLength(1);
    expect(labelLines[0]).toContain("formatCountTr(");
    // No raw count interpolation anywhere on the page.
    expect(code).not.toContain("${counts[");
  });

  it("the timeline hour-bucket count is formatted too", () => {
    const code = blankComments(read("src/app/timeline/page.tsx"));
    const labelLines = code.split("\n").filter((line) => line.includes("rows.length") && line.includes("küme"));
    expect(labelLines).toHaveLength(1);
    expect(labelLines[0]).toContain("formatCountTr(");
  });
});
