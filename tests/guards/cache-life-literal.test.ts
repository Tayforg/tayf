import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard: Next 16.4 declares `cacheLife` as one overload per
// profile literal ("minutes", "hours", "cluster-feed", ...). A computed
// argument such as `cacheLife(r.ok ? "cluster-feed" : "minutes")` matches no
// overload, but vitest and a plain `tsc --noEmit` (before `.next/types` is
// generated) both miss it -- only `next build` fails. Branch instead, keeping
// exactly one call per cached invocation:
//   if (r.ok) cacheLife("cluster-feed");
//   else cacheLife("minutes");
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "../../src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("cacheLife never takes a conditional argument", () => {
  it("has no ternary/logical cacheLife argument in src/", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        const m = /\bcacheLife\(([^)]*)\)/.exec(line);
        if (!m) return;
        // Literals, inline profile objects and named profile constants
        // (FEED_CACHE) type-check; a conditional argument does not.
        if (!/\?|\|\||&&/.test(m[1])) return;
        offenders.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
