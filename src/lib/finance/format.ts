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

/**
 * Label for the disclosure window of a per-ticker panel. The list is cut at
 * `cap` rows, so "son 30 gün" is only true while the list is NOT full. At the
 * cap the panel names the cap and, when the 30-day total is known and larger,
 * the total: `son 60 bildirim (30 günde 102)`. A null total (the count could
 * not be read) keeps the honest cap-only wording.
 */
export function disclosureWindowLabel(shown: number, total30d: number | null | undefined, cap: number): string {
  if (shown < cap) return "son 30 gün";
  if (total30d != null && total30d > shown) return `son ${shown} bildirim (30 günde ${total30d})`;
  return `son ${shown} bildirim`;
}

/**
 * The scope line of the "KAP ile basın arası" section. The coverage view only
 * knows a ticker's OWN filings (stock_codes), so notices that merely name the
 * share (trading halts, SPK bans, insider-trade notices, another company's
 * filing) are listed on the page but not counted. `listed` is the number of
 * disclosures the page lists, `counted` the number the section counts; the
 * difference is named when it is positive.
 */
export function coverageScopeNote(listed: number, counted: number): string {
  const left = listed - counted;
  const base = "Bu bölüm yalnızca şirketin kendi bildirimleri üzerinden hesaplanır.";
  if (!(left > 0)) return base;
  return `${base} Hisseyi yalnızca anan ${left} bildirim (işlem sırası kapatma ve açma, işlem yasağı, pay alım satım bildirimi gibi) sayılmaz.`;
}

/** "13 haber", or "son 60 haber" when the article list was cut at its cap. */
export function articleCountLabel(shown: number, truncated: boolean): string {
  return truncated ? `son ${shown} haber` : `${shown} haber`;
}

// Borsa Istanbul pay piyasasi fiyat adimi (equity price tick) table, in kurus
// (1/100 TL) so every comparison is integer arithmetic. The band a price
// falls in sets the tick; the lower bound of each band is a multiple of the
// tick above it, so a price stepped to the lower band's tick at a boundary is
// also valid in the upper band.
//
//   0,01 - 19,99    tick 0,01
//   20,00 - 49,98   tick 0,02
//   50,00 - 99,95   tick 0,05
//   100,00 - 249,90 tick 0,10
//   250,00 - 499,75 tick 0,25
//   500,00 - 999,50 tick 0,50
//   1.000 - 2.499   tick 1,00
//   2.500 and up    tick 2,50
//
// Source: Borsa Istanbul, Pay Piyasasi fiyat adimlari tablosu. Checked against
// production on 2026-11-01: all 2,512 bist_bars_daily closes of the last six
// sessions sit on this grid, band by band (1,565 / 402 / 228 / 199 / 55 / 16 /
// 23 / 24 closes, none off-grid).
const TICK_BANDS_KURUS: ReadonlyArray<{ from: number; tick: number }> = [
  { from: 250_000, tick: 250 },
  { from: 100_000, tick: 100 },
  { from: 50_000, tick: 50 },
  { from: 25_000, tick: 25 },
  { from: 10_000, tick: 10 },
  { from: 5_000, tick: 5 },
  { from: 2_000, tick: 2 },
  { from: 0, tick: 1 },
];

/** The tick, in kurus, of the band a price (in kurus, may be fractional) falls in. */
export function priceTickKurus(kurus: number): number {
  for (const band of TICK_BANDS_KURUS) {
    if (kurus >= band.from) return band.tick;
  }
  return 1;
}

/**
 * BIST equity price limits are +-10 % of the base price (the previous close),
 * but a price only exists on the tick grid: tavan is the highest valid price
 * not above base x 1.10, taban the lowest valid price not below base x 0.90,
 * each stepped on the tick of the band the limit falls in. With 0,66 as the
 * base, 0,66 x 0,9 = 0,594 and the first valid price is 0,60, a -9,09 % move
 * that is taban; a fixed 9,5 % threshold never flags it. Likewise 6,98 -> 6,30
 * (-9,74 %) is NOT taban, because 6,29 is valid.
 *
 * Given a finite `prevClose` > 0 and a finite `price` the answer is the
 * tick-aware one (and `pct` is ignored). Without them it falls back to the old
 * rule: anything past +-9,5 % is, for a reader, at the limit.
 */
export function limitFlag(pct: number, prevClose?: number | null, price?: number | null): "tavan" | "taban" | null {
  if (prevClose != null && price != null && Number.isFinite(prevClose) && prevClose > 0 && Number.isFinite(price)) {
    const baseKurus = Math.round(prevClose * 100);
    if (baseKurus > 0) {
      // Integer kurus: baseKurus x 110 / 100 is exact up to the one division.
      const upRaw = (baseKurus * 110) / 100;
      const downRaw = (baseKurus * 90) / 100;
      const upTick = priceTickKurus(upRaw);
      const downTick = priceTickKurus(downRaw);
      const tavan = (Math.floor(upRaw / upTick) * upTick) / 100;
      const taban = (Math.ceil(downRaw / downTick) * downTick) / 100;
      if (price >= tavan - 1e-6) return "tavan";
      if (price <= taban + 1e-6) return "taban";
      return null;
    }
  }
  if (pct >= 9.5) return "tavan";
  if (pct <= -9.5) return "taban";
  return null;
}
