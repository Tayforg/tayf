import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// WCAG 1.4.11 (non-text contrast) and 1.4.1 (use of colour): the header nav's
// current-page cue was `bg-foreground/10` plus an 80% vs 100% icon opacity.
// On the dark theme that tint composites to rgb(34,31,28), 1.21:1 against the
// header, and the active icon vs an inactive icon is 1.56:1. Below `sm` the
// labels are sr-only, so on a phone the nav is icons only and font-weight
// cannot show either. The fix is a full-foreground 2 px bottom border on the
// active link (`border-b-2 border-foreground`); every other link reserves the
// same border in `border-transparent`, so nothing shifts. (h41-a11y-1)
//
// What this file pins, computed from the tokens in src/app/globals.css:
//  1. --foreground vs --background is >= 3:1 in BOTH themes (the bar vs the
//     header it sits in);
//  2. --foreground vs the 10% tint it sits under is >= 3:1 in both themes (the
//     link's background paints under its border, so the bar's upper neighbour
//     is the tint, not the plain page);
//  3. the tint alone (foreground at 10% over background) is < 3:1, so the rule
//     explains why the border is needed;
//  4. the `active` constant of nav-links.tsx still carries `border-foreground`;
//  5. the idle states (`inactive` and the admin idle string) carry
//     `forced-colors:border-[Canvas]`: in forced-colors mode a transparent
//     border is repainted in the system colour (LinkText), which would make
//     every idle bar identical to the current one. `active` must not carry it.
//
// CodeQL: every scan below is a character scan or a literal split; there is no
// tag-stripping regex and no nested-quantifier regex.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const GLOBALS_CSS = readFileSync(join(ROOT, "src/app/globals.css"), "utf8");
const NAV_LINKS_SRC = readFileSync(join(ROOT, "src/components/layout/nav-links.tsx"), "utf8");

// --------------------------------------------------------------------------
// CSS slicing (character scan; same approach as focus-ring-contrast.test.ts)
// --------------------------------------------------------------------------

/** `css` with every block comment replaced by spaces (same length, newlines kept). */
function blankCssComments(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    if (css[i] === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const stop = end === -1 ? css.length : end + 2;
      for (; i < stop; i++) out += css[i] === "\n" ? "\n" : " ";
      continue;
    }
    out += css[i];
    i++;
  }
  return out;
}

interface CssRule {
  /** Text before the opening brace, trimmed (`:root`, `.dark`). */
  selector: string;
  /** Text between the matching braces. */
  body: string;
}

/** The direct child rules of `css` (one nesting level), found by a brace-balanced scan. */
function childRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  let depth = 0;
  let selectorStart = 0;
  let bodyStart = -1;
  let selector = "";
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === "{") {
      if (depth === 0) {
        selector = css.slice(selectorStart, i).trim();
        bodyStart = i + 1;
      }
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        rules.push({ selector, body: css.slice(bodyStart, i) });
        selectorStart = i + 1;
      }
      if (depth < 0) throw new Error("unbalanced '}' in css");
    } else if (c === ";" && depth === 0) {
      // A top-level statement such as `@import "x";` ends the next selector's lead-in.
      selectorStart = i + 1;
    }
  }
  if (depth !== 0) throw new Error("unbalanced '{' in css");
  return rules;
}

function topLevelRule(css: string, selector: string): CssRule {
  const rule = childRules(css).find((r) => r.selector === selector);
  if (!rule) throw new Error(`no top-level rule "${selector}" in css`);
  return rule;
}

// --------------------------------------------------------------------------
// Colour maths (same arithmetic as tests/styles/focus-ring-contrast.test.ts)
// --------------------------------------------------------------------------

/** Gamma-encoded sRGB, each channel 0..1. */
type Rgb = readonly [number, number, number];

const srgbEncode = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const srgbDecode = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** `oklch(0.19 0.01 60)` or `oklch(70.4% 0.191 22.216)` -> gamma-encoded sRGB, gamut-clamped. */
function oklchToSrgb(value: string): Rgb {
  const m = /oklch\(\s*([\d.]+)(%?)\s+([\d.]+|none)\s+([\d.]+|none)\s*\)/.exec(value);
  if (!m) throw new Error(`not an oklch() colour: ${value}`);
  const L = Number(m[1]) / (m[2] === "%" ? 100 : 1);
  const C = m[3] === "none" ? 0 : Number(m[3]);
  const hue = ((m[4] === "none" ? 0 : Number(m[4])) * Math.PI) / 180;
  const a = C * Math.cos(hue);
  const b = C * Math.sin(hue);
  // OKLab -> LMS' -> LMS (cube) -> linear sRGB (Ottosson's reference matrices).
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ].map((v) => srgbEncode(Math.min(1, Math.max(0, v))));
  return [linear[0]!, linear[1]!, linear[2]!];
}

/** WCAG 2.x relative luminance of a gamma-encoded sRGB colour. */
function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(srgbDecode) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1..21, order-independent. */
function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `fg` at `alpha` over `bg`, composited in gamma-encoded sRGB (how browsers blend). */
function composite(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => alpha * fg[i]! + (1 - alpha) * bg[i]!) as unknown as Rgb;
}

/** A custom property of a rule body, as a gamma-encoded sRGB colour. */
function tokenIn(body: string, name: string): Rgb {
  const decl = `--${name}:`;
  const at = body.indexOf(decl);
  if (at === -1) throw new Error(`--${name} not found`);
  const end = body.indexOf(";", at);
  return oklchToSrgb(body.slice(at + decl.length, end === -1 ? body.length : end));
}

// --------------------------------------------------------------------------
// nav-links.tsx source slicing (literal scan, no regex)
// --------------------------------------------------------------------------

/**
 * The text of the double-quoted string literal assigned to `const <name> =` at
 * the top of nav-links.tsx. The literal may sit on the next line.
 */
function stringConstant(src: string, name: string): string {
  const decl = `const ${name} =`;
  const at = src.indexOf(decl);
  if (at === -1) throw new Error(`no \`${decl}\` in source`);
  const open = src.indexOf('"', at + decl.length);
  if (open === -1) throw new Error(`\`${name}\` is not a double-quoted string`);
  // Only whitespace may sit between `=` and the opening quote.
  if (src.slice(at + decl.length, open).trim() !== "") {
    throw new Error(`\`${name}\` is not initialised with a string literal`);
  }
  const close = src.indexOf('"', open + 1);
  if (close === -1) throw new Error(`unterminated string for \`${name}\``);
  return src.slice(open + 1, close);
}

const CSS = blankCssComments(GLOBALS_CSS);
const LIGHT = topLevelRule(CSS, ":root").body;
const DARK = topLevelRule(CSS, ".dark").body;

const THEMES = [
  { name: "light (:root)", body: LIGHT },
  { name: "dark (.dark)", body: DARK },
] as const;

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("header nav current-page cue: border colour (WCAG 1.4.11, 3:1)", () => {
  for (const { name, body } of THEMES) {
    const foreground = tokenIn(body, "foreground");
    const background = tokenIn(body, "background");
    const tint = composite(foreground, background, 0.1);

    it(`${name}: --foreground (the bar) is at least 3:1 on --background (the header)`, () => {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(3);
    });

    it(`${name}: --foreground (the bar) is at least 3:1 on the bg-foreground/10 tint above it`, () => {
      expect(contrastRatio(foreground, tint)).toBeGreaterThanOrEqual(3);
    });

    it(`${name}: the tint alone (foreground at 10% over background) is below 3:1`, () => {
      expect(contrastRatio(tint, background)).toBeLessThan(3);
    });
  }

  it("explains the bug: the dark tint is 1.21:1 against the header, as measured in production", () => {
    const foreground = tokenIn(DARK, "foreground");
    const background = tokenIn(DARK, "background");
    const tint = composite(foreground, background, 0.1);
    expect(contrastRatio(tint, background)).toBeCloseTo(1.21, 1);
  });

  it("explains the bug: the 80% -> 100% icon opacity step is 1.56:1 on the dark theme", () => {
    const foreground = tokenIn(DARK, "foreground");
    const background = tokenIn(DARK, "background");
    const inactiveIcon = composite(foreground, background, 0.8);
    expect(contrastRatio(foreground, inactiveIcon)).toBeLessThan(3);
    expect(contrastRatio(foreground, inactiveIcon)).toBeCloseTo(1.56, 1);
  });
});

describe("header nav current-page cue: nav-links.tsx source guard", () => {
  const active = stringConstant(NAV_LINKS_SRC, "active");
  const baseLink = stringConstant(NAV_LINKS_SRC, "baseLink");
  const activeTokens = active.split(/\s+/).filter(Boolean);
  const baseTokens = baseLink.split(/\s+/).filter(Boolean);

  it("the `active` constant carries border-foreground (full-colour bar, not just the tint)", () => {
    expect(activeTokens).toContain("border-foreground");
  });

  it("the `active` constant keeps the tint and weight as supplements", () => {
    expect(activeTokens).toContain("bg-foreground/10");
    expect(activeTokens).toContain("font-medium");
  });

  it("`baseLink` reserves the border width for every state, without a colour", () => {
    expect(baseTokens).toContain("border-b-2");
    // A colour on the shared base would sit next to border-foreground on the
    // active link, and Tailwind emits .border-transparent after
    // .border-foreground, so the transparent one would win and hide the bar.
    expect(baseTokens).not.toContain("border-transparent");
    expect(activeTokens).not.toContain("border-transparent");
  });

  it("the `inactive` constant carries border-transparent, so the active state shifts nothing", () => {
    expect(stringConstant(NAV_LINKS_SRC, "inactive").split(/\s+/)).toContain("border-transparent");
  });

  it("the `inactive` constant pins the idle bar to Canvas in forced-colors mode (a transparent border is repainted in LinkText there)", () => {
    expect(stringConstant(NAV_LINKS_SRC, "inactive").split(/\s+/)).toContain(
      "forced-colors:border-[Canvas]",
    );
    expect(activeTokens).not.toContain("forced-colors:border-[Canvas]");
  });

  it("the admin link reserves the border and goes transparent only when idle", () => {
    const adminAt = NAV_LINKS_SRC.indexOf('href="/admin"');
    expect(adminAt).toBeGreaterThan(-1);
    const classAt = NAV_LINKS_SRC.indexOf("className={`", adminAt);
    expect(classAt).toBeGreaterThan(-1);
    const templateEnd = NAV_LINKS_SRC.indexOf("`}", classAt);
    expect(templateEnd).toBeGreaterThan(classAt);
    const template = NAV_LINKS_SRC.slice(classAt, templateEnd);
    const sharedEnd = template.indexOf("${");
    expect(sharedEnd).toBeGreaterThan(-1);
    const shared = template.slice(0, sharedEnd).split(/\s+/);
    expect(shared).toContain("border-b-2");
    expect(shared).not.toContain("border-transparent");
    // The idle branch is the quoted string after the `:` of the ternary.
    const idleAt = template.indexOf(': "');
    expect(idleAt).toBeGreaterThan(sharedEnd);
    const idle = template.slice(idleAt + 3, template.indexOf('"', idleAt + 3)).split(/\s+/);
    expect(idle).toContain("border-transparent");
    expect(idle).toContain("forced-colors:border-[Canvas]");
  });

  it("uses a border, not a ring or shadow, for the cue (rings and shadows are dropped in forced-colors mode)", () => {
    expect(activeTokens.filter((t) => t.includes("ring") || t.startsWith("shadow"))).toEqual([]);
  });

  it("slicer self-check: reads the constant's own literal, not a lookalike", () => {
    const src = 'const inactive = "a b";\nconst active =\n  "c d";\nconst activeX = "e";';
    expect(stringConstant(src, "active")).toBe("c d");
    expect(stringConstant(src, "inactive")).toBe("a b");
    expect(() => stringConstant(src, "missing")).toThrow();
    expect(() => stringConstant("const active = foo();", "active")).toThrow();
  });
});

describe("colour maths self-checks", () => {
  it("black on white is 21:1 and a colour on itself is 1:1", () => {
    expect(contrastRatio([0, 0, 0], [1, 1, 1])).toBeCloseTo(21, 5);
    const c = oklchToSrgb("oklch(0.72 0.06 75)");
    expect(contrastRatio(c, c)).toBeCloseTo(1, 10);
    expect(composite([1, 1, 1], [0, 0, 0], 0.5)).toEqual([0.5, 0.5, 0.5]);
  });

  it("token parsing reads the declared value, not a lookalike", () => {
    expect(tokenIn("--card-foreground: oklch(0 0 0); --foreground: oklch(1 0 0);", "foreground")).toEqual(
      oklchToSrgb("oklch(1 0 0)"),
    );
    expect(() => tokenIn("--background: oklch(1 0 0);", "foreground")).toThrow();
  });

  it("both themes declare --foreground and --background", () => {
    for (const { body } of THEMES) {
      expect(() => tokenIn(body, "foreground")).not.toThrow();
      expect(() => tokenIn(body, "background")).not.toThrow();
    }
  });
});
