import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, relative } from "node:path";

// NOTE: next/server is deliberately NOT mocked in this file. The real-Next
// pin below relies on the genuine `connection()` throwing its outside-a-
// request-scope error under vitest.
import { awaitRequestScope } from "../../src/lib/cache-resilience";

// ---------------------------------------------------------------------------
// Permanent CI guard for the "prerender-retry" rule.
//
// resolveCachedOrRetry (src/lib/cache-resilience.ts) runs an UNCACHED live
// retry when the cached attempt failed. That retry may read the clock (e.g.
// fetchTopicCounts, topic-query.ts), and under Next 16 cacheComponents a
// clock read in an uncached prerender path fails `next build`. The fix is
// central: resolveCachedOrRetry awaits `connection()` (via awaitRequestScope)
// before the retry, so a prerender postpones to the nearest Suspense
// instead of running it.
//
// What must never regress, and what this file pins:
//   (a) the matched error string still matches the installed Next;
//   (b) the await sits after the cache-hit return, outside the try, before
//       the retry;
//   (c) every call site passes (label, cached, retry, fallback) with a retry
//       that is the UNCACHED fetch, not the cached getter;
//   (d) no `"use cache"` body ever calls resolveCachedOrRetry / a getter
//       built on it / awaitRequestScope / connection() -- inside a cache
//       body `connection()` throws AND records invalidDynamicUsageError,
//       which fails the build even when caught.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SRC = resolve(ROOT, "src");
const RESILIENCE = resolve(SRC, "lib/cache-resilience.ts");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const isTestFile = (p: string) => /\.test\.(ts|tsx)$/.test(p);

// ---------------------------------------------------------------------------
// Tiny lexer-ish scanner. Returns a string of the SAME length as `src` in
// which every comment is blanked and, when `blankStrings` is set, so is the
// content of every string / template-literal text segment (quotes and
// `${ ... }` expressions are kept). Offsets therefore line up with the
// original source. Regex literals are not modelled; a quote that has no
// closing partner on its own line (a JSX apostrophe such as "Tayf'in") is
// treated as a plain character so it cannot swallow the rest of the file.
// ---------------------------------------------------------------------------
function mask(src: string, blankStrings: boolean): string {
  const out = src.split("");
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  // Template-literal state: "T" = inside template text, a number = brace
  // depth inside a `${ ... }` expression.
  const stack: Array<"T" | { depth: number }> = [];
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    const top = stack[stack.length - 1];

    if (top === "T") {
      if (c === "\\") {
        if (blankStrings) blank(i, i + 2);
        i += 2;
      } else if (c === "`") {
        stack.pop();
        i += 1;
      } else if (c === "$" && d === "{") {
        stack.push({ depth: 0 });
        i += 2;
      } else {
        if (blankStrings) blank(i, i + 1);
        i += 1;
      }
      continue;
    }

    if (c === "/" && d === "/") {
      let e = src.indexOf("\n", i);
      if (e === -1) e = n;
      blank(i, e);
      i = e;
    } else if (c === "/" && d === "*") {
      let e = src.indexOf("*/", i + 2);
      e = e === -1 ? n : e + 2;
      blank(i, e);
      i = e;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== "\n") {
        j += src[j] === "\\" ? 2 : 1;
      }
      if (j < n && src[j] === c) {
        if (blankStrings) blank(i + 1, j);
        i = j + 1;
      } else {
        i += 1; // unterminated on this line: not a string
      }
    } else if (c === "`") {
      stack.push("T");
      i += 1;
    } else if (c === "{") {
      if (top) top.depth += 1;
      i += 1;
    } else if (c === "}") {
      if (top) {
        if (top.depth === 0) stack.pop();
        else top.depth -= 1;
      }
      i += 1;
    } else {
      i += 1;
    }
  }
  return out.join("");
}

/** Index of the `}` / `)` closing the opener at `openIdx`, or -1. */
function matchClose(masked: string, openIdx: number): number {
  const opener = masked[openIdx];
  const closer = opener === "{" ? "}" : opener === "(" ? ")" : "]";
  let depth = 0;
  for (let k = openIdx; k < masked.length; k++) {
    const ch = masked[k];
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return -1;
}

const normalise = (s: string) => s.replace(/\s+/g, " ").trim();

type CallSite = {
  file: string;
  line: number;
  args: string[];
  /** Name of the nearest preceding `function NAME` (the public wrapper). */
  wrapper: string | null;
};

/**
 * Find every `resolveCachedOrRetry<...>(...)` / `resolveCachedOrRetry(...)`
 * call in `src`. Skips comments and import lines. The optional generic is
 * skipped by angle depth (ignoring the `>` of `=>`); the argument list is
 * split on top-level commas by ()[]{} depth only -- angle brackets are NOT
 * counted inside args because `=>` would unbalance them.
 */
function findCallSites(src: string, file: string): CallSite[] {
  const code = mask(src, true);
  const text = mask(src, false); // comments blanked, strings kept
  const sites: CallSite[] = [];
  const re = /resolveCachedOrRetry\s*(<|\()/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const lineStart = code.lastIndexOf("\n", m.index) + 1;
    if (/^\s*import\b/.test(code.slice(lineStart, m.index))) continue;

    let k = m.index + m[0].length - 1; // at "<" or "("
    if (code[k] === "<") {
      let depth = 0;
      for (; k < code.length; k++) {
        if (code[k] === "<") depth += 1;
        else if (code[k] === ">" && code[k - 1] !== "=") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      k += 1;
      while (/\s/.test(code[k] ?? "")) k += 1;
    }
    const line = code.slice(0, m.index).split("\n").length;
    if (code[k] !== "(") {
      sites.push({ file, line, args: [], wrapper: null });
      continue;
    }
    const close = matchClose(code, k);
    const args: string[] = [];
    let depth = 0;
    let argStart = k + 1;
    for (let p = k + 1; p <= close; p++) {
      const ch = code[p];
      if (ch === "(" || ch === "[" || ch === "{") depth += 1;
      else if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0 && p === close) {
          args.push(normalise(text.slice(argStart, p)));
          break;
        }
        depth -= 1;
      } else if (ch === "," && depth === 0) {
        args.push(normalise(text.slice(argStart, p)));
        argStart = p + 1;
      }
    }
    if (args.length > 0 && args[args.length - 1] === "") args.pop();

    let wrapper: string | null = null;
    const fnRe = /function\s+([A-Za-z0-9_$]+)/g;
    const before = code.slice(0, m.index);
    let fm: RegExpExecArray | null;
    while ((fm = fnRe.exec(before)) !== null) wrapper = fm[1] ?? null;

    sites.push({ file, line, args, wrapper });
  }
  return sites;
}

/** Call-site rule violations (empty = healthy). */
function checkCallSite(site: CallSite): string[] {
  const where = `${site.file}:${site.line}`;
  if (site.args.length === 0) return [`${where}: could not parse the call`];
  if (site.args.length !== 4) {
    return [
      `${where}: expected 4 args (label, cached, retry, fallback), got ${site.args.length}`,
    ];
  }
  const [, cached, retry] = site.args as [string, string, string, string];
  const problems: string[] = [];
  if (normalise(retry) === normalise(cached)) {
    problems.push(`${where}: retry is the same function as cached`);
  }
  if (/Cached\b|Cached\(/.test(retry)) {
    problems.push(
      `${where}: retry "${retry}" looks like the cached getter, it must be the uncached fetch`,
    );
  }
  return problems;
}

const DIRECTIVE_RE = /^\s*["']use cache(:[^"']*)?["'];?\s*$/;
const FORBIDDEN_IN_CACHE_BODY =
  /\b(resolveCachedOrRetry|awaitRequestScope|connection)\s*(<[^>]*>)?\s*\(/;

type CacheBody = { file: string; line: number; body: string };

/** The body (masked) of every function that carries a `"use cache"` directive. */
function findCacheBodies(src: string, file: string): CacheBody[] {
  const code = mask(src, true);
  const bodies: CacheBody[] = [];
  let offset = 0;
  for (const line of src.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    if (!DIRECTIVE_RE.test(line)) continue;
    const quoteIdx = lineStart + line.search(/["']/);
    // A directive-looking line inside a comment or template literal is not one.
    if (code[quoteIdx] !== '"' && code[quoteIdx] !== "'") continue;
    const lineNo = src.slice(0, quoteIdx).split("\n").length;

    const before = code.slice(0, quoteIdx);
    if (/^[\s;"']*$/.test(before)) {
      // File-level directive: the whole module is a cache scope.
      bodies.push({ file, line: lineNo, body: code });
      continue;
    }
    const open = before.lastIndexOf("{");
    const close = open === -1 ? -1 : matchClose(code, open);
    if (open === -1 || close < quoteIdx) {
      bodies.push({ file, line: lineNo, body: "\u0000UNBALANCED" });
      continue;
    }
    bodies.push({ file, line: lineNo, body: code.slice(open, close + 1) });
  }
  return bodies;
}

// ---------------------------------------------------------------------------

describe("awaitRequestScope against the real Next (no next/server mock)", () => {
  it("swallows the genuine outside-request-scope error and resolves", async () => {
    // Under vitest there is no work store, so the real connection() throws
    // "`connection` was called outside a request scope". That this resolves
    // proves the string awaitRequestScope matches still matches the
    // installed Next.
    await expect(awaitRequestScope()).resolves.toBeUndefined();
  });

  it("the installed Next still words the error 'was called outside a request scope'", () => {
    const file = resolve(
      ROOT,
      "node_modules/next/dist/server/app-render/work-unit-async-storage.external.js",
    );
    expect(readFileSync(file, "utf8")).toContain(
      "was called outside a request scope",
    );
  });
});

describe("resolveCachedOrRetry awaits the request scope before the live retry", () => {
  it("orders: cache-hit return, then await awaitRequestScope(), then try { retry() }", () => {
    const code = mask(readFileSync(RESILIENCE, "utf8"), true);
    const start = code.indexOf("export async function resolveCachedOrRetry");
    expect(start).toBeGreaterThan(-1);
    const open = code.indexOf(
      "{",
      code.indexOf(")", code.indexOf("fallback: T", start)),
    );
    const close = matchClose(code, open);
    expect(close).toBeGreaterThan(open);
    const fn = code.slice(open, close + 1);

    const hit = fn.indexOf("if (result.ok) return result.data;");
    const wait = fn.indexOf("await awaitRequestScope()");
    const tryIdx = fn.indexOf("try {");
    const retryIdx = fn.indexOf("retry()");

    expect(hit).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(hit);
    expect(tryIdx).toBeGreaterThan(wait);
    expect(retryIdx).toBeGreaterThan(wait);
    expect(retryIdx).toBeGreaterThan(tryIdx);
  });
});

describe("every resolveCachedOrRetry call site passes an uncached retry", () => {
  const sites = walk(SRC)
    .filter((f) => !isTestFile(f) && f !== RESILIENCE)
    .flatMap((f) => findCallSites(readFileSync(f, "utf8"), relative(ROOT, f)));

  it("finds the known call sites (sanity floor: the scanner is not blind)", () => {
    expect(sites.length).toBeGreaterThanOrEqual(10);
  });

  it("each call has exactly (label, cached, retry, fallback) with retry != cached", () => {
    expect(sites.flatMap(checkCallSite)).toEqual([]);
  });

  describe("scanner self-checks", () => {
    const check = (call: string) =>
      findCallSites(`async function getX() {\n  return ${call};\n}\n`, "x.ts")
        .map(checkCallSite)
        .flat();

    it("accepts a well-formed call, with or without a generic and trailing comma", () => {
      expect(
        check(
          'resolveCachedOrRetry("l", () => getCached(id), () => fetchIt(id), null,)',
        ),
      ).toEqual([]);
      expect(
        check(
          'resolveCachedOrRetry<Record<string, () => number> | null>("l", getXCached, fetchX, null)',
        ),
      ).toEqual([]);
    });

    it("flags a wrong arity", () => {
      expect(
        check('resolveCachedOrRetry("l", getXCached, fetchX)'),
      ).toHaveLength(1);
    });

    it("flags retry === cached", () => {
      expect(
        check('resolveCachedOrRetry("l", fetchX, fetchX, null)'),
      ).toHaveLength(1);
    });

    it("flags a cached getter passed as the retry", () => {
      expect(
        check('resolveCachedOrRetry("l", getXCached, () => getXCached(), null)'),
      ).not.toEqual([]);
    });

    it("ignores comments and imports", () => {
      const src = [
        'import { resolveCachedOrRetry } from "@/lib/cache-resilience";',
        "// resolveCachedOrRetry(only, three, args)",
        "/* resolveCachedOrRetry(a, b) */",
        "",
      ].join("\n");
      expect(findCallSites(src, "x.ts")).toEqual([]);
    });
  });
});

describe('no "use cache" body calls a request-scope API or a resolveCachedOrRetry getter', () => {
  const files = walk(SRC);
  const wrappers = new Set(
    files
      .filter((f) => !isTestFile(f) && f !== RESILIENCE)
      .flatMap((f) => findCallSites(readFileSync(f, "utf8"), f))
      .map((s) => s.wrapper)
      .filter((w): w is string => w !== null),
  );
  const bodies = files.flatMap((f) =>
    findCacheBodies(readFileSync(f, "utf8"), relative(ROOT, f)),
  );

  const violations = (list: CacheBody[]): string[] =>
    list.flatMap(({ file, line, body }) => {
      const where = `${file}:${line}`;
      if (body === "\u0000UNBALANCED") {
        return [`${where}: could not brace-match the cache body`];
      }
      const out: string[] = [];
      const hit = FORBIDDEN_IN_CACHE_BODY.exec(body);
      if (hit) out.push(`${where}: "use cache" body calls ${hit[1]}()`);
      for (const w of wrappers) {
        if (new RegExp(`\\b${w}\\s*\\(`).test(body)) {
          out.push(
            `${where}: "use cache" body calls ${w}(), which is built on resolveCachedOrRetry`,
          );
        }
      }
      return out;
    });

  it("finds the cache bodies (sanity floor: the scanner is not blind)", () => {
    expect(bodies.length).toBeGreaterThanOrEqual(30);
    expect(wrappers.size).toBeGreaterThanOrEqual(8);
  });

  it("keeps resolveCachedOrRetry, awaitRequestScope and connection() out of every cache body", () => {
    expect(violations(bodies)).toEqual([]);
  });

  describe("scanner self-checks", () => {
    const bodiesOf = (src: string) => findCacheBodies(src, "x.ts");

    it("flags connection() / awaitRequestScope() / resolveCachedOrRetry() in a body", () => {
      const src = [
        "async function a() {",
        '  "use cache";',
        "  await connection();",
        "}",
        "async function b() {",
        '  "use cache: remote";',
        "  await awaitRequestScope();",
        "}",
        "const c = async () => {",
        "  'use cache'",
        "  return resolveCachedOrRetry<number>('l', x, y, 0);",
        "};",
      ].join("\n");
      const found = bodiesOf(src);
      expect(found).toHaveLength(3);
      expect(violations(found)).toHaveLength(3);
    });

    it("does not misfire on braces inside strings, comments and templates", () => {
      const src = [
        "async function a() {",
        '  "use cache";',
        '  const s = "{ not a brace";',
        "  // } nor this",
        "  const t = `${{ a: 1 }.a} }}`;",
        "  return s + t;",
        "}",
        "async function after() {",
        "  await connection();",
        "}",
      ].join("\n");
      const found = bodiesOf(src);
      expect(found).toHaveLength(1);
      expect(violations(found)).toEqual([]);
    });

    it("ignores a directive-looking line inside a template literal", () => {
      const src = ["const t = `", '"use cache"', "`;", ""].join("\n");
      expect(bodiesOf(src)).toEqual([]);
    });
  });
});
