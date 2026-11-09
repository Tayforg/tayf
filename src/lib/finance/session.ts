// Session-aware wording for the Ekonomi pages. Pure on purpose: no clock reads
// (callers pass `nowMs`, taken after `await connection()`), no next/* imports,
// so every rule is testable with an explicit instant.
//
// Istanbul is a fixed UTC+3 (no DST since 2016), so calendar days are derived
// by shifting the epoch by hand, the same way format.ts does.

import { fmtKat, limitPrices } from "@/lib/finance/format";
import type { Company, QuoteStat } from "@/lib/finance/queries";
import type { Quote } from "@/lib/finance/quotes";

const IST_OFFSET_MS = 3 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

/** BIST continuous session in Istanbul minutes of the day: 09:55 .. 18:15. */
export const SESSION_OPEN_MIN = 9 * 60 + 55;
export const SESSION_CLOSE_MIN = 18 * 60 + 15;

/**
 * A quote whose last trade is more than this many Istanbul calendar days old
 * is shown by its date only. Four days covers a normal weekend plus a one-day
 * holiday (Fri close read on Tuesday); the 9-day bayram gaps land here too,
 * which is why the label states the date and never asserts a halt.
 */
export const HALTED_AFTER_DAYS = 4;

export type QuoteFreshness =
  | { kind: "live"; label: "bugün" }
  | { kind: "last_session"; label: string }
  | { kind: "halted"; label: string };

const two = (n: number) => String(n).padStart(2, "0");

/** Whole Istanbul calendar days since the epoch for an instant. */
function istDay(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / DAY_MS);
}

function ddMM(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${two(d.getUTCDate())}.${two(d.getUTCMonth() + 1)}`;
}

function ddMMyyyy(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${ddMM(ms)}.${d.getUTCFullYear()}`;
}

/** dd.MM of a YYYY-MM-DD day string, or null when it is not one. */
function ddMMOfDay(day: string): string | null {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(day);
  return m ? `${m[2]}.${m[1]}` : null;
}

/** Comparable YYYY-MM-DD key (tolerates a longer ISO string). */
const dayKey = (day: string) => day.slice(0, 10);

/**
 * Whether the BIST continuous session is running at `nowMs`: a weekday inside
 * 09:55-18:15 Istanbul time (both bounds inclusive). Clock only: there is no
 * holiday calendar, so a weekday holiday reads as open. That is the safe
 * direction for wording, because "Piyasa kapalı" is claimed only when the
 * market is certainly closed (weekend or outside the session hours).
 * An unparsable `nowMs` is not open.
 */
export function marketOpen(nowMs: number): boolean {
  if (!Number.isFinite(nowMs)) return false;
  const now = new Date(nowMs + IST_OFFSET_MS);
  const weekday = now.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  return weekday >= 1 && weekday <= 5 && minute >= SESSION_OPEN_MIN && minute <= SESSION_CLOSE_MIN;
}

/**
 * How current a quote is, for the word shown next to its move.
 *  - halted: the last trade is more than HALTED_AFTER_DAYS calendar days back.
 *  - live: traded today, on a weekday, inside the 09:55-18:15 session.
 *  - last_session: everything else (weekend, overnight, closed for the day).
 */
export function quoteFreshness(asOfIso: string, nowMs: number): QuoteFreshness {
  const asOfMs = Date.parse(asOfIso);
  if (!Number.isFinite(asOfMs)) return { kind: "last_session", label: "son seans" };
  if (!Number.isFinite(nowMs)) return { kind: "last_session", label: `son seans ${ddMM(asOfMs)}` };

  const gapDays = istDay(nowMs) - istDay(asOfMs);
  if (gapDays > HALTED_AFTER_DAYS) return { kind: "halted", label: `son işlem ${ddMMyyyy(asOfMs)}` };

  if (gapDays === 0 && marketOpen(nowMs)) return { kind: "live", label: "bugün" };
  return { kind: "last_session", label: `son seans ${ddMM(asOfMs)}` };
}

/**
 * The one-line cue under the /ekonomi header, or null when nothing needs
 * saying. `asOfIso` is the NEWEST quote's last trade.
 *
 * Quotes are cached for minutes and served stale-while-revalidate, so at the
 * open every cached quote can still carry the previous session's date while
 * BIST is trading. The newest quote's date alone therefore cannot say the
 * market is closed; the clock decides that:
 *  - market closed (weekend, before the open, after the close): "Piyasa kapalı · <label>".
 *  - session hours but the newest quote is not today's: "Veriler gecikmeli · <label>",
 *    which states what is on screen and claims nothing about the market.
 * An unparsable `nowMs` takes the neutral wording.
 */
export function marketCueText(asOfIso: string | null, nowMs: number): string | null {
  if (!asOfIso) return null;
  const fresh = quoteFreshness(asOfIso, nowMs);
  if (fresh.kind === "live") return null;
  const closed = Number.isFinite(nowMs) && !marketOpen(nowMs);
  return closed ? `Piyasa kapalı · ${fresh.label}` : `Veriler gecikmeli · ${fresh.label}`;
}

/**
 * Reference price for the intraday chart's "previous close" line. The stat row
 * is the daily bar of `stat.lastDay`, so it only describes a baseline for the
 * session being drawn when the days line up:
 *  - session after lastDay: lastClose is the previous close.
 *  - same day: the stat's own prevClose (the quote's when the stat has none).
 *  - session before lastDay: nothing honest to draw.
 * Without a stat, or without a session day, fall back to what is known.
 */
export function chartBaseline(args: {
  stat?: QuoteStat | null;
  intradayDay: string | null;
  quotePrevClose: number | null;
}): number | null {
  const { stat, intradayDay, quotePrevClose } = args;
  if (!stat) return quotePrevClose;
  if (intradayDay == null) return stat.prevClose ?? quotePrevClose;
  const session = dayKey(intradayDay);
  const statDay = dayKey(stat.lastDay);
  if (session > statDay) return stat.lastClose;
  if (session === statDay) return stat.prevClose ?? quotePrevClose;
  return null;
}

/**
 * A last 5-minute bar earlier than this (Istanbul minutes of the day, 17:30) is
 * not a normal end of session: the continuous session runs to 18:00 and the
 * closing auction prints the 17:55 bar. A bar that ends before it, once the
 * session is over, means the bars stopped coming (h92-marketclock-1).
 */
const CUT_BAR_BEFORE_MIN = 17 * 60 + 30;

/** Relative gap between the last bar's close and the settled close that is worth correcting (0.5 %). */
const CUT_CLOSE_GAP = 0.005;

/**
 * Whether the newest 5-minute session on screen was cut short, so that its last
 * bar is not where the day settled (h92-marketclock-1).
 *
 * bist_intraday_targets used to select news tickers over a rolling 7 x 24 hours,
 * so a ticker left the target list at the minute its last mention turned 7 days
 * old, in the middle of a session, and quotes-ingest never back-filled the rest.
 * VKING 2026-11-06: bars to 12:05 Istanbul, the last at 11,53, the daily close
 * 12,09. The chart drew its last price, colour and aria-label from that bar and
 * contradicted the header. This is true only when ALL of these hold:
 *  1. there is a last bar and a session day;
 *  2. the stat is the daily bar of that same day and has a usable settled close;
 *  3. the session is over: a later Istanbul day, or the same day after 18:15;
 *  4. the last bar is before 17:30 Istanbul;
 *  5. the last bar's close is more than 0.5 % away from the settled close.
 * Anything unreadable is false: a normal day, a half day (its bars end near
 * 12:30 and agree with the settle) and an open session all keep the chart as it
 * is. The chart's settled close is stat.lastClose, the header's own number.
 */
export function intradayCutShort(a: {
  lastBar: { ts: string; close: number } | null;
  intradayDay: string | null;
  stat: QuoteStat | null | undefined;
  nowMs: number;
}): boolean {
  const { lastBar, intradayDay, stat, nowMs } = a;
  if (!lastBar || !intradayDay) return false;
  if (!stat || dayKey(stat.lastDay) !== dayKey(intradayDay)) return false;
  if (!Number.isFinite(stat.lastClose) || !(stat.lastClose > 0)) return false;

  if (!Number.isFinite(nowMs)) return false;
  const now = new Date(nowMs + IST_OFFSET_MS);
  const today = now.toISOString().slice(0, 10);
  const session = dayKey(intradayDay);
  const nowMinute = now.getUTCHours() * 60 + now.getUTCMinutes();
  const over = today > session || (today === session && nowMinute > SESSION_CLOSE_MIN);
  if (!over) return false;

  const barMs = Date.parse(lastBar.ts);
  if (!Number.isFinite(barMs)) return false;
  const bar = new Date(barMs + IST_OFFSET_MS);
  if (bar.getUTCHours() * 60 + bar.getUTCMinutes() >= CUT_BAR_BEFORE_MIN) return false;

  return Math.abs(lastBar.close / stat.lastClose - 1) > CUT_CLOSE_GAP;
}

/**
 * The "Seans içi" panel meta: the session day as dd.MM.yyyy plus, when the
 * session was cut (see intradayCutShort), the Istanbul time its bars stop at.
 * Without a usable `cutAtTs` it is the original line, unchanged.
 */
export function intradayPanelMeta(day: string, cutAtTs: string | null): string {
  const date = day.split("-").reverse().join(".");
  const cutMs = cutAtTs == null ? Number.NaN : Date.parse(cutAtTs);
  if (!Number.isFinite(cutMs)) return `${date}, 5 dakikalık kapanışlar, haberler işaretli`;
  const cut = new Date(cutMs + IST_OFFSET_MS);
  const clock = `${two(cut.getUTCHours())}:${two(cut.getUTCMinutes())}`;
  return `${date}, 5 dakikalık kapanışlar, ${clock} sonrası veri eksik, haberler işaretli`;
}

/** Sub-kurus slack for comparing a price with a band limit (float noise only). */
const BAND_EPSILON = 1e-6;

/**
 * Whether two bases are the same price to the kurus: a base back-solved from
 * Yahoo's percent differs from the settled close by float noise, which is no
 * reason to rewrite a quote that already measures from the right close.
 */
const sameBase = (a: number, b: number) => Math.abs(a - b) < 0.005;

/**
 * A price more than one tick past tavan or taban cannot exist on a day whose
 * base is `prevClose`, so a quote showing one was measured from the wrong
 * base. Such a quote keeps its price but loses its baseline, which the chips
 * and the header already render as "—" with no limit tag. The tick of slack
 * leaves a real limit hit (and a price a tick off the grid) alone. Skipped for
 * a quote that already has no baseline (its prevClose is the price itself).
 */
function withinBandOrUnknown(quote: Quote): Quote {
  if (quote.hasBaseline === false || !Number.isFinite(quote.price)) return quote;
  const band = limitPrices(quote.prevClose);
  if (!band) return quote;
  const outside =
    quote.price > band.tavan + band.upTick + BAND_EPSILON || quote.price < band.taban - band.downTick - BAND_EPSILON;
  return outside ? { ...quote, hasBaseline: false } : quote;
}

/**
 * Re-bases a quote's day move on bist_quote_stats (h36-data-1).
 *
 * During a session Yahoo's 5d/1d payload resolves the previous close to the
 * close from TWO sessions back, so the live price was measured against D-2
 * ("tavan +%13,58" on a +3,35 % day, a move past the +-10 % band). The stat
 * row is the daily bar of `stat.lastDay`, so which of its closes is the base
 * for the session the quote belongs to (the Istanbul day of `quote.asOf`)
 * depends on whether the days line up, the same rule chartBaseline draws the
 * intraday chart's dashed line with:
 *  - stat day before the session day: lastClose is the previous close.
 *  - same day: the stat's own prevClose.
 *  - stat day after the session day: it describes a later session; keep the quote.
 * With no stat, no usable asOf, or no usable base the quote is kept as it was.
 *
 * Whatever the base, the result goes through a band guard (see
 * withinBandOrUnknown), so a stat that is itself stale or unadjusted (a capital
 * increase leaves prevClose on the old share price) can never put a move past
 * the daily limit on screen: the move becomes unknown instead.
 */
export function rebaseQuoteOnStat(quote: Quote, stat: QuoteStat | null | undefined): Quote {
  if (!stat) return withinBandOrUnknown(quote);
  const asOfMs = Date.parse(quote.asOf);
  if (!Number.isFinite(asOfMs)) return withinBandOrUnknown(quote);

  const sessionDay = new Date(asOfMs + IST_OFFSET_MS).toISOString().slice(0, 10);
  const statDay = dayKey(stat.lastDay);
  if (statDay > sessionDay) return withinBandOrUnknown(quote);

  const base = statDay < sessionDay ? stat.lastClose : stat.prevClose;
  if (base == null || !Number.isFinite(base) || !(base > 0)) return withinBandOrUnknown(quote);

  // Already measured from this close: keep Yahoo's own percent untouched.
  if (quote.hasBaseline !== false && sameBase(quote.prevClose, base)) return withinBandOrUnknown(quote);

  return withinBandOrUnknown({
    ...quote,
    prevClose: base,
    changePct: ((quote.price - base) / base) * 100,
    hasBaseline: true,
  });
}

/**
 * The Istanbul calendar day (YYYY-MM-DD) a quote's last trade belongs to, or
 * null for null, undefined or a value that is not a parsable instant. Never
 * throws. This is the "session on screen" for a quote with no 5-minute bars
 * (h99-financenumbers-1): during a session the quote is today's, while
 * bist_quote_stats still describes the previous session until the daily bar
 * lands (about 19:33 Istanbul), so the relative volume has to name its own day
 * (rvolLabel(stat, quoteSessionDay(quote?.asOf))). Same day rule as
 * rebaseQuoteOnStat.
 */
export function quoteSessionDay(asOf: string | null | undefined): string | null {
  if (typeof asOf !== "string") return null;
  const ms = Date.parse(asOf);
  if (!Number.isFinite(ms)) return null;
  const shifted = new Date(ms + IST_OFFSET_MS);
  if (Number.isNaN(shifted.getTime())) return null;
  const day = shifted.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/**
 * Relative volume plus, when the volume belongs to a different day than the
 * session on screen, that day as dd.MM ("hacim 20 günlük ortalamanın 1,3 katı ·
 * 30.10 seansı"; the wording is built by rvolPhrase / rvolParts).
 */
export function rvolLabel(
  stat: QuoteStat | null | undefined,
  intradayDay: string | null,
): { rvol: number; dayLabel: string | null } | null {
  if (stat?.rvol == null) return null;
  if (intradayDay == null || dayKey(stat.lastDay) === dayKey(intradayDay)) return { rvol: stat.rvol, dayLabel: null };
  return { rvol: stat.rvol, dayLabel: ddMMOfDay(stat.lastDay) };
}

/**
 * The relative-volume wording of the /ekonomi/<ticker> header, in the pieces
 * the header colours separately: "20 günlük ortalamanın" | "1,9 katı" |
 * "05.11 seansı" (null when the volume belongs to the session on screen).
 * The genitive "ortalamanın" needs its head noun "katı", as on /trends
 * ("7 günlük ortalamanın 3,1 katı"); the compact chip form "1,9x" is only for
 * places with no genitive in front of it. rvolPhrase joins these pieces, so
 * the markup and the string cannot drift apart.
 */
export function rvolParts(v: { rvol: number; dayLabel: string | null }): {
  basis: string;
  ratio: string;
  day: string | null;
} {
  return {
    basis: "20 günlük ortalamanın",
    ratio: `${fmtKat(v.rvol)} katı`,
    day: v.dayLabel ? `${v.dayLabel} seansı` : null,
  };
}

/** One string: "20 günlük ortalamanın 1,9 katı" (+ " · 05.11 seansı" for another day's volume). */
export function rvolPhrase(v: { rvol: number; dayLabel: string | null }): string {
  const p = rvolParts(v);
  return `${p.basis} ${p.ratio}${p.day ? ` · ${p.day}` : ""}`;
}

type CompanyMeta = Pick<Company, "city" | "sharesTraded" | "tickers">;

/** Header meta line: city · işlem görmüyor · paylar: A B. Empty when nothing applies. */
export function companyMetaLine(company: CompanyMeta | null | undefined): string {
  if (!company) return "";
  const parts: string[] = [];
  if (company.city) parts.push(company.city);
  if (!company.sharesTraded) parts.push("işlem görmüyor");
  if (company.tickers.length > 1) parts.push(`paylar: ${company.tickers.join(" ")}`);
  return parts.join(" · ");
}

/** Shown in place of the price when there is no quote. */
export function priceEmptyLabel(company: Pick<Company, "sharesTraded"> | null | undefined): string {
  return company && !company.sharesTraded ? "işlem görmüyor" : "fiyat alınamadı";
}

/** Empty-state copy for the intraday panel. */
export function intradayEmptyCopy(company: Pick<Company, "sharesTraded"> | null | undefined): string {
  if (company && !company.sharesTraded) return "Bu şirketin payları borsada işlem görmüyor; seans verisi yok.";
  return "Bu hisse için seans içi veri henüz toplanmadı. Haberde geçen hisseler seans boyunca 5 dakikada bir kaydedilir.";
}
