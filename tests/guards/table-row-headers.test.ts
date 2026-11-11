import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// h126-a11y-2: public data tables have row headers.
//
// /kaynaklar/durum (118 rows x 7 columns), /kalite, /metodoloji and /gelistirici
// rendered the cell that names each row as a <td>. A screen reader moving down a
// column then announced "Son haber, 16 Haziran 2026" with no source name, on a
// page whose whole purpose is per-source status (WCAG 1.3.1, technique H63,
// failure F91). axe has no rule for it, which is why the earlier a11y passes
// missed it. The naming cell is now <th scope="row"> (src/app/trends/page.tsx
// has been the reference pattern since the chart text alternative).
//
// Rule: every non-test source file under src/app (the admin tree is out of
// scope) that contains a "<table" declares at least as many scope="row" cells as
// it has "<table" openings, so a second table added to a file that already has
// one cannot ride on the first table's row headers. A table that genuinely has
// no row-naming cell (a one-row key/value strip, say) needs a reviewed line
// comment in the same file:
//
//   // table-row-headers: exempt — <reason>
//
// The reason after the em dash is mandatory. Each exempt comment covers exactly
// one table (a file with two tables and one comment still fails), and a
// scope="row" that only appears inside a comment is not a row header.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const APP_DIR = "src/app";
const ADMIN_PREFIX = "src/app/admin/";

const TABLE_OPEN = /<table\b/g;
// `scope` must be the whole attribute name; every JSX spelling of the value.
const ROW_SCOPE = /(?<![\w-])scope\s*=\s*(?:\{\s*)?["'`]row["'`]/g;
// Same line only (`[ \t]`, never `\s`), and the reason may not be just a comment closer.
const EXEMPT = /table-row-headers:[ \t]*exempt[ \t]*—[ \t]*[^\s*/]/g;
// Comments are stripped before scope="row" is counted, so a note that quotes the
// attribute is not a row header. Only these three forms are removed: a general
// `/* ... */` strip would pair the `/*` of the JSX text `/api/v1/*`
// (src/app/gelistirici/page.tsx) with a later `*/` and swallow real cells.
const COMMENTS = [
  /\{\s*\/\*[\s\S]*?\*\/\s*\}/g, // JSX comment {/* ... */}
  /^[ \t]*\/\*[\s\S]*?\*\//gm, // block comment that starts a line
  /^[ \t]*\/\/.*$/gm, // whole-line // comment
];

function stripComments(src: string): string {
  return COMMENTS.reduce((out, re) => out.replace(re, ""), src);
}

/** What is wrong with `src`'s tables, or null when it is fine. */
export function rowHeaderProblem(src: string): string | null {
  const tables = src.match(TABLE_OPEN)?.length ?? 0;
  if (tables === 0) return null;
  // Exemptions are counted on the raw source (they live in comments); each one
  // covers one table.
  const exemptions = src.match(EXEMPT)?.length ?? 0;
  const rowHeaders = stripComments(src).match(ROW_SCOPE)?.length ?? 0;
  if (rowHeaders + exemptions >= tables) return null;
  const exempt = exemptions > 0 ? ` + ${exemptions} exempt` : "";
  return `${tables} <table> but ${rowHeaders} scope="row"${exempt}`;
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

describe("public tables have row headers (src/app, admin excluded)", () => {
  const rel = (f: string): string => relative(ROOT, f).split(sep).join("/");
  const files = walk(resolve(ROOT, APP_DIR))
    .filter((f) => !rel(f).startsWith(ADMIN_PREFIX))
    .sort();
  const withTables = files.filter((f) => /<table\b/.test(readFileSync(f, "utf8")));

  it("scans every public page that renders a table", () => {
    expect(withTables.map(rel)).toEqual(
      expect.arrayContaining([
        "src/app/kaynaklar/durum/page.tsx",
        "src/app/kalite/page.tsx",
        "src/app/metodoloji/page.tsx",
        "src/app/gelistirici/page.tsx",
        "src/app/trends/page.tsx",
      ]),
    );
  });

  it("never scans the admin tree", () => {
    expect(files.filter((f) => rel(f).startsWith(ADMIN_PREFIX))).toEqual([]);
  });

  it("every file with a <table> declares a scope=\"row\" cell per table, or an exempt comment", () => {
    const offenders = withTables.flatMap((f) => {
      const problem = rowHeaderProblem(readFileSync(f, "utf8"));
      return problem === null ? [] : [`${rel(f)}: ${problem}`];
    });
    expect(offenders).toEqual([]);
  });
});

describe("rowHeaderProblem (mutation checks on synthetic sources)", () => {
  const table = (cell: string): string =>
    `<table><tbody><tr>${cell}<td>x</td></tr></tbody></table>`;

  it("flags a table whose naming cell is a td", () => {
    expect(rowHeaderProblem(table("<td>Kaynak</td>"))).toBe('1 <table> but 0 scope="row"');
  });

  it("accepts a table whose naming cell is th scope=row, in every JSX spelling", () => {
    for (const attr of [`scope="row"`, `scope='row'`, `scope={"row"}`, "scope={`row`}", `scope = "row"`]) {
      expect(rowHeaderProblem(table(`<th ${attr}>Kaynak</th>`)), attr).toBeNull();
    }
  });

  it("flags a column-only scope and a look-alike attribute", () => {
    expect(rowHeaderProblem(table(`<th scope="col">Kaynak</th>`))).not.toBeNull();
    expect(rowHeaderProblem(table(`<th data-scope="row">Kaynak</th>`))).not.toBeNull();
    expect(rowHeaderProblem(table(`<th colscope="row">Kaynak</th>`))).not.toBeNull();
  });

  it("a second table in the same file needs its own scope=row", () => {
    const one = table(`<th scope="row">A</th>`);
    expect(rowHeaderProblem(one)).toBeNull();
    expect(rowHeaderProblem(one + table("<td>B</td>"))).toBe('2 <table> but 1 scope="row"');
    expect(rowHeaderProblem(one + table(`<th scope="row">B</th>`))).toBeNull();
  });

  it("ignores a file with no table", () => {
    expect(rowHeaderProblem(`<div role="grid"><th>x</th></div>`)).toBeNull();
  });

  it("honours a line comment with a reason, and rejects one without", () => {
    const exempt = `// table-row-headers: exempt — one-row strip, the column header names every cell\n`;
    expect(rowHeaderProblem(exempt + table("<td>x</td>"))).toBeNull();
    expect(
      rowHeaderProblem(`{/* table-row-headers: exempt — key/value pairs only */}` + table("<td>x</td>")),
    ).toBeNull();
    expect(rowHeaderProblem(`// table-row-headers: exempt —\n` + table("<td>x</td>"))).not.toBeNull();
    expect(rowHeaderProblem(`{/* table-row-headers: exempt — */}` + table("<td>x</td>"))).not.toBeNull();
    expect(rowHeaderProblem(`// table-row-headers: exempt\n` + table("<td>x</td>"))).not.toBeNull();
    expect(rowHeaderProblem(`// exempt — because\n` + table("<td>x</td>"))).not.toBeNull();
  });

  it("an exempt comment covers one table, not the whole file", () => {
    const exempt = `// table-row-headers: exempt — one-row strip\n`;
    expect(rowHeaderProblem(exempt + table("<td>a</td>") + table("<td>b</td>"))).toBe(
      '2 <table> but 0 scope="row" + 1 exempt',
    );
    expect(rowHeaderProblem(exempt + exempt + table("<td>a</td>") + table("<td>b</td>"))).toBeNull();
    // exemptions and row headers add up: one of each covers two tables
    expect(
      rowHeaderProblem(exempt + table(`<th scope="row">a</th>`) + table("<td>b</td>")),
    ).toBeNull();
  });

  it("does not count a scope=row that only appears in a comment", () => {
    expect(rowHeaderProblem(`{/* use <th scope="row"> here */}` + table("<td>a</td>"))).toBe(
      '1 <table> but 0 scope="row"',
    );
    expect(rowHeaderProblem(`// cell is scope="row"\n` + table("<td>a</td>"))).not.toBeNull();
    expect(rowHeaderProblem(`  /* cell is scope="row" */\n` + table("<td>a</td>"))).not.toBeNull();
    expect(
      rowHeaderProblem(`/*\n * every cell is scope="row"\n */\n` + table("<td>a</td>")),
    ).not.toBeNull();
    // a comment next to a real row header does not hide it
    expect(
      rowHeaderProblem(`// scope="row" below\n` + table(`<th scope="row">a</th>`)),
    ).toBeNull();
  });

  it("does not mistake JSX text containing /* for a comment (gelistirici: /api/v1/*)", () => {
    const withGlob = `<p>Her <code>/api/v1/*</code> istegi</p>\n`;
    expect(rowHeaderProblem(withGlob + table(`<th scope="row">a</th>`))).toBeNull();
    // a second `*/` later in the file must not pair with the glob and swallow the cell
    expect(
      rowHeaderProblem(
        withGlob + table(`<th scope="row">a</th>`) + `{/* note */}\n` + `<p>x</p>`,
      ),
    ).toBeNull();
  });
});
