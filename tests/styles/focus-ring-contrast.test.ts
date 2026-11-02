import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// WCAG 1.4.11 (non-text contrast): a keyboard focus indicator needs 3:1 against
// the surface it sits on. The default outline of every control that has no
// explicit `focus-visible:ring-*` came from `* { @apply outline-ring/50 }`:
// the ring token at 50% alpha composites to 2.73:1 on the dark page background
// (2.75:1 on the card). The same arithmetic applies to the
// `focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50`
// pattern of the game buttons and the newsletter / correction forms, where the
// ring is the only focus indicator. (h21-a11y-1)
//
// What this file pins:
//  1. the base `*` rule applies `outline-ring` with no `/NN` alpha suffix;
//  2. no non-test file under src/ (outside the shadcn primitives in
//     src/components/ui) writes `focus-visible:ring-ring/NN` unless the same
//     line also carries `focus-visible:border-ring`, which is the shadcn field
//     pattern where the border carries the full-colour indicator;
//  3. the numbers: --ring clears 3:1 on --background and --card in BOTH themes,
//     and the 50%-alpha composite does not (so the rule explains itself).
//
// CodeQL: every scan below is a character scan or a literal split; there is no
// tag-stripping regex and no nested-quantifier regex.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const SRC_DIR = join(ROOT, "src");
const GLOBALS_CSS = readFileSync(join(SRC_DIR, "app/globals.css"), "utf8");

// --------------------------------------------------------------------------
// CSS slicing (character scan)
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
  /** Text before the opening brace, trimmed (`:root`, `@layer base`, `*`). */
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

/** The `* { ... }` rule inside `@layer base { ... }`. */
function baseStarRule(css: string): CssRule {
  const layer = topLevelRule(css, "@layer base");
  const rule = childRules(layer.body).find((r) => r.selector === "*");
  if (!rule) throw new Error("no `* { }` rule inside @layer base");
  return rule;
}

/** Whitespace-separated utility tokens of every `@apply` statement in a rule body. */
function applyTokens(body: string): string[] {
  const tokens: string[] = [];
  let from = 0;
  for (;;) {
    const at = body.indexOf("@apply", from);
    if (at === -1) break;
    const end = body.indexOf(";", at);
    const stop = end === -1 ? body.length : end;
    for (const t of body.slice(at + "@apply".length, stop).split(/\s+/)) {
      if (t !== "") tokens.push(t);
    }
    from = stop;
  }
  return tokens;
}

const CSS = blankCssComments(GLOBALS_CSS);

// --------------------------------------------------------------------------
// Source walker (character scan comment blanking)
// --------------------------------------------------------------------------

/** Repo-relative, forward-slash path. */
function repoPath(file: string): string {
  return relative(ROOT, file).split(sep).join("/");
}

/** Non-test .ts/.tsx files under `dir`, skipping the shadcn primitives in src/components/ui. */
function walkSource(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (repoPath(full) === "src/components/ui") continue;
      out.push(...walkSource(full));
    } else if ((name.endsWith(".ts") || name.endsWith(".tsx")) && !name.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * `src` with every `//` and block comment replaced by spaces (newlines kept so
 * line numbers survive). Quoted strings are tracked so a `//` inside
 * "https://..." does not blank the rest of the line; ' and " strings end at
 * the line break, template literals span lines. A slip here leaves a comment
 * un-blanked (a visible false positive), never hides real code.
 */
function blankComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (quote !== null) {
      out += c;
      if (c === "\\" && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (c === quote || (c === "\n" && quote !== "`")) quote = null;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      for (; i < src.length && src[i] !== "\n"; i++) out += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) out += src[i] === "\n" ? "\n" : " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    out += c;
    i++;
  }
  return out;
}

const RING_ALPHA_PREFIX = "focus-visible:ring-ring/";
const BORDER_RING = "focus-visible:border-ring";

/** Class-name tokens of one line: split on whitespace, quotes, backticks, braces and commas. */
function lineTokens(line: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  for (const c of line) {
    if (c === " " || c === "\t" || c === '"' || c === "'" || c === "`" || c === "{" || c === "}" || c === ",") {
      if (cur !== "") tokens.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur !== "") tokens.push(cur);
  return tokens;
}

/** True when `token` is `focus-visible:ring-ring/<digits>`. */
function isRingAlphaToken(token: string): boolean {
  if (!token.startsWith(RING_ALPHA_PREFIX)) return false;
  const rest = token.slice(RING_ALPHA_PREFIX.length);
  if (rest === "") return false;
  for (const c of rest) if (c < "0" || c > "9") return false;
  return true;
}

/** 1-based line numbers of lines with a `focus-visible:ring-ring/NN` token and no `focus-visible:border-ring`. */
function ringAlphaOffenderLines(src: string): number[] {
  const hits: number[] = [];
  blankComments(src)
    .split("\n")
    .forEach((line, idx) => {
      const tokens = lineTokens(line);
      if (tokens.some(isRingAlphaToken) && !tokens.includes(BORDER_RING)) hits.push(idx + 1);
    });
  return hits;
}

const SOURCE_FILES = walkSource(SRC_DIR).sort();
const SOURCES = new Map(SOURCE_FILES.map((f) => [repoPath(f), readFileSync(f, "utf8")]));

// --------------------------------------------------------------------------
// Colour maths (copied from tests/guards/text-contrast-tokens.test.ts)
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

/** A custom property of a top-level rule body, as a gamma-encoded sRGB colour. */
function tokenIn(body: string, name: string): Rgb {
  const decl = `--${name}:`;
  const at = body.indexOf(decl);
  if (at === -1) throw new Error(`--${name} not found`);
  const end = body.indexOf(";", at);
  return oklchToSrgb(body.slice(at + decl.length, end === -1 ? body.length : end));
}

const LIGHT = topLevelRule(CSS, ":root").body;
const DARK = topLevelRule(CSS, ".dark").body;

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("base outline colour (globals.css `@layer base { * { ... } }`)", () => {
  const star = baseStarRule(CSS);
  const tokens = applyTokens(star.body);

  it("applies outline-ring at full opacity", () => {
    expect(tokens).toContain("outline-ring");
  });

  it("carries no outline-ring/NN alpha variant", () => {
    expect(tokens.filter((t) => t.startsWith("outline-ring/"))).toEqual([]);
  });

  it("slicer self-check: finds the rule inside the layer, not a sibling `*`", () => {
    const css = "@layer base { * { @apply outline-ring/50; } body { @apply x; } } * { @apply other; }";
    expect(applyTokens(baseStarRule(css).body)).toEqual(["outline-ring/50"]);
    expect(applyTokens("@apply a b;\n @apply c;")).toEqual(["a", "b", "c"]);
    expect(() => baseStarRule("@layer base { body { color: red; } }")).toThrow();
  });
});

describe("focus-visible:ring-ring/NN (partial-alpha focus rings)", () => {
  it("walks a meaningful number of files and skips src/components/ui", () => {
    expect(SOURCES.size).toBeGreaterThan(50);
    expect([...SOURCES.keys()].some((p) => p.startsWith("src/components/ui/"))).toBe(false);
    expect([...SOURCES.keys()].some((p) => p.includes(".test."))).toBe(false);
  });

  it("no file uses a partial-alpha ring without focus-visible:border-ring on the same line", () => {
    const offenders: string[] = [];
    for (const [file, src] of SOURCES) {
      for (const line of ringAlphaOffenderLines(src)) offenders.push(`${file}:${line}`);
    }
    expect(offenders).toEqual([]);
  });

  it("is not vacuous: bias-badge.tsx is scanned, carries ring-ring/NN with border-ring, and is exempt", () => {
    const file = "src/components/story/bias-badge.tsx";
    const src = SOURCES.get(file);
    expect(src).toBeDefined();
    const tokens = lineTokens(blankComments(src!));
    expect(tokens.some(isRingAlphaToken)).toBe(true);
    expect(tokens).toContain(BORDER_RING);
    expect(ringAlphaOffenderLines(src!)).toEqual([]);
  });

  it("scanner self-check on synthetic strings", () => {
    const bad = 'className="focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"';
    expect(ringAlphaOffenderLines(bad)).toEqual([1]);
    expect(ringAlphaOffenderLines(`x\n${bad}\ny`)).toEqual([2]);
    // Template literal and arbitrary alpha digits.
    expect(ringAlphaOffenderLines("`a focus-visible:ring-ring/35 b`")).toEqual([1]);
    // Full-colour ring, border-carried ring, and a different ring colour are fine.
    expect(ringAlphaOffenderLines("focus-visible:ring-2 focus-visible:ring-ring")).toEqual([]);
    expect(ringAlphaOffenderLines("focus-visible:border-ring focus-visible:ring-ring/50")).toEqual([]);
    expect(ringAlphaOffenderLines("focus-visible:ring-destructive/50")).toEqual([]);
    // A token that merely contains the prefix is not the ring token.
    expect(ringAlphaOffenderLines("focus-visible:ring-ring/50x")).toEqual([]);
    // Comments are blanked.
    expect(ringAlphaOffenderLines("// focus-visible:ring-ring/50")).toEqual([]);
    expect(ringAlphaOffenderLines("/* focus-visible:ring-ring/50 */")).toEqual([]);
    expect(ringAlphaOffenderLines('const u = "https://x"; a = "focus-visible:ring-ring/50"')).toEqual([1]);
  });
});

describe("--ring contrast (WCAG 1.4.11, 3:1 for the focus indicator)", () => {
  const themes = [
    { name: "light (:root)", body: LIGHT },
    { name: "dark (.dark)", body: DARK },
  ];

  for (const { name, body } of themes) {
    const ring = tokenIn(body, "ring");
    const background = tokenIn(body, "background");
    const card = tokenIn(body, "card");

    it(`${name}: --ring is at least 3:1 on --background`, () => {
      expect(contrastRatio(ring, background)).toBeGreaterThanOrEqual(3);
    });

    it(`${name}: --ring is at least 3:1 on --card`, () => {
      expect(contrastRatio(ring, card)).toBeGreaterThanOrEqual(3);
    });
  }

  it("explains the bug: the dark ring at 50% alpha is below 3:1 on the page and the card", () => {
    const ring = tokenIn(DARK, "ring");
    const background = tokenIn(DARK, "background");
    const card = tokenIn(DARK, "card");
    const onBackground = contrastRatio(composite(ring, background, 0.5), background);
    const onCard = contrastRatio(composite(ring, card, 0.5), card);
    expect(onBackground).toBeLessThan(3);
    expect(onCard).toBeLessThan(3);
    // Matches the measured 2.73 / 2.75 of the production audit.
    expect(onBackground).toBeCloseTo(2.73, 1);
  });

  it("colour-maths self-check: black on white is 21:1 and a colour on itself is 1:1", () => {
    expect(contrastRatio([0, 0, 0], [1, 1, 1])).toBeCloseTo(21, 5);
    const c = oklchToSrgb("oklch(0.72 0.06 75)");
    expect(contrastRatio(c, c)).toBeCloseTo(1, 10);
    expect(composite([1, 1, 1], [0, 0, 0], 0.5)).toEqual([0.5, 0.5, 0.5]);
  });

  it("token parsing self-check: reads the declared value, not a lookalike", () => {
    expect(tokenIn("--sidebar-ring: oklch(0 0 0); --ring: oklch(1 0 0);", "ring")).toEqual(oklchToSrgb("oklch(1 0 0)"));
    expect(() => tokenIn("--background: oklch(1 0 0);", "ring")).toThrow();
  });
});
