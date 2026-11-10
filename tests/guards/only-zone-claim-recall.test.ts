import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (h108-sharesurfaces-1): every outbound surface that words a
// "Kör nokta" claim goes through `onlyZoneClaim(counts, zone, nonVotingOutside,
// recallMatchedCount)` (src/lib/bias/zone-summary.ts). Its fourth argument has a
// default (0, today's wording), which is exactly how a caller can silently miss
// the "kümede sadece X" wording /blindspots already uses for a zone Jev matched
// with the same event: the OG ribbon, the embed, the share text and the digest
// all printed "sadece X yazdı" over cluster 0746c9d2 that way.
//
//     onlyZoneClaim(zones, zone, outside, detail.recallMatchedZones?.length ?? 0)  // ok
//     onlyZoneClaim(zones, zone, outside)                                           // offender
//
// So every call in src/ (non-test files) must pass FOUR arguments, the fourth
// being an explicit `0` when a surface genuinely has no lookup. The definition
// is excluded. A new caller that forgets the recall input fails here.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SRC_DIR = join(ROOT, "src");

const EXPECTED_ARGS = 4;

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
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

/** Blanks import statements, so the specifier is not read as a reference. */
function blankImports(src: string): string {
  return src.replace(
    /import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+)\s+from\s*["'][^"']+["'];?/g,
    (m) => m.replace(/[^\n]/g, " "),
  );
}

interface Call {
  /** Text between the parentheses. */
  args: string;
  /** Top-level arguments (a trailing comma adds none). */
  argCount: number;
  /** 1-based line of the call. */
  line: number;
}

/**
 * The index of the `)` matching the `(` at `open`, skipping string and template
 * literals (a `${...}` inside a template is part of the literal here: this
 * guard's inputs do not nest templates). -1 when unbalanced.
 */
function matchingParen(code: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < code.length; i++) {
    const ch = code[i] as string;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Number of non-empty top-level, comma-separated arguments in `args`. */
function topLevelArgCount(args: string): number {
  let depth = 0;
  let quote: string | null = null;
  let count = 0;
  let segment = "";
  const flush = () => {
    if (segment.trim() !== "") count++;
    segment = "";
  };
  for (let i = 0; i < args.length; i++) {
    const ch = args[i] as string;
    if (quote) {
      segment += ch;
      if (ch === "\\") {
        segment += args[i + 1] ?? "";
        i++;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      segment += ch;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      segment += ch;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      segment += ch;
    } else if (ch === "," && depth === 0) flush();
    else segment += ch;
  }
  flush();
  return count;
}

/** Every call of `name(`, excluding its own `function name(` definition. */
function callsOf(name: string, src: string): Call[] {
  const code = blankImports(blankComments(src));
  const out: Call[] = [];
  const re = new RegExp(`\\b${name}\\s*\\(`, "g");
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    if (/\bfunction\s+$/.test(code.slice(0, m.index))) continue;
    const open = m.index + m[0].length - 1;
    const close = matchingParen(code, open);
    const args = code.slice(open + 1, close === -1 ? code.length : close);
    out.push({
      args,
      argCount: topLevelArgCount(args),
      line: code.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

/** Uses of `name` that are neither a call nor the definition nor an import. */
function referencesOf(name: string, src: string): number {
  const code = blankImports(blankComments(src));
  const all = code.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0;
  const calls = callsOf(name, src).length;
  const definitions = code.match(new RegExp(`\\bfunction\\s+${name}\\b`, "g"))?.length ?? 0;
  return all - calls - definitions;
}

const files = walk(SRC_DIR).map((full) => ({
  rel: relative(ROOT, full).split("\\").join("/"),
  src: readFileSync(full, "utf8"),
}));

/** Drops every `<...>` group (nested generics included) by a depth scan, not a regex. */
function dropAngleGroups(src: string): string {
  let out = "";
  let depth = 0;
  for (const ch of src) {
    if (ch === "<") depth++;
    else if (ch === ">" && depth > 0) depth--;
    else if (depth === 0) out += ch;
  }
  return out;
}

describe("only-zone-claim-recall guard: scanner self-test", () => {
  it("counts top-level arguments, not commas inside nested calls, arrays, objects or strings", () => {
    expect(topLevelArgCount("a, b, c, d")).toBe(4);
    expect(topLevelArgCount("a, b, c")).toBe(3);
    expect(topLevelArgCount("")).toBe(0);
    expect(topLevelArgCount("zones, zone, nonVotingOutsideZone(uniqueSources(members), zone), 0")).toBe(4);
    expect(topLevelArgCount("{ a: 1, b: 2 }, [1, 2], f(1, 2), 'x, y'")).toBe(4);
    expect(topLevelArgCount("`a, ${b}`, \"c, d\", e")).toBe(3);
  });

  it("a trailing comma adds no argument, and a ternary or optional chain stays one", () => {
    expect(topLevelArgCount("a, b, c, d,\n")).toBe(4);
    expect(topLevelArgCount("a, b, c,\n")).toBe(3);
    expect(topLevelArgCount("a, b, c, detail.recallMatchedZones?.length ?? 0")).toBe(4);
    expect(topLevelArgCount("a, b, c, x ? 1 : 2")).toBe(4);
  });

  it("flags a three-argument call and passes a four-argument one, over several lines", () => {
    const bad = "const c = onlyZoneClaim(\n  counts,\n  zone,\n  nonVotingOutsideZone(sources, zone),\n);";
    const good =
      "const c = onlyZoneClaim(\n  counts,\n  zone,\n  nonVotingOutsideZone(sources, zone),\n  detail.recallMatchedZones?.length ?? 0,\n);";
    expect(callsOf("onlyZoneClaim", bad).map((c) => c.argCount)).toEqual([3]);
    expect(callsOf("onlyZoneClaim", good).map((c) => c.argCount)).toEqual([4]);
    expect(callsOf("onlyZoneClaim", bad)[0]?.line).toBe(1);
  });

  it("an explicit 0 is a fourth argument", () => {
    expect(callsOf("onlyZoneClaim", "onlyZoneClaim(counts, zone, outside, 0)").map((c) => c.argCount)).toEqual([4]);
  });

  it("skips the definition, comments, strings in comments and the import specifier", () => {
    const src = [
      'import { onlyZoneClaim, zoneCountsOf } from "@/lib/bias/zone-summary";',
      "// onlyZoneClaim(a, b, c) in a comment",
      "/* onlyZoneClaim(a) in a block comment */",
      "export function onlyZoneClaim(a: number, b: number, c: number, d = 0) {}",
      "const x = onlyZoneClaim(counts, zone, outside, recall);",
    ].join("\n");
    expect(callsOf("onlyZoneClaim", src)).toHaveLength(1);
    expect(referencesOf("onlyZoneClaim", src)).toBe(0);
  });

  it("flags a reference that is not a call (an alias or a stored function would dodge the count)", () => {
    expect(referencesOf("onlyZoneClaim", "const f = onlyZoneClaim;\nf(a, b, c);")).toBe(1);
    expect(referencesOf("onlyZoneClaim", "const f = onlyZoneClaim(a, b, c, d);")).toBe(0);
  });
});

describe("only-zone-claim-recall guard: src/", () => {
  const callFiles = files
    .map((f) => ({ rel: f.rel, calls: callsOf("onlyZoneClaim", f.src) }))
    .filter((f) => f.calls.length > 0);

  it("walks the known outbound surfaces (so the guard cannot pass on an empty walk)", () => {
    const rels = callFiles.map((f) => f.rel);
    for (const expected of [
      "src/lib/clusters/share.ts",
      "src/lib/embed/embed-html.ts",
      "src/lib/digest/template.ts",
      "src/app/cluster/[id]/opengraph-image.tsx",
    ]) {
      expect(rels, `${expected} not found by the walk`).toContain(expected);
    }
  });

  it("every onlyZoneClaim( call passes four arguments, the fourth being the recall count", () => {
    const offenders: string[] = [];
    for (const { rel, calls } of callFiles) {
      for (const call of calls) {
        if (call.argCount !== EXPECTED_ARGS) {
          offenders.push(`${rel}:${call.line} passes ${call.argCount} argument(s), not ${EXPECTED_ARGS}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("no surface stores or aliases onlyZoneClaim: a call the count above cannot see", () => {
    const offenders = files
      .filter((f) => referencesOf("onlyZoneClaim", f.src) > 0)
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("the definition keeps the recall count as its fourth parameter", () => {
    const summary = files.find((f) => f.rel === "src/lib/bias/zone-summary.ts");
    expect(summary, "zone-summary.ts not found by the walk").toBeDefined();
    const code = blankComments(summary?.src ?? "");
    const at = code.indexOf("export function onlyZoneClaim(");
    expect(at).toBeGreaterThanOrEqual(0);
    const open = code.indexOf("(", at);
    const close = matchingParen(code, open);
    // Type annotations carry commas of their own (`Record<MediaDnaZone, number>`),
    // which a call's arguments never do: drop the generics before counting.
    const params = dropAngleGroups(code.slice(open + 1, close));
    expect(topLevelArgCount(params)).toBe(EXPECTED_ARGS);
    expect(params).toContain("recallMatchedCount");
  });
});
