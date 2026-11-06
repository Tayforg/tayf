import { describe, expect, it } from "vitest";

import {
  articleCountLabel,
  coverageScopeNote,
  disclosureWindowLabel,
  fmtKat,
  fmtPct,
  fmtX,
  limitFlag,
  limitPrices,
  priceTickKurus,
} from "./format";

describe("fmtPct (Turkish prefix form: sign, then %, then the number)", () => {
  it("writes the /ekonomi moves of h19-copy-2 as -%4,73 / +%9,95 / -%3,21", () => {
    expect(fmtPct(-4.73)).toBe("-%4,73");
    expect(fmtPct(9.95)).toBe("+%9,95");
    expect(fmtPct(-3.21)).toBe("-%3,21");
  });

  it("writes the limit moves with two decimals", () => {
    expect(fmtPct(-10)).toBe("-%10,00");
    expect(fmtPct(10)).toBe("+%10,00");
  });

  it("writes a flat move without a sign", () => {
    expect(fmtPct(0)).toBe("%0,00");
    expect(fmtPct(-0.001)).toBe("%0,00");
  });
});

describe("fmtKat (h51-morphology-2: the ratio as a bare number, for '... katı')", () => {
  it("rounds to one decimal with the Turkish decimal comma and no 'x'", () => {
    expect(fmtKat(1.94)).toBe("1,9");
    expect(fmtKat(0.66)).toBe("0,7");
    expect(fmtKat(12)).toBe("12,0");
  });

  it("keeps the grouping dot of tr-TR for four-digit ratios", () => {
    expect(fmtKat(1234.5)).toBe("1.234,5");
  });

  it("leaves the compact chip form fmtX as it was ('hacim 1,9x' has no genitive)", () => {
    expect(fmtX(1.94)).toBe("1,9x");
    expect(fmtX(12)).toBe("12,0x");
  });
});

describe("disclosureWindowLabel", () => {
  it("says 'son 30 gün' only when the list is NOT cut at the cap", () => {
    expect(disclosureWindowLabel(12, 12, 60)).toBe("son 30 gün");
    expect(disclosureWindowLabel(59, 59, 60)).toBe("son 30 gün");
    expect(disclosureWindowLabel(0, 0, 60)).toBe("son 30 gün");
  });

  it("names the cap and the 30-day total when the cap cut the list (ISMEN: 60 of 102)", () => {
    expect(disclosureWindowLabel(60, 102, 60)).toBe("son 60 bildirim (30 günde 102)");
  });

  it("drops the total when it is not larger than what is shown", () => {
    expect(disclosureWindowLabel(60, 60, 60)).toBe("son 60 bildirim");
  });

  it("drops the total when the count could not be read (null)", () => {
    expect(disclosureWindowLabel(60, null, 60)).toBe("son 60 bildirim");
  });
});

describe("coverageScopeNote", () => {
  it("says the section counts the company's own filings, with no count when nothing was left out", () => {
    const note = coverageScopeNote(12, 12);
    expect(note).toContain("yalnızca şirketin kendi bildirimleri");
    expect(note).not.toMatch(/\d/);
  });

  it("names how many listed notices are left out (halts, bans, insider trades)", () => {
    const note = coverageScopeNote(60, 55);
    expect(note).toContain("5 bildirim");
    expect(note).toContain("işlem sırası");
  });

  it("never reports a negative count when the counted number exceeds the listed one", () => {
    expect(coverageScopeNote(3, 5)).not.toMatch(/-\d/);
    expect(coverageScopeNote(3, 5)).not.toMatch(/\d/);
  });
});

describe("articleCountLabel", () => {
  it("is '<n> haber' for a complete list and 'son <n> haber' for a truncated one", () => {
    expect(articleCountLabel(13, false)).toBe("13 haber");
    expect(articleCountLabel(60, true)).toBe("son 60 haber");
    expect(articleCountLabel(0, false)).toBe("0 haber");
  });
});

describe("priceTickKurus (Borsa Istanbul pay piyasasi fiyat adimi, in kurus)", () => {
  it.each([
    [0.01, 1],
    [19.99, 1],
    [20, 2],
    [49.98, 2],
    [50, 5],
    [99.95, 5],
    [100, 10],
    [249.9, 10],
    [250, 25],
    [499.75, 25],
    [500, 50],
    [999.5, 50],
    [1000, 100],
    [2499, 100],
    [2500, 250],
    [10000, 250],
  ])("a price of %s sits in the band with a tick of %s kurus", (price, tick) => {
    expect(priceTickKurus(Math.round(price * 100))).toBe(tick);
  });

  it("a value just under a band boundary keeps the lower band's tick (99,99 is still a 0,05 tick)", () => {
    expect(priceTickKurus(9999)).toBe(5);
    expect(priceTickKurus(1999)).toBe(1);
  });
});

describe("limitFlag", () => {
  describe("with the previous close and the price (tick-aware)", () => {
    it("INFO 0.66 -> 0.60 is taban: 0.66 x 0.9 = 0.594 rounds UP to the 0.01 tick", () => {
      expect(limitFlag(-9.09, 0.66, 0.6)).toBe("taban");
    });

    it("0.77 -> 0.70 is taban (0.693 up to 0.70)", () => {
      expect(limitFlag(-9.09, 0.77, 0.7)).toBe("taban");
    });

    it("6.98 -> 6.30 is NOT taban: the floor is 6.29 (6.282 up to the 0.01 tick), and 6.29 is", () => {
      expect(limitFlag(-9.74, 6.98, 6.3)).toBeNull();
      expect(limitFlag(-9.89, 6.98, 6.29)).toBe("taban");
    });

    it("21.00 -> 23.10 is tavan (a 0.02 tick band: 23.10 is on the grid)", () => {
      expect(limitFlag(10, 21, 23.1)).toBe("tavan");
      expect(limitFlag(9.5, 21, 23.08)).toBeNull();
    });

    it("100 -> 110 is tavan and 100 -> 109.9 is not (0.10 tick band)", () => {
      expect(limitFlag(10, 100, 110)).toBe("tavan");
      expect(limitFlag(9.9, 100, 109.9)).toBeNull();
    });

    it("rounds the tavan DOWN to the tick of the band it falls in (90.9 x 1.1 = 99.99 -> 99.95)", () => {
      expect(limitFlag(9.9, 90.9, 99.95)).toBe("tavan");
      expect(limitFlag(9.8, 90.9, 99.9)).toBeNull();
    });

    it("works on integer kurus, so 21 x 1.1 and 1.15 x 0.9 do not drift on float error", () => {
      expect(limitFlag(10, 1.15, 1.26)).toBe("tavan"); // 1.265 -> 1.26
      expect(limitFlag(-10, 1.15, 1.04)).toBe("taban"); // 1.035 -> 1.04
      expect(limitFlag(-10, 1.15, 1.05)).toBeNull();
    });

    it("rounds the previous close to the kurus first", () => {
      expect(limitFlag(-10, 0.6600001, 0.6)).toBe("taban");
    });

    it("a high-priced stock uses its own tick (OZATD 2150 -> 1935 is taban; 1936 is not)", () => {
      expect(limitFlag(-10, 2150, 1935)).toBe("taban");
      expect(limitFlag(-9.95, 2150, 1936)).toBeNull();
    });

    it("the tick-aware answer wins over the pct: a -9.74 % move that is above the floor is not taban", () => {
      expect(limitFlag(-9.74, 6.98, 6.3)).toBeNull();
    });
  });

  describe("without a usable previous close (the pct rule)", () => {
    it("keeps the +-9.5 % threshold", () => {
      expect(limitFlag(9.6)).toBe("tavan");
      expect(limitFlag(-9.8)).toBe("taban");
      expect(limitFlag(9.5)).toBe("tavan");
      expect(limitFlag(-9.5)).toBe("taban");
      expect(limitFlag(4)).toBeNull();
    });

    it("falls back when prevClose is missing, zero, negative or not finite", () => {
      expect(limitFlag(9.6, undefined, 110)).toBe("tavan");
      expect(limitFlag(9.6, null, 110)).toBe("tavan");
      expect(limitFlag(9.6, 0, 110)).toBe("tavan");
      expect(limitFlag(-9.6, -5, 1)).toBe("taban");
      expect(limitFlag(9.6, Number.NaN, 110)).toBe("tavan");
    });

    it("falls back when the price is missing or not finite", () => {
      expect(limitFlag(9.6, 100)).toBe("tavan");
      expect(limitFlag(9.6, 100, undefined)).toBe("tavan");
      expect(limitFlag(-9.6, 100, Number.NaN)).toBe("taban");
      expect(limitFlag(2, 100)).toBeNull();
    });
  });
});

describe("limitPrices (h36-data-1: the band limitFlag and the quote guard share)", () => {
  it("returns the tick-stepped tavan/taban and the tick (in TL) each limit sits on", () => {
    // 100 x 1.1 = 110 sits in the 0,10 band, 100 x 0.9 = 90 in the 0,05 band.
    expect(limitPrices(100)).toEqual({ tavan: 110, taban: 90, upTick: 0.1, downTick: 0.05 });
  });

  it("THYAO 291.25: both limits sit in the 0,25 band (320.25 / 262.25)", () => {
    expect(limitPrices(291.25)).toEqual({ tavan: 320.25, taban: 262.25, upTick: 0.25, downTick: 0.25 });
  });

  it("0.73: tavan 0.80 (0.803 down to the 0,01 tick), taban 0.66 (0.657 up)", () => {
    expect(limitPrices(0.73)).toEqual({ tavan: 0.8, taban: 0.66, upTick: 0.01, downTick: 0.01 });
  });

  it("rounds the previous close to the kurus first", () => {
    expect(limitPrices(0.6600001)).toEqual(limitPrices(0.66));
  });

  it("is null for a previous close that is missing, zero, negative, sub-kurus or not finite", () => {
    expect(limitPrices(null)).toBeNull();
    expect(limitPrices(undefined)).toBeNull();
    expect(limitPrices(0)).toBeNull();
    expect(limitPrices(-5)).toBeNull();
    expect(limitPrices(0.004)).toBeNull();
    expect(limitPrices(Number.NaN)).toBeNull();
    expect(limitPrices(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("limitFlag agrees with it at both limits and one tick inside", () => {
    const lim = limitPrices(291.25)!;
    expect(limitFlag(0, 291.25, lim.tavan)).toBe("tavan");
    expect(limitFlag(0, 291.25, lim.tavan - lim.upTick)).toBeNull();
    expect(limitFlag(0, 291.25, lim.taban)).toBe("taban");
    expect(limitFlag(0, 291.25, lim.taban + lim.downTick)).toBeNull();
  });
});
