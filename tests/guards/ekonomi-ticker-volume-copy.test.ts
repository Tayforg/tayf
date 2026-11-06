import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, relative } from "node:path";

// ---------------------------------------------------------------------------
// h51-morphology-2: the /ekonomi/<ticker> header read
//   "hacim 1,9x 20 günlük ortalamanın · 05.11 seansı"
// The genitive "ortalamanın" had no head noun ("katı"), and "1,9x" cannot
// stand in for it. /trends writes it correctly ("7 günlük ortalamanın 3,1
// katı"). The header now reads "hacim 20 günlük ortalamanın 1,9 katı", and the
// words come from ONE place, rvolPhrase / rvolParts in src/lib/finance/
// session.ts, so no surface can print the ratio with different wording.
//
// Static on purpose: the page is an async server component, which this repo
// does not render in tests.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "../../src");
const PAGE = resolve(SRC, "app/ekonomi/[ticker]/page.tsx");
const HELPER = resolve(SRC, "lib/finance/session.ts");

const BASIS = "20 günlük ortalamanın";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("/ekonomi/<ticker> header volume line", () => {
  const page = readFileSync(PAGE, "utf8");

  it("no longer hard-codes the dangling '20 günlük ortalamanın' + day label markup", () => {
    expect(page).not.toContain("20 günlük ortalamanın{volume.dayLabel");
  });

  it("holds none of the wording itself: no 'günlük ortalamanın' literal in the page", () => {
    expect(page).not.toContain("günlük ortalamanın");
  });

  it("no longer prints the ratio in the 'x' form, which cannot head the genitive", () => {
    expect(page).not.toMatch(/\bfmtX\b/);
  });

  it("takes its wording from the finance libs: imports rvolPhrase from session or format", () => {
    expect(page).toMatch(/import\s*\{[^}]*\brvolPhrase\b[^}]*\}\s*from\s*"@\/lib\/finance\/(session|format)"/);
  });

  it("renders the colour split from rvolParts, so the pieces are the helper's", () => {
    expect(page).toMatch(/import\s*\{[^}]*\brvolParts\b[^}]*\}\s*from\s*"@\/lib\/finance\/session"/);
    expect(page).toMatch(/\brvolParts\(/);
    expect(page).toMatch(/\brvolPhrase\(/);
  });
});

describe("the 20-day volume wording has one source", () => {
  it("'20 günlük ortalamanın' appears in src/lib/finance/session.ts and nowhere else outside tests", () => {
    const offenders = walk(SRC)
      .filter((file) => file !== HELPER)
      .filter((file) => readFileSync(file, "utf8").includes(BASIS))
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
    expect(readFileSync(HELPER, "utf8")).toContain(BASIS);
  });
});
