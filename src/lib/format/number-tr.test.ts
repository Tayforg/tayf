import { describe, expect, it } from "vitest";

import { formatCountTr, formatPctTr } from "./number-tr";

describe("formatCountTr", () => {
  it("groups thousands with a dot, including four-digit numbers", () => {
    // tr-TR's default minimumGroupingDigits is 2, which would print "1689".
    expect(formatCountTr(1689)).toBe("1.689");
  });

  it("groups six-digit numbers", () => {
    expect(formatCountTr(218109)).toBe("218.109");
  });

  it("leaves three-digit numbers alone", () => {
    expect(formatCountTr(999)).toBe("999");
  });

  it("formats zero", () => {
    expect(formatCountTr(0)).toBe("0");
  });

  it("rounds fractions to whole numbers", () => {
    expect(formatCountTr(1234.6)).toBe("1.235");
  });

  it("treats NaN as 0", () => {
    expect(formatCountTr(Number.NaN)).toBe("0");
  });

  it("treats Infinity and -Infinity as 0", () => {
    expect(formatCountTr(Number.POSITIVE_INFINITY)).toBe("0");
    expect(formatCountTr(Number.NEGATIVE_INFINITY)).toBe("0");
  });

  it("keeps the minus sign on negative numbers", () => {
    expect(formatCountTr(-1689)).toBe("-1.689");
  });
});

describe("formatPctTr", () => {
  it("uses the Turkish prefix form", () => {
    expect(formatPctTr(50)).toBe("%50");
  });

  it("formats 100", () => {
    expect(formatPctTr(100)).toBe("%100");
  });

  it("formats 0", () => {
    expect(formatPctTr(0)).toBe("%0");
  });

  it("treats NaN as 0", () => {
    expect(formatPctTr(Number.NaN)).toBe("%0");
  });
});
