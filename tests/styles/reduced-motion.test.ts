import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("globals.css prefers-reduced-motion", () => {
  const src = readFileSync(join(__dirname, "..", "..", "src/app/globals.css"), "utf8");
  const match = src.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/);

  it("defines a prefers-reduced-motion media query", () => {
    expect(match).toBeTruthy();
  });

  it("forces near-zero animation timing, each !important", () => {
    const block = match![0];
    expect(block).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(block).toMatch(/animation-delay:\s*0ms\s*!important/);
    expect(block).toMatch(/animation-iteration-count:\s*1\s*!important/);
    expect(block).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
  });
});
