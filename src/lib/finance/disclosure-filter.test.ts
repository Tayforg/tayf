import { describe, expect, it } from "vitest";

import { tickerDisclosureOr } from "./disclosure-filter";

describe("tickerDisclosureOr", () => {
  it("matches stock_codes OR related_stocks and keeps the circuit-breaker clause, as ONE filter string", () => {
    expect(tickerDisclosureOr("THYAO")).toBe(
      "and(or(stock_codes.cs.{THYAO},related_stocks.cs.{THYAO}),or(subject.is.null,subject.not.ilike.*Devre Kesici*))",
    );
  });

  it("names both columns, so a halt notice tagged only in related_stocks is found", () => {
    const f = tickerDisclosureOr("TRHOL");
    expect(f).toContain("stock_codes.cs.{TRHOL}");
    expect(f).toContain("related_stocks.cs.{TRHOL}");
    expect(f).toContain("subject.is.null");
  });

  it("accepts digits and 2-6 character codes", () => {
    expect(() => tickerDisclosureOr("A1")).not.toThrow();
    expect(() => tickerDisclosureOr("ABC123")).not.toThrow();
  });

  it.each([
    ["a comma-separated pair", "a,b"],
    ["an unbalanced parenthesis", "X)"],
    ["a filter-injection attempt", "A},subject.is.null,x.cs.{B"],
    ["lowercase", "thyao"],
    ["the empty string", ""],
    ["one character", "A"],
    ["seven characters", "ABCDEFG"],
    ["a space", "TH YAO"],
  ])("throws for %s", (_label, bad) => {
    expect(() => tickerDisclosureOr(bad)).toThrow(/invalid ticker/);
  });
});
