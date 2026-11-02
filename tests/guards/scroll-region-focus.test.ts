import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// WCAG 2.1.1 (Keyboard): a horizontally scrolling element that holds no
// focusable child cannot be scrolled with the keyboard, because browsers only
// scroll a scroller that has focus. On /kalite the data table and on
// /gelistirici the data tables and the code samples overflow at a 390 px
// viewport (the /kalite chart no longer scrolls: its labels are HTML around a
// fluid svg), so each one needs to be a focus stop: tabIndex={0}, a region role with an
// accessible name (so a screen reader announces what took focus), and a
// visible focus ring (the same `focus-visible:ring-2` the rest of the site
// uses).
//
// This is a character-scan guard, not a regex one: comments are blanked
// first, then every `overflow-x-auto` is located and classified by walking the
// text (quotes, template literals, brace depth), so a `>` inside a template
// literal or a `//` inside a string cannot confuse it.
//
//   (a) inside a JSX opening tag: that tag must carry all four attributes.
//   (b) inside a `const <name> = "..."` class string: the string must carry
//       the ring, and every `className={<name>}` tag must carry the other
//       three attributes. Any other use of <name> is a violation, so a new
//       use cannot slip past the guard.
//   Anything else (an overflow class in a ternary, a helper call, ...) is
//   reported rather than silently skipped.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");

const OVERFLOW = "overflow-x-auto";
const RING = "focus-visible:ring-2";

const isLetter = (c: string | undefined): boolean =>
  c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
const isIdentChar = (c: string | undefined): boolean =>
  c !== undefined && (isLetter(c) || (c >= "0" && c <= "9") || c === "_" || c === "$");
const isQuote = (c: string | undefined): boolean => c === '"' || c === "'" || c === "`";
const isSpace = (c: string | undefined): boolean =>
  c === " " || c === "\n" || c === "\t" || c === "\r";

/** Index just past the closing quote of the string that opens at `i`. */
function skipQuoted(src: string, i: number): number {
  const quote = src[i]!;
  let j = i + 1;
  while (j < src.length) {
    const c = src[j]!;
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === quote) return j + 1;
    // A ' or " string never spans lines; stopping here keeps one stray
    // apostrophe in JSX text from swallowing the rest of the file.
    if (c === "\n" && quote !== "`") return j;
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
      k = skipQuoted(src, k);
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

interface Tag {
  start: number;
  text: string;
}

/** The JSX opening tag that contains index `i`, or null. */
function enclosingTag(src: string, i: number): Tag | null {
  for (let j = i; j >= 0; j -= 1) {
    // `<` + letter, not preceded by an identifier char (that would be a generic like Array<string>).
    if (src[j] === "<" && isLetter(src[j + 1]) && !isIdentChar(src[j - 1])) {
      const end = tagEnd(src, j);
      return end > i ? { start: j, text: src.slice(j, end + 1) } : null;
    }
  }
  return null;
}

interface ConstString {
  name: string;
  nameAt: number;
  start: number;
  end: number;
  text: string;
}

/** Every `const <name> = "<string>"` (or template) declaration. */
function findConstStrings(src: string): ConstString[] {
  const found: ConstString[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf("const ", from);
    if (at === -1) break;
    from = at + 6;
    if (at > 0 && isIdentChar(src[at - 1])) continue;
    let k = at + 6;
    const nameAt = k;
    let name = "";
    while (isIdentChar(src[k])) {
      name += src[k];
      k += 1;
    }
    if (name === "") continue;
    while (isSpace(src[k])) k += 1;
    if (src[k] === ":") {
      // Optional type annotation: skip to the `=` of the same statement.
      while (k < src.length && src[k] !== "=" && src[k] !== ";") k += 1;
    }
    if (src[k] !== "=") continue;
    k += 1;
    while (isSpace(src[k])) k += 1;
    if (!isQuote(src[k])) continue;
    const end = skipQuoted(src, k);
    found.push({ name, nameAt, start: k, end, text: src.slice(k, end) });
  }
  return found;
}

/** Offsets of whole-word occurrences of `name`. */
function wordOffsets(src: string, name: string): number[] {
  const offsets: number[] = [];
  for (let at = src.indexOf(name); at !== -1; at = src.indexOf(name, at + 1)) {
    if (!isIdentChar(src[at - 1]) && !isIdentChar(src[at + name.length])) offsets.push(at);
  }
  return offsets;
}

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (src[i] === "\n") line += 1;
  return line;
}

/** True when the tag text has ` <name>=` as an attribute. */
function hasAttribute(tag: string, name: string): boolean {
  for (let at = tag.indexOf(`${name}=`); at !== -1; at = tag.indexOf(`${name}=`, at + 1)) {
    if (isSpace(tag[at - 1])) return true;
  }
  return false;
}

function attributeViolations(tag: string, where: string, needsRing: boolean): string[] {
  const missing: string[] = [];
  if (!tag.includes("tabIndex={0}")) missing.push("tabIndex={0}");
  if (!tag.includes('role="region"')) missing.push('role="region"');
  if (!hasAttribute(tag, "aria-label") && !hasAttribute(tag, "aria-labelledby")) {
    missing.push("aria-label or aria-labelledby");
  }
  if (needsRing && !tag.includes(RING)) missing.push(RING);
  return missing.map((what) => `${where}: scroll region is missing ${what}`);
}

export interface ScanResult {
  /** Distinct scroll-region tags that were checked. */
  regions: number;
  violations: string[];
}

export function scanScrollRegions(rawSource: string): ScanResult {
  const src = blankComments(rawSource);
  const consts = findConstStrings(src);
  const violations: string[] = [];
  const checkedTags = new Set<number>();
  const checkedConsts = new Set<string>();

  for (let i = src.indexOf(OVERFLOW); i !== -1; i = src.indexOf(OVERFLOW, i + 1)) {
    const where = `line ${lineOf(src, i)}`;

    const decl = consts.find((c) => i >= c.start && i < c.end);
    if (decl) {
      if (checkedConsts.has(decl.name)) continue;
      checkedConsts.add(decl.name);
      if (!decl.text.includes(RING)) {
        violations.push(`${where}: const ${decl.name} holds ${OVERFLOW} but not ${RING}`);
      }
      for (const use of wordOffsets(src, decl.name)) {
        if (use === decl.nameAt) continue;
        const useWhere = `line ${lineOf(src, use)}`;
        if (!src.slice(0, use).trimEnd().endsWith("className={")) {
          violations.push(`${useWhere}: ${decl.name} is used outside a className={...} attribute`);
          continue;
        }
        const tag = enclosingTag(src, use);
        if (tag === null) {
          violations.push(`${useWhere}: ${decl.name} is not inside a JSX opening tag`);
          continue;
        }
        if (checkedTags.has(tag.start)) continue;
        checkedTags.add(tag.start);
        violations.push(...attributeViolations(tag.text, useWhere, false));
      }
      continue;
    }

    const tag = enclosingTag(src, i);
    if (tag === null) {
      violations.push(`${where}: ${OVERFLOW} is neither in a JSX tag nor in a const class string`);
      continue;
    }
    if (checkedTags.has(tag.start)) continue;
    checkedTags.add(tag.start);
    violations.push(...attributeViolations(tag.text, where, true));
  }

  return { regions: checkedTags.size, violations };
}

const GUARDED_PAGES = [
  { file: "src/app/kalite/page.tsx", minRegions: 1 },
  { file: "src/app/gelistirici/page.tsx", minRegions: 6 },
] as const;

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) count += 1;
  return count;
}

/** Occurrences on lines that are comments from their first character on (the only ones the page files have). */
function occurrencesOnCommentLines(raw: string, needle: string): number {
  let count = 0;
  for (const line of raw.split("\n")) {
    const t = line.trimStart();
    const isComment = t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("{/*");
    if (isComment) count += countOccurrences(line, needle);
  }
  return count;
}

describe("scroll regions are keyboard reachable on /kalite and /gelistirici", () => {
  for (const { file, minRegions } of GUARDED_PAGES) {
    const raw = readFileSync(resolve(ROOT, file), "utf8");

    it(`${file}: every ${OVERFLOW} region is focusable, named and has a visible focus ring`, () => {
      const result = scanScrollRegions(raw);
      expect(result.violations).toEqual([]);
      // Non-vacuous: the page really has this many scroll regions.
      expect(result.regions).toBeGreaterThanOrEqual(minRegions);
    });

    it(`${file}: comment blanking leaves every non-comment ${OVERFLOW} in view (nothing is swallowed)`, () => {
      const kept = countOccurrences(blankComments(raw), OVERFLOW);
      expect(kept).toBe(countOccurrences(raw, OVERFLOW) - occurrencesOnCommentLines(raw, OVERFLOW));
      expect(kept).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------
// The scanner is what keeps the guard honest, so it is mutation-tested on
// synthetic sources: each mutant must be reported.
// ---------------------------------------------------------------------------

type Part = "tabIndex" | "role" | "label" | "ring";

/** A chart-wrapper tag built from literal parts; `omit` drops parts to make a mutant. */
function regionTag(omit: readonly Part[] = []): string {
  const ring = omit.includes("ring")
    ? ""
    : " focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const attrs = [`className="w-full overflow-x-auto${ring}"`];
  if (!omit.includes("role")) attrs.push('role="region"');
  if (!omit.includes("label")) attrs.push('aria-label="Grafik"');
  if (!omit.includes("tabIndex")) attrs.push("tabIndex={0}");
  return `<div ${attrs.join(" ")}>`;
}

const page = (tag: string): string =>
  `export default function P() {\n  return (\n    <section>\n      ${tag}\n        <p>x</p>\n      </div>\n    </section>\n  );\n}\n`;

describe("scanScrollRegions (mutation checks on synthetic sources)", () => {
  it("accepts a fully compliant region", () => {
    expect(scanScrollRegions(page(regionTag()))).toEqual({ regions: 1, violations: [] });
  });

  it("accepts aria-labelledby in place of aria-label, and attributes split over lines", () => {
    const tag = `<div
        className="overflow-x-auto focus-visible:ring-2"
        role="region"
        aria-labelledby="tablo"
        tabIndex={0}
      >`;
    expect(scanScrollRegions(page(tag))).toEqual({ regions: 1, violations: [] });
  });

  it("accepts a template-literal aria-label that contains a '>'", () => {
    const tag =
      '<div className="overflow-x-auto focus-visible:ring-2" role="region" aria-label={`${a} > ${b} parametreleri`} tabIndex={0}>';
    expect(scanScrollRegions(page(tag))).toEqual({ regions: 1, violations: [] });
  });

  it("reports a missing tabIndex", () => {
    expect(scanScrollRegions(page(regionTag(["tabIndex"]))).violations).toEqual([
      "line 4: scroll region is missing tabIndex={0}",
    ]);
  });

  it("reports tabIndex={-1} as missing (not a keyboard stop)", () => {
    const tag =
      '<div className="overflow-x-auto focus-visible:ring-2" role="region" aria-label="Grafik" tabIndex={-1}>';
    expect(scanScrollRegions(page(tag)).violations).toEqual([
      "line 4: scroll region is missing tabIndex={0}",
    ]);
  });

  it("reports a missing role", () => {
    expect(scanScrollRegions(page(regionTag(["role"]))).violations).toEqual([
      'line 4: scroll region is missing role="region"',
    ]);
  });

  it("reports a missing accessible name", () => {
    expect(scanScrollRegions(page(regionTag(["label"]))).violations).toEqual([
      "line 4: scroll region is missing aria-label or aria-labelledby",
    ]);
  });

  it("reports a missing focus ring", () => {
    expect(scanScrollRegions(page(regionTag(["ring"]))).violations).toEqual([
      `line 4: scroll region is missing ${RING}`,
    ]);
  });

  it("reports every missing attribute of a bare region", () => {
    const result = scanScrollRegions(page('<div className="overflow-x-auto">'));
    expect(result.regions).toBe(1);
    expect(result.violations).toHaveLength(4);
  });

  it("counts a tag that repeats the overflow class once", () => {
    const tag =
      '<div className="overflow-x-auto sm:overflow-x-auto focus-visible:ring-2" role="region" aria-label="Grafik" tabIndex={0}>';
    expect(scanScrollRegions(page(tag))).toEqual({ regions: 1, violations: [] });
  });

  it("accepts a const class string used by fully labelled tags", () => {
    const src = `const codeClass = "overflow-x-auto px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
export default function P() {
  return (
    <section>
      <pre className={codeClass} tabIndex={0} role="region" aria-label="curl örneği">a</pre>
      <pre className={codeClass} tabIndex={0} role="region" aria-label="Python örneği">b</pre>
    </section>
  );
}
`;
    expect(scanScrollRegions(src)).toEqual({ regions: 2, violations: [] });
  });

  it("reports a const class string used by an unlabelled tag", () => {
    const src = `const codeClass = "overflow-x-auto focus-visible:ring-2";
export default function P() {
  return (
    <section>
      <pre className={codeClass} tabIndex={0} role="region" aria-label="curl örneği">a</pre>
      <pre className={codeClass}>b</pre>
    </section>
  );
}
`;
    const result = scanScrollRegions(src);
    expect(result.regions).toBe(2);
    expect(result.violations).toEqual([
      "line 6: scroll region is missing tabIndex={0}",
      'line 6: scroll region is missing role="region"',
      "line 6: scroll region is missing aria-label or aria-labelledby",
    ]);
  });

  it("reports a const class string without the focus ring", () => {
    const src = `const codeClass = "overflow-x-auto px-3";
export default function P() {
  return <pre className={codeClass} tabIndex={0} role="region" aria-label="x">a</pre>;
}
`;
    expect(scanScrollRegions(src).violations).toEqual([
      `line 1: const codeClass holds ${OVERFLOW} but not ${RING}`,
    ]);
  });

  it("reports a const class string used outside className={...}", () => {
    const src = `const codeClass = "overflow-x-auto focus-visible:ring-2";
export const joined = codeClass + " p-2";
`;
    expect(scanScrollRegions(src).violations).toEqual([
      "line 2: codeClass is used outside a className={...} attribute",
    ]);
  });

  it("reports an overflow class it cannot classify instead of skipping it", () => {
    const src = `export const cls = open ? "overflow-x-auto" : "";\n`;
    expect(scanScrollRegions(src).violations).toEqual([
      `line 1: ${OVERFLOW} is neither in a JSX tag nor in a const class string`,
    ]);
  });

  it("ignores an overflow region that only appears in a comment", () => {
    const src = `// <div className="overflow-x-auto">\n/* <div className="overflow-x-auto"> */\nexport const x = 1;\n{/* <div className="overflow-x-auto"> */}\n`;
    expect(scanScrollRegions(src)).toEqual({ regions: 0, violations: [] });
  });

  it("does not let attributes that only appear in a comment satisfy the rules", () => {
    const tag = '<div className="overflow-x-auto focus-visible:ring-2" /* tabIndex={0} role="region" aria-label="x" */>';
    expect(scanScrollRegions(page(tag)).violations).toHaveLength(3);
  });

  it("is not fooled by a // inside a string literal before the region", () => {
    const src = `const url = "https://example.test/a";\n${page(regionTag(["tabIndex"]))}`;
    expect(scanScrollRegions(src).violations).toEqual(["line 5: scroll region is missing tabIndex={0}"]);
  });
});

describe("blankComments", () => {
  it("does not treat JSX text like /api/v1/* or https://x.test as a comment", () => {
    const src = '<code>/api/v1/*</code>\n<a>https://x.test/a</a>\n<div className="overflow-x-auto">\n';
    expect(blankComments(src)).toBe(src);
  });

  it("keeps length, line breaks and string contents, and blanks comments", () => {
    const src = `const a = "x // y"; // tail\n/* block\nspans */ const b = \`t // u\`;\n`;
    const out = blankComments(src);
    expect(out).toHaveLength(src.length);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out).toContain('"x // y"');
    expect(out).toContain("`t // u`");
    expect(out).not.toContain("tail");
    expect(out).not.toContain("block");
    expect(out).not.toContain("spans");
  });
});
