import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, relative, sep } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard: in a `"use cache"` function that reads from Supabase,
// `cacheLife` must be chosen AFTER the read, not before it.
//
// 2026-10-24 /sources '—' incident. The footer chip, the /sources and
// /blindspots denominator footnotes, /kalite and /duzeltmeler all read through
// `"use cache"` functions shaped like this:
//
//   export async function getX() {
//     "use cache";
//     cacheLife("source-directory");   // <- fixed BEFORE the query ran
//     cacheTag("sources");
//     try { ...query...; if (error) return null; } catch { return null; }
//   }
//
// Because the lifetime was fixed up front, a transient Supabase failure (a
// statement timeout, a 4 s reader abort) resolved `null` and that `null` was
// memoised for the whole `source-directory` window (expire 1 h). Every request
// in that hour rendered the "durum bilinmiyor" '—' even though the database
// was healthy again a second later.
//
// The shape that cannot do this (src/lib/clusters/timeline-query.ts):
//
//   async function getXCached() {
//     "use cache";
//     cacheTag("sources");
//     const r = await attemptCached("label", fetchX);   // never rejects
//     if (r.ok) cacheLife("source-directory");          // success: long window
//     else cacheLife("minutes");                        // failure: short window
//     return r;
//   }
//
// What this file enforces, for every non-test `src/**/*.ts(x)`: for each
// INDENTED `"use cache";` directive (a function-level cache; a column-0
// file-level directive is a different construct and is skipped), take the body
// up to the next column-0 `}` line. The body is an offender when a
// `cacheLife(` call appears before its first `await`, because the lifetime is
// then decided before the outcome of any read is known.
//
// Ratchet: EMPTY. The 2026-10-24 sweep converted every body that predated this
// guard (finance/queries.ts, seo/sitemaps.ts, weekly/week-archive.ts,
// headline/status.ts, fact-checks, finance/quotes.ts, framing-receipt.ts,
// app/sources/page.tsx, sources/clickbait.ts), so there is no debt table any
// more and `found` must equal `{}`. A new offender fails with the file and the
// function NAME, and there is no allowance to add: convert the function to the
// shape above. The only exemption is PURE_CACHE_BODIES, a short list of bodies
// verified by hand to read nothing from the outside world (a clock and a
// pure computation: nothing that can fail or be cached wrongly). Each entry
// is still checked on every run: it must exist, and its body must pass
// isPureCacheBody (no await, no client factory, no query, no fetch, no call to
// a get/fetch/load/read helper), so a pure body that later gains a read fails
// here instead of hiding behind its name.
//
// The shapes that replaced the debt:
//   - null / empty contract, no live retry: the exported function does
//     `return r.ok ? r.data : <failure value>` on the `Cached` result;
//   - throw contract: `resolveCachedOrThrow(label, cached, retry)` in the
//     uncached exported function (one live retry behind awaitRequestScope, the
//     retry error propagates);
//   - fallback contract: `resolveCachedOrRetry(label, cached, retry, fallback)`.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SRC = resolve(ROOT, "src");

/**
 * Bodies that are exempt BY NAME because they are pure: one clock read and a
 * computation, no I/O. Repo-relative path (posix separators) -> function names
 * as findEarlyCacheLife reports them. Not a licence: each entry must exist and
 * pass isPureCacheBody on every run (see the tests at the bottom). A body that
 * gains a read must be converted to the attemptCached shape instead.
 */
const PURE_CACHE_BODIES: Record<string, string[]> = {
  "src/lib/seo/sitemaps.ts": [
    "getCurrentSitemapMonth",
    "getSitemapIndexXml",
    "getStaticSitemapXml",
  ],
  "src/lib/weekly/week-archive.ts": ["getRecentWeekKeys"],
  "src/lib/sources/karne.ts": ["getKarneFreshnessCached"],
  "src/lib/sources/reliability.ts": ["getReliabilityFreshnessCached"],
};

/**
 * Readers fixed together with this guard or converted by the later sweep. They
 * must stay clean: never an offender, and (a stale-exemption check) never
 * listed in PURE_CACHE_BODIES unless they are one of its pure bodies.
 */
const FIXED_WITH_THE_GUARD = [
  "src/lib/sources/feed-status.ts",
  "src/lib/sources/active-count.ts",
  "src/lib/corrections/public-log.ts",
  "src/lib/quality/snapshots.ts",
  // cached-failure-sweep:
  "src/lib/fact-checks/cluster-fact-checks-query.ts",
  "src/lib/finance/queries.ts",
  "src/lib/finance/quotes.ts",
  "src/lib/headline/status.ts",
  "src/lib/seo/sitemaps.ts",
  "src/lib/weekly/week-archive.ts",
  "src/lib/clusters/framing-receipt.ts",
  "src/app/sources/page.tsx",
  "src/lib/sources/clickbait.ts",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tiny lexer-ish scanner. Returns a string of the SAME length (and the same
// line breaks) as `src` in which every comment and the content of every
// string / template-literal text segment is blanked; quotes and `${ ... }`
// expressions are kept. A quote with no closing partner on its own line (a
// JSX apostrophe) is treated as a plain character so it cannot swallow the
// rest of the file. Regex literals are not modelled.
// ---------------------------------------------------------------------------
function mask(src: string): string {
  const out = src.split("");
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const stack: Array<"T" | { depth: number }> = [];
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    const top = stack[stack.length - 1];

    if (top === "T") {
      if (c === "\\") {
        blank(i, i + 2);
        i += 2;
      } else if (c === "`") {
        stack.pop();
        i += 1;
      } else if (c === "$" && d === "{") {
        stack.push({ depth: 0 });
        i += 2;
      } else {
        blank(i, i + 1);
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
        blank(i + 1, j);
        i = j + 1;
      } else {
        i += 1;
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

// A masked directive line: indentation, a quote pair holding only blanks.
const MASKED_DIRECTIVE = /^[ \t]+(["'])\s+\1;?\s*$/;
// The raw directive: `"use cache"`, optionally `"use cache: remote"` etc.
const RAW_DIRECTIVE = /^[ \t]+["']use cache(?::\s*[a-z-]+)?["'];?\s*$/;

export interface EarlyCacheLifeBody {
  /** Nearest enclosing `function NAME` / `NAME = async`, else `<anonymous>@<line>`. */
  name: string;
  /** The masked body: comments blanked, string contents blanked. */
  body: string;
}

const FUNCTION_NAME_RE = /\bfunction\s+([A-Za-z0-9_$]+)|\b([A-Za-z0-9_$]+)\s*=\s*async\b/g;

/**
 * Name of the function that owns the directive on masked line `lineIdx`: the
 * nearest preceding `function NAME` or `NAME = async`, provided no column-0 `}`
 * line (the end of an earlier top-level body) sits between it and the
 * directive. A `} | null> {` that closes a multi-line return type is not one.
 */
function ownerName(masked: string[], lineIdx: number): string {
  const before = masked.slice(0, lineIdx).join("\n");
  let found: { name: string; end: number } | null = null;
  FUNCTION_NAME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FUNCTION_NAME_RE.exec(before)) !== null) {
    found = { name: (m[1] ?? m[2]) as string, end: m.index + m[0].length };
  }
  if (found && !/^\};?\s*$/m.test(before.slice(found.end))) return found.name;
  return `<anonymous>@${lineIdx + 1}`;
}

/**
 * Every `"use cache"` body in `source` that calls `cacheLife(` before its first
 * `await` (see the file header), with the name of the owning function. A body
 * with no `await` at all counts too: it either delegates the read by returning
 * its promise (`return getX()`, so the outcome is still unknown when the
 * lifetime is fixed) or is a pure computation, and a text scan cannot tell the
 * two apart (PURE_CACHE_BODIES + isPureCacheBody do).
 */
export function findEarlyCacheLife(source: string): EarlyCacheLifeBody[] {
  const raw = source.split("\n");
  const masked = mask(source).split("\n");
  const offenders: EarlyCacheLifeBody[] = [];

  for (let i = 0; i < raw.length; i++) {
    if (!RAW_DIRECTIVE.test(raw[i] ?? "")) continue;
    if (!MASKED_DIRECTIVE.test(masked[i] ?? "")) continue; // inside a comment/string

    const body: string[] = [];
    for (let j = i + 1; j < masked.length; j++) {
      const line = masked[j] ?? "";
      if (/^\}/.test(line)) break;
      body.push(line);
    }
    const text = body.join("\n");

    const awaitAt = text.search(/\bawait\b/);
    const lifeAt = text.search(/\bcacheLife\s*\(/);
    if (lifeAt === -1) continue;
    if (awaitAt === -1 || lifeAt < awaitAt) {
      offenders.push({ name: ownerName(masked, i), body: text });
    }
  }

  return offenders;
}

/** Number of offending bodies in `source` (kept for the scanner self-tests). */
export function countEarlyCacheLife(source: string): number {
  return findEarlyCacheLife(source).length;
}

/**
 * A pure body reads nothing: no `await`, no client factory, no query builder
 * call, no `fetch`, and no call to a `get*` / `fetch*` / `load*` / `read*`
 * helper (the usual names for a delegated read). `body` is already masked, so a
 * word in a comment or a string cannot trip it.
 */
export function isPureCacheBody(maskedBody: string): boolean {
  if (/\bawait\b/.test(maskedBody)) return false;
  if (/\bcreate\w*Client\s*\(/.test(maskedBody)) return false;
  if (/\.(from|rpc|select|insert|update|upsert|delete)\s*\(/.test(maskedBody)) return false;
  if (/\bfetch\s*\(/.test(maskedBody)) return false;
  if (/\b(get|fetch|load|read)[A-Z]\w*\s*\(/.test(maskedBody)) return false;
  return true;
}

const toRel = (file: string) => relative(ROOT, file).split(sep).join("/");

/** Offenders per file, before the PURE exemption. */
function scanRaw(): Record<string, EarlyCacheLifeBody[]> {
  const found: Record<string, EarlyCacheLifeBody[]> = {};
  for (const file of walk(SRC)) {
    const bodies = findEarlyCacheLife(readFileSync(file, "utf8"));
    if (bodies.length > 0) found[toRel(file)] = bodies;
  }
  return found;
}

/** file -> offending function names, minus the PURE bodies that really are pure. */
function scanRepo(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const [file, bodies] of Object.entries(scanRaw())) {
    const pure = new Set(PURE_CACHE_BODIES[file] ?? []);
    const names = bodies
      .filter((b) => !(pure.has(b.name) && isPureCacheBody(b.body)))
      .map((b) => b.name);
    if (names.length > 0) found[file] = names;
  }
  // Stable key order so a failing diff is readable.
  return Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)));
}

describe("scanner self-tests", () => {
  it("flags the old feed-status shape: cacheLife fixed before the query ran", () => {
    const old = `
export async function getSourceItemsPerDay(): Promise<Record<string, number> | null> {
  "use cache";
  cacheLife("source-directory");
  cacheTag("sources");

  try {
    const supabase = createServerClient();
    const { data, error } = await supabase.from("sources").select("slug");
    if (error) return null;
    return toMap(data);
  } catch {
    return null;
  }
}
`;
    expect(countEarlyCacheLife(old)).toBe(1);
  });

  it("passes the timeline shape: cacheTag, attempt, then one cacheLife per outcome", () => {
    const timeline = `
async function getRecentClustersCached() {
  "use cache";
  cacheTag("clusters");
  const r = await attemptCached("timeline", fetchRecentClusters);
  if (r.ok) cacheLife("cluster-feed");
  else cacheLife("minutes");
  return r;
}
`;
    expect(countEarlyCacheLife(timeline)).toBe(0);
  });

  it("counts every offending body in a file, not just the first", () => {
    const two = `
export async function first() {
  "use cache";
  cacheLife("hours");
  return await read();
}

export async function second() {
  "use cache";
  cacheLife("hours");
  return await read();
}

export async function third() {
  "use cache";
  const r = await attemptCached("x", read);
  cacheLife("hours");
  return r;
}
`;
    expect(countEarlyCacheLife(two)).toBe(2);
  });

  it("ignores a column-0 (file-level) directive", () => {
    const fileLevel = `"use cache";
export async function f() {
  cacheLife("hours");
  return await read();
}
`;
    expect(countEarlyCacheLife(fileLevel)).toBe(0);
  });

  it("counts a body with no await: a delegated read still has its lifetime fixed up front", () => {
    const delegated = `
export async function getCachedReceipt(id: string) {
  "use cache";
  cacheLife("cluster-feed");
  cacheTag("clusters");
  return getReceipt(id);
}
`;
    expect(countEarlyCacheLife(delegated)).toBe(1);
  });

  it("does not count a body that never calls cacheLife", () => {
    const noLife = `
export async function f() {
  "use cache";
  cacheTag("x");
  return await read();
}
`;
    expect(countEarlyCacheLife(noLife)).toBe(0);
  });

  it("ignores cacheLife( and await mentioned in comments or strings", () => {
    const decoys = `
async function ok() {
  "use cache";
  // cacheLife("source-directory") would go wrong here
  /* cacheLife("hours") */
  const label = "cacheLife(x)";
  const r = await attemptCached(label, read);
  if (r.ok) cacheLife("hours");
  else cacheLife("minutes");
  return r;
}

async function stillBad() {
  "use cache";
  const note = "await is only a word here";
  // await in a comment
  cacheLife("hours");
  return await read();
}
`;
    expect(countEarlyCacheLife(decoys)).toBe(1);
  });

  it("a directive inside a comment is not a directive", () => {
    const commented = `
/*
  Example of the old shape:
    "use cache";
    cacheLife("hours");
*/
async function f() {
  cacheLife("hours");
  return await read();
}
`;
    expect(countEarlyCacheLife(commented)).toBe(0);
  });

  it("stops the body at the first column-0 closing brace", () => {
    const twoFns = `
async function a() {
  "use cache";
  const r = await attemptCached("a", read);
  cacheLife("hours");
  return r;
}

async function b() {
  cacheLife("hours");
  return await read();
}
`;
    // b has no directive: its early cacheLife is not part of a's body.
    expect(countEarlyCacheLife(twoFns)).toBe(0);
  });
});

describe("owner names and purity (scanner self-tests)", () => {
  it("names a body after its `function NAME` (exported, async or not)", () => {
    const src = `
export async function getAlpha() {
  "use cache";
  cacheLife("hours");
  return 1;
}
`;
    expect(findEarlyCacheLife(src).map((b) => b.name)).toEqual(["getAlpha"]);
  });

  it("names a body after `NAME = async` for an arrow function", () => {
    const src = `
const getBeta = async (id: string) => {
  "use cache";
  cacheLife("hours");
  return id;
};
`;
    // The arrow's closing brace is `};` at column 0, which is also where the
    // body scan stops, so the directive line is the whole story here.
    expect(findEarlyCacheLife(src).map((b) => b.name)).toEqual(["getBeta"]);
  });

  it("uses the nearest preceding name, not the first in the file", () => {
    const src = `
async function first() {
  "use cache";
  const r = await attemptCached("a", read);
  if (r.ok) cacheLife("hours");
  else cacheLife("minutes");
  return r;
}

async function second() {
  "use cache";
  cacheLife("hours");
  return read();
}
`;
    expect(findEarlyCacheLife(src).map((b) => b.name)).toEqual(["second"]);
  });

  it("falls back to <anonymous>@line when no function owns the directive", () => {
    const src = `
async function closed() {
  return 1;
}

export default async () => {
  "use cache";
  cacheLife("hours");
  return read();
};
`;
    const found = findEarlyCacheLife(src);
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe("<anonymous>@7");
  });

  it("does not take a name from a comment or a string", () => {
    const src = `
// function fromComment() {}
const label = "function fromString() {}";
export default async () => {
  "use cache";
  cacheLife("hours");
  return read();
};
`;
    expect(findEarlyCacheLife(src)[0]!.name).toMatch(/^<anonymous>@\d+$/);
  });

  it("passes the karne freshness body: a clock read and a pure computation", () => {
    const src = `
async function getKarneFreshnessCached(
  computedAt: string,
): Promise<SourceKarneFreshness> {
  "use cache";
  cacheLife("hours");
  return karneFreshness(computedAt, Date.now());
}
`;
    const found = findEarlyCacheLife(src);
    expect(found.map((b) => b.name)).toEqual(["getKarneFreshnessCached"]);
    expect(isPureCacheBody(found[0]!.body)).toBe(true);
  });

  it("rejects a body with an await", () => {
    expect(isPureCacheBody("\n  cacheLife('x');\n  const v = await thing();\n")).toBe(false);
  });

  it("rejects a body that builds a client or runs a query", () => {
    expect(isPureCacheBody("\n  const s = createReaderClient();\n  return 1;")).toBe(false);
    expect(isPureCacheBody("\n  return supabase.from(\"t\").select(\"*\");")).toBe(false);
    expect(isPureCacheBody("\n  return supabase.rpc(\"f\");")).toBe(false);
    expect(isPureCacheBody("\n  return fetch(url);")).toBe(false);
  });

  it("rejects a body that calls a get/fetch/load/read helper (a delegated read)", () => {
    expect(isPureCacheBody("\n  return getX(id);")).toBe(false);
    expect(isPureCacheBody("\n  return fetchThing();")).toBe(false);
    expect(isPureCacheBody("\n  return loadRows();")).toBe(false);
    expect(isPureCacheBody("\n  return readRow(id);")).toBe(false);
  });

  it("does not mistake a word in a longer identifier or a comment for a read", () => {
    // `budget(` and `widget(` contain no get/fetch/load/read + Capital call.
    expect(isPureCacheBody("\n  return budget(widget(1));")).toBe(true);
  });
});

describe("cacheLife is decided after the read in every \"use cache\" body", () => {
  const found = scanRepo();

  it("has no offender at all: the ratchet is empty", () => {
    expect(found).toEqual({});
  });

  it("keeps the converted readers clean", () => {
    for (const file of FIXED_WITH_THE_GUARD) {
      expect(found, file).not.toHaveProperty([file]);
    }
  });

  it("lists the fixed readers as files that exist", () => {
    for (const file of FIXED_WITH_THE_GUARD) {
      expect(() => statSync(resolve(ROOT, file)), file).not.toThrow();
    }
  });

  it("only exempts files that exist", () => {
    for (const file of Object.keys(PURE_CACHE_BODIES)) {
      expect(() => statSync(resolve(ROOT, file)), file).not.toThrow();
    }
  });

  it("every exempt name exists and is still pure (a pure body that gains a read fails here)", () => {
    const raw = scanRaw();
    for (const [file, names] of Object.entries(PURE_CACHE_BODIES)) {
      const bodies = raw[file] ?? [];
      for (const name of names) {
        const hit = bodies.find((b) => b.name === name);
        expect(hit, `${file}: ${name} is not an early-cacheLife body (stale exemption: remove it)`).toBeDefined();
        expect(isPureCacheBody(hit!.body), `${file}: ${name} is no longer pure`).toBe(true);
      }
    }
  });
});
