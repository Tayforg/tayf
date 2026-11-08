import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// h65-keyboard-2: every <nav> landmark carries an accessible name.
//
// The site already names its two global landmarks ("Ana menü" in the header,
// "Alt menü" in the footer). A page that adds a third <nav> with no name leaves
// a screen-reader user who lists or jumps between landmarks with an anonymous
// "navigation" next to two named ones: /source/<slug> wrapped a single back
// link in a bare <nav>, and the /ekonomi/<ticker> breadcrumb had no label.
//
// Rule: in every non-test .tsx under src/app and src/components, the opening
// tag of each `<nav` JSX element must carry `aria-label=` or `aria-labelledby=`
// as an attribute of its own.
//
// This is a character-scan guard, in the style of scroll-region-focus.test.ts:
// comments are blanked first (a comment that mentions `<nav>` is not a
// landmark), then the opening tag is walked to its closing `>` at brace depth
// 0 outside quotes, so attributes may span lines and contain `>` inside a
// template literal or an arrow function. The attribute check runs on a
// skeleton of the tag with quoted and braced contents blanked, so a
// className string or a child element's own label cannot satisfy it.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SCANNED_DIRS = ["src/app", "src/components"] as const;

/** Fewest `<nav` elements the real tree must show (14 when the guard was written), so a broken scanner cannot pass by finding none. */
const MIN_NAVS = 14;

const isLetter = (c: string | undefined): boolean =>
  c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
const isIdentChar = (c: string | undefined): boolean =>
  c !== undefined && (isLetter(c) || (c >= "0" && c <= "9") || c === "_" || c === "$");
const isQuote = (c: string | undefined): boolean => c === '"' || c === "'" || c === "`";
const isSpace = (c: string | undefined): boolean =>
  c === " " || c === "\n" || c === "\t" || c === "\r";

/**
 * Index just past the closing quote of the string that opens at `i`.
 * `multiline` is true inside a tag's attribute list, where a " or ' always opens
 * an attribute value and JSX lets that value span lines.
 */
function skipQuoted(src: string, i: number, multiline = false): number {
  const quote = src[i]!;
  let j = i + 1;
  while (j < src.length) {
    const c = src[j]!;
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === quote) return j + 1;
    // Outside a tag's attribute list a ' or " string is taken not to span lines:
    // stopping here keeps one stray apostrophe in JSX text from swallowing the rest of the file.
    if (c === "\n" && quote !== "`" && !multiline) return j;
    if (quote === "`" && c === "$" && src[j + 1] === "{") {
      j = skipBraces(src, j + 1);
      continue;
    }
    j += 1;
  }
  return src.length;
}

/** Index just past the `}` that closes the `{` at `i`. */
function skipBraces(src: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j]!;
    if (isQuote(c)) {
      j = skipQuoted(src, j);
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
    j += 1;
  }
  return src.length;
}

/**
 * A comment opener sits at the start of the file or after whitespace or one of `;{}(),`.
 * JSX text such as `/api/v1/*` or `https://x.test` has a letter, digit, `:` or `/` in front
 * of its `/*` or `//`, and must not be mistaken for a comment: that would blank real markup.
 */
function opensComment(src: string, i: number): boolean {
  const prev = src[i - 1];
  return prev === undefined || isSpace(prev) || ";{}(),".includes(prev);
}

/** Replaces every comment character with a space (newlines kept), so offsets and line numbers survive. */
export function blankComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/" && opensComment(src, i)) {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (c === "/" && next === "*" && opensComment(src, i)) {
      const close = src.indexOf("*/", i + 2);
      const stop = close === -1 ? src.length : close + 2;
      for (; i < stop; i += 1) out += src[i] === "\n" ? "\n" : " ";
      continue;
    }
    if (isQuote(c)) {
      const stop = skipQuoted(src, i);
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Index of the `>` that closes the opening tag starting at `<` index `start` (brace depth 0, outside quotes), or -1. */
function tagEnd(src: string, start: number): number {
  let k = start + 1;
  while (k < src.length) {
    const c = src[k]!;
    if (isQuote(c)) {
      k = skipQuoted(src, k, true);
      continue;
    }
    if (c === "{") {
      k = skipBraces(src, k);
      continue;
    }
    if (c === ">") return k;
    k += 1;
  }
  return -1;
}

/** The tag with the inside of every quoted string and `{...}` replaced by spaces (same length, newlines kept). */
function skeleton(tag: string): string {
  let out = "";
  let i = 0;
  const blank = (from: number, to: number): string => tag.slice(from, to).replace(/[^\n]/g, " ");
  while (i < tag.length) {
    const c = tag[i]!;
    if (isQuote(c) || c === "{") {
      const stop = isQuote(c) ? skipQuoted(tag, i, true) : skipBraces(tag, i);
      out += c + blank(i + 1, stop);
      i = stop;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** True when the tag has ` <name>=` as an attribute of its own (not inside a string, a brace expression or a child). */
function hasAttribute(tag: string, name: string): boolean {
  const flat = skeleton(tag);
  for (let at = flat.indexOf(`${name}=`); at !== -1; at = flat.indexOf(`${name}=`, at + 1)) {
    if (isSpace(flat[at - 1])) return true;
  }
  return false;
}

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (src[i] === "\n") line += 1;
  return line;
}

export interface NavScan {
  /** `<nav` elements found (comments excluded). */
  navs: number;
  /** One entry per unnamed nav: `line <n>: ...`. */
  violations: string[];
}

export function scanNavLandmarks(rawSource: string): NavScan {
  const src = blankComments(rawSource);
  const violations: string[] = [];
  let navs = 0;

  for (let at = src.indexOf("<nav"); at !== -1; at = src.indexOf("<nav", at + 1)) {
    const after = src[at + 4];
    // `<nav` starts a JSX element only when whitespace, `>` or `/` follows (not `<navigation`),
    // and an identifier character in front means a generic such as `Foo<nav`, not an element.
    if (!(isSpace(after) || after === ">" || after === "/") || isIdentChar(src[at - 1])) continue;
    navs += 1;
    const where = `line ${lineOf(src, at)}`;
    const end = tagEnd(src, at);
    if (end === -1) {
      violations.push(`${where}: <nav> opening tag is never closed`);
      continue;
    }
    const tag = src.slice(at, end + 1);
    if (!hasAttribute(tag, "aria-label") && !hasAttribute(tag, "aria-labelledby")) {
      violations.push(`${where}: <nav> has no aria-label or aria-labelledby`);
    }
  }

  return { navs, violations };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

describe("every <nav> landmark has an accessible name", () => {
  const files = SCANNED_DIRS.flatMap((d) => walk(resolve(ROOT, d))).sort();

  it("scans the app and component trees", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.map((f) => relative(ROOT, f).split(sep).join("/"))).toEqual(
      expect.arrayContaining(["src/components/layout/nav-links.tsx", "src/components/layout/footer.tsx"]),
    );
  });

  it("no non-test .tsx under src/app or src/components has an unnamed <nav> (file:line)", () => {
    const offenders: string[] = [];
    let navs = 0;
    for (const file of files) {
      const result = scanNavLandmarks(readFileSync(file, "utf8"));
      navs += result.navs;
      const rel = relative(ROOT, file).split(sep).join("/");
      for (const v of result.violations) offenders.push(`${rel}:${v.replace(/^line /, "")}`);
    }
    expect(offenders).toEqual([]);
    // Non-vacuous: the scanner really sees the site's landmarks.
    expect(navs).toBeGreaterThanOrEqual(MIN_NAVS);
  });
});

// ---------------------------------------------------------------------------
// The scanner is what keeps the guard honest, so it is mutation-tested on
// synthetic sources: a labelled nav must pass, every unnamed one must be
// reported.
// ---------------------------------------------------------------------------

const page = (nav: string): string =>
  `export default function P() {\n  return (\n    <div>\n      ${nav}\n        <a href="/x">x</a>\n      </nav>\n    </div>\n  );\n}\n`;

describe("scanNavLandmarks (mutation checks on synthetic sources)", () => {
  it("accepts a multi-line opening tag that carries aria-label", () => {
    const nav = `<nav
        aria-label="Sayfalar"
        className={\`\${cardClass} flex items-center\`}
      >`;
    expect(scanNavLandmarks(page(nav))).toEqual({ navs: 1, violations: [] });
  });

  it("accepts aria-labelledby, and a label that follows an attribute holding a '>'", () => {
    expect(scanNavLandmarks(page('<nav aria-labelledby="baslik" className="x">'))).toEqual({
      navs: 1,
      violations: [],
    });
    const nav = '<nav className={`${a} > ${b}`} onClick={() => go()} aria-label="Gezinti yolu">';
    expect(scanNavLandmarks(page(nav))).toEqual({ navs: 1, violations: [] });
  });

  it("rejects a bare <nav className=\"x\">", () => {
    expect(scanNavLandmarks(page('<nav className="x">'))).toEqual({
      navs: 1,
      violations: ["line 4: <nav> has no aria-label or aria-labelledby"],
    });
  });

  it("rejects a bare <nav> and a multi-line tag without a name", () => {
    expect(scanNavLandmarks(page("<nav>")).violations).toEqual([
      "line 4: <nav> has no aria-label or aria-labelledby",
    ]);
    const nav = `<nav
        className="flex items-center"
      >`;
    expect(scanNavLandmarks(page(nav)).violations).toEqual([
      "line 4: <nav> has no aria-label or aria-labelledby",
    ]);
  });

  it("is not satisfied by a label that belongs to a child element", () => {
    const src = `export const x = (
  <nav className="x">
    <a href="/y" aria-label="Geri">y</a>
  </nav>
);
`;
    expect(scanNavLandmarks(src).violations).toEqual([
      "line 2: <nav> has no aria-label or aria-labelledby",
    ]);
  });

  // JSX lets a "..." attribute value contain a newline, so a quoted attribute value inside an opening tag may span lines.
  it("rejects an unnamed nav whose className string spans lines, a child's label does not count", () => {
    const src = 'export const x = (\n  <nav className="flex\n    gap-2">\n    <a href="/y" aria-label="Geri">y</a>\n  </nav>\n);\n';
    expect(scanNavLandmarks(src).violations).toEqual([
      "line 2: <nav> has no aria-label or aria-labelledby",
    ]);
  });

  it("accepts a named nav whose className string spans lines", () => {
    const src = 'export const x = (\n  <nav className="flex\n    gap-2" aria-label="Sayfalar">\n    <a href="/y">y</a>\n  </nav>\n);\n';
    expect(scanNavLandmarks(src)).toEqual({ navs: 1, violations: [] });
  });

  it("is not satisfied by the attribute name appearing inside a string or a brace expression", () => {
    expect(scanNavLandmarks(page('<nav className="a aria-label=b">')).violations).toHaveLength(1);
    expect(scanNavLandmarks(page('<nav className={cx("a", " aria-labelledby=b")}>')).violations).toHaveLength(1);
    expect(scanNavLandmarks(page("<nav data-x={`aria-label=\"y\"`}>")).violations).toHaveLength(1);
  });

  it("does not let a label that only appears in a comment satisfy the rule", () => {
    const nav = '<nav className="x" /* aria-label="Gezinti yolu" */>';
    expect(scanNavLandmarks(page(nav)).violations).toHaveLength(1);
  });

  it("does not match aria-label as a suffix of another attribute name", () => {
    expect(scanNavLandmarks(page('<nav data-aria-label="x">')).violations).toHaveLength(1);
  });

  it("reports an opening tag that is never closed", () => {
    expect(scanNavLandmarks('export const x = <nav className="x"').violations).toEqual([
      "line 1: <nav> opening tag is never closed",
    ]);
  });

  it("counts and checks each nav in a file separately", () => {
    const src = `export const x = (
  <div>
    <nav aria-label="A">a</nav>
    <nav className="b">b</nav>
    <nav aria-label="C">c</nav>
  </div>
);
`;
    expect(scanNavLandmarks(src)).toEqual({
      navs: 3,
      violations: ["line 4: <nav> has no aria-label or aria-labelledby"],
    });
  });

  it("ignores a <nav> that only appears in a comment", () => {
    const src = `// the <nav> itself\n/* <nav className="x"> */\nexport const x = 1;\n{/* <nav> */}\n`;
    expect(scanNavLandmarks(src)).toEqual({ navs: 0, violations: [] });
  });

  it("ignores names that merely start with nav, and generics", () => {
    const src = `const a = <navigation className="x" />;\nconst b = useRef<nav>(null);\nconst c = <navbar>y</navbar>;\n`;
    expect(scanNavLandmarks(src)).toEqual({ navs: 0, violations: [] });
  });

  it("is not fooled by a // inside a string literal before the nav", () => {
    const src = `const url = "https://example.test/a";\n${page('<nav className="x">')}`;
    expect(scanNavLandmarks(src).violations).toEqual([
      "line 5: <nav> has no aria-label or aria-labelledby",
    ]);
  });
});

describe("blankComments", () => {
  it("does not treat JSX text like /api/v1/* or https://x.test as a comment", () => {
    const src = "<code>/api/v1/*</code>\n<a>https://x.test/a</a>\n<nav className=\"x\">\n";
    expect(blankComments(src)).toBe(src);
  });

  it("keeps length and line breaks, and blanks comments", () => {
    const src = `const a = "x // y"; // tail\n/* block\nspans */ const b = 1;\n`;
    const out = blankComments(src);
    expect(out).toHaveLength(src.length);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out).toContain('"x // y"');
    expect(out).not.toContain("tail");
    expect(out).not.toContain("block");
  });
});
