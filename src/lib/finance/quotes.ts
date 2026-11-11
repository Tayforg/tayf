import { cacheLife } from "next/cache";

import { attemptCached } from "@/lib/cache-resilience";

// Quote boundary for the Ekonomi pages. Business code only sees
// `QuoteSource`; the Yahoo implementation is constructed in
// `defaultQuoteSource()` so a test can hand in a fake fetch without touching
// the network.
//
// Yahoo's chart endpoint is unauthenticated and covers BIST as `<CODE>.IS`.
// It is a convenience, not a contract: when it breaks, implement
// `QuoteSource` (both `getQuotes` and `lookup`) over a paid feed and swap it in
// `defaultQuoteSource()`; `getQuote`, the cache boundary, reaches its source
// only through that function.

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
  /**
   * The Istanbul day (YYYY-MM-DD) of each element of `closes`: same length, same order. Absent when the timestamps
   * could not be aligned with the closes. Optional because getQuote is cached remotely (expire 900 s) and an
   * entry written before this field existed must keep working (h120-finance-1: session.sparklineCloses uses it to
   * put the D-1 settled close back, which Yahoo leaves out of the 5d/1d array during a session).
   */
  closeDays?: string[];
  currency: string;
  asOf: string;
}

/**
 * What one lookup concluded, so the cache boundary can pick a lifetime
 * from the outcome (see `getQuote`):
 *   - `quote`: a parsed quote;
 *   - `unlisted`: the source does not list the symbol (Yahoo answers 404). That
 *     is a stable fact about the ticker, not a blip;
 *   - `unavailable`: anything else that produced no quote (a 5xx or other
 *     non-ok status, a timeout or rejected fetch, a payload that does not
 *     parse). Worth asking again soon.
 */
export type QuoteLookup =
  | { kind: "quote"; quote: Quote }
  | { kind: "unlisted" }
  | { kind: "unavailable" };

export interface QuoteSource {
  getQuotes(tickers: readonly string[]): Promise<Quote[]>;
  /**
   * One ticker's outcome; must never reject. `getQuote` picks the cache
   * lifetime from it, so a replacement feed reports `unlisted` for a symbol it
   * will never carry and `unavailable` for a blip.
   */
  lookup(ticker: string): Promise<QuoteLookup>;
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

/** YYYY-MM-DD of an Istanbul day number (the output of istanbulDay). */
function istanbulDayKey(ms: number): string {
  return new Date(istanbulDay(ms) * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The Istanbul day of each close that parseYahooChart keeps, in the same order, or undefined when the alignment
 * cannot be proven: `timestamps` missing, not an array, not the same length as `rawCloses`, or a kept index whose
 * timestamp is not a finite number. The kept indexes are exactly those of the `closes` filter in parseYahooChart
 * (a finite number); a dropped bar's own timestamp is never read, so it may be null.
 */
function keptCloseDays(
  rawCloses: ReadonlyArray<number | null>,
  timestamps: ReadonlyArray<number | null> | undefined,
): string[] | undefined {
  if (!Array.isArray(timestamps) || timestamps.length !== rawCloses.length) return undefined;
  const days: string[] = [];
  for (let i = 0; i < rawCloses.length; i++) {
    const close = rawCloses[i];
    if (typeof close !== "number" || !Number.isFinite(close)) continue;
    const ts = timestamps[i];
    if (typeof ts !== "number" || !Number.isFinite(ts)) return undefined;
    days.push(istanbulDayKey(ts * 1000));
  }
  return days;
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
  const closeDays = keptCloseDays(rawCloses, r.timestamp);
  return {
    ticker,
    price,
    prevClose,
    changePct,
    hasBaseline,
    closes,
    ...(closeDays ? { closeDays } : {}),
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
        const outcome = await this.lookup(t);
        if (outcome.kind === "quote") out.push(outcome.quote);
      }
    };
    await Promise.all(Array.from({ length: Math.min(YAHOO_CONCURRENCY, queue.length) }, worker));
    return out;
  }

  /** One ticker's outcome; never rejects. See `QuoteLookup`. */
  async lookup(ticker: string): Promise<QuoteLookup> {
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
      if (res.status === 404) {
        // Yahoo does not list this symbol (a delisted or renamed BIST code).
        // Permanent as far as a chip is concerned: info level, not a warning,
        // and getQuote caches it for hours instead of minutes.
        console.info("[quotes] yahoo 404 for " + ticker + " (unlisted, cached 6 h)");
        return { kind: "unlisted" };
      }
      if (!res.ok) {
        // SEC-05: capture the status so a total feed outage (every ticker
        // failing) is visible in logs instead of silently rendering blank
        // chips. One dead symbol must still not blank the page.
        console.warn("[quotes] yahoo " + res.status + " for " + ticker);
        return { kind: "unavailable" };
      }
      const quote = parseYahooChart(ticker, await res.json());
      return quote ? { kind: "quote", quote } : { kind: "unavailable" };
    } catch (err) {
      console.warn(`[quotes] fetch failed for ${ticker}: ${err instanceof Error ? err.name + ": " + err.message : String(err)}`);
      return { kind: "unavailable" };
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
 * The lifetime follows the outcome of the lookup (`QuoteLookup`):
 *   - a real quote keeps the 5-minute window;
 *   - `unlisted` (Yahoo answered 404 for the symbol) is memoised for 6 hours
 *     (stale 1 h, revalidate 6 h, expire 24 h): the symbol is not coming back
 *     within the hour, and re-asking every minute only buried real warnings
 *     and spent outbound calls (h28-errors-3);
 *   - anything else, "no quote" because of a Yahoo 5xx or other non-ok status,
 *     a rejected fetch, a payload that does not parse, or a throw that
 *     attemptCached absorbs, is memoised for `minutes` only, so a blip cannot
 *     blank a ticker's chip for 5-15 minutes.
 * Exactly one `cacheLife` per invocation, after the attempt.
 */
async function getQuote(ticker: string): Promise<Quote | null> {
  "use cache: remote";
  const r = await attemptCached("quote", () => defaultQuoteSource().lookup(ticker));
  const o: QuoteLookup = r.ok ? r.data : { kind: "unavailable" };
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (o.kind === "quote") cacheLife({ stale: 60, revalidate: 300, expire: 900 });
  else if (o.kind === "unlisted") cacheLife({ stale: 3600, revalidate: 21600, expire: 86400 });
  else cacheLife("minutes");
  return o.kind === "quote" ? o.quote : null;
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
  // Each worker's getQuote() call makes a single-ticker lookup() on the
  // default source, so the source's own getQuotes() concurrency limiter never
  // engages and no longer bounds anything against
  // query1.finance.yahoo.com — this call site is the only thing that can. Bound
  // it to the same YAHOO_CONCURRENCY the source declares (was 40, quintupling
  // outbound concurrency to an unauthenticated third party with no
  // retry/backoff on this path).
  await Promise.all(Array.from({ length: Math.min(YAHOO_CONCURRENCY, queue.length) }, worker));
  return out;
}
