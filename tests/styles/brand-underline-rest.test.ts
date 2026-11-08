import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// WCAG 1.4.1 (use of colour, level A, failure F73): `.brand-underline` links
// had NO cue at rest. The rule was `text-decoration: none` plus a gradient
// background-image sized `0% 2px`, grown to `100% 2px` only on :hover. Tailwind
// preflight makes every <a> inherit its colour, so the in-sentence links on
// /metodoloji and /duzeltmeler looked exactly like the surrounding muted text;
// touch and keyboard users never trigger :hover. A gradient-only cue also
// vanishes in forced-colors mode, which strips background images. (h66-contrast-1)
//
// The fix is a real text-decoration at rest (1px, brand amber, offset 3px) that
// only gets thicker on hover. What this file pins, read from src/app/globals.css:
//  1. the `.brand-underline` rule declares `text-decoration-line: underline` (or
//     the shorthand) and neither `text-decoration: none` nor `background-size: 0%`
//     nor a background-image cue;
//  2. the rule sets `text-underline-offset`;
//  3. `.brand-underline:hover` changes only thickness or colour, never the line;
//  4. the decoration colour is at least 3:1 on the dark --background and --card
//     (WCAG 1.4.11 for a non-text cue; the app is dark-only).
//
// CodeQL: every scan below is a character scan or a literal split; there is no
// tag-stripping regex and no nested-quantifier regex.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const GLOBALS_CSS = readFileSync(join(ROOT, "src/app/globals.css"), "utf8");

// --------------------------------------------------------------------------
// CSS slicing (character scan; same approach as nav-current-contrast.test.ts)
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
  /** Text before the opening brace, trimmed (`:root`, `@layer utilities`, `.brand-underline`). */
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

function ruleIn(css: string, selector: string): CssRule {
  const rule = childRules(css).find((r) => r.selector === selector);
  if (!rule) throw new Error(`no rule "${selector}" in css`);
  return rule;
}

/** `prop: value` pairs of a rule body (later declarations win, like the cascade). */
function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of body.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    out.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
  }
  return out;
}

const CSS = blankCssComments(GLOBALS_CSS);
const UTILITIES = ruleIn(CSS, "@layer utilities").body;
const REST = declarations(ruleIn(UTILITIES, ".brand-underline").body);
const HOVER = declarations(ruleIn(UTILITIES, ".brand-underline:hover").body);
const DARK = ruleIn(CSS, ".dark").body;

/** Whitespace-separated tokens of a declaration value. */
const tokensOf = (value: string | undefined): string[] => (value ?? "").split(/\s+/).filter(Boolean);

/** True when the declarations switch an underline on (longhand or shorthand). */
function underlinesAtRest(decls: ReadonlyMap<string, string>): boolean {
  return (
    tokensOf(decls.get("text-decoration-line")).includes("underline") ||
    tokensOf(decls.get("text-decoration")).includes("underline")
  );
}

/** Why a `.brand-underline` rule body leaves the link without a rest cue; [] when it has one. */
function restProblems(decls: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  if (!underlinesAtRest(decls)) problems.push("no text-decoration-line: underline at rest");
  if (tokensOf(decls.get("text-decoration")).includes("none")) problems.push("text-decoration: none");
  if (tokensOf(decls.get("text-decoration-line")).includes("none")) problems.push("text-decoration-line: none");
  if ((decls.get("background-size") ?? "").startsWith("0%")) problems.push("background-size: 0% (cue hidden at rest)");
  if (decls.has("background-image")) problems.push("background-image cue (stripped in forced-colors mode)");
  if (!decls.has("text-underline-offset")) problems.push("no text-underline-offset");
  return problems;
}

// --------------------------------------------------------------------------
// Colour maths (same arithmetic as tests/styles/nav-current-contrast.test.ts)
// --------------------------------------------------------------------------

/** Gamma-encoded sRGB, each channel 0..1. */
type Rgb = readonly [number, number, number];

const srgbEncode = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const srgbDecode = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** `oklch(0.76 0.12 75)` -> gamma-encoded sRGB, gamut-clamped. */
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

/** A custom property of a rule body, as a gamma-encoded sRGB colour. */
function tokenIn(body: string, name: string): Rgb {
  const decl = `--${name}:`;
  const at = body.indexOf(decl);
  if (at === -1) throw new Error(`--${name} not found`);
  const end = body.indexOf(";", at);
  return oklchToSrgb(body.slice(at + decl.length, end === -1 ? body.length : end));
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe(".brand-underline rest cue (WCAG 1.4.1, F73)", () => {
  it("declares an underline at rest (text-decoration-line or the shorthand)", () => {
    expect(underlinesAtRest(REST)).toBe(true);
  });

  it("does not switch the decoration off, size the cue to 0%, or rely on a background gradient", () => {
    expect(REST.get("text-decoration")).not.toBe("none");
    expect(REST.get("text-decoration-line")).not.toBe("none");
    expect((REST.get("background-size") ?? "").startsWith("0%")).toBe(false);
    expect(REST.has("background-image")).toBe(false);
    expect(restProblems(REST)).toEqual([]);
  });

  it("sets text-underline-offset so the underline clears descenders", () => {
    expect(REST.has("text-underline-offset")).toBe(true);
  });

  it("uses the 1px brand underline at rest", () => {
    expect(REST.get("text-decoration-thickness")).toBe("1px");
    expect(REST.get("text-decoration-color")).toBe("oklch(0.76 0.12 75)");
  });

  it("changes only thickness or colour on :hover, never the decoration line", () => {
    expect(HOVER.size).toBeGreaterThan(0);
    const allowed = new Set(["text-decoration-thickness", "text-decoration-color"]);
    const extra = [...HOVER.keys()].filter((prop) => !allowed.has(prop));
    expect(extra, `:hover may only change thickness or colour, found: ${extra.join(", ")}`).toEqual([]);
    expect(HOVER.has("text-decoration-line")).toBe(false);
    expect(HOVER.has("text-decoration")).toBe(false);
  });

  it("thickens the underline on :hover (a hover affordance on top of the rest cue)", () => {
    expect(HOVER.get("text-decoration-thickness")).toBe("2px");
  });

  describe("decoration colour (non-text cue, 3:1)", () => {
    // Read inside each test so a missing declaration fails that test, not the whole file.
    const decoration = (): Rgb => {
      const value = REST.get("text-decoration-color");
      if (value === undefined) throw new Error(".brand-underline declares no text-decoration-color");
      return oklchToSrgb(value);
    };

    it("is at least 3:1 on the dark --background", () => {
      const ratio = contrastRatio(decoration(), tokenIn(DARK, "background"));
      expect(ratio, `decoration on --background is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    });

    it("is at least 3:1 on the dark --card (the source karne and label cards)", () => {
      const ratio = contrastRatio(decoration(), tokenIn(DARK, "card"));
      expect(ratio, `decoration on --card is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    });
  });

  it("keeps the class name on every call site (no className churn)", () => {
    const sites = [
      "src/app/metodoloji/page.tsx",
      "src/app/duzeltmeler/page.tsx",
      "src/app/source/[slug]/page.tsx",
      "src/components/source/source-karne.tsx",
      "src/components/source/label-card.tsx",
      "src/components/source/source-reliability.tsx",
    ];
    for (const file of sites) {
      expect(readFileSync(join(ROOT, file), "utf8"), file).toContain("brand-underline");
    }
  });
});

describe(".brand-underline guard self-checks", () => {
  const OLD_RULE = [
    "text-decoration: none;",
    "background-image: linear-gradient(oklch(0.76 0.12 75), oklch(0.76 0.12 75));",
    "background-size: 0% 2px;",
    "background-position: 0% 100%;",
    "background-repeat: no-repeat;",
    "transition: background-size 0.3s ease;",
  ].join("\n");

  it("flags the pre-fix rule (hover-only gradient, text-decoration: none)", () => {
    const problems = restProblems(declarations(OLD_RULE));
    expect(problems).toContain("no text-decoration-line: underline at rest");
    expect(problems).toContain("text-decoration: none");
    expect(problems).toContain("background-size: 0% (cue hidden at rest)");
    expect(problems).toContain("background-image cue (stripped in forced-colors mode)");
    expect(problems).toContain("no text-underline-offset");
  });

  it("accepts the shorthand `text-decoration: underline` as an at-rest underline", () => {
    const decls = declarations("text-decoration: underline; text-underline-offset: 3px;");
    expect(underlinesAtRest(decls)).toBe(true);
    expect(restProblems(decls)).toEqual([]);
  });

  it("does not take `text-decoration: none` or an unrelated property for an underline", () => {
    expect(underlinesAtRest(declarations("text-decoration: none;"))).toBe(false);
    expect(underlinesAtRest(declarations("text-decoration-line: none;"))).toBe(false);
    expect(underlinesAtRest(declarations("text-decoration-color: underline;"))).toBe(false);
    expect(underlinesAtRest(declarations(""))).toBe(false);
  });

  it("slicer reads the selector's own body, not its :hover sibling", () => {
    const css = ".a { color: red; } .a:hover { color: blue; }";
    expect(declarations(ruleIn(css, ".a").body).get("color")).toBe("red");
    expect(declarations(ruleIn(css, ".a:hover").body).get("color")).toBe("blue");
    expect(() => ruleIn(css, ".b")).toThrow();
    expect(() => childRules(".a { color: red;")).toThrow();
  });

  it("colour maths: black on white is 21:1; token parsing reads the declared value", () => {
    expect(contrastRatio([0, 0, 0], [1, 1, 1])).toBeCloseTo(21, 5);
    expect(tokenIn("--card-foreground: oklch(0 0 0); --foreground: oklch(1 0 0);", "foreground")).toEqual(
      oklchToSrgb("oklch(1 0 0)"),
    );
    expect(() => tokenIn("--background: oklch(1 0 0);", "foreground")).toThrow();
    expect(() => oklchToSrgb("#fff")).toThrow();
  });
});
