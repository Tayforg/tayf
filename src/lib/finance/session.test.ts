import { describe, expect, it } from "vitest";

import type { QuoteStat } from "@/lib/finance/queries";
import type { Quote } from "@/lib/finance/quotes";

import { limitFlag } from "./format";
import {
  auctionStubSettledClose,
  chartBaseline,
  companyMetaLine,
  intradayCutShort,
  intradayEmptyCopy,
  intradayPanelMeta,
  marketCueText,
  marketOpen,
  priceEmptyLabel,
  quoteFreshness,
  quoteSessionDay,
  rebaseQuoteOnStat,
  rvolLabel,
  rvolParts,
  rvolPhrase,
  sparklineCloses,
} from "./session";

// Every case passes an explicit nowMs: the module is pure and never reads the
// clock. Calendar anchors (Istanbul, UTC+3): Fri 30.10.2026, Sat 31.10,
// Sun 01.11, Mon 02.11, Tue 03.11, Wed 04.11.
const at = (iso: string) => Date.parse(iso);

describe("quoteFreshness", () => {
  it("is live on a weekday inside the session when the quote is from today", () => {
    expect(quoteFreshness("2026-11-02T10:55:00+03:00", at("2026-11-02T11:00:00+03:00"))).toEqual({
      kind: "live",
      label: "bugün",
    });
  });

  it("is last_session on a Sunday with Friday's quote", () => {
    expect(quoteFreshness("2026-10-30T15:00:00Z", at("2026-11-01T12:00:00+03:00"))).toEqual({
      kind: "last_session",
      label: "son seans 30.10",
    });
  });

  it("is halted when the last trade is months old", () => {
    expect(quoteFreshness("2026-08-12T15:00:00Z", at("2026-11-01T12:00:00+03:00"))).toEqual({
      kind: "halted",
      label: "son işlem 12.08.2026",
    });
  });

  it("TERA: an asOf five calendar days back is halted, with the date and no claim of a halt", () => {
    const f = quoteFreshness("2026-10-27T14:00:00Z", at("2026-11-01T12:00:00+03:00"));
    expect(f).toEqual({ kind: "halted", label: "son işlem 27.10.2026" });
    expect(f.label).not.toContain("durdu");
  });

  it("Monday before the open with Friday's quote is last_session: three days is not halted", () => {
    expect(quoteFreshness("2026-10-30T15:00:00Z", at("2026-11-02T09:30:00+03:00"))).toEqual({
      kind: "last_session",
      label: "son seans 30.10",
    });
  });

  it("is last_session after the close even when the quote is from today", () => {
    expect(quoteFreshness("2026-11-02T18:05:00+03:00", at("2026-11-02T18:30:00+03:00"))).toEqual({
      kind: "last_session",
      label: "son seans 02.11",
    });
  });

  it("is last_session before the open even when the quote is from today", () => {
    expect(quoteFreshness("2026-11-02T09:00:00+03:00", at("2026-11-02T09:30:00+03:00"))).toEqual({
      kind: "last_session",
      label: "son seans 02.11",
    });
  });

  it("session minute boundaries are inclusive: 09:55 and 18:15 are live, 09:54 and 18:16 are not", () => {
    const asOf = "2026-11-02T09:50:00+03:00";
    expect(quoteFreshness(asOf, at("2026-11-02T09:55:00+03:00")).kind).toBe("live");
    expect(quoteFreshness(asOf, at("2026-11-02T18:15:00+03:00")).kind).toBe("live");
    expect(quoteFreshness(asOf, at("2026-11-02T09:54:00+03:00")).kind).toBe("last_session");
    expect(quoteFreshness(asOf, at("2026-11-02T18:16:00+03:00")).kind).toBe("last_session");
  });

  it("is never live at the weekend, even with a same-day quote", () => {
    expect(quoteFreshness("2026-11-01T11:00:00+03:00", at("2026-11-01T12:00:00+03:00")).kind).toBe("last_session");
  });

  it("uses the Istanbul calendar day, not UTC: 22:30Z Friday is already Saturday in Istanbul", () => {
    // 2026-10-30T22:30Z = Sat 31.10 01:30 +03:00
    expect(quoteFreshness("2026-10-30T22:30:00Z", at("2026-11-01T12:00:00+03:00"))).toEqual({
      kind: "last_session",
      label: "son seans 31.10",
    });
  });

  it("boundary: Friday's quote is last_session on Tuesday (4 days) and halted on Wednesday (5 days)", () => {
    const asOf = "2026-10-30T15:00:00Z";
    expect(quoteFreshness(asOf, at("2026-11-03T12:00:00+03:00")).kind).toBe("last_session");
    expect(quoteFreshness(asOf, at("2026-11-04T12:00:00+03:00"))).toEqual({
      kind: "halted",
      label: "son işlem 30.10.2026",
    });
  });

  it("does not mark a quote from the future as halted", () => {
    expect(quoteFreshness("2026-11-03T10:00:00+03:00", at("2026-11-02T11:00:00+03:00")).kind).toBe("last_session");
  });

  it("an unparsable asOf is last_session without a date", () => {
    expect(quoteFreshness("not-a-date", at("2026-11-02T11:00:00+03:00"))).toEqual({
      kind: "last_session",
      label: "son seans",
    });
    expect(quoteFreshness("", at("2026-11-02T11:00:00+03:00"))).toEqual({ kind: "last_session", label: "son seans" });
  });

  it("an unparsable nowMs falls back to last_session instead of throwing", () => {
    expect(quoteFreshness("2026-10-30T15:00:00Z", Number.NaN)).toEqual({
      kind: "last_session",
      label: "son seans 30.10",
    });
  });
});

describe("marketOpen", () => {
  it("is open on a weekday inside 09:55-18:15 Istanbul time", () => {
    expect(marketOpen(at("2026-11-02T11:00:00+03:00"))).toBe(true);
    expect(marketOpen(at("2026-11-03T17:00:00+03:00"))).toBe(true);
  });

  it("minute boundaries are inclusive: 09:55 and 18:15 are open, 09:54 and 18:16 are not", () => {
    expect(marketOpen(at("2026-11-02T09:55:00+03:00"))).toBe(true);
    expect(marketOpen(at("2026-11-02T18:15:00+03:00"))).toBe(true);
    expect(marketOpen(at("2026-11-02T09:54:00+03:00"))).toBe(false);
    expect(marketOpen(at("2026-11-02T18:16:00+03:00"))).toBe(false);
  });

  it("is closed on Saturday and Sunday, even at midday", () => {
    expect(marketOpen(at("2026-10-31T12:00:00+03:00"))).toBe(false);
    expect(marketOpen(at("2026-11-01T12:00:00+03:00"))).toBe(false);
  });

  it("reads the Istanbul clock, not UTC: 07:00Z Monday is 10:00 in Istanbul (open); 22:30Z Friday is Saturday 01:30 (closed)", () => {
    expect(marketOpen(at("2026-11-02T07:00:00Z"))).toBe(true);
    expect(marketOpen(at("2026-10-30T22:30:00Z"))).toBe(false);
  });

  it("an unparsable nowMs is not open", () => {
    expect(marketOpen(Number.NaN)).toBe(false);
  });
});

describe("marketCueText", () => {
  const FRIDAY_QUOTE = "2026-10-30T15:00:00Z";

  it("says nothing when there is no quote", () => {
    expect(marketCueText(null, at("2026-11-02T11:00:00+03:00"))).toBeNull();
  });

  it("says nothing for a live quote", () => {
    expect(marketCueText("2026-11-02T10:55:00+03:00", at("2026-11-02T11:00:00+03:00"))).toBeNull();
  });

  it("claims 'Piyasa kapalı' on a Sunday with Friday's quote", () => {
    expect(marketCueText(FRIDAY_QUOTE, at("2026-11-01T12:00:00+03:00"))).toBe("Piyasa kapalı · son seans 30.10");
  });

  it("claims 'Piyasa kapalı' on a weekday evening, after the close", () => {
    expect(marketCueText("2026-11-02T18:05:00+03:00", at("2026-11-02T20:00:00+03:00"))).toBe(
      "Piyasa kapalı · son seans 02.11",
    );
  });

  it("never claims the market is closed during session hours: Monday 10:15 with Friday's cached quote", () => {
    const text = marketCueText(FRIDAY_QUOTE, at("2026-11-02T10:15:00+03:00"));
    expect(text).toBe("Veriler gecikmeli · son seans 30.10");
    expect(text).not.toContain("Piyasa kapalı");
  });

  it("never claims the market is closed during session hours when a mid-session refresh failed (today's older quote)", () => {
    const text = marketCueText("2026-11-02T10:00:00+03:00", at("2026-11-02T10:40:00+03:00"));
    // Same day and inside the session: live, so no cue at all.
    expect(text).toBeNull();
  });

  it("a halted quote during session hours gets the neutral wording with its date", () => {
    expect(marketCueText("2026-10-27T14:00:00Z", at("2026-11-03T12:00:00+03:00"))).toBe(
      "Veriler gecikmeli · son işlem 27.10.2026",
    );
  });

  it("a halted quote outside session hours still says 'Piyasa kapalı'", () => {
    expect(marketCueText("2026-10-27T14:00:00Z", at("2026-11-01T12:00:00+03:00"))).toBe(
      "Piyasa kapalı · son işlem 27.10.2026",
    );
  });

  it("an unparsable nowMs gets the neutral wording, never a closed claim", () => {
    expect(marketCueText(FRIDAY_QUOTE, Number.NaN)).toBe("Veriler gecikmeli · son seans 30.10");
  });
});

function stat(over: Partial<QuoteStat> = {}): QuoteStat {
  return {
    ticker: "TURSG",
    lastDay: "2026-10-30",
    lastClose: 100,
    prevClose: 98,
    lastVolume: 1000,
    avgVolume20: 800,
    rvol: 1.25,
    ...over,
  };
}

describe("chartBaseline", () => {
  it("a session newer than the stat day uses the stat's last close", () => {
    expect(chartBaseline({ stat: stat(), intradayDay: "2026-11-02", quotePrevClose: 97 })).toBe(100);
  });

  it("the same day as the stat uses the stat's prevClose", () => {
    expect(chartBaseline({ stat: stat(), intradayDay: "2026-10-30", quotePrevClose: 97 })).toBe(98);
  });

  it("the same day with no stat prevClose falls back to the quote's prevClose", () => {
    expect(chartBaseline({ stat: stat({ prevClose: null }), intradayDay: "2026-10-30", quotePrevClose: 97 })).toBe(97);
  });

  it("the same day with neither is null", () => {
    expect(chartBaseline({ stat: stat({ prevClose: null }), intradayDay: "2026-10-30", quotePrevClose: null })).toBeNull();
  });

  it("a session older than the stat day has no honest baseline", () => {
    expect(chartBaseline({ stat: stat(), intradayDay: "2026-10-29", quotePrevClose: 97 })).toBeNull();
  });

  it("without a stat the quote's prevClose is used", () => {
    expect(chartBaseline({ stat: undefined, intradayDay: "2026-10-30", quotePrevClose: 97 })).toBe(97);
    expect(chartBaseline({ stat: null, intradayDay: null, quotePrevClose: 97 })).toBe(97);
  });

  it("nothing known is null", () => {
    expect(chartBaseline({ stat: undefined, intradayDay: null, quotePrevClose: null })).toBeNull();
  });

  it("a stat with no intraday day uses stat.prevClose, then the quote's", () => {
    expect(chartBaseline({ stat: stat(), intradayDay: null, quotePrevClose: 97 })).toBe(98);
    expect(chartBaseline({ stat: stat({ prevClose: null }), intradayDay: null, quotePrevClose: 97 })).toBe(97);
  });
});

describe("rvolLabel", () => {
  it("is null when there is no stat or no rvol", () => {
    expect(rvolLabel(undefined, "2026-10-30")).toBeNull();
    expect(rvolLabel(null, "2026-10-30")).toBeNull();
    expect(rvolLabel(stat({ rvol: null }), "2026-10-30")).toBeNull();
  });

  it("carries no day label when the volume day is the session shown", () => {
    expect(rvolLabel(stat(), "2026-10-30")).toEqual({ rvol: 1.25, dayLabel: null });
  });

  it("carries no day label when there is no intraday day to compare with", () => {
    expect(rvolLabel(stat(), null)).toEqual({ rvol: 1.25, dayLabel: null });
  });

  it("names the volume day (dd.MM) when it differs from the session shown", () => {
    expect(rvolLabel(stat(), "2026-11-02")).toEqual({ rvol: 1.25, dayLabel: "30.10" });
  });

  it("keeps a zero rvol (it is a number, not missing)", () => {
    expect(rvolLabel(stat({ rvol: 0 }), "2026-10-30")).toEqual({ rvol: 0, dayLabel: null });
  });
});

// h99-financenumbers-1: during a session the quote is today's but bist_quote_stats still
// holds the previous session (the daily bar lands about 19:33 Istanbul), so the tape and the
// header of a ticker with no 5-minute bars printed Friday's relative volume with no day.
// quoteSessionDay is the session day the quote belongs to; rvolLabel then names the volume's day.
describe("quoteSessionDay", () => {
  it("is the Istanbul calendar day of a quote's last trade", () => {
    expect(quoteSessionDay("2026-11-09T07:20:00Z")).toBe("2026-11-09");
  });

  it("rolls over at midnight Istanbul, not midnight UTC (21:30Z is 00:30 the next day)", () => {
    expect(quoteSessionDay("2026-11-08T21:30:00Z")).toBe("2026-11-09");
    expect(quoteSessionDay("2026-11-08T20:59:59Z")).toBe("2026-11-08");
    expect(quoteSessionDay("2026-11-08T21:00:00Z")).toBe("2026-11-09");
  });

  it("reads an offset timestamp as the instant it is", () => {
    expect(quoteSessionDay("2026-11-09T00:30:00+03:00")).toBe("2026-11-09");
    expect(quoteSessionDay("2026-11-08T23:30:00+03:00")).toBe("2026-11-08");
  });

  it("is null for an unparsable value, null and undefined, and never throws", () => {
    expect(quoteSessionDay("garbage")).toBeNull();
    expect(quoteSessionDay("")).toBeNull();
    expect(quoteSessionDay(undefined)).toBeNull();
    expect(quoteSessionDay(null)).toBeNull();
    expect(() => quoteSessionDay(12345 as unknown as string)).not.toThrow();
  });

  it("feeds rvolLabel: Friday's volume next to a Monday quote carries the day, a same-day pair does not", () => {
    const friday = stat({ lastDay: "2026-11-06", rvol: 2.7 });
    expect(rvolLabel(friday, quoteSessionDay("2026-11-09T07:20:00Z"))).toEqual({ rvol: 2.7, dayLabel: "06.11" });
    expect(rvolLabel(friday, quoteSessionDay("2026-11-06T15:05:00Z"))).toEqual({ rvol: 2.7, dayLabel: null });
  });

  it("with no quote the volume stays unlabelled (null session day), as before", () => {
    expect(rvolLabel(stat({ lastDay: "2026-11-06", rvol: 2.7 }), quoteSessionDay(undefined))).toEqual({
      rvol: 2.7,
      dayLabel: null,
    });
  });

  it("reads 'hacim 20 günlük ortalamanın 3,0 katı · 06.11 seansı' for ACSEL during a session", () => {
    const label = rvolLabel(stat({ ticker: "ACSEL", lastDay: "2026-11-06", rvol: 3.03 }), quoteSessionDay("2026-11-09T07:20:00Z"));
    expect(label && rvolPhrase(label)).toBe("20 günlük ortalamanın 3,0 katı · 06.11 seansı");
  });
});

describe("companyMetaLine", () => {
  it("joins city, the not-traded note and the share classes with a middle dot", () => {
    expect(companyMetaLine({ city: "İSTANBUL", sharesTraded: false, tickers: ["TRMEN", "TVM"] })).toBe(
      "İSTANBUL · işlem görmüyor · paylar: TRMEN TVM",
    );
  });

  it("a traded company with a single ticker shows the city only", () => {
    expect(companyMetaLine({ city: "İSTANBUL", sharesTraded: true, tickers: ["TURSG"] })).toBe("İSTANBUL");
  });

  it("omits a missing city without leaving a stray separator", () => {
    expect(companyMetaLine({ city: null, sharesTraded: false, tickers: ["TRMEN"] })).toBe("işlem görmüyor");
    expect(companyMetaLine({ city: null, sharesTraded: true, tickers: ["A", "B"] })).toBe("paylar: A B");
  });

  it("is empty when there is nothing to say", () => {
    expect(companyMetaLine({ city: null, sharesTraded: true, tickers: ["TURSG"] })).toBe("");
    expect(companyMetaLine({ city: null, sharesTraded: true, tickers: [] })).toBe("");
  });

  it("is empty for a null or undefined company", () => {
    expect(companyMetaLine(null)).toBe("");
    expect(companyMetaLine(undefined)).toBe("");
  });
});

describe("priceEmptyLabel", () => {
  it("says the company does not trade when it does not", () => {
    expect(priceEmptyLabel({ sharesTraded: false })).toBe("işlem görmüyor");
  });

  it("says the price could not be fetched for a traded or unknown company", () => {
    expect(priceEmptyLabel({ sharesTraded: true })).toBe("fiyat alınamadı");
    expect(priceEmptyLabel(null)).toBe("fiyat alınamadı");
    expect(priceEmptyLabel(undefined)).toBe("fiyat alınamadı");
  });
});

describe("intradayEmptyCopy", () => {
  it("says there is no session data for a company whose shares do not trade", () => {
    expect(intradayEmptyCopy({ sharesTraded: false })).toBe(
      "Bu şirketin payları borsada işlem görmüyor; seans verisi yok.",
    );
  });

  it("keeps the collection copy for a traded or unknown company", () => {
    const copy =
      "Bu hisse için seans içi veri henüz toplanmadı. Haberde geçen hisseler seans boyunca 5 dakikada bir kaydedilir.";
    expect(intradayEmptyCopy({ sharesTraded: true })).toBe(copy);
    expect(intradayEmptyCopy(null)).toBe(copy);
    expect(intradayEmptyCopy(undefined)).toBe(copy);
  });
});

// h36-data-1: during the session Yahoo's 5d/1d payload resolves the day's
// baseline to the close from TWO sessions back, so the chip and the header
// measured the live price against D-2 ("tavan +%13,58" on a +3,35 % day).
// bist_quote_stats.last_close is the settled close of the last finished
// session, which is the right base while a later session is on screen.
describe("rebaseQuoteOnStat", () => {
  function quote(over: Partial<Quote> = {}): Quote {
    return {
      ticker: "THYAO",
      price: 301,
      prevClose: 265,
      changePct: 13.58,
      hasBaseline: true,
      closes: [262, 265, 291.25, 301],
      currency: "TRY",
      asOf: "2026-11-05T08:10:00Z",
      ...over,
    };
  }

  it("THYAO: 301 against the 11-04 close of 291.25 is +3.35 %, not the +13.58 % against 265, and no tavan", () => {
    const out = rebaseQuoteOnStat(quote(), stat({ lastDay: "2026-11-04", lastClose: 291.25, prevClose: 265 }));
    expect(out.prevClose).toBe(291.25);
    expect(out.changePct).toBeCloseTo(3.348, 2);
    expect(out.hasBaseline).toBe(true);
    expect(limitFlag(out.changePct, out.prevClose, out.price)).toBeNull();
  });

  it("keeps the price, ticker, closes, currency and asOf; it does not mutate its input", () => {
    const q = quote();
    const copy = structuredClone(q);
    const out = rebaseQuoteOnStat(q, stat({ lastDay: "2026-11-04", lastClose: 291.25, prevClose: 265 }));
    expect(q).toEqual(copy);
    expect(out).not.toBe(q);
    expect(out.price).toBe(301);
    expect(out.ticker).toBe("THYAO");
    expect(out.closes).toEqual(q.closes);
    expect(out.currency).toBe("TRY");
    expect(out.asOf).toBe(q.asOf);
  });

  it("KARCL: 31.46 against 28.60 is +10.0 % and a real tavan (Yahoo said +21 % against 26.00)", () => {
    const out = rebaseQuoteOnStat(
      quote({ ticker: "KARCL", price: 31.46, prevClose: 26, changePct: 21 }),
      stat({ ticker: "KARCL", lastDay: "2026-11-04", lastClose: 28.6, prevClose: 26 }),
    );
    expect(out.prevClose).toBe(28.6);
    expect(out.changePct).toBeCloseTo(10, 2);
    expect(out.hasBaseline).toBe(true);
    expect(limitFlag(out.changePct, out.prevClose, out.price)).toBe("tavan");
  });

  it("DUNYH (capital increase): the unadjusted stat prevClose 109.10 is ignored while a later session is on screen", () => {
    const out = rebaseQuoteOnStat(
      quote({ ticker: "DUNYH", price: 11.8, prevClose: 109.1, changePct: -89.18 }),
      stat({ ticker: "DUNYH", lastDay: "2026-11-04", lastClose: 10.73, prevClose: 109.1 }),
    );
    expect(out.prevClose).toBe(10.73);
    expect(out.changePct).toBeCloseTo(9.97, 2);
    expect(out.hasBaseline).toBe(true);
    expect(limitFlag(out.changePct, out.prevClose, out.price)).toBe("tavan");
  });

  it("the h20 pre-open shape is unchanged: a Friday quote with Friday's stat keeps Yahoo's -4.73", () => {
    const q = quote({
      ticker: "TURSG",
      asOf: "2026-10-30T15:09:57Z",
      price: 347.5,
      prevClose: 364.75,
      changePct: -4.73,
    });
    const out = rebaseQuoteOnStat(q, stat({ lastDay: "2026-10-30", lastClose: 347.5, prevClose: 364.75 }));
    expect(out).toEqual(q);
    expect(out.changePct).toBe(-4.73);
  });

  it("same day as the stat: the stat's own prevClose is the base (the stat already holds today's bar)", () => {
    const out = rebaseQuoteOnStat(
      quote({ asOf: "2026-11-05T15:09:00Z", price: 300, prevClose: 265, changePct: 13.2 }),
      stat({ lastDay: "2026-11-05", lastClose: 300, prevClose: 291.25 }),
    );
    expect(out.prevClose).toBe(291.25);
    expect(out.changePct).toBeCloseTo(3.0043, 3);
    expect(out.hasBaseline).toBe(true);
  });

  it("same day with no stat prevClose: nothing to rebase on, the quote is kept", () => {
    const q = quote({ asOf: "2026-11-05T15:09:00Z", price: 300, prevClose: 291.25, changePct: 3.0043 });
    expect(rebaseQuoteOnStat(q, stat({ lastDay: "2026-11-05", lastClose: 300, prevClose: null }))).toEqual(q);
  });

  it("after the close, before quotes-daily writes today's bar: the stat still holds yesterday, so lastClose is the base", () => {
    const out = rebaseQuoteOnStat(
      quote({ asOf: "2026-11-05T15:09:00Z" }),
      stat({ lastDay: "2026-11-04", lastClose: 291.25, prevClose: 265 }),
    );
    expect(out.prevClose).toBe(291.25);
    expect(out.changePct).toBeCloseTo(3.348, 2);
  });

  it("no stat: the quote is returned unchanged", () => {
    const q = quote({ price: 295, prevClose: 291.25, changePct: 1.2876 });
    expect(rebaseQuoteOnStat(q, undefined)).toEqual(q);
    expect(rebaseQuoteOnStat(q, null)).toEqual(q);
  });

  it("a stat newer than the quote cannot describe its session: the quote is returned unchanged", () => {
    const q = quote({ asOf: "2026-11-04T15:09:00Z", price: 291.25, prevClose: 265, changePct: 9.9 });
    expect(rebaseQuoteOnStat(q, stat({ lastDay: "2026-11-05", lastClose: 301, prevClose: 291.25 }))).toEqual(q);
  });

  it("guard, no stat: 11.80 against 109.10 is far outside the band, so the move is unknown (hasBaseline false)", () => {
    const q = quote({ ticker: "DUNYH", price: 11.8, prevClose: 109.1, changePct: -89.18 });
    const out = rebaseQuoteOnStat(q, undefined);
    expect(out.hasBaseline).toBe(false);
    expect(out.price).toBe(11.8);
  });

  it("guard, Yahoo path: THYAO 301 against 265 is past tavan + one tick (291.50 + 0.25) without a stat", () => {
    expect(rebaseQuoteOnStat(quote(), undefined).hasBaseline).toBe(false);
  });

  it("guard, rebased path: a base that still leaves the price outside the band is unknown too", () => {
    const out = rebaseQuoteOnStat(
      quote({ price: 130, prevClose: 90, changePct: 44 }),
      stat({ lastDay: "2026-11-04", lastClose: 100, prevClose: 95 }),
    );
    expect(out.prevClose).toBe(100);
    expect(out.hasBaseline).toBe(false);
  });

  it("guard boundary: tavan + one tick still counts as known, two ticks do not (base 100: tavan 110, tick 0.10)", () => {
    const s = stat({ lastDay: "2026-11-04", lastClose: 100, prevClose: 95 });
    expect(rebaseQuoteOnStat(quote({ price: 110 }), s).hasBaseline).toBe(true);
    expect(rebaseQuoteOnStat(quote({ price: 110.1 }), s).hasBaseline).toBe(true);
    expect(rebaseQuoteOnStat(quote({ price: 110.2 }), s).hasBaseline).toBe(false);
  });

  it("guard boundary, downside: taban - one tick is known, two ticks are not (base 100: taban 90, tick 0.05)", () => {
    const s = stat({ lastDay: "2026-11-04", lastClose: 100, prevClose: 95 });
    expect(rebaseQuoteOnStat(quote({ price: 90 }), s).hasBaseline).toBe(true);
    expect(rebaseQuoteOnStat(quote({ price: 89.95 }), s).hasBaseline).toBe(true);
    expect(rebaseQuoteOnStat(quote({ price: 89.9 }), s).hasBaseline).toBe(false);
  });

  it("tick edge: base 0.73, price 0.80 is a known move and a tavan (0.803 steps down to 0.80)", () => {
    const out = rebaseQuoteOnStat(
      quote({ ticker: "PEKGY", price: 0.8, prevClose: 0.7, changePct: 14.3 }),
      stat({ ticker: "PEKGY", lastDay: "2026-11-04", lastClose: 0.73, prevClose: 0.7 }),
    );
    expect(out.hasBaseline).toBe(true);
    expect(out.prevClose).toBe(0.73);
    expect(limitFlag(out.changePct, out.prevClose, out.price)).toBe("tavan");
    // The Yahoo path agrees: a quote already on 0.73 stays known.
    expect(rebaseQuoteOnStat(quote({ price: 0.8, prevClose: 0.73, changePct: 9.59 }), undefined).hasBaseline).toBe(true);
  });

  it("a quote that already has no baseline stays unknown without a stat, and is not 'guarded' on its placeholder", () => {
    const q = quote({ price: 301, prevClose: 301, changePct: 0, hasBaseline: false });
    expect(rebaseQuoteOnStat(q, undefined)).toEqual(q);
  });

  it("a placeholder quote (hasBaseline false) is upgraded to a known move when the stat supplies a base", () => {
    const out = rebaseQuoteOnStat(
      quote({ price: 301, prevClose: 301, changePct: 0, hasBaseline: false }),
      stat({ lastDay: "2026-11-04", lastClose: 291.25, prevClose: 265 }),
    );
    expect(out.hasBaseline).toBe(true);
    expect(out.changePct).toBeCloseTo(3.348, 2);
  });

  it("uses the Istanbul calendar day of asOf, not UTC: 22:30Z on 11-04 is already 11-05 in Istanbul", () => {
    // UTC day = 11-04 = the stat day would pick prevClose (265); Istanbul day 11-05 picks lastClose.
    const out = rebaseQuoteOnStat(
      quote({ asOf: "2026-11-04T22:30:00Z", price: 291.25, prevClose: 265, changePct: 9.9 }),
      stat({ lastDay: "2026-11-04", lastClose: 291.25, prevClose: 265 }),
    );
    expect(out.prevClose).toBe(291.25);
    expect(out.changePct).toBeCloseTo(0, 6);
  });

  it("tolerates a stat day written as a longer ISO string", () => {
    const out = rebaseQuoteOnStat(quote(), stat({ lastDay: "2026-11-04T00:00:00+00:00", lastClose: 291.25, prevClose: 265 }));
    expect(out.prevClose).toBe(291.25);
  });

  it("an unusable stat close (zero, negative, not finite) leaves the quote as it was", () => {
    const q = quote({ price: 295, prevClose: 291.25, changePct: 1.29 });
    for (const lastClose of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(rebaseQuoteOnStat(q, stat({ lastDay: "2026-11-04", lastClose }))).toEqual(q);
    }
  });

  it("an unparsable asOf cannot name a session day: the quote is kept", () => {
    const q = quote({ asOf: "not-a-date", price: 295, prevClose: 291.25, changePct: 1.29 });
    expect(rebaseQuoteOnStat(q, stat({ lastDay: "2026-11-04", lastClose: 280 }))).toEqual(q);
  });
});

describe("rvolPhrase (h51-morphology-2: the genitive 'ortalamanın' must be followed by 'katı')", () => {
  it("reads as a complete phrase when the volume belongs to the session on screen", () => {
    expect(rvolPhrase({ rvol: 1.9, dayLabel: null })).toBe("20 günlük ortalamanın 1,9 katı");
  });

  it("names the volume day when it differs from the session shown", () => {
    expect(rvolPhrase({ rvol: 0.7, dayLabel: "05.11" })).toBe("20 günlük ortalamanın 0,7 katı · 05.11 seansı");
  });

  it("rounds the ratio to one decimal with the Turkish comma", () => {
    expect(rvolPhrase({ rvol: 1.94, dayLabel: null })).toBe("20 günlük ortalamanın 1,9 katı");
    expect(rvolPhrase({ rvol: 12, dayLabel: null })).toBe("20 günlük ortalamanın 12,0 katı");
  });

  it("never ends on a dangling genitive and never prints the 'x' form", () => {
    for (const dayLabel of [null, "05.11"]) {
      for (const rvol of [0, 0.7, 1.9, 2, 12.34]) {
        const out = rvolPhrase({ rvol, dayLabel });
        expect(out).not.toMatch(/\dx/);
        expect(out).not.toMatch(/ortalamanın( ·|$)/);
        expect(out).toContain(" katı");
      }
    }
  });

  // h57-ekonomi-1: documents the contract. The header rounds once, at display,
  // so it must be fed the unrounded ratio (GARAN: 43896321 / 23743772.6).
  it("rounds an unrounded ratio once: 1.84875 reads '1,8 katı', not the double-rounded '1,9'", () => {
    expect(rvolPhrase({ rvol: 1.84875, dayLabel: "06.11" })).toContain("1,8 katı");
    expect(rvolPhrase({ rvol: 1.84875, dayLabel: "06.11" })).not.toContain("1,9");
  });

  it("takes the output of rvolLabel as is", () => {
    const label = rvolLabel(stat(), "2026-11-02");
    expect(label).not.toBeNull();
    expect(rvolPhrase(label!)).toBe("20 günlük ortalamanın 1,3 katı · 30.10 seansı");
  });
});

describe("rvolParts (the pieces the header colours separately)", () => {
  it("joins back to exactly rvolPhrase, so the markup cannot drift from the string", () => {
    for (const dayLabel of [null, "05.11"]) {
      const v = { rvol: 1.9, dayLabel };
      const p = rvolParts(v);
      expect(`${p.basis} ${p.ratio}${p.day ? ` · ${p.day}` : ""}`).toBe(rvolPhrase(v));
    }
  });

  it("splits the basis, the ratio and the day label", () => {
    expect(rvolParts({ rvol: 1.9, dayLabel: "05.11" })).toEqual({
      basis: "20 günlük ortalamanın",
      ratio: "1,9 katı",
      day: "05.11 seansı",
    });
    expect(rvolParts({ rvol: 1.9, dayLabel: null }).day).toBeNull();
  });

  it("h57-ekonomi-1: the ratio of an unrounded 1.84875 is '1,8 katı'", () => {
    expect(rvolParts({ rvol: 1.84875, dayLabel: null }).ratio).toBe("1,8 katı");
  });
});

// h92-marketclock-1: bist_intraday_targets used a rolling 7-day news window, so a
// ticker left the target list mid-session and its 5-minute bars stopped there
// (VKING 2026-11-06: last bar 12:05 Istanbul, close 11.53, the daily close 12.09).
// intradayCutShort says when the newest session's bars end before the close and the
// last bar is not where the day settled; the chart then prints the settled close.
describe("intradayCutShort (h92-marketclock-1)", () => {
  const stat = (over: Partial<QuoteStat> = {}): QuoteStat => ({
    ticker: "VKING",
    lastDay: "2026-11-06",
    lastClose: 12.09,
    prevClose: 11.67,
    lastVolume: 307202,
    avgVolume20: 250000,
    rvol: 1.2,
    ...over,
  });
  // VKING: the newest bar is 09:05Z = 12:05 Istanbul, 11.53 against a 12.09 settle; read on Monday 05:30 Istanbul.
  const vking = () => ({
    lastBar: { ts: "2026-11-06T09:05:00Z", close: 11.53 },
    intradayDay: "2026-11-06" as string | null,
    stat: stat() as QuoteStat | null | undefined,
    nowMs: at("2026-11-09T02:30:00Z"),
  });

  it("VKING 2026-11-06 read on Monday: true", () => {
    expect(intradayCutShort(vking())).toBe(true);
  });

  it("a full session whose last bar is the 17:55 closing auction, 1 % off the settle: false", () => {
    expect(
      intradayCutShort({
        ...vking(),
        lastBar: { ts: "2026-11-06T14:55:00Z", close: 12.21 },
      }),
    ).toBe(false);
  });

  it("the 17:30 Istanbul bar is not before 17:30: false; the 17:25 bar is: true", () => {
    expect(intradayCutShort({ ...vking(), lastBar: { ts: "2026-11-06T14:30:00Z", close: 11.53 } })).toBe(false);
    expect(intradayCutShort({ ...vking(), lastBar: { ts: "2026-11-06T14:25:00Z", close: 11.53 } })).toBe(true);
  });

  it("the half day 2026-10-28 (last bar 12:35 Istanbul, close equal to the settle): false", () => {
    expect(
      intradayCutShort({
        lastBar: { ts: "2026-10-28T09:35:00Z", close: 12.09 },
        intradayDay: "2026-10-28",
        stat: stat({ lastDay: "2026-10-28" }),
        nowMs: at("2026-10-29T08:00:00Z"),
      }),
    ).toBe(false);
  });

  it("the same day while the session is open (13:00 Istanbul): false, the bars are still coming", () => {
    expect(intradayCutShort({ ...vking(), nowMs: at("2026-11-06T10:00:00Z") })).toBe(false);
  });

  it("the same day right after the close: 18:15 Istanbul is still the session, 18:16 is over", () => {
    expect(intradayCutShort({ ...vking(), nowMs: at("2026-11-06T15:15:00Z") })).toBe(false);
    expect(intradayCutShort({ ...vking(), nowMs: at("2026-11-06T15:16:00Z") })).toBe(true);
  });

  it("the next Istanbul day counts as over even before the open (00:30 Istanbul on Saturday)", () => {
    expect(intradayCutShort({ ...vking(), nowMs: at("2026-11-06T21:30:00Z") })).toBe(true);
  });

  it("a stat of another day describes another session: false (earlier and later)", () => {
    expect(intradayCutShort({ ...vking(), stat: stat({ lastDay: "2026-11-05" }) })).toBe(false);
    expect(intradayCutShort({ ...vking(), stat: stat({ lastDay: "2026-11-07" }) })).toBe(false);
  });

  it("a stat day with a time part still lines up with the session day", () => {
    expect(intradayCutShort({ ...vking(), stat: stat({ lastDay: "2026-11-06T00:00:00+00:00" }) })).toBe(true);
  });

  it("no stat (null or undefined): false", () => {
    expect(intradayCutShort({ ...vking(), stat: null })).toBe(false);
    expect(intradayCutShort({ ...vking(), stat: undefined })).toBe(false);
  });

  it("an unusable settle (0, negative, NaN, Infinity): false", () => {
    for (const lastClose of [0, -12.09, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(intradayCutShort({ ...vking(), stat: stat({ lastClose }) }), `lastClose ${lastClose}`).toBe(false);
    }
  });

  it("no last bar or no session day: false", () => {
    expect(intradayCutShort({ ...vking(), lastBar: null })).toBe(false);
    expect(intradayCutShort({ ...vking(), intradayDay: null })).toBe(false);
  });

  it("an unparsable bar time or clock: false", () => {
    expect(intradayCutShort({ ...vking(), lastBar: { ts: "not a time", close: 11.53 } })).toBe(false);
    expect(intradayCutShort({ ...vking(), nowMs: Number.NaN })).toBe(false);
  });

  it("a last bar within 0.5 % of the settle: false (the cut cost nothing visible); 0.6 % either way: true", () => {
    const base = { ...vking(), stat: stat({ lastClose: 100 }) };
    expect(intradayCutShort({ ...base, lastBar: { ts: "2026-11-06T09:05:00Z", close: 100.4 } })).toBe(false);
    expect(intradayCutShort({ ...base, lastBar: { ts: "2026-11-06T09:05:00Z", close: 99.6 } })).toBe(false);
    expect(intradayCutShort({ ...base, lastBar: { ts: "2026-11-06T09:05:00Z", close: 100.6 } })).toBe(true);
    expect(intradayCutShort({ ...base, lastBar: { ts: "2026-11-06T09:05:00Z", close: 99.4 } })).toBe(true);
  });

  it("a last bar with a NaN close: false (never trips on garbage)", () => {
    expect(intradayCutShort({ ...vking(), lastBar: { ts: "2026-11-06T09:05:00Z", close: Number.NaN } })).toBe(false);
  });
});

describe("intradayPanelMeta (h92-marketclock-1)", () => {
  it("is today's string, unchanged, when the session is not cut", () => {
    expect(intradayPanelMeta("2026-11-06", null)).toBe("06.11.2026, 5 dakikalık kapanışlar, haberler işaretli");
  });

  it("names the Istanbul time the data stops at when the session is cut", () => {
    expect(intradayPanelMeta("2026-11-06", "2026-11-06T09:05:00Z")).toBe(
      "06.11.2026, 5 dakikalık kapanışlar, 12:05 sonrası veri eksik, haberler işaretli",
    );
    expect(intradayPanelMeta("2026-11-06", "2026-11-06T14:25:00Z")).toBe(
      "06.11.2026, 5 dakikalık kapanışlar, 17:25 sonrası veri eksik, haberler işaretli",
    );
  });

  it("falls back to the plain string for a cut time it cannot read", () => {
    expect(intradayPanelMeta("2026-11-06", "garbage")).toBe("06.11.2026, 5 dakikalık kapanışlar, haberler işaretli");
  });
});

// h120-finance-1: during a session Yahoo's 5d/1d array leaves out the D-1 settled close (CITAS 2026-11-11 11:16
// Istanbul: 5, 6, 9 Nov and the live 11 Nov bar, no 10 Nov). The header move is re-based on the settled close
// (rebaseQuoteOnStat) but the sparkline drew the raw array, so its last segment contradicted the header
// (-19 % line next to "taban -%9,96"). sparklineCloses puts the settled close back where it belongs.
describe("sparklineCloses (h120-finance-1)", () => {
  const citas = (over: Partial<Quote> = {}): Quote => ({
    ticker: "CITAS",
    price: 81.85,
    prevClose: 90.9,
    changePct: -9.96,
    hasBaseline: true,
    closes: [108.9, 101, 101, 81.85],
    closeDays: ["2026-11-05", "2026-11-06", "2026-11-09", "2026-11-11"],
    currency: "TRY",
    asOf: "2026-11-11T08:16:00Z",
    ...over,
  });
  const citasStat = (over: Partial<QuoteStat> = {}): QuoteStat => ({
    ticker: "CITAS",
    lastDay: "2026-11-10",
    lastClose: 90.9,
    prevClose: 101,
    lastVolume: 1000,
    avgVolume20: 900,
    rvol: 1.1,
    ...over,
  });
  const garan = (over: Partial<Quote> = {}): Quote => ({
    ticker: "GARAN",
    price: 153.2,
    prevClose: 155.4,
    changePct: -1.42,
    hasBaseline: true,
    closes: [142, 144.3, 153.1, 153.2],
    closeDays: ["2026-11-05", "2026-11-06", "2026-11-09", "2026-11-11"],
    currency: "TRY",
    asOf: "2026-11-11T08:16:00Z",
    ...over,
  });
  const garanStat = (over: Partial<QuoteStat> = {}): QuoteStat => citasStat({ ticker: "GARAN", lastClose: 155.4, prevClose: 153.1, ...over });

  it("CITAS replay: the 11-10 close 90.9 goes in before the live bar, so the last segment is down 90.9 -> 81.85", () => {
    expect(sparklineCloses(citas(), citasStat())).toEqual([108.9, 101, 101, 90.9, 81.85]);
  });

  it("GARAN replay: the line no longer ends flat-up next to a red move: 155.4 then 153.2", () => {
    expect(sparklineCloses(garan(), garanStat())).toEqual([142, 144.3, 153.1, 155.4, 153.2]);
  });

  it("the last segment's sign agrees with the header move for both replays", () => {
    for (const [q, s] of [[citas(), citasStat()], [garan(), garanStat()]] as const) {
      const pts = sparklineCloses(q, s);
      const rebased = rebaseQuoteOnStat(q, s);
      const last = pts[pts.length - 1]! - pts[pts.length - 2]!;
      expect(Math.sign(last)).toBe(Math.sign(rebased.changePct));
    }
  });

  it("a 5-close input that already has 11-10 is unchanged", () => {
    const q = citas({
      closes: [108.9, 101, 101, 90.9, 81.85],
      closeDays: ["2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10", "2026-11-11"],
    });
    expect(sparklineCloses(q, citasStat())).toEqual([108.9, 101, 101, 90.9, 81.85]);
  });

  it("stat.lastDay === the session day (evening, after the daily bar landed) leaves it unchanged", () => {
    const out = sparklineCloses(citas(), citasStat({ lastDay: "2026-11-11", lastClose: 81.85, prevClose: 90.9 }));
    expect(out).toEqual([108.9, 101, 101, 81.85]);
  });

  it("a stat that describes a later day than the session on screen leaves it unchanged", () => {
    expect(sparklineCloses(citas(), citasStat({ lastDay: "2026-11-12" }))).toEqual([108.9, 101, 101, 81.85]);
  });

  it("no stat, a null stat, closeDays undefined, or closeDays of the wrong length all leave it unchanged", () => {
    const base = [108.9, 101, 101, 81.85];
    expect(sparklineCloses(citas(), undefined)).toEqual(base);
    expect(sparklineCloses(citas(), null)).toEqual(base);
    expect(sparklineCloses(citas({ closeDays: undefined }), citasStat())).toEqual(base);
    expect(sparklineCloses(citas({ closeDays: ["2026-11-05", "2026-11-06", "2026-11-11"] }), citasStat())).toEqual(base);
    expect(sparklineCloses(citas({ closeDays: [] }), citasStat())).toEqual(base);
  });

  it("an older cache entry (no closeDays key at all) keeps working", () => {
    const { closeDays: _days, ...legacy } = citas();
    expect(sparklineCloses(legacy as Quote, citasStat())).toEqual([108.9, 101, 101, 81.85]);
  });

  it("a ticker that has not traded today (asOf on 11-10, closes up to 11-10) is unchanged", () => {
    const q = citas({
      asOf: "2026-11-10T15:09:00Z",
      closes: [108.9, 101, 101, 90.9],
      closeDays: ["2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10"],
    });
    expect(sparklineCloses(q, citasStat())).toEqual([108.9, 101, 101, 90.9]);
  });

  it("an unusable stat close (zero, negative, NaN, Infinity) leaves it unchanged", () => {
    for (const lastClose of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(sparklineCloses(citas(), citasStat({ lastClose }))).toEqual([108.9, 101, 101, 81.85]);
    }
  });

  it("an unusable asOf (no session day) leaves it unchanged", () => {
    expect(sparklineCloses(citas({ asOf: "garbage" }), citasStat())).toEqual([108.9, 101, 101, 81.85]);
    expect(sparklineCloses(citas({ asOf: "" }), citasStat())).toEqual([108.9, 101, 101, 81.85]);
  });

  it("an unusable stat day leaves it unchanged (never sorts an empty or garbage day before the session)", () => {
    expect(sparklineCloses(citas(), citasStat({ lastDay: "" }))).toEqual([108.9, 101, 101, 81.85]);
    expect(sparklineCloses(citas(), citasStat({ lastDay: "garbage" }))).toEqual([108.9, 101, 101, 81.85]);
  });

  it("a stat day that is not later than every earlier close day is unchanged (it would land out of order)", () => {
    // Closes already run to 11-09 but the stat is the older 11-06 bar: its 11-06 close is already in the array.
    expect(sparklineCloses(citas(), citasStat({ lastDay: "2026-11-06", lastClose: 101 }))).toEqual([108.9, 101, 101, 81.85]);
    // Stat day 11-07 sits before 11-09 in time: inserting it just before the live bar would put it after 11-09.
    expect(sparklineCloses(citas(), citasStat({ lastDay: "2026-11-07", lastClose: 100 }))).toEqual([108.9, 101, 101, 81.85]);
  });

  it("inserts just before the first close on or after the session day (two entries on the live day), then trims to 5", () => {
    const q = citas({
      closes: [108.9, 101, 101, 81.85, 82.1],
      closeDays: ["2026-11-05", "2026-11-06", "2026-11-09", "2026-11-11", "2026-11-11"],
    });
    expect(sparklineCloses(q, citasStat())).toEqual([101, 101, 90.9, 81.85, 82.1]);
  });

  it("appends the settled close when there is no bar on or after the session day", () => {
    // asOf is today's, but the array stops at 11-09 (a payload with no live bar).
    const q = citas({ closes: [108.9, 101, 101], closeDays: ["2026-11-05", "2026-11-06", "2026-11-09"] });
    expect(sparklineCloses(q, citasStat())).toEqual([108.9, 101, 101, 90.9]);
  });

  it("keeps only the last 5 values and never returns more than 5", () => {
    const q = citas({
      closes: [1, 2, 3, 4, 81.85],
      closeDays: ["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09", "2026-11-11"],
    });
    const out = sparklineCloses(q, citasStat());
    expect(out).toEqual([2, 3, 4, 90.9, 81.85]);
    expect(out.length).toBeLessThanOrEqual(5);
    const long = citas({
      closes: [1, 2, 3, 4, 5, 6, 81.85],
      closeDays: ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09", "2026-11-11"],
    });
    expect(sparklineCloses(long, citasStat())).toHaveLength(5);
  });

  it("does not mutate its input and returns a new array when it inserts", () => {
    const q = citas();
    const copy = structuredClone(q);
    const out = sparklineCloses(q, citasStat());
    expect(q).toEqual(copy);
    expect(out).not.toBe(q.closes);
  });

  it("works on the rebased quote the page passes (rebaseQuoteOnStat keeps closeDays)", () => {
    const rebased = rebaseQuoteOnStat(citas({ prevClose: 101, changePct: -18.96 }), citasStat());
    expect(rebased.closeDays).toEqual(["2026-11-05", "2026-11-06", "2026-11-09", "2026-11-11"]);
    expect(sparklineCloses(rebased, citasStat())).toEqual([108.9, 101, 101, 90.9, 81.85]);
  });

  it("never throws on garbage and falls back to the closes", () => {
    const q = citas({ closeDays: [null, 3, undefined, {}] as unknown as string[] });
    expect(() => sparklineCloses(q, citasStat())).not.toThrow();
    expect(sparklineCloses(q, citasStat())).toEqual([108.9, 101, 101, 81.85]);
    const s = citasStat({ lastDay: 42 as unknown as string });
    expect(() => sparklineCloses(citas(), s)).not.toThrow();
    expect(sparklineCloses(citas(), s)).toEqual([108.9, 101, 101, 81.85]);
    expect(() => sparklineCloses({ ...citas(), closes: undefined } as unknown as Quote, citasStat())).not.toThrow();
  });
});

// h120-finance-2: the last 5-minute bar of every session is an 18:00 pre-auction stub with volume 0 whose close can
// differ from the settled close (2026-11-10: SISE stub 35.46 red vs settled 35.72 green; TUPRS stub 332.25 green
// vs settled 331.25 red). Once the daily bar is in, the chart is given the settled close for its last-price tag,
// colour and aria-label. Known residual: between the close and the daily bar's arrival (about 19:33 Istanbul)
// bist_quote_stats still describes the previous day, so the helper answers null and the stub still shows.
describe("auctionStubSettledClose (h120-finance-2)", () => {
  const sise = () => ({
    lastBar: { ts: "2026-11-10T15:00:00Z", close: 35.46, volume: 0 as number | null },
    intradayDay: "2026-11-10" as string | null,
    stat: {
      ticker: "SISE",
      lastDay: "2026-11-10",
      lastClose: 35.72,
      prevClose: 35.48,
      lastVolume: 1000,
      avgVolume20: 900,
      rvol: 1.1,
    } as QuoteStat | null | undefined,
    nowMs: at("2026-11-10T19:00:00Z"),
  });

  it("SISE 11-10 replay: the 18:00 stub 35.46 gives the settled close 35.72", () => {
    expect(auctionStubSettledClose(sise())).toBe(35.72);
  });

  it("TUPRS 11-10 replay: the stub 332.25 gives the settled close 331.25", () => {
    const base = sise();
    expect(
      auctionStubSettledClose({
        ...base,
        lastBar: { ts: "2026-11-10T15:00:00Z", close: 332.25, volume: 0 },
        stat: { ...base.stat!, ticker: "TUPRS", lastClose: 331.25, prevClose: 332.25 },
      }),
    ).toBe(331.25);
  });

  it("a bar that traded (volume 1200) is not a stub: null", () => {
    expect(auctionStubSettledClose({ ...sise(), lastBar: { ts: "2026-11-10T15:00:00Z", close: 35.46, volume: 1200 } })).toBeNull();
  });

  it("a null volume is not proof of a stub: null", () => {
    expect(auctionStubSettledClose({ ...sise(), lastBar: { ts: "2026-11-10T15:00:00Z", close: 35.46, volume: null } })).toBeNull();
  });

  it("a volume-0 bar at 17:55 (the closing auction itself) is not the 18:00 stub: null", () => {
    expect(auctionStubSettledClose({ ...sise(), lastBar: { ts: "2026-11-10T14:55:00Z", close: 35.46, volume: 0 } })).toBeNull();
  });

  it("18:00 Istanbul is the first stub minute; a later volume-0 bar counts too", () => {
    expect(auctionStubSettledClose({ ...sise(), lastBar: { ts: "2026-11-10T15:00:00Z", close: 35.46, volume: 0 } })).toBe(35.72);
    expect(auctionStubSettledClose({ ...sise(), lastBar: { ts: "2026-11-10T15:05:00Z", close: 35.46, volume: 0 } })).toBe(35.72);
  });

  it("stat.lastDay 11-09 (the daily bar is not in yet): null", () => {
    const base = sise();
    expect(auctionStubSettledClose({ ...base, stat: { ...base.stat!, lastDay: "2026-11-09" } })).toBeNull();
  });

  it("a stat day later than the session on screen: null", () => {
    const base = sise();
    expect(auctionStubSettledClose({ ...base, stat: { ...base.stat!, lastDay: "2026-11-11" } })).toBeNull();
  });

  it("tolerates a longer ISO string in stat.lastDay or intradayDay (dayKey)", () => {
    const base = sise();
    expect(auctionStubSettledClose({ ...base, stat: { ...base.stat!, lastDay: "2026-11-10T00:00:00Z" } })).toBe(35.72);
    expect(auctionStubSettledClose({ ...base, intradayDay: "2026-11-10T00:00:00Z" })).toBe(35.72);
  });

  it("the session is not over yet: 17:59 Istanbul the same day is null, and so is 18:15 itself", () => {
    expect(auctionStubSettledClose({ ...sise(), nowMs: at("2026-11-10T14:59:00Z") })).toBeNull();
    expect(auctionStubSettledClose({ ...sise(), nowMs: at("2026-11-10T15:15:00Z") })).toBeNull();
  });

  it("the same day one minute past 18:15 is over (intradayCutShort's rule), a later day always is", () => {
    expect(auctionStubSettledClose({ ...sise(), nowMs: at("2026-11-10T15:16:00Z") })).toBe(35.72);
    expect(auctionStubSettledClose({ ...sise(), nowMs: at("2026-11-12T10:00:00Z") })).toBe(35.72);
  });

  it("agrees with intradayCutShort on when a session is over", () => {
    const cutArgs = (nowMs: number) => ({
      lastBar: { ts: "2026-11-10T09:05:00Z", close: 30 },
      intradayDay: "2026-11-10",
      stat: sise().stat,
      nowMs,
    });
    for (const now of ["2026-11-10T14:59:00Z", "2026-11-10T15:15:00Z", "2026-11-10T15:16:00Z", "2026-11-11T03:00:00Z"]) {
      const over = intradayCutShort(cutArgs(at(now)));
      expect(auctionStubSettledClose({ ...sise(), nowMs: at(now) }) !== null).toBe(over);
    }
  });

  it("the next morning before the first bar (11-11 06:00Z, 09:00 Istanbul) still gives 35.72", () => {
    expect(auctionStubSettledClose({ ...sise(), nowMs: at("2026-11-11T06:00:00Z") })).toBe(35.72);
  });

  it("stub equal to the settled close: null (nothing to correct)", () => {
    expect(auctionStubSettledClose({ ...sise(), lastBar: { ts: "2026-11-10T15:00:00Z", close: 35.72, volume: 0 } })).toBeNull();
  });

  it("null or non-finite inputs return null and never throw", () => {
    const base = sise();
    expect(auctionStubSettledClose({ ...base, lastBar: null })).toBeNull();
    expect(auctionStubSettledClose({ ...base, intradayDay: null })).toBeNull();
    expect(auctionStubSettledClose({ ...base, stat: null })).toBeNull();
    expect(auctionStubSettledClose({ ...base, stat: undefined })).toBeNull();
    expect(auctionStubSettledClose({ ...base, nowMs: Number.NaN })).toBeNull();
    expect(auctionStubSettledClose({ ...base, nowMs: Number.POSITIVE_INFINITY })).toBeNull();
    expect(auctionStubSettledClose({ ...base, lastBar: { ts: "garbage", close: 35.46, volume: 0 } })).toBeNull();
    expect(auctionStubSettledClose({ ...base, lastBar: { ts: "2026-11-10T15:00:00Z", close: Number.NaN, volume: 0 } })).toBeNull();
    for (const lastClose of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(auctionStubSettledClose({ ...base, stat: { ...base.stat!, lastClose } })).toBeNull();
    }
    expect(() => auctionStubSettledClose({ ...base, stat: { ...base.stat!, lastDay: 42 as unknown as string } })).not.toThrow();
  });
});
