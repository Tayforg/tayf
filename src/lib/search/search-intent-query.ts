import { getTradedTickers } from "@/lib/finance/traded-tickers";
import { getActiveSourceNames } from "@/lib/sources/registry-query";

import {
  outletQueryWords,
  resolveSearchIntent,
  tickerCandidate,
  type SearchIntent,
} from "./search-intent";

// The lookup behind the home search's link row (h153). The query text alone says
// which lookups are needed, so an ordinary search ("asgari ücret zammı") costs no
// read at all: more than 4 words, an operator, or a word that is not code-shaped
// ends here.
//
//   - an outlet-shaped query (1 to 4 words) reads the active sources' names;
//   - a code-shaped query (one word of 4 to 6 letters, not an everyday word)
//     reads the set of traded codes.
//
// Both getters take NO argument, so a stream of unique queries cannot create new
// cache keys: there is one entry of each, shared with /api/sources and the finance
// reads. Both are null-contract reads (no live retry, no connection()), and they run
// in parallel with each other and with the archive search. A failed read is "no
// link" for the minutes window, never a failed page.
//
// NEVER throws, and never logs the query: a search term is reader text.

export async function loadSearchIntent(q: string): Promise<SearchIntent | null> {
  try {
    const wantsTicker = tickerCandidate(q) !== null;
    const wantsOutlet = outletQueryWords(q) !== null;
    if (!wantsTicker && !wantsOutlet) return null;

    const [sources, tickers] = await Promise.all([
      wantsOutlet ? getActiveSourceNames() : Promise.resolve(null),
      wantsTicker ? getTradedTickers() : Promise.resolve(null),
    ]);
    return resolveSearchIntent({ q, sources, tickers });
  } catch (error) {
    console.warn(`[search] intent lookup failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return null;
  }
}
