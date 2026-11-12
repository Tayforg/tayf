import { formatCountTr } from "@/lib/format/number-tr";
import { dayLabelTr } from "@/lib/trends/day-label";

import { ENTITY_HUB_MIN_INDEXABLE } from "./entity-hub";

// The pure half of the /gundem/[key] daily chart (h154-hub-trend): validation of the rows of migration 206's
// `entity_cluster_days` and every line of Turkish copy the chart prints. No I/O, no clock, no Next import.
//
// The RPC returns 15 rows: the 14 Istanbul days ending today (a day without a cluster is a row with 0) and one row with
// `day` null that counts the clusters whose first report is older than the oldest of those days. The count of a day is
// the number of THIS hub's clusters whose first report fell on it (a cluster, not a headline), so the bars and the
// hub's own "Son 14 günde N küme" line count the same thing; the daily rollup of /trends does not (it counts headline
// articles and changes basis inside the window, see migration 206).
//
// Every count in the copy goes through formatCountTr (dot grouping on every ICU build). Wherever the window length is
// named it is HUB_TREND_DAYS, never a second literal.

/** Days drawn: the hub's own window (ENTITY_HUB_WINDOW_DAYS), as Istanbul calendar days ending today. */
export const HUB_TREND_DAYS = 14;

export interface HubTrendDay {
  /** Istanbul calendar day, YYYY-MM-DD. */
  day: string;
  /** Clusters of the hub whose first report fell on that day. */
  clusters: number;
}

export type HubTrend =
  | {
      status: "ok";
      /** HUB_TREND_DAYS days, oldest first, the last one the running (incomplete) day. */
      days: readonly HubTrendDay[];
      /** Matched clusters whose first report is older than the first day: in the hub's total, not in the chart. */
      earlier: number;
    }
  | { status: "unavailable" };

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** The UTC midnight of a real calendar date written YYYY-MM-DD, or null (a malformed key, or 2026-02-30). */
function dayKeyMs(key: string): number | null {
  const m = DAY_KEY.exec(key);
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const dayOfMonth = Number(m[3]);
  const ms = Date.UTC(year, month - 1, dayOfMonth);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== dayOfMonth) {
    return null;
  }
  return ms;
}

/** True for a non-empty string of ASCII digits (a bigint a driver sent as text). */
function isDigits(text: string): boolean {
  if (text.length === 0) return false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

/** A count as a safe integer >= 0, or null. A string must be plain digits: "", " ", "1e3", "-1" and "1.5" are not counts. */
function countOf(raw: unknown): number | null {
  let n: number;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string" && isDigits(raw)) n = Number(raw);
  else return null;
  // `+ 0` turns a negative zero (a JSON "-0") into 0.
  return Number.isSafeInteger(n) && n >= 0 ? n + 0 : null;
}

/**
 * The 15 rows of entity_cluster_days as the chart's input, or null when they are not exactly that: an array of 15
 * objects, one with `day` null (earlier) and 14 with real, distinct, consecutive calendar days, every count a safe integer
 * >= 0 (a number, or the digits of a bigint sent as a string). The input order does not matter; the days come back oldest
 * first. Anything else is null, so a half-answered or reshaped RPC draws no chart instead of a wrong one.
 */
export function parseHubTrendRows(rows: unknown): { days: HubTrendDay[]; earlier: number } | null {
  if (!Array.isArray(rows) || rows.length !== HUB_TREND_DAYS + 1) return null;

  const dated: Array<{ ms: number; day: string; clusters: number }> = [];
  let earlier: number | null = null;
  for (const row of rows as unknown[]) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return null;
    const { day, clusters } = row as { day?: unknown; clusters?: unknown };
    const n = countOf(clusters);
    if (n === null) return null;
    if (day === null) {
      if (earlier !== null) return null;
      earlier = n;
      continue;
    }
    if (typeof day !== "string") return null;
    const ms = dayKeyMs(day);
    if (ms === null) return null;
    dated.push({ ms, day, clusters: n });
  }
  if (earlier === null || dated.length !== HUB_TREND_DAYS) return null;

  dated.sort((a, b) => a.ms - b.ms);
  for (let i = 1; i < dated.length; i++) {
    const previous = dated[i - 1] as { ms: number };
    const current = dated[i] as { ms: number };
    if (current.ms - previous.ms !== DAY_MS) return null;
  }
  return { days: dated.map(({ day, clusters }) => ({ day, clusters })), earlier };
}

/** Clusters drawn: the sum of the days (the earlier ones are not in it). */
export function hubTrendSum(days: readonly HubTrendDay[]): number {
  let sum = 0;
  for (const d of days) sum += d.clusters;
  return sum;
}

/** "sparse" below ENTITY_HUB_MIN_INDEXABLE clusters in the window (too few for a daily chart), else "chart". */
export function hubTrendState(days: readonly HubTrendDay[]): "sparse" | "chart" {
  return hubTrendSum(days) < ENTITY_HUB_MIN_INDEXABLE ? "sparse" : "chart";
}

export interface HubTrendTableRow {
  day: string;
  /** "12 Kasım", and "12 Kasım (eksik)" on the last row: the running day is still counting. */
  label: string;
  clusters: number;
}

/** The rows of the text alternative to the chart, oldest first; only the last one carries " (eksik)". */
export function hubTrendTableRows(days: readonly HubTrendDay[]): HubTrendTableRow[] {
  return days.map((d, i) => ({
    day: d.day,
    label: i === days.length - 1 ? `${dayLabelTr(d.day)} (eksik)` : dayLabelTr(d.day),
    clusters: d.clusters,
  }));
}

export const HUB_TREND_HEADING = "Günlere göre küme sayısı";

export const HUB_TREND_CAPTION =
  "Her sütun, bu gündem başlığıyla eşleşen ve ilk haberi o gün çıkan küme sayısıdır (haber sayısı değil). Günler Türkiye saatine göre.";

/** The same wording as the /trends table toggle. */
export const HUB_TREND_TABLE_TOGGLE = "Günlük sayıları tablo olarak göster";

export function hubTrendTotalLine(sum: number): string {
  return `Grafikte ${formatCountTr(sum)} küme, son ${HUB_TREND_DAYS} gün (son gün dahil, eksik).`;
}

/** The clusters the hub counts but the chart cannot draw; null when there are none. It never prints a subtraction. */
export function hubTrendEarlierNote(earlier: number): string | null {
  return earlier > 0
    ? `İlk haberi ${HUB_TREND_DAYS} günden önce çıkan ${formatCountTr(earlier)} küme yukarıdaki sayıya dahil, grafikte yok.`
    : null;
}

/**
 * The earlier note of the sparse state, where no chart is drawn: it must not name a chart ("grafikte yok") or point at "the
 * number above" (the sparse line directly above it says another number). It names the page total instead; null when there
 * are none.
 */
export function hubTrendSparseEarlierNote(earlier: number): string | null {
  return earlier > 0
    ? `İlk haberi ${HUB_TREND_DAYS} günden önce çıkan ${formatCountTr(earlier)} küme bu sayıya girmedi; sayfanın üstündeki toplama dahil.`
    : null;
}

export function hubTrendSparseLine(sum: number, earlier: number): string {
  if (sum === 0 && earlier > 0) {
    return `Bu başlıktaki ${formatCountTr(earlier)} kümenin ilk haberi ${HUB_TREND_DAYS} günden önce çıktı; günlük grafik çizilmedi.`;
  }
  if (sum === 0) return `Son ${HUB_TREND_DAYS} günde ilk haberi çıkan küme yok.`;
  return `Son ${HUB_TREND_DAYS} günde ilk haberi çıkan ${formatCountTr(sum)} küme var; günlük grafik için çok az.`;
}

export function hubTrendAriaLabel(label: string, sum: number): string {
  return `${label}: son ${HUB_TREND_DAYS} günde ilk haberin gününe göre küme sayısı, günlük sütun grafiği. Grafikte ${formatCountTr(sum)} küme. Son günün sayımı eksik.`;
}

export function hubTrendTableCaption(label: string): string {
  return `${label}: son ${HUB_TREND_DAYS} günde ilk haberin gününe göre günlük küme sayısı (günler Türkiye saatine göre)`;
}
