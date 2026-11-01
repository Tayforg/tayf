// Session-aware wording for the Ekonomi pages. Pure on purpose: no clock reads
// (callers pass `nowMs`, taken after `await connection()`), no next/* imports,
// so every rule is testable with an explicit instant.
//
// Istanbul is a fixed UTC+3 (no DST since 2016), so calendar days are derived
// by shifting the epoch by hand, the same way format.ts does.

import type { Company, QuoteStat } from "@/lib/finance/queries";

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
 * Relative volume plus, when the volume belongs to a different day than the
 * session on screen, that day as dd.MM ("hacim 1,3x ... · 30.10 seansı").
 */
export function rvolLabel(
  stat: QuoteStat | null | undefined,
  intradayDay: string | null,
): { rvol: number; dayLabel: string | null } | null {
  if (stat?.rvol == null) return null;
  if (intradayDay == null || dayKey(stat.lastDay) === dayKey(intradayDay)) return { rvol: stat.rvol, dayLabel: null };
  return { rvol: stat.rvol, dayLabel: ddMMOfDay(stat.lastDay) };
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
