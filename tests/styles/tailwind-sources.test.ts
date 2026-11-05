import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { describe, expect, it } from "vitest";

// h34-perf-2. Tailwind 4 detects sources automatically: every non-ignored file
// under the project root is scanned for class-name candidates. Test files and
// fixtures therefore leaked rules into the public, render-blocking stylesheet
// (an invalid `.h-\[Npx\]{height:Npx}` from a doc comment, `.w-12345` from a
// copy-register test, ...: about 12 kB raw of rules no page uses). src/app/
// globals.css now opts them out with `@source not`. Paths in a `@source`
// directive are relative to the CSS file that holds it.
//
// Only sources that never reach a browser may be dropped here: tests, test
// files and fixtures. Admin pages render in production and stay in the sheet;
// scripts/ stays too (src/lib/admin/content-twins.ts imports from it).
//
// CodeQL: literal includes and character scans only; no regular expression runs
// over file content.

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..");
const GLOBALS_PATH = join(ROOT, "src", "app", "globals.css");
const GLOBALS_DIR = dirname(GLOBALS_PATH);
const GLOBALS_CSS = readFileSync(GLOBALS_PATH, "utf8");

const IMPORT_LINE = '@import "tailwindcss";';
const NOT_PREFIX = '@source not "';

/** Every `@source not "<pattern>";` line of the sheet, in order, with its offset. */
function sourceNotEntries(css: string): { pattern: string; offset: number }[] {
  const out: { pattern: string; offset: number }[] = [];
  let offset = 0;
  for (const line of css.split("\n")) {
    if (line.startsWith(NOT_PREFIX)) {
      const end = line.indexOf('"', NOT_PREFIX.length);
      expect(end, `unterminated @source not line: ${line}`).toBeGreaterThan(NOT_PREFIX.length);
      expect(line.slice(end), `trailing text on: ${line}`).toBe('";');
      out.push({ pattern: line.slice(NOT_PREFIX.length, end), offset });
    }
    offset += line.length + 1;
  }
  return out;
}

/** The directory part of a pattern, up to its first wildcard / brace character. */
function staticDir(pattern: string): string {
  let cut = pattern.length;
  for (const ch of ["*", "?", "[", "{"]) {
    const at = pattern.indexOf(ch);
    if (at !== -1 && at < cut) cut = at;
  }
  const head = pattern.slice(0, cut);
  if (head.length === pattern.length) return head; // no wildcard: the pattern is the directory
  return head.slice(0, head.lastIndexOf("/") + 1);
}

function hasWildcard(pattern: string): boolean {
  return ["*", "?", "[", "{"].some((ch) => pattern.includes(ch));
}

function lastSegment(pattern: string): string {
  return pattern.slice(pattern.lastIndexOf("/") + 1);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** The exclusions the sheet must carry. */
const REQUIRED = ["../../tests", "../**/*.test.ts", "../**/*.test.tsx", "../**/__fixtures__"] as const;
/** The only wildcard tails an exclusion may have: test files and fixtures directories. */
const SAFE_GLOB_TAILS: readonly string[] = ["*.test.ts", "*.test.tsx", "__fixtures__"];

describe("globals.css @source not entries (h34-perf-2)", () => {
  const entries = sourceNotEntries(GLOBALS_CSS);
  const patterns = entries.map((e) => e.pattern);

  it("carries every required exclusion", () => {
    for (const required of REQUIRED) {
      expect(patterns, `missing @source not "${required}";`).toContain(required);
    }
  });

  it("lists each pattern once", () => {
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it("puts them after the tailwindcss import and before the first rule", () => {
    expect(GLOBALS_CSS.startsWith(IMPORT_LINE), `${IMPORT_LINE} is the first line`).toBe(true);
    const firstRule = GLOBALS_CSS.indexOf("@custom-variant");
    expect(firstRule).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.offset, e.pattern).toBeGreaterThan(0);
      expect(e.offset, e.pattern).toBeLessThan(firstRule);
    }
  });

  it("points every pattern at a real directory inside the repository", () => {
    for (const pattern of patterns) {
      const dir = resolve(GLOBALS_DIR, staticDir(pattern));
      expect(existsSync(dir), `${pattern} -> ${dir}`).toBe(true);
      expect(statSync(dir).isDirectory(), `${pattern} -> ${dir}`).toBe(true);
      expect(relative(ROOT, dir).startsWith(".."), `${pattern} escapes the repository`).toBe(false);
    }
  });

  it("drops only tests, test files and fixtures: no production source is excluded", () => {
    for (const pattern of patterns) {
      if (hasWildcard(pattern)) {
        // A glob is confined to src/ and ends in a test-file or fixtures name.
        expect(resolve(GLOBALS_DIR, staticDir(pattern)), `${pattern}: glob root`).toBe(join(ROOT, "src"));
        expect(SAFE_GLOB_TAILS, `${pattern}: tail ${lastSegment(pattern)}`).toContain(lastSegment(pattern));
      } else {
        // A bare path is exactly the top-level tests directory, nothing else.
        expect(resolve(GLOBALS_DIR, pattern), pattern).toBe(join(ROOT, "tests"));
      }
    }
  });

  it("the test-file globs match real files (the exclusions are not dead)", () => {
    const srcFiles = walk(join(ROOT, "src"));
    for (const ext of [".test.ts", ".test.tsx"]) {
      expect(
        srcFiles.some((f) => f.endsWith(ext)),
        `no src/**/*${ext} file: that exclusion would be dead`,
      ).toBe(true);
    }
    expect(walk(join(ROOT, "tests")).some((f) => f.endsWith(".test.ts"))).toBe(true);
  });
});

describe("the compiled public stylesheet (h34-perf-2)", () => {
  // Needles are assembled, not written out, so this file never is itself the
  // reason a class shows up in the sheet (it is excluded anyway: assembling them
  // just keeps a failure here pointing at globals.css and nothing else).
  const COPY_REGISTER_WIDTH = [".w", "12345"].join("-");
  const INVALID_HEIGHT_SELECTOR = [".h-", "\\[", "N", "px\\]"].join("");

  async function compile(css: string): Promise<string> {
    const result = await postcss([tailwindcss({ base: ROOT })]).process(css, { from: GLOBALS_PATH });
    return result.css;
  }

  /** CSS class-selector escaping, the way Tailwind writes a candidate into a selector. */
  function escapeClass(token: string): string {
    let out = "";
    for (const ch of token) {
      const plain =
        (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === "-";
      out += plain ? ch : `\\${ch}`;
    }
    return out;
  }

  /** True when the class `klass` has a selector in `css` (not just as the prefix of a longer class). */
  function hasClassSelector(css: string, klass: string): boolean {
    const needle = `.${escapeClass(klass)}`;
    let from = 0;
    for (;;) {
      const at = css.indexOf(needle, from);
      if (at === -1) return false;
      const next = css[at + needle.length] ?? " ";
      const continues =
        (next >= "a" && next <= "z") ||
        (next >= "A" && next <= "Z") ||
        (next >= "0" && next <= "9") ||
        next === "-" ||
        next === "_" ||
        next === "\\";
      if (!continues) return true;
      from = at + needle.length;
    }
  }

  /** Whitespace / quote separated words of a source text: every class-name candidate, and more. */
  function words(text: string): Set<string> {
    const out = new Set<string>();
    let cur = "";
    for (const ch of text) {
      if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r" || ch === '"' || ch === "'" || ch === "`") {
        if (cur.length >= 3) out.add(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    if (cur.length >= 3) out.add(cur);
    return out;
  }

  it("emits no rule that only a test or fixture mentions", async () => {
    const out = await compile(GLOBALS_CSS);
    // `.w-12345` (copy-register test) and `.h-\[Npx\]{height:Npx}` (doc comment
    // in the anchor-offset test) are the two the audit found in the live sheet.
    expect(out.includes(COPY_REGISTER_WIDTH), "a test-only width utility is in the sheet").toBe(false);
    expect(out.includes(INVALID_HEIGHT_SELECTOR), "the invalid arbitrary-height selector is in the sheet").toBe(false);
    expect(out.includes("height: Npx"), "an invalid height declaration is in the sheet").toBe(false);
    expect(out.includes("height:Npx")).toBe(false);
  }, 60_000);

  it("still emits the utilities production code uses", async () => {
    const out = await compile(GLOBALS_CSS);
    // Controls: the header is `sticky top-0`, the shell is flex. A glob that
    // swallowed src would drop these.
    for (const klass of ["sticky", "flex", "hidden", "rounded-md"]) {
      expect(hasClassSelector(out, klass), `.${klass} vanished from the sheet`).toBe(true);
    }
  }, 60_000);

  it("still emits a utility only the admin pages use (admin renders in production)", async () => {
    const out = await compile(GLOBALS_CSS);
    const prodFiles = walk(join(ROOT, "src")).filter(
      (f) => (f.endsWith(".tsx") || f.endsWith(".ts")) && !f.endsWith(".test.tsx") && !f.endsWith(".test.ts"),
    );
    const adminRoot = join(ROOT, "src", "app", "admin") + sep;
    const adminWords = new Set<string>();
    const otherWords = new Set<string>();
    for (const file of prodFiles) {
      const bucket = file.startsWith(adminRoot) ? adminWords : otherWords;
      for (const w of words(readFileSync(file, "utf8"))) bucket.add(w);
    }
    expect(adminWords.size, "no admin sources found").toBeGreaterThan(0);
    // A word that only src/app/admin contains and that Tailwind turned into a
    // rule is an admin-only utility (max-w-[1400px], sm:py-8, ...). Dropping the
    // admin tree from the scan would lose every one of them.
    const adminOnly = [...adminWords].filter((w) => !otherWords.has(w));
    const surviving = adminOnly.filter((w) => hasClassSelector(out, w));
    expect(surviving.length, `no admin-only utility in the sheet (${adminOnly.length} admin-only words)`).toBeGreaterThan(0);
  }, 60_000);
});
