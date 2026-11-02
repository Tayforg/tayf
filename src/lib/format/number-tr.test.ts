import { describe, expect, it } from "vitest";

import { formatCountTr, formatPctTr, signedPercentTr } from "./number-tr";

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

describe("signedPercentTr", () => {
  it("writes a negative move as sign, percent sign, number", () => {
    expect(signedPercentTr(-4.73)).toBe("-%4,73");
  });

  it("writes a positive move with an explicit plus", () => {
    expect(signedPercentTr(9.95)).toBe("+%9,95");
  });

  it("writes zero without a sign", () => {
    expect(signedPercentTr(0)).toBe("%0,00");
  });

  it("groups thousands with a dot and keeps comma decimals", () => {
    expect(signedPercentTr(1234.5)).toBe("+%1.234,50");
    expect(signedPercentTr(-1234.5)).toBe("-%1.234,50");
  });

  it("honours the fraction digit count", () => {
    expect(signedPercentTr(12.345, 1)).toBe("+%12,3");
    expect(signedPercentTr(4.6, 0)).toBe("+%5");
    expect(signedPercentTr(-4.6, 0)).toBe("-%5");
    expect(signedPercentTr(1.23456, 4)).toBe("+%1,2346");
  });

  it("gives a value that rounds to zero no sign, so there is no '+%0,00' or '-%0,00'", () => {
    expect(signedPercentTr(-0.001)).toBe("%0,00");
    expect(signedPercentTr(0.004)).toBe("%0,00");
    expect(signedPercentTr(-0)).toBe("%0,00");
    expect(signedPercentTr(-0.4, 0)).toBe("%0");
    expect(signedPercentTr(-0.04, 1)).toBe("%0,0");
  });

  it("keeps the sign on the smallest value that still shows a non-zero digit", () => {
    expect(signedPercentTr(0.01)).toBe("+%0,01");
    expect(signedPercentTr(-0.01)).toBe("-%0,01");
  });

  it("treats NaN, Infinity and -Infinity as zero", () => {
    expect(signedPercentTr(Number.NaN)).toBe("%0,00");
    expect(signedPercentTr(Number.POSITIVE_INFINITY)).toBe("%0,00");
    expect(signedPercentTr(Number.NEGATIVE_INFINITY)).toBe("%0,00");
    expect(signedPercentTr(Number.NaN, 1)).toBe("%0,0");
  });

  it("clamps the fraction digit count to an integer in 0..4", () => {
    expect(signedPercentTr(1.234567, 9)).toBe("+%1,2346");
    expect(signedPercentTr(1.234567, -3)).toBe("+%1");
    expect(signedPercentTr(1.234567, 1.9)).toBe("+%1,2");
    expect(signedPercentTr(1.234567, Number.NaN)).toBe("+%1,23");
    expect(signedPercentTr(1.234567, Number.POSITIVE_INFINITY)).toBe("+%1,2346");
    expect(signedPercentTr(1.234567, Number.NEGATIVE_INFINITY)).toBe("+%1");
  });

  it("uses the ASCII hyphen-minus, never U+2212, like every other rendered number", () => {
    const negative = signedPercentTr(-4.73);
    expect(negative.codePointAt(0)).toBe(0x2d);
    expect(negative.includes(String.fromCodePoint(0x2212))).toBe(false);
    expect(signedPercentTr(4.73).codePointAt(0)).toBe(0x2b);
  });

  it("is stable across repeated calls (the formatter is cached per digit count)", () => {
    expect(signedPercentTr(-4.73)).toBe("-%4,73");
    expect(signedPercentTr(-4.73)).toBe("-%4,73");
    expect(signedPercentTr(-4.73, 1)).toBe("-%4,7");
    expect(signedPercentTr(-4.73)).toBe("-%4,73");
  });
});
