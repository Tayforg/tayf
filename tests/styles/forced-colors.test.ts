import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Forced colors (Windows High Contrast) strips box-shadow, so every
// `focus-visible:outline-none` + `ring-*` pairing loses its focus indicator.
// One unlayered `@media (forced-colors: active)` rule restores a real outline
// for all of them (WCAG 2.4.7). It must stay unlayered: Tailwind v4 emits
// `outline-none` inside `@layer utilities`, and unlayered CSS beats any
// layered rule without !important.

const raw = readFileSync(join(__dirname, "..", "..", "src/app/globals.css"), "utf8");

// Blank out every comment with same-length spaces so match indices still
// line up with the original file and braces inside comments never count.
const src = raw.replace(/\/\*[\s\S]*?\*\//g, (c) => " ".repeat(c.length));

/** Brace depth ({ minus }) of everything before `index`. */
function depthBefore(text: string, index: number): number {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
  }
  return depth;
}

/** Body between the first `{` at/after `from` and its matching `}`. */
function blockBody(text: string, from: number): string {
  const open = text.indexOf("{", from);
  expect(open).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced braces after index " + from);
}

describe("globals.css forced-colors", () => {
  const match = /@media\s*\(\s*forced-colors:\s*active\s*\)/.exec(src);

  it("defines a forced-colors: active media query", () => {
    expect(match).not.toBeNull();
  });

  it("depthBefore self-check: reports depth > 0 inside @layer base", () => {
    const layer = src.indexOf("@layer base {");
    expect(layer).toBeGreaterThanOrEqual(0);
    const inside = src.indexOf("{", layer) + 1;
    expect(depthBefore(src, inside)).toBeGreaterThan(0);
    expect(depthBefore(src, layer)).toBe(0);
  });

  it("is unlayered (top level, brace depth 0)", () => {
    expect(match).not.toBeNull();
    expect(depthBefore(src, match!.index)).toBe(0);
  });

  it("restores a visible :focus-visible outline using a system colour", () => {
    expect(match).not.toBeNull();
    const body = blockBody(src, match!.index);
    const rule = /(?:^|[\s,}])(\*?:focus-visible)\s*\{([^}]*)\}/.exec(body);
    expect(rule, "no :focus-visible rule in the forced-colors block").not.toBeNull();
    const decls = rule![2]!;
    expect(decls).toMatch(/outline:\s*2px\s+solid\s+(Highlight|CanvasText)/);
    expect(decls).toMatch(/outline-offset:\s*2px/);
  });

  it("keeps the prefers-reduced-motion block (the append did not clobber it)", () => {
    expect(src).toMatch(/@media \(prefers-reduced-motion: reduce\) \{/);
  });
});
