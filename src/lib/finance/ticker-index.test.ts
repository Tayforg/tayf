import { describe, expect, it } from "vitest";

import { NON_EQUITY_TICKERS, isThinTicker } from "./ticker-index";

describe("isThinTicker (which /ekonomi/<ticker> pages stay out of the index)", () => {
  const traded = { sharesTraded: true };

  it("a normal traded equity is not thin (THYAO)", () => {
    expect(isThinTicker("THYAO", traded)).toBe(false);
    expect(isThinTicker("ISCTR", traded)).toBe(false);
    expect(isThinTicker("ASELS", traded)).toBe(false);
  });

  it("KTEST, KAP's test company, is thin even though its row says shares_traded", () => {
    expect(isThinTicker("KTEST", traded)).toBe(true);
  });

  it("TGB (a 3-letter alias of GARAN with no bars of its own) is thin", () => {
    expect(isThinTicker("TGB", traded)).toBe(true);
  });

  it("KOZAL (no company row at all) is thin", () => {
    expect(isThinTicker("KOZAL", null)).toBe(true);
    expect(isThinTicker("KOZAL", undefined)).toBe(true);
  });

  it("a passive or delisted company (shares_traded = false: BOYNR, KILER, DENIZ) is thin", () => {
    expect(isThinTicker("BOYNR", { sharesTraded: false })).toBe(true);
    expect(isThinTicker("KILER", { sharesTraded: false })).toBe(true);
  });

  it("anything shorter than 4 characters is thin, whatever the company says", () => {
    expect(isThinTicker("ABC", traded)).toBe(true);
    expect(isThinTicker("AB", traded)).toBe(true);
    expect(isThinTicker("ABCD", traded)).toBe(false);
  });

  it("NON_EQUITY_TICKERS holds KTEST (the only traded company without any bars on 2026-11-01)", () => {
    expect(NON_EQUITY_TICKERS.has("KTEST")).toBe(true);
    expect(NON_EQUITY_TICKERS.has("THYAO")).toBe(false);
  });
});
