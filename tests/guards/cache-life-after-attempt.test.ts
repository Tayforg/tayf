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
// Ratchet: functions that predate this guard and still decide the lifetime up
// front are listed in KNOWN_EARLY_CACHELIFE with the number of offending
// bodies per file. The table is compared with `toEqual`, so it can only
// shrink: fixing a file makes the comparison fail until its entry is removed,
// and a new offender fails until a reviewer consciously adds it. Do not add
// entries; convert the function to the shape above instead.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SRC = resolve(ROOT, "src");

/**
 * Repo-relative path (posix separators) -> number of offending bodies.
 * Entries are debt, not a licence: convert the function, then delete the line.
 */
const KNOWN_EARLY_CACHELIFE: Record<string, number> = {
  // Not audited yet: the lifetime is fixed before the read runs.
  "src/lib/fact-checks/cluster-fact-checks-query.ts": 1,
  "src/lib/finance/queries.ts": 11,
  "src/lib/finance/quotes.ts": 1,
  "src/lib/headline/status.ts": 1,
  "src/lib/seo/sitemaps.ts": 6,
  "src/lib/weekly/week-archive.ts": 2,
  // Delegated read: `return getClusterFramingReceipt(id)` after cacheLife.
  "src/lib/clusters/framing-receipt.ts": 1,
  // Throw-based fetchers (a throw is never memoised, but a throw out of a
  // "use cache" body is the build hazard documented in cache-resilience.ts).
  "src/app/sources/page.tsx": 1,
  "src/lib/sources/clickbait.ts": 1,
  // Pure bodies (one clock read, nothing that can fail). A text scan cannot
  // tell them from a delegated read; they stay listed rather than exempted.
  "src/lib/sources/karne.ts": 1,
  "src/lib/sources/reliability.ts": 1,
};

/** The four readers fixed together with this guard. They must stay clean. */
const FIXED_WITH_THE_GUARD = [
  "src/lib/sources/feed-status.ts",
  "src/lib/sources/active-count.ts",
  "src/lib/corrections/public-log.ts",
  "src/lib/quality/snapshots.ts",
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

/**
 * Number of `"use cache"` bodies in `source` that call `cacheLife(` before
 * their first `await` (see the file header). A body with no `await` at all
 * counts too: it either delegates the read by returning its promise
 * (`return getX()`, so the outcome is still unknown when the lifetime is
 * fixed) or is a pure computation, and a text scan cannot tell the two apart.
 */
export function countEarlyCacheLife(source: string): number {
  const raw = source.split("\n");
  const masked = mask(source).split("\n");
  let offenders = 0;

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
    if (awaitAt === -1 || lifeAt < awaitAt) offenders += 1;
  }

  return offenders;
}

function scanRepo(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of walk(SRC)) {
    const count = countEarlyCacheLife(readFileSync(file, "utf8"));
    if (count > 0) found[relative(ROOT, file).split(sep).join("/")] = count;
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

describe("cacheLife is decided after the read in every \"use cache\" body", () => {
  const found = scanRepo();

  it("matches the ratchet exactly (it can only shrink)", () => {
    expect(found).toEqual(KNOWN_EARLY_CACHELIFE);
  });

  it("keeps the readers fixed with this guard clean", () => {
    for (const file of FIXED_WITH_THE_GUARD) {
      expect(found, file).not.toHaveProperty([file]);
      expect(KNOWN_EARLY_CACHELIFE, file).not.toHaveProperty([file]);
    }
  });

  it("only lists files that exist", () => {
    for (const file of Object.keys(KNOWN_EARLY_CACHELIFE)) {
      expect(() => statSync(resolve(ROOT, file)), file).not.toThrow();
    }
  });
});
