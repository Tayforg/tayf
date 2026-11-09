import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (h101-a11yrecent-1, WCAG 1.4.10 reflow): the price header
// of /ekonomi/<ticker> overflowed horizontally at 320 CSS px for a price of
// 1.000 TL or more (LYDYE "1.755,00": scrollWidth 334), and on ordinary phones
// for ISATR ("4.950.000,00": 406 at 320 and 375).
//
// Cause: below md the header grid had no column template, so its single
// implicit `auto` track grew to the min-content of the right-hand block. That
// block (price + 140 px sparkline) could neither shrink nor wrap.
//
// Three literal class strings keep it reflowing (below md only; the md layout
// is unchanged):
//   - the header has `grid-cols-1` (repeat(1, minmax(0, 1fr))), so the track
//     can never exceed the container, and keeps its md two-column template;
//   - the price + sparkline block may shrink and wrap (min-w-0 + flex-wrap), so
//     the 140 px sparkline drops under the price instead of widening the page;
//   - the limit tag + price row may wrap (flex-wrap).
//
// The checks read the class attribute as a string literal, so they fail if a
// class is ever computed (a className={...} expression has no `className="`
// inside its tag). Source scans use character scans, not regexes over JSX.
// The page is a server component and the repo does not render those, so this
// reads the source, as cluster-actions-reflow.test.ts does.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const PAGE_PATH = resolve(ROOT, "src/app/ekonomi/[ticker]/page.tsx");

const CLASS_ATTR = 'className="';

/**
 * Index of the `>` that closes the JSX opening tag whose name starts at
 * `from` (a `>` inside a quoted attribute value or a `{...}` expression does
 * not count). -1 when the tag never closes.
 */
function openingTagEnd(src: string, from: number): number {
  let quote = "";
  let braces = 0;
  for (let i = from; i < src.length; i += 1) {
    const ch = src[i]!;
    if (quote !== "") {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "{") {
      braces += 1;
    } else if (ch === "}") {
      braces -= 1;
    } else if (ch === ">" && braces === 0) {
      return i;
    }
  }
  return -1;
}

/**
 * The tokens of the first `className="..."` literal found in
 * src[from, tagEnd). Null when the tag has no string-literal className.
 */
function classTokensIn(src: string, from: number, tagEnd: number): string[] | null {
  const attr = src.indexOf(CLASS_ATTR, from);
  if (attr === -1 || attr >= tagEnd) return null;
  const valueStart = attr + CLASS_ATTR.length;
  const valueEnd = src.indexOf('"', valueStart);
  if (valueEnd === -1 || valueEnd >= tagEnd) return null;
  return src
    .slice(valueStart, valueEnd)
    .split(/\s+/)
    .filter(Boolean);
}

const src = readFileSync(PAGE_PATH, "utf8");

/** The page source between `<header` and `</header>` (the price header, exactly one). */
function headerRegion(): { start: number; end: number } {
  const start = src.indexOf("<header");
  expect(start, "page.tsx has a <header>").toBeGreaterThan(-1);
  // Exactly one: the guard would silently pin the wrong element otherwise.
  expect(src.indexOf("<header", start + 1), "one <header> only").toBe(-1);
  const end = src.indexOf("</header>", start);
  expect(end, "the <header> closes").toBeGreaterThan(start);
  return { start, end };
}

/** Tokens of the literal className of the `<div` that opens just before `marker` (inside the header). */
function divTokensAround(marker: string): string[] {
  const { start, end } = headerRegion();
  const at = src.indexOf(marker, start);
  expect(at, `the header contains ${marker}`).toBeGreaterThan(-1);
  expect(at, `${marker} is inside the header`).toBeLessThan(end);
  // Exactly one: the guard would silently pin the wrong element otherwise.
  expect(src.indexOf(marker, at + 1), `${marker} appears once`).toBe(-1);
  const open = src.lastIndexOf("<div", at);
  expect(open, `${marker} sits in a <div>`).toBeGreaterThan(start);
  const tagEnd = openingTagEnd(src, open);
  expect(tagEnd, "the div tag closes").toBeGreaterThan(open);
  expect(tagEnd, "the div tag closes before the marker").toBeLessThan(at);
  const tokens = classTokensIn(src, open, tagEnd);
  expect(tokens, `the div around ${marker} has a literal className`).not.toBeNull();
  return tokens!;
}

describe("/ekonomi/<ticker> price header reflow at 320 px (h101-a11yrecent-1)", () => {
  it("the header grid has grid-cols-1 below md and keeps its md two-column template", () => {
    const { start } = headerRegion();
    const tagEnd = openingTagEnd(src, start);
    expect(tagEnd, "the header tag closes").toBeGreaterThan(start);
    const tokens = classTokensIn(src, start, tagEnd);
    expect(tokens, "the header has a literal className").not.toBeNull();
    for (const token of ["grid", "grid-cols-1", "md:grid-cols-[minmax(0,1fr)_auto]", "md:items-end", "gap-4"]) {
      expect(tokens, `header ${token}`).toContain(token);
    }
  });

  it("the price + sparkline block can shrink and wrap, and keeps its mono layout", () => {
    const tokens = divTokensAround("{quote && fresh ? (");
    for (const token of ["flex", "min-w-0", "flex-wrap", "items-end", "gap-x-4", "gap-y-2", "font-mono"]) {
      expect(tokens, `price block ${token}`).toContain(token);
    }
    // The old unwrappable shape: a bare gap-4 row.
    expect(tokens).not.toContain("gap-4");
  });

  // Rendered with the site's compiled CSS in headless Chrome (iframes of fixed width), the header at
  // 640, 700 and 767 px is the single-column layout: the block is full width, and a bare `justify-end`
  // moved the price and sparkline from the left edge to the right edge (x 33 -> 213 at 640 px).
  // The wrapped phone layout wants them right-aligned (the sparkline sits under the price, flush
  // right like the md layout), so the alignment is scoped to phones. At md and above the block is
  // shrink-to-fit in an auto track, where justify-end changes nothing either way.
  it("right-aligns the block on phones only (max-sm:), so 640-767 px keeps its left-aligned layout", () => {
    const tokens = divTokensAround("{quote && fresh ? (");
    expect(tokens).toContain("max-sm:justify-end");
    expect(tokens).not.toContain("justify-end");
  });

  it("the limit tag + price row can wrap", () => {
    const tokens = divTokensAround("{limit ? <span");
    for (const token of ["flex", "flex-wrap", "items-baseline", "justify-end", "gap-2"]) {
      expect(tokens, `limit + price row ${token}`).toContain(token);
    }
  });

  it("keeps the price at text-3xl (a 12-character price is 216 px, inside the 254 px content box at 320)", () => {
    const { start, end } = headerRegion();
    const at = src.indexOf("{fmtPrice(quote.price)}", start);
    expect(at, "the header prints the price").toBeGreaterThan(-1);
    expect(at).toBeLessThan(end);
    const open = src.lastIndexOf("<span", at);
    const tokens = classTokensIn(src, open, openingTagEnd(src, open));
    expect(tokens, "the price span has a literal className").not.toBeNull();
    expect(tokens).toContain("text-3xl");
    expect(tokens).toContain("tabular-nums");
  });

  it("keeps the 140 px sparkline in the wrapping block (it wraps under the price, it is not shrunk)", () => {
    const { start, end } = headerRegion();
    const at = src.indexOf("<Sparkline", start);
    expect(at, "the header draws the sparkline").toBeGreaterThan(-1);
    expect(at).toBeLessThan(end);
    expect(src.slice(at, openingTagEnd(src, at))).toContain("width={140}");
  });

  it("scans correctly: a computed className is reported as no literal", () => {
    const computed = '<div aria-label="x" className={cx("a", "b")}>';
    expect(classTokensIn(computed, 0, openingTagEnd(computed, 0))).toBeNull();
    const literal = '<div className="a  b>c" aria-label="x">';
    expect(classTokensIn(literal, 0, openingTagEnd(literal, 0))).toEqual(["a", "b>c"]);
  });
});
