import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Static source assertion, not a render test: src/app/layout.tsx imports
// next/font/google, which vitest's node environment cannot resolve, so
// importing the module would fail long before the metadata object could be
// inspected. Same pattern as tests/app/konu-routes.test.ts.

const layoutPath = resolve(__dirname, "../../src/app/layout.tsx");
const layoutSrc = readFileSync(layoutPath, "utf-8");

describe("root layout robots metadata", () => {
  it("sets max-image-preview:large for both the default and Googlebot directives", () => {
    const matches = layoutSrc.match(/"max-image-preview":\s*"large"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(layoutSrc).toContain("googleBot");
  });

  it("keeps index/follow true alongside the large image preview", () => {
    expect(layoutSrc).toMatch(/robots:\s*{[\s\S]*?index:\s*true/);
    expect(layoutSrc).toMatch(/robots:\s*{[\s\S]*?follow:\s*true/);
  });
});

describe("root layout search-console verification", () => {
  it("reads all three verification env vars", () => {
    expect(layoutSrc).toContain("GOOGLE_SITE_VERIFICATION");
    expect(layoutSrc).toContain("YANDEX_VERIFICATION");
    expect(layoutSrc).toContain("BING_VERIFICATION");
    expect(layoutSrc).toContain("msvalidate.01");
  });
});
