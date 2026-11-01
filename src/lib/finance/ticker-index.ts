// Which /ekonomi/<ticker> pages are worth a search index entry.
//
// h11-finance-4: every well-formed code that has a company row, an article or
// a disclosure renders a full page, and all of them were indexable:
// /ekonomi/KTEST ("KAP TEST A.Ş."), /ekonomi/TGB (an alias of GARAN with no
// bars) and /ekonomi/KOZAL (no company row) answered 200 with
// `index, follow`. A page for a code that does not trade is thin content with a
// stale or missing price. Those pages stay reachable (a reader following a
// headline's chip still lands somewhere) but ask not to be indexed.

/**
 * Codes with a company row that says it trades but are not equities. Checked
 * against production on 2026-11-01: KTEST ("KAP TEST A.Ş.", kap_state A,
 * shares_traded true) is the only shares_traded company with no row in
 * bist_bars_daily at all (1 of 626). Extend only from that kind of evidence.
 */
export const NON_EQUITY_TICKERS: ReadonlySet<string> = new Set(["KTEST"]);

/**
 * True for a ticker page that should carry `robots: noindex`:
 *   - no company row (a code only an article or a disclosure mentions: KOZAL),
 *   - a company that does not trade (shares_traded = false: BOYNR, KILER),
 *   - a code shorter than 4 characters (TGB, DNZ: aliases and old codes), or
 *   - a known non-equity code (KTEST).
 */
export function isThinTicker(ticker: string, company: { sharesTraded: boolean } | null | undefined): boolean {
  if (!company || !company.sharesTraded) return true;
  if (ticker.length < 4) return true;
  return NON_EQUITY_TICKERS.has(ticker);
}
