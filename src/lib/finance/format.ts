// Number and time formatting for the Ekonomi pages. Turkish locale for
// numbers; the clock is Istanbul, which is a fixed UTC+3 (no DST since
// 2016), so dates are shifted by hand instead of going through Intl, whose
// tr-TR day/month pattern without a year comes out as "12/09".

const PRICE = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PCT = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "always" });
const X = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const IST_OFFSET_MS = 3 * 3600 * 1000;

function ist(iso: string | number): Date {
  return new Date(new Date(iso).getTime() + IST_OFFSET_MS);
}

const two = (n: number) => String(n).padStart(2, "0");

export function fmtPrice(n: number): string {
  return PRICE.format(n);
}

export function fmtPct(n: number): string {
  return `${PCT.format(n)}%`;
}

/** Ratio like relative volume: 2.4 -> "2,4x". */
export function fmtX(n: number): string {
  return `${X.format(n)}x`;
}

/** Istanbul calendar day as YYYY-MM-DD. */
export function istToday(now = Date.now()): string {
  return ist(now).toISOString().slice(0, 10);
}

export function fmtClock(iso: string): string {
  const d = ist(iso);
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

export function fmtDayClock(iso: string): string {
  const d = ist(iso);
  return `${two(d.getUTCDate())}.${two(d.getUTCMonth() + 1)} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/** Time shown as HH:mm when today (Istanbul), otherwise dd.MM HH:mm. */
export function fmtWhen(iso: string, now = Date.now()): string {
  return istToday(now) === ist(iso).toISOString().slice(0, 10) ? fmtClock(iso) : fmtDayClock(iso);
}

/** Tailwind text class for a signed change. */
export function moveClass(pct: number): string {
  if (pct > 0.005) return "text-emerald-400";
  if (pct < -0.005) return "text-red-400";
  return "text-muted-foreground";
}

/** Percent change from `from` to `to`, or null when either side is missing. */
export function pctChange(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from == null || to == null || !(from > 0)) return null;
  return ((to - from) / from) * 100;
}

// BIST equity price limits are +-10% of the reference price; anything past
// 9.5% is, for a reader, at the limit.
export function limitFlag(pct: number): "tavan" | "taban" | null {
  if (pct >= 9.5) return "tavan";
  if (pct <= -9.5) return "taban";
  return null;
}
