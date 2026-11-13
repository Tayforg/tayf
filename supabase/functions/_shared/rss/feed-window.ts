// supabase/functions/_shared/rss/feed-window.ts
//
// Feed window overflow (migration 212). A feed that holds only its newest N
// items (haberport: 50, replaced once an hour) loses everything that appears
// between two polls once more than N items show up in that gap: the items that
// fell off the end were never offered to Tayf and nothing recorded the loss.
//
// Ingest already looks up which of a poll's urls are stored (`lookupStoredByUrl`).
// A poll of a full-sized window whose urls are ALL absent from `articles` means
// the window moved past the previous poll, so some items were skipped. This
// module is that rule and nothing else: pure, no Deno globals, no imports, so
// vitest and the Edge Function share it.
//
// Three things keep the signal honest:
//
//   * The window must be big enough to be a window. A 3-item feed that shows 3
//     new items says nothing about loss; `WINDOW_OVERFLOW_MIN_ITEMS` is the floor.
//   * A failed lookup proves nothing. `lookup.ok === false` means "nothing is
//     known", never "nothing is stored" (the lookup is fail-open: `byUrl` may
//     hold a partial answer).
//   * The first look at a feed proves nothing either. A bootstrap poll
//     (`fetch_items_count` still NULL) finds an empty database for that feed by
//     construction, as does a source added to the registry a minute ago.
//
// The rule is a detector, not a recovery: the lost items stay lost. Recovering
// them (a second feed url for the outlet, say) is a registry decision.

/** A feed shorter than this cannot show an overflow: nothing is concluded from it. */
export const WINDOW_OVERFLOW_MIN_ITEMS = 10;

export interface WindowOverflowInput {
  /** Items this poll prepared (after the cheap normalisation and the foreign-host filter). */
  itemCount: number;
  /** How many of those urls are already stored, under any source and any title. */
  storedCount: number;
  /** The stored-url lookup answered completely. */
  lookupOk: boolean;
  /** This poll is the one-time bootstrap of a never-measured source. */
  bootstrap: boolean;
}

/**
 * True when a poll of at least `WINDOW_OVERFLOW_MIN_ITEMS` items found none of
 * them stored, on a lookup that answered and a poll that is not a bootstrap.
 * Never throws: anything that is not a non-negative integer count, or a flag
 * that is not the exact boolean, reads as "no overflow".
 */
export function isWindowOverflow(input: WindowOverflowInput): boolean {
  if (input === null || typeof input !== "object") return false;
  const { itemCount, storedCount, lookupOk, bootstrap } = input;
  if (lookupOk !== true || bootstrap !== false) return false;
  if (!Number.isInteger(itemCount) || !Number.isInteger(storedCount)) return false;
  return itemCount >= WINDOW_OVERFLOW_MIN_ITEMS && storedCount === 0;
}
