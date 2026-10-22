import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Static source assertion, not a render test: src/app/layout.tsx imports
// next/font/google, which vitest's node environment cannot resolve. Same
// pattern as tests/app/layout-robots.test.ts.

const layoutPath = resolve(__dirname, "../../src/app/layout.tsx");
const layoutSrc = readFileSync(layoutPath, "utf-8");

describe("root layout viewport (dark-only)", () => {
  it("emits one dark theme-color matching --background (oklch(0.14 0.008 60))", () => {
    expect(layoutSrc).toContain('themeColor: "#0c0806"');
  });

  it("declares colorScheme dark", () => {
    expect(layoutSrc).toContain('colorScheme: "dark"');
  });

  it("has no light-mode theme-color or media query left", () => {
    expect(layoutSrc).not.toContain("#ffffff");
    expect(layoutSrc).not.toContain("prefers-color-scheme: light");
  });
});
