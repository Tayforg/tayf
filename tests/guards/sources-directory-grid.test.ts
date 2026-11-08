import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// h73-breakpoints-3: the /sources directory goes to 3 columns at 768 px, not 640.
//
// At exactly 640 px the old `sm:grid-cols-3` cut each card from 298 px to
// 195 px: 40 outlet and owner names ended in an ellipsis and 85 of 118
// "son 7 günde N haber" lines wrapped, so the names the directory exists to
// show were hidden across 640-767 px. `md:grid-cols-3` keeps two roomy columns
// until 768 px (cards of about 237 px at 3 columns).
//
// The loaded directory (page.tsx), its Suspense skeleton and the route loading
// UI (loading.tsx) must keep the same grid classes so the columns never shift
// when the real cards stream in or one placeholder swaps for the next.
//
// Source-text guard, no render of the async server page. Comments are
// stripped first so prose cannot satisfy (or trip) an assertion.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");

const FILES = [
  "src/app/sources/page.tsx",
  "src/app/sources/source-directory-skeleton.tsx",
  "src/app/sources/loading.tsx",
] as const;

const GRID_CLASSES =
  "grid grid-cols-1 min-[480px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3";

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function read(rel: string): string {
  return stripComments(readFileSync(resolve(ROOT, rel), "utf8"));
}

/** Every className string literal in `src` that belongs to the directory grid. */
export function directoryGridClassNames(src: string): string[] {
  return [...src.matchAll(/className="([^"]*)"/g)]
    .map((m) => m[1]!)
    .filter((cls) => cls.split(/\s+/).includes("min-[480px]:grid-cols-2"));
}

describe("directoryGridClassNames", () => {
  it("picks only the className that carries the 480 px two-column step", () => {
    const src = `<div className="a b"/><div className="grid min-[480px]:grid-cols-2 x"/>`;
    expect(directoryGridClassNames(src)).toEqual([
      "grid min-[480px]:grid-cols-2 x",
    ]);
  });

  it("finds nothing in a file without the directory grid", () => {
    expect(directoryGridClassNames(`<div className="grid grid-cols-2"/>`)).toEqual(
      [],
    );
  });
});

describe("/sources directory grid breakpoint", () => {
  it.each(FILES)("%s declares exactly one directory grid with the literal classes", (rel) => {
    const grids = directoryGridClassNames(read(rel));
    expect(grids).toEqual([GRID_CLASSES]);
  });

  it.each(FILES)("%s does not step to 3 columns at sm (640 px)", (rel) => {
    const [grid] = directoryGridClassNames(read(rel));
    expect(grid).toBeDefined();
    const tokens = grid!.split(/\s+/);
    expect(tokens).not.toContain("sm:grid-cols-3");
    expect(tokens).toContain("md:grid-cols-3");
    expect(read(rel)).not.toContain("sm:grid-cols-3");
  });

  it("the skeleton, the route loading UI and the loaded directory use identical grid classes, so streaming never shifts the layout", () => {
    const [page] = directoryGridClassNames(read(FILES[0]));
    const [skeleton] = directoryGridClassNames(read(FILES[1]));
    const [loading] = directoryGridClassNames(read(FILES[2]));
    expect(page).toBeDefined();
    expect(skeleton).toBe(page);
    expect(loading).toBe(page);
  });
});
