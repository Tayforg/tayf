import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (h32-a11y-1, WCAG 1.4.10 reflow): at 320 CSS px the
// cluster hero clipped the Bluesky share chip and the "Düzeltme talebi" link.
// The "Kanal ile paylaş" group was one unwrappable row 279 px wide, and that
// min-content width kept the data-row="actions" flex row from wrapping, so the
// hero card (overflow-hidden) cut ~20 px off its right edge.
//
// Two literal class strings keep it reflowing:
//   - the channel group (share-button.tsx) may wrap: flex-wrap + max-w-full;
//   - the actions row (cluster/[id]/page.tsx) may shrink below its content:
//     min-w-0 + max-w-full, with every max-sm: token it already had.
//
// The checks read the class attribute as a string literal, so they fail if a
// class is ever computed (a className={...} expression has no `className="`
// inside its tag). Source scans below use character scans, not regexes.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const PAGE_PATH = resolve(ROOT, "src/app/cluster/[id]/page.tsx");
const SHARE_PATH = resolve(ROOT, "src/components/story/share-button.tsx");

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

/** Every max-sm: token the actions row carried before h32-a11y-1. */
const EXISTING_MAX_SM_TOKENS = [
  "max-sm:flex",
  "max-sm:basis-full",
  "max-sm:flex-wrap",
  "max-sm:items-center",
  "max-sm:gap-2",
];

describe("cluster hero actions reflow at 320 px (h32-a11y-1)", () => {
  it('keeps min-w-0 and max-w-full (and every max-sm: token) on the data-row="actions" row', () => {
    const src = readFileSync(PAGE_PATH, "utf8");
    const marker = src.indexOf('data-row="actions"');
    expect(marker, 'page.tsx has a data-row="actions" element').toBeGreaterThan(-1);
    // Exactly one: the guard would silently pin the wrong row otherwise.
    expect(src.indexOf('data-row="actions"', marker + 1)).toBe(-1);

    const end = openingTagEnd(src, marker);
    expect(end, "the actions tag closes").toBeGreaterThan(marker);
    const tokens = classTokensIn(src, marker, end);
    expect(tokens, "the actions row has a literal className").not.toBeNull();
    for (const token of ["min-w-0", "max-w-full", ...EXISTING_MAX_SM_TOKENS]) {
      expect(tokens, `actions row ${token}`).toContain(token);
    }
  });

  it('keeps flex-wrap and max-w-full on the "Kanal ile paylaş" group', () => {
    const src = readFileSync(SHARE_PATH, "utf8");
    const marker = src.indexOf('aria-label="Kanal ile paylaş"');
    expect(marker, "share-button.tsx has the channel group").toBeGreaterThan(-1);
    expect(src.indexOf('aria-label="Kanal ile paylaş"', marker + 1)).toBe(-1);

    const open = src.lastIndexOf("<span", marker);
    expect(open, "the group is a <span>").toBeGreaterThan(-1);
    const end = openingTagEnd(src, open);
    expect(end, "the group tag closes").toBeGreaterThan(marker);
    const tokens = classTokensIn(src, open, end);
    expect(tokens, "the channel group has a literal className").not.toBeNull();
    for (const token of ["flex-wrap", "max-w-full"]) {
      expect(tokens, `channel group ${token}`).toContain(token);
    }
  });

  // h46-mobile-1: on phones the secondary share options sit behind a "Daha
  // fazla" disclosure. The channel group above must stay inside the wrapper
  // that toggles (so it still reflows when opened), and both wrapper classes
  // plus the toggle's own classes must stay string literals (Tailwind 4 only
  // generates classes it can read verbatim from the source).
  describe("'Daha fazla' disclosure wrapper (h46-mobile-1)", () => {
    /** The string literal assigned to `const <name> = "..."`; null if not a plain literal. */
    function constLiteral(src: string, name: string): string | null {
      const head = `const ${name} =`;
      const at = src.indexOf(head);
      if (at === -1) return null;
      let i = at + head.length;
      while (src[i] === " " || src[i] === "\n") i += 1;
      // Anything but a plain quoted string here (a template, a call, a name)
      // is computed; the ";" check below also rejects `"a" + "b"`.
      if (src[i] !== '"') return null;
      const end = src.indexOf('"', i + 1);
      if (end === -1) return null;
      let j = end + 1;
      while (src[j] === " " || src[j] === "\n") j += 1;
      if (src[j] !== ";") return null;
      return src.slice(i + 1, end);
    }

    /** Index just past the </span> that closes the <span> opened at `open`. */
    function spanEnd(src: string, open: number): number {
      let depth = 0;
      let i = open;
      while (i < src.length) {
        const nextOpen = src.indexOf("<span", i);
        const nextClose = src.indexOf("</span>", i);
        if (nextClose === -1) return -1;
        if (nextOpen !== -1 && nextOpen < nextClose) {
          depth += 1;
          i = nextOpen + "<span".length;
        } else {
          depth -= 1;
          i = nextClose + "</span>".length;
          if (depth === 0) return i;
        }
      }
      return -1;
    }

    const src = readFileSync(SHARE_PATH, "utf8");

    it("declares the open and closed wrapper classes as plain string literals", () => {
      expect(constLiteral(src, "MORE_OPEN"), "MORE_OPEN is a literal").toBe("contents");
      expect(constLiteral(src, "MORE_CLOSED"), "MORE_CLOSED is a literal").toBe(
        "contents max-sm:hidden",
      );
    });

    it("declares the toggle chip classes as a literal with sm:hidden and the 44 px floor", () => {
      const toggle = constLiteral(src, "MORE_TOGGLE_CLASS");
      expect(toggle, "MORE_TOGGLE_CLASS is a literal").not.toBeNull();
      const tokens = toggle!.split(/\s+/).filter(Boolean);
      for (const token of ["sm:hidden", "max-sm:min-h-11", "max-sm:min-w-11", "max-sm:justify-center"]) {
        expect(tokens, `toggle ${token}`).toContain(token);
      }
    });

    it("builds the wrapper className only from those two constants, and keeps the channel group inside it", () => {
      const marker = src.indexOf('data-group="more-share"');
      expect(marker, "share-button.tsx has the more-share wrapper").toBeGreaterThan(-1);
      expect(src.indexOf('data-group="more-share"', marker + 1)).toBe(-1);

      const open = src.lastIndexOf("<span", marker);
      const tagEnd = openingTagEnd(src, open);
      expect(tagEnd, "the wrapper tag closes").toBeGreaterThan(marker);
      expect(src.slice(open, tagEnd)).toContain("className={moreOpen ? MORE_OPEN : MORE_CLOSED}");

      const close = spanEnd(src, open);
      expect(close, "the wrapper span closes").toBeGreaterThan(tagEnd);
      const group = src.indexOf('aria-label="Kanal ile paylaş"');
      expect(group, "the channel group is inside the wrapper").toBeGreaterThan(open);
      expect(group).toBeLessThan(close);
      // Everything that must stay visible when the wrapper is hidden lives outside it.
      for (const outside of ['role="status"', "<ManualCopyBox", "onClick={handleShare}"]) {
        const at = src.indexOf(outside);
        expect(at, outside).toBeGreaterThan(-1);
        expect(at < open || at >= close, `${outside} is outside the wrapper`).toBe(true);
      }
    });
  });

  // h60-mobile-1: on phones tapping "Karşılaştır" inserted a visible hint
  // BEFORE the button in one inline-flex flex-wrap span, which wrapped the
  // button (and "Düzeltme talebi") ~41 px down and pushed the bias spectrum off
  // the first screen. Two literal class strings keep the control in place:
  //   - the wrapper dissolves on phones (max-sm:contents), so its children join
  //     the actions row above;
  //   - the visible hint goes to its own line at the END of that row
  //     (max-sm:order-last + max-sm:basis-full).
  // Both must stay plain string literals in the source (Tailwind 4 only
  // generates classes it can read verbatim), and the button must stay before
  // the live region in the markup.
  describe("compare button hint never moves the control on phones (h60-mobile-1)", () => {
    const COMPARE_PATH = resolve(ROOT, "src/components/compare/compare-button.tsx");
    const WRAPPER_CLASS = "inline-flex flex-wrap items-center gap-2 max-sm:contents";
    const HINT_VISIBLE_CLASS =
      "text-[11px] text-muted-foreground max-sm:order-last max-sm:basis-full";
    const src = readFileSync(COMPARE_PATH, "utf8");

    /** The opening tag (from `<span` to its closing `>`) that contains `marker`. */
    function spanTagAround(marker: string): string {
      const at = src.indexOf(marker);
      expect(at, `compare-button.tsx has ${marker}`).toBeGreaterThan(-1);
      // Exactly one: the guard would silently pin the wrong element otherwise.
      expect(src.indexOf(marker, at + 1), `${marker} appears once`).toBe(-1);
      const open = src.lastIndexOf("<span", at);
      expect(open, `${marker} sits in a <span>`).toBeGreaterThan(-1);
      const end = openingTagEnd(src, open);
      expect(end, "the span tag closes").toBeGreaterThan(at);
      return src.slice(open, end);
    }

    it("the wrapper carries the phone-dissolving class as a string literal", () => {
      const wrapper = spanTagAround(WRAPPER_CLASS);
      const tokens = classTokensIn(wrapper, 0, wrapper.length);
      expect(tokens, "the wrapper has a literal className").not.toBeNull();
      expect(tokens!.join(" ")).toBe(WRAPPER_CLASS);
      for (const token of ["inline-flex", "flex-wrap", "items-center", "gap-2", "max-sm:contents"]) {
        expect(tokens, `wrapper ${token}`).toContain(token);
      }
    });

    it("the live region keeps both hint classes as quoted string literals", () => {
      const status = spanTagAround('role="status"');
      // Whitespace-normalised so a line break from the formatter cannot hide it.
      const tag = status.split(/\s+/).filter(Boolean).join(" ");
      expect(tag).toContain("hint.srOnly");
      expect(tag).toContain('"sr-only"');
      expect(tag).toContain(`"${HINT_VISIBLE_CLASS}"`);
      for (const token of ["max-sm:order-last", "max-sm:basis-full"]) {
        expect(HINT_VISIBLE_CLASS.split(" "), `hint ${token}`).toContain(token);
      }
    });

    it("renders [link] [button] [role=status] in source order: the button precedes the live region", () => {
      // Scan from the wrapper element on: the header comment above the
      // component mentions <button> and a link in prose.
      const from = src.indexOf(WRAPPER_CLASS);
      expect(from, "the wrapper element").toBeGreaterThan(-1);
      const link = src.indexOf("<Link", from);
      const firstButton = src.indexOf("<button", from);
      const lastButtonClose = src.lastIndexOf("</button>");
      const status = src.indexOf('role="status"', from);
      expect(link, "a <Link>").toBeGreaterThan(-1);
      expect(firstButton, "a <button>").toBeGreaterThan(-1);
      expect(status, "the live region").toBeGreaterThan(-1);
      expect(link).toBeLessThan(firstButton);
      // Both button branches (add / remove-or-clear) come before the region.
      expect(lastButtonClose).toBeLessThan(status);
      // One live region only.
      expect(src.indexOf('role="status"', status + 1)).toBe(-1);
    });

    it("keeps the 44 px targets on the compare controls", () => {
      expect(src).toContain('const CHIP_TARGET = "min-h-[44px] touch-manipulation";');
      expect(src).toContain("inline-flex min-h-[44px] items-center px-1 touch-manipulation");
    });
  });

  it("scans correctly: a computed className is reported as no literal", () => {
    const computed = '<span aria-label="x" className={cx("a", "b")}>';
    expect(classTokensIn(computed, 0, openingTagEnd(computed, 0))).toBeNull();
    const literal = '<span className="a  b>c" aria-label="x">';
    expect(classTokensIn(literal, 0, openingTagEnd(literal, 0))).toEqual(["a", "b>c"]);
  });
});
