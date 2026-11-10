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
 * h48-ekonomi-3: how many of today's circuit-breaker notices /ekonomi reads, in
 * ONE request: PostgREST's response cap (`max_rows`, 1,000 on Supabase), because
 * a bigger `.limit()` would silently come back at 1,000 anyway. The largest day
 * seen is 475 notices (23 Oct), so a day normally fits whole; a read that returns
 * exactly this many may be cut, and the strip then says so. Lives here, in a
 * module with no server imports, because the strip component needs the number too.
 */
export const CIRCUIT_BREAKER_DAY_LIMIT = 1000;

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

/** The subject of the notices KAP TEST A.Ş. (KTEST) files to exercise KAP itself. */
export const TEST_NOTICE_TEXT = "Test Bildirimi";

/**
 * h108-kapdisclosures-4: KAP's own "Test Bildirimi" rows (3-4 a month, the latest on a Saturday)
 * are real disclosures, and with the breaker clause the only feed exclusion one stayed among the
 * newest 40 until 40 later notices arrived, up to about 61 h over a weekend. `neq` is NULL for a
 * NULL subject, so NULLs are kept explicitly, as in NOT_CIRCUIT_BREAKER_OR. The value has a space,
 * so it is double-quoted inside the or() list (PostgREST reads a quoted value whole).
 *
 * Never a second `.or()` call: a kap_disclosures query chain has at most one (the guard in
 * tests/guards/kap-related-stocks.test.ts), so this joins the one string through
 * tickerDisclosureOr and FEED_DISCLOSURE_OR.
 */
export const NOT_TEST_NOTICE_OR = `subject.is.null,subject.neq."${TEST_NOTICE_TEXT}"`;

/**
 * The `.or()` argument for the all-ticker feed (/ekonomi's KAP panel): not a circuit-breaker
 * notice AND not a test notice, as one logic tree.
 */
export const FEED_DISCLOSURE_OR = `and(or(${NOT_CIRCUIT_BREAKER_OR}),or(${NOT_TEST_NOTICE_OR}))`;

/**
 * The `.or()` argument for "this ticker's disclosures, circuit-breaker and test notices
 * excluded": (stock_codes has T OR related_stocks has T) AND (not a breaker) AND (not a test
 * notice). Throws on anything that is not an upper-case 2-6 character code.
 */
export function tickerDisclosureOr(ticker: string): string {
  if (typeof ticker !== "string" || !TICKER_SHAPE.test(ticker)) {
    throw new Error(`[finance] tickerDisclosureOr: invalid ticker ${JSON.stringify(ticker)}`);
  }
  return `and(or(stock_codes.cs.{${ticker}},related_stocks.cs.{${ticker}}),or(${NOT_CIRCUIT_BREAKER_OR}),or(${NOT_TEST_NOTICE_OR}))`;
}
