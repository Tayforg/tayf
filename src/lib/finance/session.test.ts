import { describe, expect, it } from "vitest";

import type { QuoteStat } from "@/lib/finance/queries";
import type { Quote } from "@/lib/finance/quotes";

import { limitFlag } from "./format";
import {
  chartBaseline,
  companyMetaLine,
  intradayEmptyCopy,
  marketCueText,
  marketOpen,
  priceEmptyLabel,
  quoteFreshness,
  rebaseQuoteOnStat,
  rvolLabel,
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
