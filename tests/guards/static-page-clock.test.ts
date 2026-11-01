import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

// A fully static App Router page (it exports generateStaticParams, never reads
// searchParams and never awaits connection()) is prerendered at build time.
// Under cacheComponents a clock read in its render body -- Date.now(),
// new Date() or the currentTimeMs() wrapper -- fails `next build` with
// "Next.js encountered the unstable value `Date.now()` while prerendering",
// but ONLY once the page's cached data read succeeds: a failed read takes the
// retry path, which awaits the request scope first and so hides the bug. That
// is how #138 shipped /gundem/[key] green locally (migration 123 not yet
// applied, read failed) and broke the Vercel build after it was applied.
// Such pages must take "now" from a timestamp stamped inside the cache scope
// (see EntityHub.asOfMs in src/lib/entities/entity-hub-query.ts).
// Complements tests/guards/cache-retry-prerender.test.ts (the retry path).

const ROOT = join(__dirname, "..", "..");
const APP = join(ROOT, "src", "app");

function pageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...pageFiles(full));
    else if (name === "page.tsx") out.push(full);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** True when the page is fully static in the sense above. */
function isFullyStatic(src: string): boolean {
  const code = stripComments(src);
  return (
    /export\s+(async\s+)?function\s+generateStaticParams\b/.test(code) &&
    !/\bsearchParams\b/.test(code) &&
    !/await\s+connection\(\s*\)/.test(code)
  );
}

/** Clock reads in code (comments excluded). `new Date(x)` with an argument is fine. */
function clockReads(src: string): string[] {
  const code = stripComments(src);
  return code.match(/\bDate\.now\(\s*\)|\bnew Date\(\s*\)|\bcurrentTimeMs\(\s*\)/g) ?? [];
}

/**
 * Clock-reading components a static page may render only with an explicit
 * "now" prop. ClusterCard's time-ago badge falls back to Date.now() when
 * `nowMs` is omitted (src/components/story/cluster-card.tsx).
 */
const NEEDS_NOW_PROP: ReadonlyArray<{ tag: string; prop: string }> = [
  { tag: "ClusterCard", prop: "nowMs" },
];

/**
 * JSX elements of `tag` missing `prop=`. Scans each opening tag to its end by
 * brace depth, so a `>` inside an expression prop (`isAging={hoursAgo > 48}`)
 * does not end the element early.
 */
function elementsMissingProp(src: string, tag: string, prop: string): number {
  const code = stripComments(src);
  const open = new RegExp(`<${tag}\\b`, "g");
  const hasProp = new RegExp(`\\b${prop}=`);
  let missing = 0;
  for (const m of code.matchAll(open)) {
    let depth = 0;
    let end = (m.index ?? 0) + m[0].length;
    for (; end < code.length; end++) {
      const ch = code[end];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
    }
    if (!hasProp.test(code.slice(m.index ?? 0, end))) missing++;
  }
  return missing;
}

describe("static pages never read the clock during prerender", () => {
  const offenders = pageFiles(APP)
    .map((file) => ({ file: relative(ROOT, file), src: readFileSync(file, "utf8") }))
    .filter(({ src }) => isFullyStatic(src))
    .map(({ file, src }) => ({ file, reads: clockReads(src) }))
    .filter(({ reads }) => reads.length > 0);

  it("finds no clock read in a fully static page", () => {
    expect(offenders).toEqual([]);
  });

  it("passes an explicit now to clock-reading components in fully static pages", () => {
    const missing = pageFiles(APP)
      .map((file) => ({ file: relative(ROOT, file), src: readFileSync(file, "utf8") }))
      .filter(({ src }) => isFullyStatic(src))
      .flatMap(({ file, src }) =>
        NEEDS_NOW_PROP.map(({ tag, prop }) => ({ file, tag, missing: elementsMissingProp(src, tag, prop) })),
      )
      .filter((x) => x.missing > 0);
    expect(missing).toEqual([]);
  });

  it("covers /gundem/[key] (the page that broke the #138 build)", () => {
    const src = readFileSync(join(APP, "gundem", "[key]", "page.tsx"), "utf8");
    expect(isFullyStatic(src)).toBe(true);
    expect(clockReads(src)).toEqual([]);
  });
});

describe("guard self-tests", () => {
  const staticPage = `export async function generateStaticParams() { return []; }
export default async function Page() { const nowMs = currentTimeMs(); return nowMs; }`;

  it("flags currentTimeMs(), Date.now() and new Date() in a static page", () => {
    expect(isFullyStatic(staticPage)).toBe(true);
    expect(clockReads(staticPage)).toEqual(["currentTimeMs()"]);
    expect(clockReads("const a = Date.now(); const b = new Date();")).toEqual(["Date.now()", "new Date()"]);
  });

  it("ignores comments and dated constructors", () => {
    expect(clockReads("// Date.now() here\n/* currentTimeMs() */ new Date(row.updated_at)")).toEqual([]);
  });

  it("flags a ClusterCard without nowMs and accepts one with it", () => {
    expect(elementsMissingProp('<ClusterCard cluster={c} index={i} />', "ClusterCard", "nowMs")).toBe(1);
    expect(elementsMissingProp('<ClusterCard cluster={c}\n  nowMs={nowMs}\n/>', "ClusterCard", "nowMs")).toBe(0);
    // a ">" inside an expression prop must not end the element early
    expect(elementsMissingProp('<ClusterCard isAging={h > 48} nowMs={n} />', "ClusterCard", "nowMs")).toBe(0);
    expect(elementsMissingProp('<ClusterCard isAging={h > 48} />', "ClusterCard", "nowMs")).toBe(1);
  });

  it("treats searchParams or await connection() as dynamic", () => {
    expect(isFullyStatic(staticPage.replace("Page()", "Page({ searchParams })"))).toBe(false);
    expect(isFullyStatic(staticPage.replace("const nowMs", "await connection(); const nowMs"))).toBe(false);
    expect(isFullyStatic("export default async function Page() { return Date.now(); }")).toBe(false);
  });
});
