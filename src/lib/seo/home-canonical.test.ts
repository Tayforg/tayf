import { describe, it, expect } from "vitest";
import { expectLinear, rep } from "../../../tests/_helpers/linear-time";
import {
  ARCHIVE_MAX_PAGE,
  ARCHIVE_PAGE_SIZE,
  HOME_PAGE_SIZE,
  homeCanonicalPath,
  homePageTitle,
  homeTotalPages,
  parseArchivePage,
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

describe("parseArchivePage (?arsiv=, h170-roadmap-1)", () => {
  it("the archive is paged to 4 pages of 24: the 96 best matches", () => {
    expect(ARCHIVE_MAX_PAGE).toBe(4);
    expect(ARCHIVE_PAGE_SIZE).toBe(24);
    expect(ARCHIVE_MAX_PAGE * ARCHIVE_PAGE_SIZE).toBe(96);
  });
  it("reads 2, 3 and 4 as themselves", () => {
    expect(parseArchivePage("2")).toBe(2);
    expect(parseArchivePage("3")).toBe(3);
    expect(parseArchivePage("4")).toBe(4);
  });
  it("reads 1 and a missing value as page 1", () => {
    expect(parseArchivePage("1")).toBe(1);
    expect(parseArchivePage(undefined)).toBe(1);
  });
  it("reads anything that is not a positive whole number as page 1", () => {
    for (const raw of ["abc", "0", "-1", "", " ", "2.5", "1e3", "0x2", "2x", " 2", "²", "NaN", "Infinity", "٢"]) {
      expect(parseArchivePage(raw), JSON.stringify(raw)).toBe(1);
    }
  });
  it("reads an array (a repeated ?arsiv=) as page 1, not as its first value", () => {
    expect(parseArchivePage(["2"])).toBe(1);
    expect(parseArchivePage(["3", "4"])).toBe(1);
    expect(parseArchivePage([])).toBe(1);
  });
  it("clamps a page past the last one to 4", () => {
    expect(parseArchivePage("5")).toBe(4);
    expect(parseArchivePage("9")).toBe(4);
    expect(parseArchivePage("99999999999999999999")).toBe(4);
    expect(parseArchivePage("9".repeat(400))).toBe(4);
  });
  it("accepts leading zeros without changing the page", () => {
    expect(parseArchivePage("02")).toBe(2);
    expect(parseArchivePage("000004")).toBe(4);
    expect(parseArchivePage("00")).toBe(1);
  });
  it("a very long digit string is read in linear time", () => {
    // Load-robust (tests/_helpers/linear-time.ts): the growth over a size ladder, not an absolute time.
    expectLinear(rep("9"), (raw) => parseArchivePage(raw), { n: 200_000, ceilingMs: 2000 });
    expect(parseArchivePage("9".repeat(200_000))).toBe(4);
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

describe("homePageTitle", () => {
  it("returns null for page 1 (the layout's default title applies)", () => {
    expect(homePageTitle(1, 3)).toBeNull();
    expect(homePageTitle(1, null)).toBeNull();
    expect(homePageTitle(0, 3)).toBeNull();
    expect(homePageTitle(-4, null)).toBeNull();
  });
  it("names the page and the total when the total is known", () => {
    expect(homePageTitle(2, 3)).toBe("Haberler — sayfa 2 / 3 — Tayf");
    expect(homePageTitle(3, 3)).toBe("Haberler — sayfa 3 / 3 — Tayf");
  });
  it("drops the total when it is unknown", () => {
    expect(homePageTitle(2, null)).toBe("Haberler — sayfa 2 — Tayf");
    expect(homePageTitle(40, null)).toBe("Haberler — sayfa 40 — Tayf");
  });
  it("clamps a page past the end like homeCanonicalPath does", () => {
    expect(homePageTitle(9, 3)).toBe("Haberler — sayfa 3 / 3 — Tayf");
    expect(homeCanonicalPath({ page: 9, rankedCount: 31 })).toBe("/?page=3");
  });
  it("returns null when the clamped page is 1", () => {
    expect(homePageTitle(2, 1)).toBeNull();
    expect(homePageTitle(9, 1)).toBeNull();
  });
});
