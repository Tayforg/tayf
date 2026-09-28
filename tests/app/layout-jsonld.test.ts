import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Source-grep, not a render test: layout.tsx imports next/font/google,
// which vitest's node environment cannot resolve (same pattern as
// tests/app/layout-robots.test.ts and tests/app/konu-routes.test.ts).

const layoutPath = resolve(__dirname, "../../src/app/layout.tsx");
const layoutSrc = readFileSync(layoutPath, "utf-8");

describe("root layout sitewide JSON-LD (seo-4/seo-5)", () => {
  it("renders exactly one application/ld+json script built from buildSiteJsonLd via serializeJsonLd", () => {
    expect(layoutSrc).toContain("application/ld+json");
    expect(layoutSrc).toContain("serializeJsonLd(");
    expect(layoutSrc).toContain("buildSiteJsonLd(");
  });
});
