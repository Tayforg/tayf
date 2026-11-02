import { cacheLife } from "next/cache";

import { attemptCached } from "@/lib/cache-resilience";

// Quote boundary for the Ekonomi pages. Business code only sees
// `QuoteSource`; the Yahoo implementation is constructed at the edge in
// `getQuotes()` so a test can hand in a fake without touching the network.
//
// Yahoo's chart endpoint is unauthenticated and covers BIST as `<CODE>.IS`.
// It is a convenience, not a contract: when it breaks, implement
// `QuoteSource` over a paid feed and swap it in `defaultQuoteSource()`.

export interface Quote {
  ticker: string;
  price: number;
  /** Previous session close (the base of changePct). */
  prevClose: number;
  /** Percent change vs previous close, e.g. -1.56 */
  changePct: number;
  /**
   * False when no previous-session baseline could be derived (the TS-13
   * fallback: changePct 0 and prevClose = price are placeholders, not a
   * measured flat day). Readers must treat `hasBaseline === false` as an
   * unknown move and show "—"; a cached entry written before this field
   * existed has it undefined and renders as a known move.
   */
  hasBaseline: boolean;
  /** Daily closes, oldest first, for a sparkline. */
  closes: number[];
  currency: string;
  asOf: string;
}

export interface QuoteSource {
  getQuotes(tickers: readonly string[]): Promise<Quote[]>;
}

interface YahooChart {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number;
        regularMarketChangePercent?: number;
        chartPreviousClose?: number;
        currency?: string;
        regularMarketTime?: number;
      };
      /** Epoch seconds, index-aligned with `indicators.quote[0].close`. */
      timestamp?: Array<number | null>;
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }> | null;
    error?: unknown;
  };
}

const DAY_MS = 86_400_000;

/**
 * Istanbul calendar day number for an epoch-millisecond instant. Istanbul has
 * been fixed at UTC+3 (no DST) since 2016, so a constant offset is exact.
 * Local on purpose: session.ts keeps its own `istDay` private.
 */
function istanbulDay(ms: number): number {
  return Math.floor((ms + 3 * 3_600_000) / DAY_MS);
}

/**
 * Close of the latest bar that belongs to an Istanbul day earlier than the
 * quote's own session day (`regularMarketTime`), or null when that cannot be
 * derived. `rawCloses` must be the unfiltered array: the timestamp array is
 * index-aligned with it, and dropping the null bars first would shift every
 * index. Requires `timestamps` to be an array of the same length.
 */
function previousSessionClose(
  rawCloses: ReadonlyArray<number | null>,
  timestamps: ReadonlyArray<number | null> | undefined,
  regularMarketTime: number | undefined,
): number | null {
  if (!Array.isArray(timestamps) || timestamps.length !== rawCloses.length) return null;
  if (typeof regularMarketTime !== "number" || !Number.isFinite(regularMarketTime)) return null;
  const sessionDay = istanbulDay(regularMarketTime * 1000);
  for (let i = rawCloses.length - 1; i >= 0; i--) {
    const close = rawCloses[i];
    const ts = timestamps[i];
    if (typeof close !== "number" || !Number.isFinite(close) || close <= 0) continue;
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    if (istanbulDay(ts * 1000) < sessionDay) return close;
  }
  return null;
}

export function parseYahooChart(ticker: string, json: unknown): Quote | null {
  const r = (json as YahooChart)?.chart?.result?.[0];
  const meta = r?.meta;
  if (!meta || typeof meta.regularMarketPrice !== "number") return null;
  const rawCloses = r.indicators?.quote?.[0]?.close ?? [];
  const closes = rawCloses.filter(
    (c): c is number => typeof c === "number" && Number.isFinite(c),
  );
  const price = meta.regularMarketPrice;

  // Ordered fallback chain for the previous-session baseline (TS-09, h20):
  //   1. The last close of an Istanbul day earlier than the quote's own
  //      session day (regularMarketTime), read off the timestamp array. This
  //      wins over Yahoo's percent because before the first trade of the day
  //      Yahoo reports regularMarketChangePercent = 0.0 as a placeholder:
  //      trusting it showed a fake '%0,00' on every chip and hid Friday's real
  //      move (and the tavan/taban tag, since prevClose collapsed to price).
  //      Once today's bar has traded the previous-day close is the same base
  //      Yahoo's own percent uses, so the open-session number is unchanged.
  //      Unavailable when the timestamp array is missing or misaligned,
  //      regularMarketTime is missing, or no earlier-day close exists.
  //   2. regularMarketChangePercent (already in percent units, e.g.
  //      0.334 = +0.33%), back-solved for prevClose. This is Yahoo's own live
  //      reference against the actual previous session.
  //   3. The last two daily closes. NOTE: chartPreviousClose on a
  //      range=5d request is the close from *before the whole 5-day
  //      window*, not yesterday's close — using it here would badly
  //      misstate "bugün" for names that have moved over the window. This
  //      fallback can also show yesterday's move (close[-2] to close[-1])
  //      before today's bar exists, e.g. pre-market with no trades yet.
  //   4. chartPreviousClose, but only for a genuine 1-day chart (at most
  //      one close), where it *is* the prior session's close.
  let changePct = NaN;
  let prevClose = NaN;
  let hasBaseline = true;
  const sessionBaseline = previousSessionClose(rawCloses, r.timestamp, meta.regularMarketTime);
  if (sessionBaseline !== null) {
    prevClose = sessionBaseline;
    changePct = ((price - prevClose) / prevClose) * 100;
  } else if (typeof meta.regularMarketChangePercent === "number" && Number.isFinite(meta.regularMarketChangePercent)) {
    changePct = meta.regularMarketChangePercent;
    prevClose = price / (1 + changePct / 100);
  } else if (closes.length >= 2) {
    prevClose = closes[closes.length - 2]!;
    changePct = ((price - prevClose) / prevClose) * 100;
  } else if (typeof meta.chartPreviousClose === "number" && Number.isFinite(meta.chartPreviousClose) && meta.chartPreviousClose > 0 && closes.length <= 1) {
    prevClose = meta.chartPreviousClose;
    changePct = ((price - prevClose) / prevClose) * 100;
  }
  // TS-13: changePct === -100 sends the regularMarketChangePercent branch's
  // `price / (1 + changePct / 100)` to Infinity. Treat any non-finite or
  // non-positive prevClose (or non-finite changePct) as "no baseline"
  // rather than let Infinity/NaN leak into the returned Quote.
  if (!Number.isFinite(changePct) || !Number.isFinite(prevClose) || prevClose <= 0) {
    changePct = 0;
    prevClose = price;
    hasBaseline = false;
  }
  return {
    ticker,
    price,
    prevClose,
    changePct,
    hasBaseline,
    closes,
    currency: meta.currency ?? "TRY",
    asOf: new Date((meta.regularMarketTime ?? Date.now() / 1000) * 1000).toISOString(),
  };
}

export const YAHOO_CONCURRENCY = 8;
const YAHOO_TIMEOUT_MS = 6000;

export class YahooQuoteSource implements QuoteSource {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async getQuotes(tickers: readonly string[]): Promise<Quote[]> {
    const out: Quote[] = [];
    const queue = [...tickers];
    const worker = async () => {
      for (let t = queue.shift(); t !== undefined; t = queue.shift()) {
        const q = await this.one(t);
        if (q) out.push(q);
      }
    };
    await Promise.all(Array.from({ length: Math.min(YAHOO_CONCURRENCY, queue.length) }, worker));
    return out;
  }

  private async one(ticker: string): Promise<Quote | null> {
    try {
      const res = await this.fetchImpl(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}.IS?range=5d&interval=1d`,
        {
          // SEC-06/TS-03: reuse the identity the repo already publishes and
          // that already resolves (_shared/og-image.ts:62,
          // _shared/rss/fetcher.ts:161,174 — tayf.app is a live site)
          // instead of a fabricated Mozilla/5.0 prefix with no product
          // token or contact URL.
          headers: { "User-Agent": "Mozilla/5.0 (compatible; Tayf/1.0; +https://tayf.app) finance-app" },
          signal: AbortSignal.timeout(YAHOO_TIMEOUT_MS),
        },
      );
      if (!res.ok) {
        // SEC-05: capture the status so a total feed outage (every ticker
        // failing) is visible in logs instead of silently rendering blank
        // chips. One dead symbol must still not blank the page.
        console.warn("[quotes] yahoo " + res.status + " for " + ticker);
        return null;
      }
      return parseYahooChart(ticker, await res.json());
    } catch (err) {
      console.warn(`[quotes] fetch failed for ${ticker}: ${err instanceof Error ? err.name + ": " + err.message : String(err)}`);
      return null;
    }
  }
}

export function defaultQuoteSource(): QuoteSource {
  return new YahooQuoteSource();
}

/**
 * Single-ticker cache boundary. Each ticker's quote is cached independently
 * under its own Next cache key, so the key never depends on which other
 * tickers happened to be requested alongside it in a given call.
 *
 * The lifetime follows the outcome: a real quote keeps the 5-minute window,
 * while "no quote" -- a Yahoo non-200, a rejected fetch, an unknown symbol
 * (YahooQuoteSource turns every one of them into an empty list) or a throw
 * that attemptCached absorbs -- is memoised for `minutes` only, so a blip
 * cannot blank a ticker's chip for 5-15 minutes. Exactly one `cacheLife` per
 * invocation, after the attempt.
 */
async function getQuote(ticker: string): Promise<Quote | null> {
  "use cache: remote";
  const r = await attemptCached("quote", () => defaultQuoteSource().getQuotes([ticker]));
  const quote = r.ok ? (r.data[0] ?? null) : null;
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (quote) cacheLife({ stale: 60, revalidate: 300, expire: 900 });
  else cacheLife("minutes");
  return quote;
}

/** Quotes keyed by ticker, fanned out over the per-ticker cache boundary above. */
export async function getQuotes(tickers: readonly string[]): Promise<Record<string, Quote>> {
  const unique = [...new Set(tickers)].sort();
  if (unique.length === 0) return {};
  const out: Record<string, Quote> = {};
  const queue = [...unique];
  const worker = async () => {
    for (let t = queue.shift(); t !== undefined; t = queue.shift()) {
      const q = await getQuote(t);
      if (q) out[t] = q;
    }
  };
  // Each worker's getQuote() call fans out to YahooQuoteSource.getQuotes()
  // with a single ticker, so that source's own concurrency limiter
  // collapses to min(YAHOO_CONCURRENCY, 1) = 1 and no longer bounds
  // anything against query1.finance.yahoo.com — this call site is the only
  // thing that can. Bound it to the same YAHOO_CONCURRENCY the source
  // declares (was 40, quintupling outbound concurrency to an
  // unauthenticated third party with no retry/backoff on this path).
  await Promise.all(Array.from({ length: Math.min(YAHOO_CONCURRENCY, queue.length) }, worker));
  return out;
}
