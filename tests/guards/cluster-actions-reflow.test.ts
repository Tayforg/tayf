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

  it("scans correctly: a computed className is reported as no literal", () => {
    const computed = '<span aria-label="x" className={cx("a", "b")}>';
    expect(classTokensIn(computed, 0, openingTagEnd(computed, 0))).toBeNull();
    const literal = '<span className="a  b>c" aria-label="x">';
    expect(classTokensIn(literal, 0, openingTagEnd(literal, 0))).toEqual(["a", "b>c"]);
  });
});
