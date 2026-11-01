import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (ekonomi-coverage, extended by hunt 13): PostgREST
// truncates EVERY response at its `max_rows` (1,000 on Supabase) whatever
// `.limit(N)` asks for. A `.limit(2000)` therefore reads as "the first 2,000
// rows" but silently returns 1,000; /ekonomi/[ticker] computed "KAP ile basın
// arası" over the first 1,000 of 1,845 coverage rows that way and reported 10
// of 18 disclosures as covered, and /hafta summed only the 1,000 largest of a
// week's 1,991 clusters (about 21% of the votes missing) with a truncation
// caveat that could never fire. Anything that needs more than 1,000 rows must
// page with `.range()` (see readAllPages in src/lib/db/paging.ts).
//
// The guard scans the non-test .ts/.tsx source files of the read layers that
// have been bitten or are exposed: src/lib/finance (flat, as before),
// src/lib/weekly, src/lib/trends and src/app/api/cron (recursive). It fails on
// `.limit(N)` where N is
//   - a numeric literal greater than 1000, or
//   - an identifier whose same-file `const IDENT = <number>` is greater than
//     1000 (an identifier imported from another file or a member expression
//     such as `opts.limit` cannot be resolved here and is not checked).
// A deliberate exception carries `postgrest-cap-ok: <reason>` in a comment on
// that line or the line directly above it; a marker without a reason does not
// count.
// ---------------------------------------------------------------------------

const POSTGREST_MAX_ROWS = 1000;
const MARKER = /postgrest-cap-ok:\s*\S/;

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");

/** Scanned read layers. Finance stays flat (its tests and helpers live beside the code). */
const SCAN_DIRS: ReadonlyArray<{ dir: string; recursive: boolean }> = [
  { dir: "src/lib/finance", recursive: false },
  { dir: "src/lib/weekly", recursive: true },
  { dir: "src/lib/trends", recursive: true },
  { dir: "src/app/api/cron", recursive: true },
];

/** Blanks // and block comments, keeping offsets (and newlines) intact. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

function toNumber(raw: string): number {
  return Number(raw.replace(/_/g, ""));
}

/** `const NAME = <number>` declarations (largest value wins when a name repeats). */
function numericConsts(code: string): Map<string, number> {
  const out = new Map<string, number>();
  const re = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*(\d[\d_]*)\s*;?\s*$/gm;
  for (const m of code.matchAll(re)) {
    const value = toNumber(m[2]!);
    out.set(m[1]!, Math.max(out.get(m[1]!) ?? 0, value));
  }
  return out;
}

/** One message per `.limit(N)` over the PostgREST cap that carries no marker. */
function findViolations(src: string, file = "fixture.ts"): string[] {
  const code = blankComments(src);
  const rawLines = src.split("\n");
  const codeLines = code.split("\n");
  const consts = numericConsts(code);
  const violations: string[] = [];

  codeLines.forEach((line, i) => {
    for (const m of line.matchAll(/\.limit\(\s*([^()]*?)\s*\)/g)) {
      const arg = m[1]!;
      let value: number | null = null;
      if (/^\d[\d_]*$/.test(arg)) value = toNumber(arg);
      else if (/^[A-Za-z_$][\w$]*$/.test(arg)) value = consts.get(arg) ?? null;
      if (value === null || value <= POSTGREST_MAX_ROWS) continue;
      const marked = MARKER.test(rawLines[i] ?? "") || MARKER.test(rawLines[i - 1] ?? "");
      if (marked) continue;
      violations.push(
        `${file}:${i + 1}: .limit(${arg}) asks for ${value} rows but PostgREST returns at most ${POSTGREST_MAX_ROWS}; ` +
          "page with readAllPages()/.range(), or add `// postgrest-cap-ok: <reason>` above it",
      );
    }
  });
  return violations;
}

/** Non-test .ts/.tsx files under `dir` (absolute paths), descending into folders when asked. */
function sourcesIn(dir: string, recursive: boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return recursive ? sourcesIn(full, true) : [];
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
  });
}

/** Every scanned source file, as a repo-relative path. */
function scannedSources(): string[] {
  return SCAN_DIRS.flatMap(({ dir, recursive }) => sourcesIn(resolve(ROOT, dir), recursive))
    .map((file) => relative(ROOT, file))
    .sort();
}

describe("postgrest row cap: no .limit(N) above 1,000 in the scanned read layers", () => {
  it("scans the finance read layer (the guard is not vacuous)", () => {
    expect(scannedSources()).toEqual(
      expect.arrayContaining([
        "src/lib/finance/queries.ts",
        "src/lib/finance/ticker-relevance.ts",
        "src/lib/finance/kap-pickup-query.ts",
        "src/lib/finance/paging.ts",
      ]),
    );
  });

  it("scans the weekly, trends and cron read layers, including nested route folders", () => {
    expect(scannedSources()).toEqual(
      expect.arrayContaining([
        "src/lib/weekly/weekly-query.ts",
        "src/lib/weekly/week-archive.ts",
        "src/lib/trends/rising-query.ts",
        "src/app/api/cron/digest/route.ts",
      ]),
    );
  });

  it("skips test files and non-source files", () => {
    for (const name of scannedSources()) {
      expect(name).toMatch(/\.tsx?$/);
      expect(name).not.toMatch(/\.test\./);
    }
  });

  it("has no unmarked .limit(N) over the PostgREST max_rows", () => {
    const violations = scannedSources().flatMap((file) =>
      findViolations(readFileSync(resolve(ROOT, file), "utf8"), file),
    );
    expect(violations).toEqual([]);
  });
});

describe("postgrest row cap: the detector itself", () => {
  it("flags a numeric literal above 1000", () => {
    expect(findViolations("const q = s.from('t').limit(2000);")).toHaveLength(1);
    expect(findViolations("q.limit(1001)")).toHaveLength(1);
  });

  it("accepts 1000 and anything below", () => {
    expect(findViolations("q.limit(1000);\nq.limit(60);\nq.limit(1);")).toEqual([]);
  });

  it("sees through numeric separators and whitespace", () => {
    expect(findViolations("q.limit( 5_000 )")).toHaveLength(1);
    expect(findViolations("q.limit( 1_000 )")).toEqual([]);
  });

  it("flags an identifier whose same-file const is above 1000", () => {
    expect(findViolations("const MENTION_LIMIT = 5000;\nq.limit(MENTION_LIMIT);")).toHaveLength(1);
    expect(findViolations("export const MAX: number = 5000;\nq.limit(MAX);")).toHaveLength(1);
  });

  it("accepts an identifier whose const is at or below 1000", () => {
    expect(findViolations("const PAGE = 1000;\nq.limit(PAGE);")).toEqual([]);
  });

  it("cannot resolve imported identifiers or member expressions, and does not guess", () => {
    expect(findViolations("q.limit(LEGAL_NOTICE_LOOKUP_LIMIT);\nq.limit(opts.limit);\nq.limit(Math.ceil(n * 1.25));")).toEqual([]);
  });

  it("accepts a marker with a reason on the same line", () => {
    expect(findViolations("q.limit(5000); // postgrest-cap-ok: clamped, documented")).toEqual([]);
  });

  it("accepts a marker with a reason on the line above", () => {
    const src = [
      "const q = s",
      "  .from('t')",
      "  // postgrest-cap-ok: continues with .range() below",
      "  .limit(5000);",
    ].join("\n");
    expect(findViolations(src)).toEqual([]);
  });

  it("rejects a marker without a reason", () => {
    expect(findViolations("// postgrest-cap-ok:\nq.limit(5000);")).toHaveLength(1);
    expect(findViolations("// postgrest-cap-ok:   \nq.limit(5000);")).toHaveLength(1);
  });

  it("rejects a marker two lines above (it must be adjacent)", () => {
    expect(findViolations("// postgrest-cap-ok: far away\n\nq.limit(5000);")).toHaveLength(1);
  });

  it("ignores .limit(N) that only appears in comments", () => {
    const src = ["// q.limit(5000) would be clamped", "/* and q.limit(9000)", "   too */", "q.limit(10);"].join("\n");
    expect(findViolations(src)).toEqual([]);
  });

  it("reports the file and 1-based line of each offender", () => {
    const [v] = findViolations("a();\nb();\nq.limit(2000);", "src/lib/finance/x.ts");
    expect(v).toMatch(/^src\/lib\/finance\/x\.ts:3: /);
  });

  it("reports every offender, not just the first", () => {
    expect(findViolations("q.limit(2000);\nq.limit(3000);\nq.limit(10);")).toHaveLength(2);
  });
});
