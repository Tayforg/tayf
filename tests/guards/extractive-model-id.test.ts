import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (hunt 15, extractive-v2): clusters.title_neutral_model
// holds the rule version of the extractive picker ("extractive-v1", "-v2", ...).
// The headline cron re-picks old versions in the background, so for a while
// rows of two versions coexist, and every future bump repeats that. A reader
// that compares the column with `=== EXTRACTIVE_MODEL_ID` (or a hard-coded
// "extractive-v1") silently mislabels every row of the previous version as an
// LLM title the moment the constant moves (cluster-detail-query.ts did exactly
// that: title_method flipped to "llm" for the whole backlog). So:
//
//   * outside src/lib/clusters/neutral-title.ts, no non-test source under src/
//     compares ===/!==/==/!= against EXTRACTIVE_MODEL_ID, and none holds an
//     `extractive-v<digit>` literal -- readers use isExtractiveModelId();
//   * writers may still ASSIGN the constant (title_neutral_model:
//     EXTRACTIVE_MODEL_ID, p_model: EXTRACTIVE_MODEL_ID);
//   * non-vacuity: the scan sees neutral-title.ts (where the literal lives) and
//     the known consumers, and both finders are mutation-tested.
//
// Comments are blanked first (offsets preserved), so prose that quotes the
// ids cannot trip the guard or hide a real comparison.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SRC = resolve(ROOT, "src");
const OWNER = "src/lib/clusters/neutral-title.ts";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "__tests__") continue;
      out.push(...walk(p));
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.(test|spec)\.[a-z]+$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const rel = (p: string): string => relative(ROOT, p).split(sep).join("/");

/** Blanks // and block comments, keeping offsets (and newlines) intact. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

/** `x === EXTRACTIVE_MODEL_ID`, `EXTRACTIVE_MODEL_ID !== x`, and the loose forms. */
function findComparisons(code: string): string[] {
  const re = /(?:[!=]==?\s*EXTRACTIVE_MODEL_ID\b|\bEXTRACTIVE_MODEL_ID\s*[!=]==?)/g;
  return [...code.matchAll(re)].map((m) => m[0]);
}

/** A hard-coded `extractive-v<digit>` version id anywhere in code. */
function findVersionLiterals(code: string): string[] {
  return [...code.matchAll(/extractive-v\d+/g)].map((m) => m[0]);
}

const files = walk(SRC).map((f) => ({ file: rel(f), code: blankComments(readFileSync(f, "utf8")) }));

describe("EXTRACTIVE_MODEL_ID: readers must use isExtractiveModelId", () => {
  it("scans a non-vacuous set (the owner, the cron route and the cluster-detail reader)", () => {
    const names = files.map((f) => f.file);
    expect(names).toContain(OWNER);
    expect(names).toContain("src/app/api/cron/headline/route.ts");
    expect(names).toContain("src/lib/clusters/cluster-detail-query.ts");
    expect(files.length).toBeGreaterThan(100);
    // The owner really holds the literal (so the finder is not scanning thin air).
    const owner = files.find((f) => f.file === OWNER)!;
    expect(findVersionLiterals(owner.code).length).toBeGreaterThan(0);
  });

  it("no source outside neutral-title.ts compares against EXTRACTIVE_MODEL_ID", () => {
    const bad = files
      .filter((f) => f.file !== OWNER)
      .flatMap((f) => findComparisons(f.code).map((c) => `${f.file}: ${c}`));
    expect(bad).toEqual([]);
  });

  it("no source outside neutral-title.ts hard-codes an extractive-v<digit> id", () => {
    const bad = files
      .filter((f) => f.file !== OWNER)
      .flatMap((f) => findVersionLiterals(f.code).map((c) => `${f.file}: ${c}`));
    expect(bad).toEqual([]);
  });

  it("the cluster-detail reader goes through isExtractiveModelId", () => {
    const f = files.find((x) => x.file === "src/lib/clusters/cluster-detail-query.ts")!;
    expect(f.code).toMatch(/isExtractiveModelId\(\s*clusterRow\.title_neutral_model\s*\)/);
  });

  it("neutral-title.ts exports a prefix-based isExtractiveModelId and the current id is extractive-*", () => {
    const owner = files.find((f) => f.file === OWNER)!;
    expect(owner.code).toMatch(/export function isExtractiveModelId\(/);
    expect(owner.code).toMatch(/\.startsWith\(\s*["']extractive-["']\s*\)/);
    expect(owner.code).toMatch(/export const EXTRACTIVE_MODEL_ID = ["']extractive-v\d+["']/);
  });
});

describe("JEV_NEUTRAL_MODEL_ID follows EXTRACTIVE_MODEL_ID (the Deno copy cannot be imported)", () => {
  it("supabase/functions/_shared/jev.ts holds the same extractive-v<N> literal as neutral-title.ts", () => {
    // The edge function cannot import from src/, so it keeps its own copy of
    // the id. A bump that forgets it leaves the jev-shadow neutral_pick stage
    // looking for rows nothing writes any more. Comments are blanked first, so
    // prose that quotes an id cannot satisfy or trip the check.
    const jev = blankComments(readFileSync(resolve(ROOT, "supabase/functions/_shared/jev.ts"), "utf8"));
    const owner = files.find((f) => f.file === OWNER)!;
    const jevLiteral = /export const JEV_NEUTRAL_MODEL_ID = ["'](extractive-v\d+)["']/.exec(jev);
    const srcLiteral = /export const EXTRACTIVE_MODEL_ID = ["'](extractive-v\d+)["']/.exec(owner.code);
    expect(jevLiteral, "JEV_NEUTRAL_MODEL_ID literal not found in jev.ts").not.toBeNull();
    expect(srcLiteral, "EXTRACTIVE_MODEL_ID literal not found in neutral-title.ts").not.toBeNull();
    expect(jevLiteral![1]).toBe(srcLiteral![1]);
  });
});

describe("EXTRACTIVE_MODEL_ID guard: the finders really catch violations (mutation tests)", () => {
  const code = (src: string) => blankComments(src);

  it("flags every comparison form", () => {
    expect(findComparisons(code("if (row.title_neutral_model === EXTRACTIVE_MODEL_ID) {}"))).toHaveLength(1);
    expect(findComparisons(code("if (row.title_neutral_model !== EXTRACTIVE_MODEL_ID) {}"))).toHaveLength(1);
    expect(findComparisons(code("if (EXTRACTIVE_MODEL_ID === m) {}"))).toHaveLength(1);
    expect(findComparisons(code("if (EXTRACTIVE_MODEL_ID !== m) {}"))).toHaveLength(1);
    expect(findComparisons(code("if (m == EXTRACTIVE_MODEL_ID) {}"))).toHaveLength(1);
    expect(findComparisons(code("const same = m===EXTRACTIVE_MODEL_ID;"))).toHaveLength(1);
    expect(findComparisons(code("x = a\n  ===\n  EXTRACTIVE_MODEL_ID"))).toHaveLength(1);
  });

  it("flags a hard-coded version id in any quote style", () => {
    expect(findVersionLiterals(code('const a = "extractive-v1";'))).toEqual(["extractive-v1"]);
    expect(findVersionLiterals(code("const a = 'extractive-v2';"))).toEqual(["extractive-v2"]);
    expect(findVersionLiterals(code("const a = `extractive-v10`;"))).toEqual(["extractive-v10"]);
  });

  it("does not flag assignments, the helper, or comments that quote the ids", () => {
    expect(findComparisons(code("update({ title_neutral_model: EXTRACTIVE_MODEL_ID });"))).toEqual([]);
    expect(findComparisons(code('rpc("f", { p_model: EXTRACTIVE_MODEL_ID, p_limit: 20 });'))).toEqual([]);
    expect(findComparisons(code("if (isExtractiveModelId(row.title_neutral_model)) {}"))).toEqual([]);
    expect(findComparisons(code("// m === EXTRACTIVE_MODEL_ID\n/* m !== EXTRACTIVE_MODEL_ID */"))).toEqual([]);
    expect(findVersionLiterals(code('// "extractive-v1"\n/* extractive-v2 */'))).toEqual([]);
    expect(findVersionLiterals(code('startsWith("extractive-")'))).toEqual([]);
  });

  it("a URL in a string does not hide a comparison that follows it", () => {
    const src = 'const u = "https://x.test/a"; if (m === EXTRACTIVE_MODEL_ID) {}';
    expect(findComparisons(code(src))).toHaveLength(1);
  });
});
