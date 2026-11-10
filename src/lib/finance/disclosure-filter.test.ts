import { describe, expect, it } from "vitest";

import {
  CIRCUIT_BREAKER_DAY_LIMIT,
  FEED_DISCLOSURE_OR,
  NOT_CIRCUIT_BREAKER_OR,
  NOT_TEST_NOTICE_OR,
  tickerDisclosureOr,
} from "./disclosure-filter";

describe("CIRCUIT_BREAKER_DAY_LIMIT", () => {
  it("is PostgREST's 1,000-row response cap: the strip reads a whole Istanbul day in one request", () => {
    expect(CIRCUIT_BREAKER_DAY_LIMIT).toBe(1000);
  });
});

describe("tickerDisclosureOr", () => {
  it("matches stock_codes OR related_stocks and keeps the circuit-breaker clause, as ONE filter string", () => {
    expect(tickerDisclosureOr("THYAO")).toBe(
      'and(or(stock_codes.cs.{THYAO},related_stocks.cs.{THYAO}),or(subject.is.null,subject.not.ilike.*Devre Kesici*),or(subject.is.null,subject.neq."Test Bildirimi"))',
    );
  });

  it("embeds the test-notice exclusion (h108-kapdisclosures-4), so a per-ticker reader needs no second .or()", () => {
    expect(tickerDisclosureOr("KTEST")).toContain(`or(${NOT_TEST_NOTICE_OR})`);
    expect(tickerDisclosureOr("THYAO")).toContain(`or(${NOT_CIRCUIT_BREAKER_OR})`);
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

// h108-kapdisclosures-4: KAP TEST A.Ş. (KTEST) files "Test Bildirimi" notices 3-4 times a month
// (the latest on a Saturday). They are real rows in kap_disclosures, so the newest-40 feed listed
// one until 40 later notices arrived (about 61 h over a weekend). Every reader that lists or counts
// disclosures leaves them out, through the same shared string.
describe("NOT_TEST_NOTICE_OR", () => {
  it("keeps NULL subjects and drops exactly 'Test Bildirimi'; the value has a space, so it is double-quoted", () => {
    expect(NOT_TEST_NOTICE_OR).toBe('subject.is.null,subject.neq."Test Bildirimi"');
  });

  it("parses as a PostgREST or() list: two conditions, the quoted value kept whole", () => {
    // Split on commas OUTSIDE double quotes, the way PostgREST reads an or() list.
    const parts = NOT_TEST_NOTICE_OR.match(/(?:[^,"]|"[^"]*")+/g) ?? [];
    expect(parts).toEqual(["subject.is.null", 'subject.neq."Test Bildirimi"']);
    expect((NOT_TEST_NOTICE_OR.match(/"/g) ?? []).length % 2).toBe(0);
  });
});

describe("FEED_DISCLOSURE_OR", () => {
  it("is ONE logic tree: not a breaker AND not a test notice, for the all-ticker feed", () => {
    expect(FEED_DISCLOSURE_OR).toBe(
      'and(or(subject.is.null,subject.not.ilike.*Devre Kesici*),or(subject.is.null,subject.neq."Test Bildirimi"))',
    );
  });
});
