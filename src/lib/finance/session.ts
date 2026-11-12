// Session-aware wording for the Ekonomi pages. Pure on purpose: no clock reads
// (callers pass `nowMs`, taken after `await connection()`), no next/* imports,
// so every rule is testable with an explicit instant.
//
// Istanbul is a fixed UTC+3 (no DST since 2016), so calendar days are derived
// by shifting the epoch by hand, the same way format.ts does.

import { bistCalendarEntry, bistCalendarLabel, bistDayNumber, bistTradingDay } from "@/lib/finance/bist-calendar";
import { fmtKat, limitPrices } from "@/lib/finance/format";
import type { Company, QuoteStat } from "@/lib/finance/queries";
import type { Quote } from "@/lib/finance/quotes";

const IST_OFFSET_MS = 3 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

/** BIST continuous session in Istanbul minutes of the day: 09:55 .. 18:15. */
export const SESSION_OPEN_MIN = 9 * 60 + 55;
export const SESSION_CLOSE_MIN = 18 * 60 + 15;

/**
 * The half-day twin of SESSION_CLOSE_MIN: 12:45. BIST "Pay Piyasası İşlem Saatleri Çizelgeleri" (04.11.2019),
 * "YARIM İŞ GÜNLERİNDE": continuous trading 10:00-12:30, closing-price trades 12:38-12:40. The full day's 18:15 is
 * the 18:10 end of its closing-price trades plus 5 minutes of slack, and so is this: 12:40 plus 5 minutes.
 */
export const HALF_DAY_CLOSE_MIN = 12 * 60 + 45;

/**
 * A quote is shown by its date only ("son işlem dd.MM.yyyy") once this many BIST sessions have passed between its
 * day and today without a trade. Weekends and closed holidays are not sessions, so a bayram closure never counts;
 * a half day is one.
 */
export const HALTED_AFTER_MISSED_SESSIONS = 2;

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

/** Whether an epoch-day number is a half day in the BIST calendar (arife, 28 Ekim): the session ends at 12:30. */
function isHalfDay(dayNum: number | null): boolean {
  return dayNum !== null && bistCalendarEntry(dayNum)?.kind === "half";
}

/**
 * Whether the BIST continuous session is running at `nowMs`: a trading day
 * inside 09:55-18:15 Istanbul time (both bounds inclusive). A trading day is a
 * weekday that is not a closed row of the static BIST calendar
 * (bist-calendar.ts); a half day (arife, 28 Ekim) ends at HALF_DAY_CLOSE_MIN,
 * 12:45, instead of 18:15. Past the table's last day only the weekday rule
 * applies. An unparsable or out-of-range `nowMs` is not open; never throws.
 */
export function marketOpen(nowMs: number): boolean {
  if (!Number.isFinite(nowMs)) return false;
  const now = new Date(nowMs + IST_OFFSET_MS);
  if (Number.isNaN(now.getTime())) return false;
  const d = istDay(nowMs);
  if (!bistTradingDay(d)) return false;
  const close = isHalfDay(d) ? HALF_DAY_CLOSE_MIN : SESSION_CLOSE_MIN;
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  return minute >= SESSION_OPEN_MIN && minute <= close;
}

/**
 * How many BIST sessions fall strictly between two Istanbul days, counting only up to HALTED_AFTER_MISSED_SESSIONS.
 * A gap of more than 31 days is the cap without walking it, so the loop is bounded.
 */
function missedSessions(fromDay: number, toDay: number): number {
  if (toDay - fromDay > 31) return HALTED_AFTER_MISSED_SESSIONS;
  let missed = 0;
  for (let d = fromDay + 1; d < toDay && missed < HALTED_AFTER_MISSED_SESSIONS; d++) {
    if (bistTradingDay(d)) missed++;
  }
  return missed;
}

/**
 * How current a quote is, for the word shown next to its move.
 *  - halted: two or more BIST sessions passed between the quote's day and today without a trade; weekends and
 *    closed holidays are not sessions, half days are.
 *  - live: traded today, on a trading day, inside the session (09:55-18:15, or to 12:45 on a half day).
 *  - last_session: everything else (weekend, holiday, overnight, closed for the day).
 */
export function quoteFreshness(asOfIso: string, nowMs: number): QuoteFreshness {
  const asOfMs = Date.parse(asOfIso);
  if (!Number.isFinite(asOfMs)) return { kind: "last_session", label: "son seans" };
  if (!Number.isFinite(nowMs)) return { kind: "last_session", label: `son seans ${ddMM(asOfMs)}` };

  const asOfDay = istDay(asOfMs);
  const today = istDay(nowMs);
  if (missedSessions(asOfDay, today) >= HALTED_AFTER_MISSED_SESSIONS) {
    return { kind: "halted", label: `son işlem ${ddMMyyyy(asOfMs)}` };
  }

  if (today === asOfDay && marketOpen(nowMs)) return { kind: "live", label: "bugün" };
  return { kind: "last_session", label: `son seans ${ddMM(asOfMs)}` };
}

/**
 * The one-line cue under the /ekonomi header, or null when nothing needs
 * saying. `asOfIso` is the NEWEST quote's last trade.
 *
 * Quotes are cached for minutes and served stale-while-revalidate, so at the
 * open every cached quote can still carry the previous session's date while
 * BIST is trading. The newest quote's date alone therefore cannot say the
 * market is closed; the clock and the BIST calendar decide that:
 *  - market closed (weekend, holiday, before the open, after the close): "Piyasa kapalı · <label>", with the
 *    reason between them on a closed holiday ("Piyasa kapalı · Cumhuriyet Bayramı tatili · son seans 28.10") and
 *    on a half day after its close ("... Cumhuriyet Bayramı arifesi, yarım gün ..."); a half day before the open
 *    and a plain weekend or evening carry no reason.
 *  - session hours but the newest quote is not today's: "Veriler gecikmeli · <label>",
 *    which states what is on screen and claims nothing about the market.
 * An unparsable `nowMs` takes the neutral wording.
 */
export function marketCueText(asOfIso: string | null, nowMs: number): string | null {
  if (!asOfIso) return null;
  const fresh = quoteFreshness(asOfIso, nowMs);
  if (fresh.kind === "live") return null;
  const closed = Number.isFinite(nowMs) && !marketOpen(nowMs);
  if (!closed) return `Veriler gecikmeli · ${fresh.label}`;
  const reason = closedReason(nowMs);
  return reason ? `Piyasa kapalı · ${reason} · ${fresh.label}` : `Piyasa kapalı · ${fresh.label}`;
}

/**
 * Why the market is closed at `nowMs`, when the calendar says so: the holiday's label on a closed day, the arife
 * label on a half day once it is past HALF_DAY_CLOSE_MIN. Null on a plain day, on a half day before its close
 * (it is closed only because it has not opened) and for an unreadable clock.
 */
function closedReason(nowMs: number): string | null {
  if (!Number.isFinite(nowMs)) return null;
  const entry = bistCalendarEntry(istDay(nowMs));
  if (!entry) return null;
  if (entry.kind === "closed") return bistCalendarLabel(entry);
  const now = new Date(nowMs + IST_OFFSET_MS);
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  return minute > HALF_DAY_CLOSE_MIN ? bistCalendarLabel(entry) : null;
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

/**
 * The half-day twin of CUT_BAR_BEFORE_MIN: 12:00, 30 minutes before the 12:30 end of continuous trading (BIST
 * çizelge 04.11.2019, "YARIM İŞ GÜNLERİNDE"), as 17:30 is 30 minutes before 18:00.
 */
const HALF_DAY_CUT_BAR_BEFORE_MIN = 12 * 60;

/** Relative gap between the last bar's close and the settled close that is worth correcting (0.5 %). */
const CUT_CLOSE_GAP = 0.005;

/**
 * Whether the session of Istanbul day `session` (YYYY-MM-DD) is over at `nowMs`: a later Istanbul day, or the
 * same day after the session end: SESSION_CLOSE_MIN (18:15), or HALF_DAY_CLOSE_MIN (12:45) when `session` is a
 * half day of the BIST calendar. An unparsable `nowMs` is not over. The one definition of "over" that
 * intradayCutShort and auctionStubSettledClose share.
 */
function sessionOver(nowMs: number, session: string): boolean {
  if (!Number.isFinite(nowMs)) return false;
  const now = new Date(nowMs + IST_OFFSET_MS);
  const today = now.toISOString().slice(0, 10);
  const nowMinute = now.getUTCHours() * 60 + now.getUTCMinutes();
  const closeMin = isHalfDay(bistDayNumber(session)) ? HALF_DAY_CLOSE_MIN : SESSION_CLOSE_MIN;
  return today > session || (today === session && nowMinute > closeMin);
}

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
 *  3. the session is over: a later Istanbul day, or the same day after 18:15
 *     (12:45 on a half day);
 *  4. the last bar is before 17:30 Istanbul (before 12:00 on a half day);
 *  5. the last bar's close is more than 0.5 % away from the settled close.
 * Anything unreadable is false: a normal day, a half day (a half day's bars end
 * near 12:30, which the 12:00 threshold and the 12:45 session end of the BIST
 * calendar account for) and an open session all keep the chart as it is. The
 * chart's settled close is stat.lastClose, the header's own number.
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

  if (!sessionOver(nowMs, dayKey(intradayDay))) return false;

  const barMs = Date.parse(lastBar.ts);
  if (!Number.isFinite(barMs)) return false;
  const bar = new Date(barMs + IST_OFFSET_MS);
  const cutBefore = isHalfDay(bistDayNumber(dayKey(intradayDay))) ? HALF_DAY_CUT_BAR_BEFORE_MIN : CUT_BAR_BEFORE_MIN;
  if (bar.getUTCHours() * 60 + bar.getUTCMinutes() >= cutBefore) return false;

  return Math.abs(lastBar.close / stat.lastClose - 1) > CUT_CLOSE_GAP;
}

/**
 * A 5-minute bar from this Istanbul minute of the day (18:00) on, with volume 0, is the closing auction's
 * pre-print stub, not a trade: the continuous session ends 18:00 and the closing auction prints the 17:55 bar.
 */
const AUCTION_STUB_FROM_MIN = 18 * 60;

/**
 * The half-day twin of AUCTION_STUB_FROM_MIN: 12:30, where continuous trading ends and the closing-price phase
 * starts (BIST çizelge 04.11.2019, "YARIM İŞ GÜNLERİNDE"), as 18:00 is on a full day.
 */
const HALF_DAY_AUCTION_STUB_FROM_MIN = 12 * 60 + 30;

/**
 * The settled close to draw the intraday chart's last price from instead of the 18:00 stub bar, or null when the
 * chart should keep reading its last bar (h120-finance-2).
 *
 * Every finished session's last 5-minute bar is stamped 18:00 Istanbul with volume 0: it carries the auction's
 * indicative price, which can differ from the settled close (2026-11-10: SISE stub 35,46 red against a settled
 * 35,72 green; TUPRS stub 332,25 green against a settled 331,25 red). The chart took its last-price tag, colour
 * and aria-label from that bar and contradicted the header, which reads the settled close. It is stat.lastClose
 * that is returned, the header's own number. This is the chart-side twin of intradayCutShort, whose rule
 * (bars before 17:30) never fires for a bar at 18:00. Non-null only when ALL of these hold:
 *  1. there is a last bar with volume exactly 0 and a finite close, whose Istanbul time is 18:00 or later
 *     (12:30 or later on a half day of the BIST calendar);
 *  2. the stat is the daily bar of the session day on screen and has a usable settled close;
 *  3. the session is over, by the same rule as intradayCutShort (a later Istanbul day, or the same day after
 *     SESSION_CLOSE_MIN, or HALF_DAY_CLOSE_MIN on a half day);
 *  4. the stub's close is not already the settled close.
 * Anything unreadable gives null. Never throws.
 *
 * Known residual: bist_quote_stats gets the day's daily bar only at about 19:33 Istanbul, so between the close
 * (18:15) and that moment stat.lastDay is still the previous day, rule 2 fails, and the stub still shows. That
 * window is accepted. From the daily bar's arrival to the next session's first bar (the whole evening, the
 * weekend, the next morning) the settled close is returned.
 */
export function auctionStubSettledClose(a: {
  lastBar: { ts: string; close: number; volume: number | null } | null;
  intradayDay: string | null;
  stat: QuoteStat | null | undefined;
  nowMs: number;
}): number | null {
  try {
    const { lastBar, intradayDay, stat, nowMs } = a;
    if (!lastBar || lastBar.volume !== 0 || !Number.isFinite(lastBar.close)) return null;
    if (typeof intradayDay !== "string" || !intradayDay) return null;
    if (!stat || typeof stat.lastDay !== "string" || dayKey(stat.lastDay) !== dayKey(intradayDay)) return null;
    if (!Number.isFinite(stat.lastClose) || !(stat.lastClose > 0)) return null;

    if (!sessionOver(nowMs, dayKey(intradayDay))) return null;

    const barMs = Date.parse(lastBar.ts);
    if (!Number.isFinite(barMs)) return null;
    const bar = new Date(barMs + IST_OFFSET_MS);
    const stubFrom = isHalfDay(bistDayNumber(dayKey(intradayDay))) ? HALF_DAY_AUCTION_STUB_FROM_MIN : AUCTION_STUB_FROM_MIN;
    if (bar.getUTCHours() * 60 + bar.getUTCMinutes() < stubFrom) return null;

    return lastBar.close !== stat.lastClose ? stat.lastClose : null;
  } catch {
    return null;
  }
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

const SPARKLINE_POINTS = 5;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The values for the header sparkline: quote.closes with the D-1 settled close put back (h120-finance-1).
 *
 * During a session Yahoo's 5d/1d array has no bar for the previous day (CITAS 2026-11-11 11:16 Istanbul: 5, 6 and
 * 9 Nov plus the live 11 Nov bar, no 10 Nov), the same quirk rebaseQuoteOnStat repairs for the move and never for
 * `closes`. The line then ran from 9 Nov straight to today, so its last segment contradicted the re-based move
 * beside it (a -19 % line next to "taban -%9,96"; GARAN flat-up next to red -1,42 %).
 * bist_quote_stats.last_close is that missing close. It is inserted, in order, just before the first close of the
 * session day (or appended when there is none), and only the last 5 values are kept, as before. Every one of
 * these must hold, else quote.closes is returned as it is (the same array):
 *  1. the stat has a finite lastClose > 0 and a YYYY-MM-DD lastDay;
 *  2. quote.closeDays names a day for each close (same length; absent on a cache entry from before the field);
 *  3. the quote has a session day (the Istanbul day of quote.asOf, the rule of rebaseQuoteOnStat);
 *  4. the stat day is before the session day, so it is a finished session and not today's own bar;
 *  5. no close already sits on the stat day;
 *  6. the stat day is later than every close day that is before the session day, so the insert keeps the order.
 * A new array is returned only when a value was inserted. Never throws, never mutates the quote.
 */
export function sparklineCloses(quote: Quote, stat: QuoteStat | null | undefined): number[] {
  try {
    const closes = quote.closes;
    const days = quote.closeDays;
    if (!stat || !Number.isFinite(stat.lastClose) || !(stat.lastClose > 0)) return closes;
    if (!Array.isArray(days) || days.length !== closes.length) return closes;
    if (typeof stat.lastDay !== "string") return closes;
    const sessionDay = quoteSessionDay(quote.asOf);
    if (sessionDay === null) return closes;
    const statDay = dayKey(stat.lastDay);
    if (!DAY_KEY_RE.test(statDay) || !(statDay < sessionDay)) return closes;

    let insertAt = days.length;
    for (let i = 0; i < days.length; i++) {
      const d = days[i];
      if (typeof d !== "string" || !DAY_KEY_RE.test(d)) return closes;
      if (d === statDay) return closes;
      if (d < sessionDay && d > statDay) return closes;
      if (d >= sessionDay && insertAt === days.length) insertAt = i;
    }

    return [...closes.slice(0, insertAt), stat.lastClose, ...closes.slice(insertAt)].slice(-SPARKLINE_POINTS);
  } catch {
    return Array.isArray(quote?.closes) ? quote.closes : [];
  }
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
