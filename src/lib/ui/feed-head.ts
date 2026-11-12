// Where a long card feed is cut into a "head" and a "tail" (h166-perf-3).
//
// /blindspots and /gundem/[key] used to render every card (30 and 20) in the
// same Suspense boundary as the page head: React 19 batches boundary reveals
// into windows of about 300 ms after first paint, and a boundary cannot reveal
// before its last card has streamed, so the head (title, counts, chart, the
// first cards: the LCP) was held back by the whole list. Each page now renders
// the first FEED_HEAD_CARDS cards with the head and the rest in a nested
// boundary after it. This module is the one place that decides the cut, so the
// two pages (and the tests that pin them) cannot disagree.
//
// Card 0 is the LCP banner and card 1 completes the first screen on a phone;
// two cards are also the least that keeps the head's byte size small. Pure:
// no clock, no I/O.

export const FEED_HEAD_CARDS = 2;

/**
 * Splits `items` into the first `head` items and the rest. `head` is clamped to
 * [0, items.length] and cut to a whole number; a non-finite `head` (NaN,
 * +-Infinity) falls back to FEED_HEAD_CARDS before clamping. `tailStart` is
 * the index in `items` of the first tail item (always `head.length`), the
 * offset a caller adds to a tail position to get the item's global index.
 * Item references are kept and the input is never mutated.
 */
export function splitFeedHead<T>(
  items: readonly T[],
  head: number = FEED_HEAD_CARDS,
): { head: T[]; tail: T[]; tailStart: number } {
  const wanted = Number.isFinite(head) ? Math.trunc(head) : FEED_HEAD_CARDS;
  const h = Math.min(Math.max(wanted, 0), items.length);
  return { head: items.slice(0, h), tail: items.slice(h), tailStart: h };
}
