// The one PostgREST filter every per-ticker reader of `kap_disclosures` uses.
//
// h11-finance-1: KAP tags a notice for a ticker in one of two columns.
// `stock_codes` is the issuer(s) the notice is about; `related_stocks` is
// written by supabase/functions/_shared/kap.ts for the notices that name a
// share without being filed by it -- Borsa Istanbul's "Pay Islem Sirasi
// Kapatma / Acma" halts, SPK trading bans, "Pay Alim Satim Bildirimi" insider
// trades. 556 of 8,098 disclosures in 30 days (6.9 %) carry ONLY
// related_stocks, so a reader that filters `stock_codes` alone never shows
// them: /ekonomi/TRHOL showed a stale price and no word about the halt.
//
// The filter is ONE `.or()` string. PostgREST accepts a nested logic tree
// (`and(or(..),or(..))`), but a second chained `.or()` call would not be
// reliable across supabase-js versions, so callers pass this string to a
// single `.or()` and never chain another (tests/guards/kap-related-stocks.test.ts).
//
// Both columns need a GIN index for the OR to be a BitmapOr: stock_codes since
// 049, related_stocks since migration 133 (kap_disclosures_related_stocks_idx).
// Apply 133 BEFORE merging a release that uses this filter.
//
// The ticker is interpolated into the filter, so it is validated against the
// ticker shape first: a comma, a parenthesis or a brace in it would otherwise
// add a clause of the caller's choosing.

/** BIST codes the finance pages accept (the same shape /ekonomi/[ticker] gates on). */
const TICKER_SHAPE = /^[A-Z0-9]{2,6}$/;

export const CIRCUIT_BREAKER_TEXT = "Devre Kesici";

/**
 * TS-06: `.not('subject','ilike',CIRCUIT_BREAKER)` compiles to
 * `subject NOT ILIKE ...`, which is NULL (not TRUE) for a NULL subject --
 * PostgREST drops those rows even though they plainly aren't circuit breaker
 * notices. subject is nullable; explicitly keep NULLs. Note the `.or()` filter
 * DSL uses `*` for a wildcard, not the `%` the `.ilike()` builder method takes.
 * Shared by every reader that lists a ticker's disclosures so the page, the
 * feed, the coverage stats and the pickup panel all mean the same set.
 */
export const NOT_CIRCUIT_BREAKER_OR = `subject.is.null,subject.not.ilike.*${CIRCUIT_BREAKER_TEXT}*`;

/**
 * The `.or()` argument for "this ticker's disclosures, circuit-breaker notices
 * excluded": (stock_codes has T OR related_stocks has T) AND (not a breaker).
 * Throws on anything that is not an upper-case 2-6 character code.
 */
export function tickerDisclosureOr(ticker: string): string {
  if (typeof ticker !== "string" || !TICKER_SHAPE.test(ticker)) {
    throw new Error(`[finance] tickerDisclosureOr: invalid ticker ${JSON.stringify(ticker)}`);
  }
  return `and(or(stock_codes.cs.{${ticker}},related_stocks.cs.{${ticker}}),or(${NOT_CIRCUIT_BREAKER_OR}))`;
}
