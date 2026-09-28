import { describe, it, expect } from "vitest";
import {
  HOME_PAGE_SIZE,
  homeCanonicalPath,
  homeTotalPages,
  parseHomePage,
  rankedCountOf,
} from "./home-canonical";

const b = (id: string) => ({ cluster: { id } });

describe("parseHomePage", () => {
  it("defaults to 1 for missing, NaN and sub-1 input", () => {
    for (const raw of [undefined, "", "abc", "0", "-3", "NaN"]) {
      expect(parseHomePage(raw), String(raw)).toBe(1);
    }
  });
  it("parses positive integers and takes the first array value", () => {
    expect(parseHomePage("2")).toBe(2);
    expect(parseHomePage("7x")).toBe(7);
    expect(parseHomePage(["3", "9"])).toBe(3);
    expect(parseHomePage([])).toBe(1);
  });
});

describe("homeTotalPages", () => {
  it("uses a 15 page size", () => {
    expect(HOME_PAGE_SIZE).toBe(15);
  });
  it("is max(1, ceil(n/15))", () => {
    expect(homeTotalPages(0)).toBe(1);
    expect(homeTotalPages(15)).toBe(1);
    expect(homeTotalPages(16)).toBe(2);
    expect(homeTotalPages(30)).toBe(2);
    expect(homeTotalPages(31)).toBe(3);
  });
  it("treats non-finite or negative counts as 1 page", () => {
    for (const n of [NaN, Infinity, -Infinity, -5]) expect(homeTotalPages(n)).toBe(1);
  });
});

describe("rankedCountOf", () => {
  it("subtracts bundles that also appear in breakingBundles", () => {
    const bundles = [b("a"), b("b"), b("c")];
    expect(rankedCountOf({ bundles, breakingBundles: [b("b")] })).toBe(2);
    expect(rankedCountOf({ bundles, breakingBundles: [] })).toBe(3);
    expect(rankedCountOf({ bundles: [], breakingBundles: [b("z")] })).toBe(0);
  });
});

describe("homeCanonicalPath", () => {
  it("returns null for a non-empty q (first value, trimmed)", () => {
    expect(homeCanonicalPath({ q: "x", page: 2, rankedCount: 30 })).toBeNull();
    expect(homeCanonicalPath({ q: ["x", ""], page: 2, rankedCount: 30 })).toBeNull();
  });
  it("ignores a blank q", () => {
    expect(homeCanonicalPath({ q: "  ", page: 2, rankedCount: 30 })).toBe("/?page=2");
    expect(homeCanonicalPath({ q: [], page: 2, rankedCount: 30 })).toBe("/?page=2");
  });
  it("returns null for page <= 1 and for unknown count", () => {
    expect(homeCanonicalPath({ page: 1, rankedCount: 30 })).toBeNull();
    expect(homeCanonicalPath({ page: 0, rankedCount: 30 })).toBeNull();
    expect(homeCanonicalPath({ page: 2, rankedCount: null })).toBeNull();
  });
  it("returns null when the clamped page is 1", () => {
    expect(homeCanonicalPath({ page: 2, rankedCount: 10 })).toBeNull();
    expect(homeCanonicalPath({ page: 9, rankedCount: 15 })).toBeNull();
  });
  it("clamps to the last page", () => {
    expect(homeCanonicalPath({ page: 2, rankedCount: 20 })).toBe("/?page=2");
    expect(homeCanonicalPath({ page: 9, rankedCount: 20 })).toBe("/?page=2");
    expect(homeCanonicalPath({ page: 3, rankedCount: 40 })).toBe("/?page=3");
  });
});

