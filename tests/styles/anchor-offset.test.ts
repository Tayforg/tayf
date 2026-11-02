import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Anchor jumps (/metodoloji#kor-nokta, the skip link, a focused control) land
// under the sticky header unless `html { scroll-padding-top }` is at least the
// header's height. The header is 59 px (2 px accent line + h-14 row + 1 px
// border) and the padding was 3.5rem = 56 px, so every jump hid 3 px of the
// target. /metodoloji then stacked `scroll-mt-24` (96 px) on top, which made its
// anchors land 96 + 56 px down. One source of truth: the html rule, sized to
// the header plus 0.75rem of air.
//
// CodeQL: literal includes and character scans only; no regular expression runs
// over the source.

const ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const HEADER = read("src/components/layout/header.tsx");
const GLOBALS_CSS = read("src/app/globals.css");
const METODOLOJI = read("src/app/metodoloji/page.tsx");

/** The digits N of the first `h-[Npx]` token in `text`, or null. */
function pixelHeight(text: string): number | null {
  const needle = "h-[";
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return null;
    // A whole class token: `h-[` must not be the tail of `min-h-[` / `max-h-[`.
    const before = at === 0 ? " " : text[at - 1]!;
    let i = at + needle.length;
    let digits = "";
    while (i < text.length && text[i]! >= "0" && text[i]! <= "9") {
      digits += text[i];
      i++;
    }
    if ((before === " " || before === '"') && digits !== "" && text.startsWith("px]", i)) return Number(digits);
    from = at + needle.length;
  }
}

/** The className string literal of the first element whose classes include `sticky top-0` and an h-[Npx]. */
function stickyHeaderClassName(source: string): string {
  const marker = 'className="';
  let from = 0;
  for (;;) {
    const at = source.indexOf(marker, from);
    if (at === -1) throw new Error("no sticky header className with h-[Npx] in header.tsx");
    const start = at + marker.length;
    const end = source.indexOf('"', start);
    const cls = source.slice(start, end);
    if (cls.includes("sticky top-0") && pixelHeight(cls) !== null) return cls;
    from = end + 1;
  }
}

/** The body of the first top-level `html { ... }` rule that declares scroll-padding-top. */
function htmlScrollRule(css: string): string {
  const needle = "html {";
  let from = 0;
  for (;;) {
    const at = css.indexOf(needle, from);
    if (at === -1) throw new Error("no html rule with scroll-padding-top in globals.css");
    const close = css.indexOf("}", at);
    const body = css.slice(at, close + 1);
    if (body.includes("scroll-padding-top")) return body;
    from = at + needle.length;
  }
}

/** `css` without block comments, found by scanning characters. */
function withoutComments(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    if (css[i] === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }
    out += css[i];
    i++;
  }
  return out;
}

describe("anchor offset under the sticky header", () => {
  const headerPx = pixelHeight(stickyHeaderClassName(HEADER));

  it("reads the sticky header height from header.tsx", () => {
    expect(headerPx).not.toBeNull();
    expect(headerPx!).toBeGreaterThan(0);
  });

  it("the header height is its parts: 2 px accent line + h-14 row + 1 px border", () => {
    expect(HEADER.includes('className="h-[2px] ')).toBe(true);
    expect(HEADER.includes("flex h-14 items-center")).toBe(true);
    expect(headerPx).toBe(2 + 56 + 1);
  });

  it("html scroll-padding-top is the header height plus 0.75rem, in the same pixels", () => {
    const rule = withoutComments(htmlScrollRule(GLOBALS_CSS));
    expect(rule.includes(`scroll-padding-top: calc(${headerPx}px + 0.75rem);`)).toBe(true);
    // The old 3.5rem (56 px) literal, shorter than the header, is gone.
    expect(rule.includes("scroll-padding-top: 3.5rem")).toBe(false);
  });

  it("the globals.css comment names the real header height, not the h-14 row alone", () => {
    const rule = htmlScrollRule(GLOBALS_CSS);
    expect(rule.includes(`${headerPx} px`)).toBe(true);
  });

  it("/metodoloji does not stack a scroll-mt on top of the global scroll-padding", () => {
    expect(METODOLOJI.includes("scroll-mt-")).toBe(false);
  });
});
