import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * h108-kapdisclosures-2 / h128-apiv1-2: which sibling share code carries the press for a code that has
 * none of its own. ONE definition for both surfaces that print the "Basın bu şirketi ISCTR koduyla
 * anıyor" note: the /ekonomi/[ticker] page (queries.ts's fetchTickerPage) and the keyed
 * GET /api/v1/kap/pickup (fetchPressCodeForWindow below). No server-only import: a plain function of
 * a Supabase client, so a route handler and a "use cache" reader can both call it.
 */

/**
 * bist_companies holds one row per company with every code it trades under, KAP fans a filing out to
 * every code, and the resolver matches press to ONE of them (ISCTR). So ISATR, ISBTR, TIB, ISKUR, TGB,
 * THL, YKB and IYM read "haberi çıkan 0 (%0)" for filings their main code shows at 100 %. When `ticker`
 * has no mention of its own in the window (`ownMentions`, raw rows) and a sibling code of the same
 * company has some, this returns the sibling with the most (ties: alphabetical), counted with one
 * head:true read per sibling over the SAME window as the attention read (`published_at >= sinceIso`).
 * Otherwise null, with no read at all.
 *
 * Fails OPEN to null (warn), like totalDisclosures30d: a missing note is far smaller than a page that
 * errors. One failed sibling read voids the answer, because the sibling that failed may be the one with
 * most press. Never rejects.
 *
 * `warnLabel` is the start of the warning line (`[finance] <warnLabel> unavailable: ...`); the default
 * is the page's own label, so the /ekonomi log line is unchanged.
 */
export async function readPressCode(
  supabase: SupabaseClient,
  ticker: string,
  companyTickers: readonly string[],
  ownMentions: number,
  sinceIso: string,
  warnLabel: string = `fetchTickerPage press code ${ticker}`,
): Promise<string | null> {
  if (ownMentions > 0) return null;
  const siblings = [...new Set(companyTickers)].filter((code) => code !== ticker).sort();
  if (siblings.length === 0) return null;
  try {
    const counts = await Promise.all(
      siblings.map(async (code) => {
        const { count, error } = await supabase
          .from("article_tickers")
          .select("article_id", { count: "exact", head: true })
          .eq("ticker", code)
          .gte("published_at", sinceIso);
        if (error) throw new Error(error.message);
        if (typeof count !== "number") throw new Error(`no count for ${code}`);
        return { code, count };
      }),
    );
    // `siblings` is sorted, so a strict > keeps the alphabetically first of equal counts.
    let best: { code: string; count: number } | null = null;
    for (const c of counts) if (c.count > 0 && (best === null || c.count > best.count)) best = c;
    return best === null ? null : best.code;
  } catch (err) {
    console.warn(`[finance] ${warnLabel} unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** The warning line of the keyed route: no request input in it, only the error text. */
const WINDOW_WARN_LABEL = "v1 kap/pickup press code";

/**
 * The keyed route's way in (it has no `fetchTickerPage` read to take the company row and the
 * own-mention count from): reads the company row of `ticker`, then, only when the company trades under
 * another code, ONE head:true count of the ticker's own article_tickers over `[sinceIso, nowIso]`, and
 * hands both to `readPressCode`. Same answer as the page for the same window.
 *
 * Fails OPEN to null on any error or throw, with a warning; never rejects. A company with no other
 * code costs one read (the company row) and a ticker with mentions of its own costs two.
 */
export async function fetchPressCodeForWindow(
  supabase: SupabaseClient,
  ticker: string,
  sinceIso: string,
  nowIso: string,
): Promise<string | null> {
  try {
    const company = await supabase
      .from("bist_companies")
      .select("tickers")
      .contains("tickers", [ticker])
      .limit(1);
    if (company.error) throw new Error(company.error.message);
    const row = (company.data ?? [])[0] as { tickers?: string[] | null } | undefined;
    const codes = row?.tickers ?? [];
    // A one-code company has no sibling to name: no further read.
    if (!codes.some((code) => code !== ticker)) return null;

    const own = await supabase
      .from("article_tickers")
      .select("article_id", { count: "exact", head: true })
      .eq("ticker", ticker)
      .gte("published_at", sinceIso)
      .lte("published_at", nowIso);
    if (own.error) throw new Error(own.error.message);
    if (typeof own.count !== "number") throw new Error("no own-mention count");

    return await readPressCode(supabase, ticker, codes, own.count, sinceIso, WINDOW_WARN_LABEL);
  } catch (err) {
    console.warn(`[finance] ${WINDOW_WARN_LABEL} unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
