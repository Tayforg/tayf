import { cacheLife } from "next/cache";

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
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }> | null;
    error?: unknown;
  };
}

export function parseYahooChart(ticker: string, json: unknown): Quote | null {
  const r = (json as YahooChart)?.chart?.result?.[0];
  const meta = r?.meta;
  if (!meta || typeof meta.regularMarketPrice !== "number") return null;
  const closes = (r.indicators?.quote?.[0]?.close ?? []).filter(
    (c): c is number => typeof c === "number" && Number.isFinite(c),
  );
  const price = meta.regularMarketPrice;

  // Ordered fallback chain for the previous-session baseline (TS-09):
  //   1. chartPreviousClose — the actual prior close the chart itself is
  //      plotted against. Preferred: regularMarketChangePercent is
  //      computed by Yahoo against a live pre/post-market reference that
  //      can diverge from the chart's own baseline.
  //   2. regularMarketChangePercent (already in percent units, e.g.
  //      0.334 = +0.33%), back-solved for prevClose.
  //   3. The last two daily closes.
  let changePct = NaN;
  let prevClose = NaN;
  if (typeof meta.chartPreviousClose === "number" && Number.isFinite(meta.chartPreviousClose) && meta.chartPreviousClose > 0) {
    prevClose = meta.chartPreviousClose;
    changePct = ((price - prevClose) / prevClose) * 100;
  } else if (typeof meta.regularMarketChangePercent === "number" && Number.isFinite(meta.regularMarketChangePercent)) {
    changePct = meta.regularMarketChangePercent;
    prevClose = price / (1 + changePct / 100);
  } else if (closes.length >= 2) {
    prevClose = closes[closes.length - 2]!;
    changePct = ((price - prevClose) / prevClose) * 100;
  }
  // TS-13: changePct === -100 sends the regularMarketChangePercent branch's
  // `price / (1 + changePct / 100)` to Infinity. Treat any non-finite or
  // non-positive prevClose (or non-finite changePct) as "no baseline"
  // rather than let Infinity/NaN leak into the returned Quote.
  if (!Number.isFinite(changePct) || !Number.isFinite(prevClose) || prevClose <= 0) {
    changePct = 0;
    prevClose = price;
  }
  return {
    ticker,
    price,
    prevClose,
    changePct,
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
 * (5 min) under its own Next cache key, so the key never depends on which
 * other tickers happened to be requested alongside it in a given call.
 */
async function getQuote(ticker: string): Promise<Quote | null> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 300, expire: 900 });
  const [quote] = await defaultQuoteSource().getQuotes([ticker]);
  return quote ?? null;
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
