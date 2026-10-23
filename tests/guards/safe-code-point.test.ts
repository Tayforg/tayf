import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (entity-decode): String.fromCodePoint throws a RangeError
// for any code point above U+10FFFF (and for NaN, negatives and fractions).
// An RSS title such as "a &#1114112; b" therefore threw out of decodeEntities,
// out of normalizeArticles, and dropped EVERY item of that source for the run.
// The numeric-entity decoders (ingest normalize.ts, dates.ts and the fact-check
// normalizer) all go through codePointToString in
// supabase/functions/_shared/rss/entities.ts, which never throws and drops
// characters XML 1.0 forbids. This sweep makes sure nobody reintroduces a raw
// String.fromCodePoint anywhere in runtime code.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SCAN_DIRS = [
  resolve(ROOT, "supabase/functions"),
  resolve(ROOT, "src"),
];

const ENTITIES_FILE = "supabase/functions/_shared/rss/entities.ts";

/** Runtime files that decode numeric references and so MUST use the helper. */
const MUST_IMPORT_HELPER = [
  "supabase/functions/_shared/rss/normalize.ts",
  "supabase/functions/_shared/rss/dates.ts",
  "src/lib/fact-checks/normalize.ts",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

/**
 * Blanks // and block comments, keeping offsets (and newlines) intact, with a
 * single left-to-right scan that knows about strings, template literals and
 * regex literals. A naive "block comments first, then line comments" regex is
 * not enough: ingest's normalize.ts has a `//` comment containing `image/*`,
 * which that approach reads as the start of a block comment and so blanks
 * hundreds of lines of real code, hiding any call inside them.
 */
function blankComments(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  // Open `${` expressions inside template literals, innermost last.
  const templateDepth: number[] = [];
  let braces = 0;
  let prevSignificant = "";
  let i = 0;

  const readTemplate = (): void => {
    // `i` is just past the opening backtick (or the `}` closing a `${`).
    while (i < src.length) {
      const c = src[i]!;
      if (c === "\\") i += 2;
      else if (c === "`") {
        i++;
        prevSignificant = "`";
        return;
      } else if (c === "$" && src[i + 1] === "{") {
        templateDepth.push(braces);
        braces++;
        i += 2;
        prevSignificant = "{";
        return;
      } else i++;
    }
  };

  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c && src[i] !== "\n") {
        i += src[i] === "\\" ? 2 : 1;
      }
      i++;
      prevSignificant = c;
    } else if (c === "`") {
      i++;
      readTemplate();
    } else if (c === "/" && /^[(,=:[!&|?{};+\-*%<>~^]?$/.test(prevSignificant)) {
      // A regex literal (the previous token cannot end an expression).
      i++;
      let inClass = false;
      while (i < src.length && src[i] !== "\n") {
        const r = src[i]!;
        if (r === "\\") i += 2;
        else if (r === "[") {
          inClass = true;
          i++;
        } else if (r === "]") {
          inClass = false;
          i++;
        } else if (r === "/" && !inClass) {
          i++;
          break;
        } else i++;
      }
      prevSignificant = "/";
    } else {
      if (c === "{") braces++;
      else if (c === "}") {
        braces--;
        if (templateDepth.length > 0 && templateDepth[templateDepth.length - 1] === braces) {
          templateDepth.pop();
          i++;
          readTemplate();
          continue;
        }
      }
      if (!/\s/.test(c)) prevSignificant = c;
      i++;
    }
  }
  return out.join("");
}

// `\bfromCodePoint\b` rather than `String.fromCodePoint(` so an alias
// (`const { fromCodePoint } = String`, `String["fromCodePoint"]`) cannot dodge it.
const RAW_CALL_RE = /\bfromCodePoint\b/;

interface Violation {
  file: string;
  line: number;
  text: string;
}

function findRawCalls(src: string, file: string): Violation[] {
  const blanked = blankComments(src);
  const out: Violation[] = [];
  blanked.split("\n").forEach((text, i) => {
    if (RAW_CALL_RE.test(text)) {
      out.push({ file, line: i + 1, text: text.trim().slice(0, 100) });
    }
  });
  return out;
}

const FIX =
  "Decode numeric character references with codePointToString() from " +
  "supabase/functions/_shared/rss/entities.ts (import it extensionless from " +
  "src/, with the .ts suffix from supabase/functions/). It never throws and " +
  "drops characters XML 1.0 forbids; String.fromCodePoint throws a RangeError " +
  "on &#1114112; and one throw drops a whole source's items.";

/**
 * The one exception: a call whose immediately preceding line returns early for
 * every code point fromCodePoint rejects (non-positive/NaN, above U+10FFFF,
 * surrogates). The service worker's self-contained runtime string
 * (src/lib/pwa/sw-source.ts) and its TS twin (sw-policy.ts) decode <title>
 * entities this way because a worker script cannot import entities.ts.
 */
function isRangeGuardedCall(src: string, line: number): boolean {
  const prev = src.split("\n")[line - 2] ?? "";
  return (
    /!\(cp > 0\)/.test(prev) &&
    /cp > (?:0x10ffff|1114111)/i.test(prev) &&
    /cp >= (?:0xd800|55296) && cp <= (?:0xdfff|57343)/i.test(prev) &&
    /return\s/.test(prev)
  );
}

describe("isRangeGuardedCall", () => {
  it("accepts a call right after the full range check (hex or decimal bounds)", () => {
    const hex = 'if (!(cp > 0) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "x";\nreturn String.fromCodePoint(cp);';
    const dec = 'if (!(cp > 0) || cp > 1114111 || (cp >= 55296 && cp <= 57343)) return "x";\nreturn String.fromCodePoint(cp);';
    expect(isRangeGuardedCall(hex, 2)).toBe(true);
    expect(isRangeGuardedCall(dec, 2)).toBe(true);
  });

  it("rejects a partial check or a call that is not directly after it", () => {
    const noSurrogate = 'if (!(cp > 0) || cp > 0x10ffff) return "x";\nreturn String.fromCodePoint(cp);';
    const gap = 'if (!(cp > 0) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "x";\nfoo();\nreturn String.fromCodePoint(cp);';
    expect(isRangeGuardedCall(noSurrogate, 2)).toBe(false);
    expect(isRangeGuardedCall(gap, 3)).toBe(false);
  });
});

function repoRelative(file: string): string {
  return relative(ROOT, file).split("\\").join("/");
}

describe("String.fromCodePoint is confined to entities.ts", () => {
  const files = SCAN_DIRS.flatMap(walk);

  it("scans a meaningful number of runtime files (the sweep is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.map(repoRelative)).toContain(ENTITIES_FILE);
  });

  it("entities.ts really holds the one allowed String.fromCodePoint", () => {
    const src = readFileSync(resolve(ROOT, ENTITIES_FILE), "utf8");
    expect(findRawCalls(src, ENTITIES_FILE).length).toBeGreaterThanOrEqual(1);
  });

  it("no other runtime file calls fromCodePoint", () => {
    const violations = files
      .filter((f) => repoRelative(f) !== ENTITIES_FILE)
      .flatMap((f) => {
        const src = readFileSync(f, "utf8");
        return findRawCalls(src, repoRelative(f)).filter(
          (v) => !isRangeGuardedCall(src, v.line),
        );
      });
    expect(
      violations,
      `fromCodePoint outside entities.ts:\n${violations
        .map((v) => `  ${v.file}:${v.line}  ${v.text}`)
        .join("\n")}\n${FIX}`,
    ).toEqual([]);
  });

  it.each(MUST_IMPORT_HELPER)(
    "%s imports codePointToString (so the sweep above guards something real)",
    (rel) => {
      const src = blankComments(readFileSync(resolve(ROOT, rel), "utf8"));
      expect(
        /import\s*\{[^}]*\bcodePointToString\b[^}]*\}\s*from\s*["'][^"']*\/entities(?:\.ts)?["']/.test(
          src,
        ),
        `${rel} must import codePointToString from the rss entities module. ${FIX}`,
      ).toBe(true);
    },
  );

  it("the helper-using files call it", () => {
    for (const rel of MUST_IMPORT_HELPER) {
      const src = blankComments(readFileSync(resolve(ROOT, rel), "utf8"));
      expect(src, rel).toMatch(/\bcodePointToString\s*\(/);
    }
  });
});

describe("the sweep itself", () => {
  it("never blanks a top-level import/export line anywhere in the scanned tree (no phantom comments)", () => {
    // A scanner that loses track of strings or regex literals starts a phantom
    // comment and silently hides real code from the sweep. Top-level
    // import/export statements are never inside a comment, so each must
    // survive blanking intact in every scanned file.
    const desynced: string[] = [];
    for (const f of SCAN_DIRS.flatMap(walk)) {
      const raw = readFileSync(f, "utf8");
      const blanked = blankComments(raw);
      expect(blanked.length).toBe(raw.length);
      const rawLines = raw.split("\n");
      const blankedLines = blanked.split("\n");
      rawLines.forEach((line, idx) => {
        if (!/^(import|export)\s/.test(line)) return;
        const after = blankedLines[idx] ?? "";
        // A trailing `// note` is legitimately blanked, so only the statement's
        // own start must survive; a line with no comment marker must be intact.
        const startLost = after.slice(0, 7) !== line.slice(0, 7);
        const changedWithoutComment =
          !/\/\/|\/\*/.test(line) && after !== line;
        if (startLost || changedWithoutComment) {
          desynced.push(`${repoRelative(f)}:${idx + 1}`);
        }
      });
    }
    expect(desynced).toEqual([]);
  });

  it("flags a real call", () => {
    expect(
      findRawCalls("const s = String.fromCodePoint(n);", "x.ts"),
    ).toHaveLength(1);
  });

  it("flags an aliased call", () => {
    expect(
      findRawCalls("const { fromCodePoint } = String;", "x.ts"),
    ).toHaveLength(1);
  });

  it("ignores line and block comments that merely mention the call", () => {
    const src = [
      "// String.fromCodePoint(cp) throws on 0x110000",
      "/* String.fromCodePoint(cp)",
      "   still a comment */",
      "const ok = codePointToString(cp);",
    ].join("\n");
    expect(findRawCalls(src, "x.ts")).toEqual([]);
  });

  it("is not fooled by `/*` inside a // comment (the normalize.ts `image/*` case)", () => {
    const src = [
      "// all returned 200 image/* (see the header)",
      "const x = String.fromCodePoint(cp);",
      "// and */ here",
    ].join("\n");
    expect(findRawCalls(src, "x.ts").map((h) => h.line)).toEqual([2]);
  });

  it("is not fooled by `//` or `/*` inside strings and regex literals", () => {
    const src = [
      'const url = "https://example.test/*";',
      "const glob = 'src/**/*.ts';",
      "const re = /[\"'`]\\/\\/\\*/g;",
      "const t = `a ${b} // not a comment`;",
      "String.fromCodePoint(cp);",
    ].join("\n");
    expect(findRawCalls(src, "x.ts").map((h) => h.line)).toEqual([5]);
  });

  it("sees a call inside a template expression", () => {
    expect(
      findRawCalls("const s = `x ${String.fromCodePoint(1)} y`;", "x.ts"),
    ).toHaveLength(1);
  });

  it("reports the offending line number", () => {
    const hits = findRawCalls("a;\nb;\nString.fromCodePoint(1);", "x.ts");
    expect(hits.map((h) => h.line)).toEqual([3]);
  });
});
