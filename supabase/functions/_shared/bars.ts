// supabase/functions/_shared/bars.ts
//
// Pure helpers for quotes-ingest: turn a Yahoo chart payload into bar rows.
// No Deno globals so vitest can import it (tests/functions/quotes-ingest.test.ts).

export interface DailyBar {
  ticker: string;
  day: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}

export interface IntradayBar {
  ticker: string;
  ts: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}

interface YahooChart {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }> | null;
  };
}

export function yahooChartUrl(ticker: string, range: string, interval: string): string {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}.IS?range=${range}&interval=${interval}`;
}

const num = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Istanbul calendar date of a unix-seconds timestamp. */
export function istDay(unixSeconds: number): string {
  return new Date((unixSeconds + 3 * 3600) * 1000).toISOString().slice(0, 10);
}

export function parseDailyBars(ticker: string, json: unknown): DailyBar[] {
  const r = (json as YahooChart)?.chart?.result?.[0];
  const t = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0];
  if (!q) return [];
  const out: DailyBar[] = [];
  for (let i = 0; i < t.length; i++) {
    const close = num(q.close?.[i]);
    if (close === null) continue;
    out.push({
      ticker,
      day: istDay(t[i]!),
      open: num(q.open?.[i]),
      high: num(q.high?.[i]),
      low: num(q.low?.[i]),
      close,
      volume: num(q.volume?.[i]),
    });
  }
  // Yahoo occasionally repeats a day (a live bar plus the settled one);
  // keep the last occurrence.
  const byDay = new Map(out.map((b) => [b.day, b]));
  return [...byDay.values()];
}

/**
 * Yahoo's flat volume-0 placeholder: a day the share did not trade, carried as one price for open, high, low and close
 * (DUNYH 2026-10-28 .. 11-11: 109,10 four times, volume 0). A traded bar never has volume 0, and a zero-volume bar with
 * a range (SASA: 4 of them in 20 sessions) or a flat bar with volume (a limit-locked day) is not this. A missing
 * (null) price never equals the close, so a bar with a missing price is not a placeholder either.
 */
function isPlaceholderBar(b: DailyBar): boolean {
  return b.volume === 0 && b.open === b.high && b.high === b.low && b.low === b.close;
}

/**
 * The daily bars quotes-ingest writes for a ticker whose newest stored bar is `lastDay`: the watermark rule (DB-03)
 * keyed on the calendar day. Rows after `lastDay` are new and kept. The `lastDay` row itself is kept too, because the
 * ticker is read again once the closing auction has settled (h11-finance-2), unless it is a placeholder: a flat
 * volume-0 close must not replace the bar that is already stored (h176-ekonomi-2: the 2026-11-09 pass overwrote DUNYH's
 * traded 11-06 bar, close 11.92, with the 109,10 placeholder). Rows before `lastDay` are dropped. With no `lastDay` (a
 * ticker that was never fetched) every row is kept, as the full 1y/1mo warmup. Pure; the input is not changed.
 */
export function freshDailyBars<T extends DailyBar>(rows: readonly T[], lastDay: string | null | undefined): T[] {
  if (!lastDay) return [...rows];
  return rows.filter((r) => r.day > lastDay || (r.day === lastDay && !isPlaceholderBar(r)));
}

/**
 * 5-minute bars. Yahoo's last bar carries the wall-clock time of the last
 * trade, not the bar start, so timestamps are floored to the 5-min grid; a
 * re-fetch then upserts the settled bar over the partial one.
 */
export function parseIntradayBars(ticker: string, json: unknown): IntradayBar[] {
  const r = (json as YahooChart)?.chart?.result?.[0];
  const t = r?.timestamp ?? [];
  const q = r?.indicators?.quote?.[0];
  if (!q) return [];
  const byTs = new Map<string, IntradayBar>();
  for (let i = 0; i < t.length; i++) {
    const close = num(q.close?.[i]);
    if (close === null) continue;
    const floored = Math.floor(t[i]! / 300) * 300;
    const ts = new Date(floored * 1000).toISOString();
    byTs.set(ts, {
      ticker,
      ts,
      open: num(q.open?.[i]),
      high: num(q.high?.[i]),
      low: num(q.low?.[i]),
      close,
      volume: num(q.volume?.[i]),
    });
  }
  return [...byTs.values()];
}
