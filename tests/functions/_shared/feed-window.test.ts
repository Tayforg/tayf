import { describe, expect, it } from "vitest";

import {
  isWindowOverflow,
  WINDOW_OVERFLOW_MIN_ITEMS,
} from "../../../supabase/functions/_shared/rss/feed-window";

// ---------------------------------------------------------------------------
// isWindowOverflow (migration 212): the pure rule behind
// sources.fetch_window_overflow_at.
//
// A feed that holds only its newest N items (haberport: 50, replaced once an
// hour) loses everything published between two polls once more than N items
// appear in that gap. Ingest already looks up which of a poll's urls are
// stored; when a poll of a full-sized window finds NONE of them stored, the
// window has moved past the previous poll and some items were never offered.
// The rule needs a window big enough to be a window (a 3-item feed that shows
// 3 new items proves nothing) and an answer it can trust (a failed lookup
// proves nothing; a bootstrap poll is the first look at the feed).
// ---------------------------------------------------------------------------

const base = { itemCount: 50, storedCount: 0, lookupOk: true, bootstrap: false };

describe("WINDOW_OVERFLOW_MIN_ITEMS", () => {
  it("is 10", () => {
    expect(WINDOW_OVERFLOW_MIN_ITEMS).toBe(10);
  });
});

describe("isWindowOverflow", () => {
  it("9 items, none stored: a window this small proves nothing", () => {
    expect(isWindowOverflow({ ...base, itemCount: 9, storedCount: 0 })).toBe(false);
  });

  it("10 items, none stored: the smallest window that can overflow", () => {
    expect(isWindowOverflow({ ...base, itemCount: 10, storedCount: 0 })).toBe(true);
  });

  it("50 items, none stored: haberport's window, one hour of news past the last poll", () => {
    expect(isWindowOverflow({ ...base, itemCount: 50, storedCount: 0 })).toBe(true);
  });

  it("50 items, 1 stored: one overlapping item shows the windows touch", () => {
    expect(isWindowOverflow({ ...base, itemCount: 50, storedCount: 1 })).toBe(false);
  });

  it("every item stored: an ordinary repeat poll", () => {
    expect(isWindowOverflow({ ...base, itemCount: 50, storedCount: 50 })).toBe(false);
  });

  it("a failed stored-url lookup proves nothing (fail-open)", () => {
    expect(isWindowOverflow({ ...base, lookupOk: false })).toBe(false);
  });

  it("a bootstrap poll is the first look at the feed, not an overflow", () => {
    expect(isWindowOverflow({ ...base, bootstrap: true })).toBe(false);
  });

  it("an empty poll (a bootstrap whose body is the stored one prepares nothing) is never an overflow", () => {
    expect(isWindowOverflow({ ...base, itemCount: 0, storedCount: 0 })).toBe(false);
  });

  it("a large window behaves the same (10,000 items, none stored; one stored)", () => {
    expect(isWindowOverflow({ ...base, itemCount: 10_000, storedCount: 0 })).toBe(true);
    expect(isWindowOverflow({ ...base, itemCount: 10_000, storedCount: 1 })).toBe(false);
  });

  it("the flags win over the counts: a failed lookup and a bootstrap together are still false", () => {
    expect(isWindowOverflow({ ...base, lookupOk: false, bootstrap: true })).toBe(false);
  });

  it("garbage counts are never an overflow: negative, fractional, NaN, infinite", () => {
    const bad = [-1, -10, 10.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const n of bad) {
      expect(isWindowOverflow({ ...base, itemCount: n }), `itemCount ${n}`).toBe(false);
      expect(isWindowOverflow({ ...base, storedCount: n }), `storedCount ${n}`).toBe(false);
    }
  });

  it("wrong types are never an overflow (the feed and the lookup are third-party shaped)", () => {
    const wrong = [
      { ...base, itemCount: "50" },
      { ...base, storedCount: "0" },
      { ...base, itemCount: null },
      { ...base, storedCount: undefined },
      { ...base, lookupOk: "yes" },
      { ...base, bootstrap: 0 },
      {},
    ];
    for (const input of wrong) {
      expect(isWindowOverflow(input as unknown as Parameters<typeof isWindowOverflow>[0])).toBe(false);
    }
  });

  it("reads only the four named fields: an extra key changes nothing", () => {
    const withExtra = { ...base, slug: "haberport", urls: ["https://example.com/a"] };
    expect(isWindowOverflow(withExtra)).toBe(true);
  });
});
