import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (cold-read resilience): the 4 s reader cap
// (`createReaderClient`, src/lib/supabase/server.ts) is for user-facing reads.
// The shared fetchers that BOTH pages and crons use -- getPoliticsClusters,
// getBlindspots, getAlertItems -- default to that cap, so every call from a
// cron route must opt out with `{ profile: "batch" }`. A cron that forgets
// aborts at 4 s on a cold Micro database where the 8 s statement_timeout
// would have let it finish (the weekly digest then sends nothing until the
// next Saturday). Route tests pin today's three crons; this sweep catches the
// next one.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const CRON_DIR = resolve(here, "../../src/app/api/cron");

const SHARED_READERS = ["getPoliticsClusters", "getBlindspots", "getAlertItems"];

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
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) =>
      p1 + " ".repeat(m.length - p1.length),
    );
}

/** Text between the `(` at `open` and its matching `)`. */
function callArgs(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

interface Violation {
  file: string;
  fn: string;
  args: string;
}

function sweep(): Violation[] {
  const violations: Violation[] = [];
  for (const file of walk(CRON_DIR)) {
    const src = blankComments(readFileSync(file, "utf8"));
    for (const fn of SHARED_READERS) {
      const re = new RegExp(`\\b${fn}\\s*\\(`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const args = callArgs(src, m.index + m[0].length - 1);
        if (!/profile\s*:\s*["']batch["']/.test(args)) {
          violations.push({
            file: relative(CRON_DIR, file),
            fn,
            args: args.trim().slice(0, 80),
          });
        }
      }
    }
  }
  return violations;
}

describe("cron routes keep the uncapped read profile", () => {
  it("finds the crons that call the shared readers (the sweep is not vacuous)", () => {
    const files = walk(CRON_DIR);
    const callers = files.filter((f) =>
      SHARED_READERS.some((fn) =>
        new RegExp(`\\b${fn}\\s*\\(`).test(blankComments(readFileSync(f, "utf8"))),
      ),
    );
    // digest (politics + blindspots), social (both), alerts-webhooks (alerts).
    expect(callers.length).toBeGreaterThanOrEqual(3);
  });

  it('every cron call to getPoliticsClusters / getBlindspots / getAlertItems passes { profile: "batch" }', () => {
    expect(sweep()).toEqual([]);
  });
});
