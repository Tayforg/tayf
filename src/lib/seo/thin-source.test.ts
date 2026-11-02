import { describe, it, expect } from "vitest";

import { THIN_SOURCE_MIN, THIN_SOURCE_WINDOW_DAYS, isThinSource } from "./thin-source";

describe("thin-source rule (shared by sources.xml and /source/[slug])", () => {
  it("pins the constants the sitemap probe and the page window rely on", () => {
    expect(THIN_SOURCE_MIN).toBe(1);
    expect(THIN_SOURCE_WINDOW_DAYS).toBe(7);
  });

  it("treats a source with no article in the window as thin", () => {
    expect(isThinSource(0)).toBe(true);
  });

  it("treats one article as enough (the boundary)", () => {
    expect(isThinSource(1)).toBe(false);
  });

  it("treats many articles as not thin", () => {
    expect(isThinSource(5)).toBe(false);
    expect(isThinSource(10_000)).toBe(false);
  });

  it("fails closed: NaN and negative counts are thin, never indexable", () => {
    expect(isThinSource(Number.NaN)).toBe(true);
    expect(isThinSource(-1)).toBe(true);
    expect(isThinSource(Number.NEGATIVE_INFINITY)).toBe(true);
  });
});
