import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Ratchet: no NEW wall-clock budget in a test.
//
// A test of the form
//
//     const t0 = performance.now();
//     work();
//     expect(performance.now() - t0).toBeLessThan(100);
//
// fails whenever the machine is busy (the scheduler preempts the process
// mid-call, so elapsed time inflates 3x or more; 26 distinct failures were seen
// in 4 concurrent full runs), and passes a mild regression on an idle one. The
// fix is tests/_helpers/linear-time.ts: expectLinear (CPU time over a size
// ladder, so the guard measures how the cost GROWS) or expectCpuUnder (a CPU
// ceiling for a fixed input).
//
// This guard counts the "sites" in every *.test.{ts,tsx,mjs,js} under src,
// scripts and tests: an assertion line holding toBeLessThan / toBeLessThanOrEqual
// with performance.now() or Date.now() on that line or within the 3 lines before
// it. Timings that come back from a helper are counted too, so a local
// `timed(fn) -> { ms }` does not hide a budget: a site is also an assertion whose
// expect( argument calls a clock helper (a function declared with a clock read in
// its first lines), or starts with a name bound within the 8 lines before by
// `const|let name =` / `const { a, b } =` to a clock read or a helper call.
// The scan is a heuristic: a name destructured from a helper call counts even when
// it is not the timing (`const { row, ms } = timed(...)` then `expect(row.x)` below),
// which can only loosen BASELINE, never let a real budget through.
// The per-file counts are compared with BASELINE below, today's counts:
//
//   - a file whose count RISES, or a file that is not in BASELINE, fails;
//   - a file whose count FALLS passes, so the remaining sites can be converted
//     one file at a time (then lower or delete the file's BASELINE entry).
//
// Not counted: tests/_helpers/ (the helper itself and its tests), this file, and
// the timestamp-tolerance lines in TIMESTAMP_TOLERANCE. Those compare a stored
// or computed timestamp with "now" (a freshness stamp written by the code under
// test), they do not time a call, so load does not move them.
// ---------------------------------------------------------------------------

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCAN_DIRS = ["src", "scripts", "tests"];
const TEST_FILE = /\.test\.(?:ts|tsx|mjs|js)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);
const EXCLUDED = ["tests/_helpers/", "tests/guards/no-wall-clock-budget.test.ts"];
const CLOCK = /\b(?:performance|Date)\.now\(\)/;
const BUDGET_ASSERT = /\.toBeLessThan(?:OrEqual)?\(/;
const WINDOW = 3;
/** A function is a clock helper when its own line or one of the next HELPER_SCAN lines reads the clock. */
const HELPER_SCAN = 6;
/** An identifier counts as a timing when it is bound this many lines before the assertion, at most. */
const BINDING_WINDOW = 8;
const FUNCTION_DECL = /\bfunction\s+(\w+)\s*[<(]/;
const ARROW_DECL = /\b(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:<[^>]*>\s*)?\(/;

/**
 * Timestamp-tolerance assertions, by the exact trimmed text of the line. They are matched by text, not
 * by line number, so editing elsewhere in the file does not move them. Every entry must still occur in
 * its file (see the last test), so the list cannot go stale.
 */
const TIMESTAMP_TOLERANCE: Readonly<Record<string, readonly string[]>> = {
  "tests/pwa/sw-worker.test.ts": ['expect(Date.now() - Date.parse(h?.get(HEADER_CACHED_AT) ?? "")).toBeLessThan(5000);'],
  "tests/api/cron-alerts-webhooks.test.ts": [
    "expect(Math.abs(Date.parse(call.sinceIso) - (Date.now() - 24 * H))).toBeLessThan(60_000);",
    "expect(Math.abs(ts - Date.now() / 1000)).toBeLessThan(120);",
  ],
  "tests/api/v1-alerts-blindspots.test.ts": ["expect(Math.abs(cutoff - (Date.now() - 6 * H))).toBeLessThan(60_000);"],
  "tests/api/sources-cache-key.test.ts": ["expect(generated).toBeLessThanOrEqual(Date.now() + 1000);"],
  "tests/functions/cluster-consumer.test.ts": [
    "expect(Math.abs(Date.now() - 12 * 3_600_000 - horizon)).toBeLessThan(60_000);",
    "expect(Math.abs(Date.parse(args.p_since) - (Date.now() - 24 * H))).toBeLessThan(5 * 60_000);",
  ],
  "tests/functions/image-consumer.test.ts": ["expect(parkedAt).toBeLessThanOrEqual(Date.now() + week + 1000);"],
  "tests/functions/kap-ingest.test.ts": ["expect(blockedAt).toBeLessThanOrEqual(Date.now() + KAP_BREAKER_BLOCK_MS + 2000);"],
};

/**
 * Today's per-file site counts (after the timestamp-tolerance lines are set aside). Only ever lower these:
 * convert a file with expectLinear / expectCpuUnder, then lower or delete its entry.
 */
const BASELINE: Readonly<Record<string, number>> = {
  "scripts/lib/ops-heartbeat.test.mjs": 1,
  "src/components/bookmark/saved-list.test.ts": 1,
  "src/components/route-title-announcer.test.tsx": 1,
  "src/lib/articles/description-boilerplate.test.ts": 3,
  "src/lib/articles/opinion-url.test.ts": 1,
  "src/lib/articles/outbound-url.test.ts": 1,
  "src/lib/articles/source-excerpt.test.ts": 1,
  "src/lib/articles/summary-tidy.test.ts": 16,
  "src/lib/clusters/in-feed-match.test.ts": 1,
  "src/lib/clusters/neutral-title.test.ts": 10,
  "src/lib/clusters/summary-agreement.test.ts": 6,
  "src/lib/clusters/summary-attribution.test.ts": 5,
  "src/lib/clusters/turkish-query.test.ts": 7,
  "src/lib/entities/entity-hub.test.ts": 1,
  "src/lib/fact-checks/normalize.test.ts": 1,
  "src/lib/seo/og-title.test.ts": 2,
  "src/lib/sources/active-count.test.ts": 1,
  "src/lib/sources/feed-status.test.ts": 1,
  "src/lib/supabase/reader-no-retry.test.ts": 1,
  "src/lib/supabase/server.test.ts": 2,
  "src/lib/text/fightin-words.test.ts": 1,
  "src/lib/weekly/week-archive.test.ts": 1,
  "src/lib/weekly/weekly-query.test.ts": 1,
  "tests/api/v1-kap-pickup.test.ts": 1,
  "tests/functions/_shared/article-key.test.ts": 3,
  "tests/functions/_shared/auth.test.ts": 5,
  "tests/functions/_shared/contentless-title.test.ts": 1,
  "tests/functions/_shared/description-clean.test.ts": 1,
  "tests/functions/_shared/ensemble-precision.test.ts": 1,
  "tests/functions/_shared/feed-freshness.test.ts": 1,
  "tests/functions/_shared/fetcher-doctype.test.ts": 5,
  "tests/functions/_shared/fetcher-refusal.test.ts": 3,
  "tests/functions/_shared/image-url.test.ts": 3,
  "tests/functions/_shared/normalize.test.ts": 9,
  "tests/functions/_shared/og-image-stop-probe.test.ts": 3,
  "tests/functions/_shared/og-image.test.ts": 6,
  "tests/functions/_shared/residual-entities.test.ts": 4,
  "tests/functions/_shared/roundup-title.test.ts": 2,
  "tests/functions/_shared/strip-tags.test.ts": 3,
  "tests/functions/_shared/title-jaccard.test.ts": 1,
  "tests/functions/_shared/twin-merge.test.ts": 1,
  "tests/functions/cluster-consumer.test.ts": 2,
  "tests/functions/image-consumer.test.ts": 1,
  "tests/functions/ingest.test.ts": 3,
};

const isComment = (line: string): boolean => /^\s*(?:\/\/|\/\*|\*)/.test(line);

/** Names of the functions that read the clock in their first lines: `timed`, `measure`, ... */
function clockHelpers(lines: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (isComment(lines[i]!)) continue;
    const decl = FUNCTION_DECL.exec(lines[i]!) ?? ARROW_DECL.exec(lines[i]!);
    if (!decl) continue;
    for (let j = i; j <= Math.min(lines.length - 1, i + HELPER_SCAN); j++) {
      if (!isComment(lines[j]!) && CLOCK.test(lines[j]!)) {
        names.add(decl[1]!);
        break;
      }
    }
  }
  return names;
}

/** The text of the expect( argument of the assertion on line i: from the nearest expect( at or above it. */
function expectArgument(lines: readonly string[], i: number, assertAt: number): string | null {
  for (let j = i; j >= Math.max(0, i - BINDING_WINDOW); j--) {
    const head = j === i ? lines[i]!.slice(0, assertAt) : lines[j]!;
    const at = head.lastIndexOf("expect(");
    if (at < 0) continue;
    const middle = j === i ? [] : [...lines.slice(j + 1, i), lines[i]!.slice(0, assertAt)];
    return [head.slice(at + "expect(".length), ...middle].join("\n");
  }
  return null;
}

/** Sites in one source: assertion lines with a clock read on the line or within the WINDOW lines before, or with a timing from a helper. */
function countSites(source: string, allowedLines: ReadonlySet<string> = new Set()): number {
  const lines = source.split("\n");
  const helpers = clockHelpers(lines);
  const helperCalls = [...helpers].map((name) => new RegExp(`\\b${name}\\(`));
  const readsTiming = (text: string): boolean => CLOCK.test(text) || helperCalls.some((call) => call.test(text));

  /** Is `name` bound to a clock read or a helper call by a const/let within the BINDING_WINDOW lines before line i? */
  const boundToTiming = (name: string, i: number): boolean => {
    const single = new RegExp(`\\b(?:const|let)\\s+${name}\\s*(?::[^=]+)?=(.*)$`);
    const destructured = new RegExp(`\\b(?:const|let)\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=(.*)$`);
    for (let j = Math.max(0, i - BINDING_WINDOW); j < i; j++) {
      if (isComment(lines[j]!)) continue;
      const bound = single.exec(lines[j]!) ?? destructured.exec(lines[j]!);
      if (bound && readsTiming(bound[1]!)) return true;
    }
    return false;
  };

  let sites = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isComment(line)) continue;
    const assertion = BUDGET_ASSERT.exec(line);
    if (!assertion) continue;
    if (allowedLines.has(line.trim())) continue;
    let counted = false;
    for (let j = Math.max(0, i - WINDOW); j <= i && !counted; j++) {
      const candidate = lines[j]!;
      counted = !isComment(candidate) && CLOCK.test(candidate);
    }
    if (!counted) {
      const arg = expectArgument(lines, i, assertion.index);
      if (arg !== null) {
        const first = /^\s*([A-Za-z_]\w*)/.exec(arg);
        counted = helperCalls.some((call) => call.test(arg)) || (first !== null && boundToTiming(first[1]!, i));
      }
    }
    if (counted) sites++;
  }
  return sites;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (TEST_FILE.test(name)) out.push(p);
  }
  return out;
}

const rel = (p: string): string => relative(ROOT, p).split(sep).join("/");

function scanRepo(): { counts: Record<string, number>; scanned: number } {
  const counts: Record<string, number> = {};
  let scanned = 0;
  for (const dir of SCAN_DIRS) {
    const base = join(ROOT, dir);
    if (!existsSync(base)) continue;
    for (const file of walk(base)) {
      const name = rel(file);
      if (EXCLUDED.some((prefix) => name.startsWith(prefix))) continue;
      scanned++;
      const n = countSites(readFileSync(file, "utf8"), new Set(TIMESTAMP_TOLERANCE[name] ?? []));
      if (n > 0) counts[name] = n;
    }
  }
  return { counts, scanned };
}

// ---------------------------------------------------------------------------
// The scanner, on synthetic sources. The sources are assembled from pieces so
// that this file never holds a clock read next to an assertion itself.
// ---------------------------------------------------------------------------

const PERF = ["performance", "now()"].join(".");
const DATE = ["Date", "now()"].join(".");
const LESS = ["", "toBeLessThan"].join(".");
const LESS_EQ = ["", "toBeLessThanOrEqual"].join(".");

describe("countSites (the scanner)", () => {
  it("counts a budget assertion with the clock read on the same line", () => {
    expect(countSites(`expect(${PERF} - t0)${LESS}(100);`)).toBe(1);
    expect(countSites(`expect(${DATE} - t0)${LESS}(100);`)).toBe(1);
  });

  it("counts a budget assertion with the clock read within the 3 lines before it", () => {
    const src = [`const t0 = ${PERF};`, "work();", "more();", `expect(elapsed)${LESS}(100);`].join("\n");
    expect(countSites(src)).toBe(1);
  });

  it("does not count a clock read 4 or more lines before the assertion", () => {
    const src = [`const t0 = ${PERF};`, "a();", "b();", "c();", `expect(elapsed)${LESS}(100);`].join("\n");
    expect(countSites(src)).toBe(0);
  });

  it("does not count a clock read that comes after the assertion", () => {
    const src = [`expect(elapsed)${LESS}(100);`, `const t0 = ${PERF};`].join("\n");
    expect(countSites(src)).toBe(0);
  });

  it("counts toBeLessThanOrEqual too", () => {
    expect(countSites(`expect(${DATE} - t0)${LESS_EQ}(100);`)).toBe(1);
  });

  it("counts each assertion line once, however many clock reads precede it", () => {
    const src = [`const a = ${PERF};`, `const b = ${PERF};`, `expect(b - a)${LESS}(5);`].join("\n");
    expect(countSites(src)).toBe(1);
  });

  it("counts two assertions fed by one clock read as two sites", () => {
    const src = [`const t0 = ${PERF};`, `expect(x)${LESS}(1);`, `expect(y)${LESS}(2);`].join("\n");
    expect(countSites(src)).toBe(2);
  });

  it("ignores an assertion with no clock read near it", () => {
    expect(countSites(`expect(items.length)${LESS}(100);`)).toBe(0);
    expect(countSites(`expect(${PERF} > 0).toBe(true);`)).toBe(0);
  });

  it("ignores a clock read that only appears in a comment", () => {
    const src = [`// the old test timed this with ${PERF}`, `expect(n)${LESS}(100);`].join("\n");
    expect(countSites(src)).toBe(0);
    expect(countSites([`/* ${DATE} */`, `expect(n)${LESS}(100);`].join("\n"))).toBe(0);
    expect(countSites([` * ${DATE}`, `expect(n)${LESS}(100);`].join("\n"))).toBe(0);
  });

  it("sets aside an allowlisted line by its exact text, wherever it sits", () => {
    const line = `expect(${DATE} - Date.parse(stamp))${LESS}(5000);`;
    const src = ["before();", `const x = ${DATE};`, `  ${line}  `, "after();", `expect(${PERF} - t0)${LESS}(1);`].join("\n");
    expect(countSites(src)).toBe(2);
    expect(countSites(src, new Set([line]))).toBe(1);
  });

  it("does not treat a near-identical line as allowlisted", () => {
    const line = `expect(${DATE} - Date.parse(stamp))${LESS}(5000);`;
    const looser = `expect(${DATE} - Date.parse(stamp))${LESS}(50000);`;
    expect(countSites(looser, new Set([line]))).toBe(1);
  });
});

// A local helper that returns the elapsed time moves the clock read away from the assertion
// (a timed() { ms } defined once, called and asserted far below), so the scanner resolves it.
describe("countSites resolves clock helpers and clock-bound identifiers", () => {
  const FILLER = (n: number): string[] => Array.from({ length: n }, (_, i) => `filler${i}();`);
  /** function timed(fn) { const t0 = PERF; fn(); return { ms: PERF - t0 }; } over several lines. */
  const TIMED = ["function timed(fn) {", `  const t0 = ${PERF};`, "  fn();", `  return { ms: ${PERF} - t0 };`, "}"];

  it("counts an assertion on a destructured result of a timed() helper defined far above", () => {
    const src = [...TIMED, ...FILLER(20), "const { ms } = timed(() => f());", `expect(ms)${LESS}(50);`].join("\n");
    expect(countSites(src)).toBe(1);
  });

  it("counts an assertion whose argument calls the helper", () => {
    const src = [...TIMED, ...FILLER(20), `expect(timed(() => f()))${LESS}(50);`].join("\n");
    expect(countSites(src)).toBe(1);
    expect(countSites([...TIMED, ...FILLER(20), `expect(timed(() => f()).ms)${LESS_EQ}(50);`].join("\n"))).toBe(1);
  });

  it("counts an assertion on a property of a helper result", () => {
    const src = [...TIMED, ...FILLER(20), "const og = timed(() => render());", `expect(og.ms)${LESS}(5);`].join("\n");
    expect(countSites(src)).toBe(1);
  });

  it("counts an elapsed value bound from a clock read more than 3 lines above the assertion", () => {
    const src = [
      `const start = ${PERF};`,
      ...FILLER(3),
      `const ms = ${PERF} - start;`,
      ...FILLER(3),
      `expect(ms)${LESS}(500);`,
    ].join("\n");
    expect(countSites(src)).toBe(1);
  });

  it("does not count an unrelated assertion next to a timed() call", () => {
    const src = [...TIMED, ...FILLER(20), "const r = timed(() => f());", `expect(header.length)${LESS}(10);`].join("\n");
    expect(countSites(src)).toBe(0);
  });

  it("does not count an identifier bound more than 8 lines above the assertion", () => {
    const src = [`const ms = ${PERF} - start;`, ...FILLER(8), `expect(ms)${LESS}(500);`].join("\n");
    expect(countSites(src)).toBe(0);
    expect(countSites([`const ms = ${PERF} - start;`, ...FILLER(7), `expect(ms)${LESS}(500);`].join("\n"))).toBe(1);
  });

  it("does not count an identifier bound to something that is not a clock", () => {
    const src = ["const ms = items.length;", `expect(ms)${LESS}(500);`].join("\n");
    expect(countSites(src)).toBe(0);
  });

  it("does not treat a function that reads no clock as a clock helper", () => {
    const src = ["function timed(fn) {", "  return { ms: fn() };", "}", ...FILLER(20), "const { ms } = timed(() => f());", `expect(ms)${LESS}(50);`].join("\n");
    expect(countSites(src)).toBe(0);
  });

  it("finds a helper declared as an arrow function, with generics and async", () => {
    const arrow = ["const timed = <T,>(fn: () => T) => {", `  const t0 = ${PERF};`, "  const value = fn();", `  return { value, ms: ${PERF} - t0 };`, "};"];
    expect(countSites([...arrow, ...FILLER(20), "const { ms } = timed(() => f());", `expect(ms)${LESS}(50);`].join("\n"))).toBe(1);
    const asyncArrow = ["const timedAsync = async (fn) => {", `  const t0 = ${DATE};`, "  await fn();", `  return ${DATE} - t0;`, "};"];
    expect(countSites([...asyncArrow, ...FILLER(20), "const took = await timedAsync(f);", `expect(took)${LESS}(50);`].join("\n"))).toBe(1);
  });

  it("finds a helper whose clock read is a few lines below its declaration, not one far below", () => {
    const near = ["function timed(fn) {", "  fn();", "  fn();", "  fn();", "  fn();", `  return ${PERF};`, "}"];
    expect(countSites([...near, ...FILLER(20), "const ms = timed(f);", `expect(ms)${LESS}(50);`].join("\n"))).toBe(1);
    const far = ["function timed(fn) {", ...Array(6).fill("  fn();"), `  return ${PERF};`, "}"];
    expect(countSites([...far, ...FILLER(20), "const ms = timed(f);", `expect(ms)${LESS}(50);`].join("\n"))).toBe(0);
  });

  it("reads an expect( argument that spans several lines", () => {
    const src = [...TIMED, ...FILLER(20), "expect(", "  timed(() => f()).ms,", `)${LESS}(50);`].join("\n");
    expect(countSites(src)).toBe(1);
  });

  it("ignores a helper or a binding that only appears in a comment", () => {
    const src = [...TIMED.map((l) => `// ${l}`), ...FILLER(20), "// const { ms } = timed(() => f());", `expect(ms)${LESS}(50);`].join("\n");
    expect(countSites(src)).toBe(0);
  });

  it("keeps the allowlist working for helper-resolved lines", () => {
    const line = `expect(ms)${LESS}(50);`;
    const src = [...TIMED, ...FILLER(20), "const { ms } = timed(() => f());", line].join("\n");
    expect(countSites(src, new Set([line]))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The ratchet on the real repository.
// ---------------------------------------------------------------------------

describe("no new wall-clock budget in a test", () => {
  const { counts, scanned } = scanRepo();

  it("no file has more wall-clock budget sites than BASELINE allows, and no new file has one", () => {
    const problems: string[] = [];
    for (const [file, n] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) {
      const allowed = BASELINE[file];
      if (allowed === undefined) problems.push(`${file}: ${n} site(s), a file that is not in BASELINE`);
      else if (n > allowed) problems.push(`${file}: ${n} site(s), BASELINE allows ${allowed}`);
    }
    expect(
      problems,
      [
        "A wall-clock budget (performance.now() / Date.now() next to toBeLessThan) fails whenever the machine is busy.",
        "Time the work with expectLinear (CPU time over a size ladder) or expectCpuUnder from tests/_helpers/linear-time.ts instead.",
        "If a line only compares a timestamp with 'now', add it to TIMESTAMP_TOLERANCE.",
      ].join("\n"),
    ).toEqual([]);
  });

  it("every BASELINE entry is a file that still exists", () => {
    const missing = Object.keys(BASELINE).filter((file) => !existsSync(join(ROOT, file)));
    expect(missing, "a renamed or deleted file: remove its BASELINE entry").toEqual([]);
  });

  it("every TIMESTAMP_TOLERANCE line still occurs in its file", () => {
    const stale: string[] = [];
    for (const [file, lines] of Object.entries(TIMESTAMP_TOLERANCE)) {
      const path = join(ROOT, file);
      const present = existsSync(path) ? new Set(readFileSync(path, "utf8").split("\n").map((l) => l.trim())) : new Set<string>();
      for (const line of lines) if (!present.has(line)) stale.push(`${file}: ${line}`);
    }
    expect(stale, "an edited or removed line: update or delete its TIMESTAMP_TOLERANCE entry").toEqual([]);
  });

  it("the guard really scans the repository", () => {
    // A scanner that silently visited nothing (wrong root, wrong glob) would let every regression through.
    expect(scanned).toBeGreaterThan(300);
  });
});
