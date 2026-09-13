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
  // regularMarketChangePercent is already in percent units (0.334 = +0.33%).
  // Fall back to the last two closes when Yahoo omits it.
  let changePct = typeof meta.regularMarketChangePercent === "number" ? meta.regularMarketChangePercent : NaN;
  let prevClose = Number.isFinite(changePct) ? price / (1 + changePct / 100) : NaN;
  if (!Number.isFinite(changePct) && closes.length >= 2) {
    prevClose = closes[closes.length - 2]!;
    changePct = ((price - prevClose) / prevClose) * 100;
  }
  if (!Number.isFinite(changePct)) {
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

const YAHOO_CONCURRENCY = 8;
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
          headers: { "User-Agent": "Mozilla/5.0 (tayf.news finance)" },
          signal: AbortSignal.timeout(YAHOO_TIMEOUT_MS),
        },
      );
      if (!res.ok) return null;
      return parseYahooChart(ticker, await res.json());
    } catch {
      // One dead symbol must not blank the page; the chip just shows no price.
      return null;
    }
  }
}

export function defaultQuoteSource(): QuoteSource {
  return new YahooQuoteSource();
}

const MAX_TICKERS = 40;

/** Quotes keyed by ticker. Cached 5 min per distinct ticker set. */
export async function getQuotes(tickers: readonly string[]): Promise<Record<string, Quote>> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 300, expire: 900 });
  const unique = [...new Set(tickers)].sort().slice(0, MAX_TICKERS);
  if (unique.length === 0) return {};
  const quotes = await defaultQuoteSource().getQuotes(unique);
  return Object.fromEntries(quotes.map((q) => [q.ticker, q]));
}
