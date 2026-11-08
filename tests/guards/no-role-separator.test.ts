import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// h67-landmarks-3: the layout chrome has no role="separator".
//
// The header drew 0 px "dividers" between the Ana menü links and inside the
// logo link as separator-role spans. A screen reader announced "separator"
// between nav items and split the logo link's reading in browse mode, for a
// divider that is invisible anyway. They are now aria-hidden decoration (the
// spans stay: their mx-0.5 margin is the nav spacing).
//
// Rule: no non-test file under src/components/layout declares a separator role,
// in any JSX spelling (role="separator", role='separator', role={"separator"},
// role={`separator`}). A real section boundary in the layout would need its own
// reviewed exception here, not a silent re-add.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const LAYOUT_DIR = "src/components/layout";

// `role` must be the whole attribute name: `data-role="separator"` is not a role.
const SEPARATOR_ROLE = /(?<![\w-])role\s*=\s*(?:\{\s*)?["'`]\s*separator\s*["'`]/;

/** 1-based line numbers of every separator-role declaration in `src`. */
export function separatorRoleLines(src: string): number[] {
  return src
    .split("\n")
    .flatMap((line, i) => (SEPARATOR_ROLE.test(line) ? [i + 1] : []));
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

describe("no role=separator under src/components/layout", () => {
  const files = walk(resolve(ROOT, LAYOUT_DIR)).sort();
  const rel = (f: string): string => relative(ROOT, f).split(sep).join("/");

  it("scans the header, nav and footer sources", () => {
    expect(files.map(rel)).toEqual(
      expect.arrayContaining([
        "src/components/layout/header.tsx",
        "src/components/layout/nav-links.tsx",
        "src/components/layout/footer.tsx",
      ]),
    );
  });

  it("no non-test layout source declares a separator role (file:line)", () => {
    const offenders = files.flatMap((f) =>
      separatorRoleLines(readFileSync(f, "utf8")).map((line) => `${rel(f)}:${line}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("separatorRoleLines (mutation checks on synthetic sources)", () => {
  it("reports each JSX spelling of a separator role", () => {
    const src = [
      `<span role="separator" />`,
      `<span role='separator' />`,
      `<span role={"separator"} />`,
      "<span role={`separator`} />",
      `<span role = "separator" />`,
    ].join("\n");
    expect(separatorRoleLines(src)).toEqual([1, 2, 3, 4, 5]);
  });

  it("reports a role attribute split from the element's first line", () => {
    const src = `<span\n  className="x"\n  role="separator"\n  aria-orientation="vertical"\n/>`;
    expect(separatorRoleLines(src)).toEqual([3]);
  });

  it("accepts aria-hidden decoration and other roles", () => {
    const src = [
      `<span aria-hidden="true" className="h-3 mx-0.5 shrink-0 bg-border" />`,
      `<nav role="navigation" aria-label="x" />`,
      `<div data-role="separator" />`,
      `const label = "separator";`,
    ].join("\n");
    expect(separatorRoleLines(src)).toEqual([]);
  });
});
