import { describe, expect, it } from "vitest";

import type { RawFeedItem } from "../../../supabase/functions/_shared/rss/fetcher";
import {
  computeFeedFreshness,
  FUTURE_ITEM_TOLERANCE_MS,
  MAX_ITEM_DATE_MS,
  MIN_ITEM_DATE_MS,
  storableItemDate,
} from "../../../supabase/functions/_shared/rss/feed-freshness";

// ---------------------------------------------------------------------------
// computeFeedFreshness: the pure "what is the newest item of this feed" helper
// behind sources.fetch_newest_item_at / fetch_items_count (migration 119).
//
// It must read the RAW parsed dates (isoDate ?? pubDate, already cleaned by the
// fetcher), never the normalised published_at: normalize.ts falls back to
// "now" for an unparseable date, which would make a frozen feed with one
// undated item look fresh on every poll. A date in the future (beyond the
// tolerance) is ignored, not clamped, for the same reason.
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const at = (ms: number): string => new Date(ms).toISOString();

describe("FUTURE_ITEM_TOLERANCE_MS", () => {
  it("is 10 minutes", () => {
    expect(FUTURE_ITEM_TOLERANCE_MS).toBe(10 * 60 * 1000);
  });
});

describe("MIN_ITEM_DATE_MS / MAX_ITEM_DATE_MS", () => {
  it("bound the storable years to 1990..2100 (the window Postgres reads back safely through jsonb_to_recordset)", () => {
    expect(MIN_ITEM_DATE_MS).toBe(Date.UTC(1990, 0, 1));
    expect(MAX_ITEM_DATE_MS).toBe(Date.UTC(2101, 0, 1));
  });
});

describe("computeFeedFreshness", () => {
  it("an empty feed has no newest item and zero items", () => {
    expect(computeFeedFreshness([], NOW)).toEqual({ newestItemAt: null, itemsCount: 0 });
  });

  it("takes the max across RFC-822, ISO and zone-less dates", () => {
    const items: RawFeedItem[] = [
      { pubDate: "Fri, 23 Oct 2026 10:00:00 +0000" },
      { isoDate: "2026-10-24T08:30:00Z" },
      { pubDate: "2026-10-24 09:15:00" }, // zone-less: Istanbul, 06:15Z
      { pubDate: "Sat, 24 Oct 2026 10:00:00" }, // zone-less RFC-822: Istanbul, 07:00Z
    ];
    expect(computeFeedFreshness(items, NOW)).toEqual({
      newestItemAt: "2026-10-24T08:30:00.000Z",
      itemsCount: 4,
    });
  });

  it("reads a zone-less date as Istanbul wall-clock time, not UTC", () => {
    const items: RawFeedItem[] = [
      { isoDate: "2026-10-24T07:00:00Z" },
      { pubDate: "2026-10-24 11:00:00" }, // 08:00Z; read as UTC it would be 11:00Z
    ];
    expect(computeFeedFreshness(items, NOW).newestItemAt).toBe("2026-10-24T08:00:00.000Z");
  });

  it("prefers isoDate over pubDate for one item", () => {
    const items: RawFeedItem[] = [
      { isoDate: "2026-10-20T00:00:00Z", pubDate: "Sat, 24 Oct 2026 11:00:00 +0000" },
    ];
    expect(computeFeedFreshness(items, NOW).newestItemAt).toBe("2026-10-20T00:00:00.000Z");
  });

  it("ignores unparseable and missing dates but still counts the items", () => {
    const items: RawFeedItem[] = [
      { pubDate: "not a date" },
      {},
      { isoDate: "" },
      { pubDate: "   " },
      { pubDate: "Fri, 23 Oct 2026 10:00:00 +0000" },
      { title: "no date at all", link: "https://example.invalid/a" },
    ];
    expect(computeFeedFreshness(items, NOW)).toEqual({
      newestItemAt: "2026-10-23T10:00:00.000Z",
      itemsCount: 6,
    });
  });

  it("an all-undated feed has newestItemAt null with itemsCount = N (never 'now')", () => {
    const items: RawFeedItem[] = [{ title: "a" }, { pubDate: "garbage" }, { isoDate: "also garbage" }];
    expect(computeFeedFreshness(items, NOW)).toEqual({ newestItemAt: null, itemsCount: 3 });
  });

  it("ignores an item 11 minutes in the future", () => {
    const items: RawFeedItem[] = [
      { isoDate: at(NOW - HOUR) },
      { isoDate: at(NOW + 11 * MIN) },
    ];
    expect(computeFeedFreshness(items, NOW)).toEqual({
      newestItemAt: at(NOW - HOUR),
      itemsCount: 2,
    });
  });

  it("counts an item 9 minutes in the future, and exactly the tolerance", () => {
    expect(computeFeedFreshness([{ isoDate: at(NOW - HOUR) }, { isoDate: at(NOW + 9 * MIN) }], NOW).newestItemAt).toBe(
      at(NOW + 9 * MIN),
    );
    expect(computeFeedFreshness([{ isoDate: at(NOW + FUTURE_ITEM_TOLERANCE_MS) }], NOW).newestItemAt).toBe(
      at(NOW + FUTURE_ITEM_TOLERANCE_MS),
    );
    expect(computeFeedFreshness([{ isoDate: at(NOW + FUTURE_ITEM_TOLERANCE_MS + 1000) }], NOW).newestItemAt).toBeNull();
  });

  it("future-dated junk does not make a frozen feed look fresh", () => {
    const items: RawFeedItem[] = [
      { isoDate: at(NOW - 30 * HOUR) },
      { isoDate: "2099-01-01T00:00:00Z" },
      { pubDate: "Wed, 01 Jan 2200 00:00:00 +0000" },
    ];
    expect(computeFeedFreshness(items, NOW).newestItemAt).toBe(at(NOW - 30 * HOUR));
  });

  it("an only-future feed has newestItemAt null (not clamped to now)", () => {
    expect(computeFeedFreshness([{ isoDate: at(NOW + 2 * 24 * HOUR) }], NOW)).toEqual({
      newestItemAt: null,
      itemsCount: 1,
    });
  });

  it("cnn-turk: a UTC-labelled date gets the 3 h correction (and is valid, not future)", () => {
    // 12:00 GMT is really 12:00 Istanbul = 09:00Z. At 09:05Z the corrected item
    // is 5 min old; the uncorrected one would be 2 h 55 min in the future.
    const now = Date.parse("2026-10-24T09:05:00.000Z");
    const items: RawFeedItem[] = [{ pubDate: "Sat, 24 Oct 2026 12:00:00 GMT" }];
    expect(computeFeedFreshness(items, now, "cnn-turk")).toEqual({
      newestItemAt: "2026-10-24T09:00:00.000Z",
      itemsCount: 1,
    });
    // another source keeps the label as written, and it is in the future
    expect(computeFeedFreshness(items, now, "ntv")).toEqual({ newestItemAt: null, itemsCount: 1 });
    expect(computeFeedFreshness(items, now)).toEqual({ newestItemAt: null, itemsCount: 1 });
  });

  it("returns an ISO string with milliseconds and does not mutate its input", () => {
    const items: RawFeedItem[] = [{ isoDate: "2026-10-24T08:30:00Z" }];
    const copy = JSON.parse(JSON.stringify(items));
    const out = computeFeedFreshness(items, NOW);
    expect(out.newestItemAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(items).toEqual(copy);
  });

  it("handles a large feed (10k items) quickly and picks the right max", () => {
    const items: RawFeedItem[] = [];
    for (let i = 0; i < 10_000; i++) items.push({ isoDate: at(NOW - (i + 1) * MIN) });
    items.push({ pubDate: "garbage" });
    const started = Date.now();
    const out = computeFeedFreshness(items, NOW);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(out).toEqual({ newestItemAt: at(NOW - MIN), itemsCount: 10_001 });
  });

  it("handles unicode and special characters in non-date fields without touching them", () => {
    const items: RawFeedItem[] = [
      { title: "Şöyle böyle 🙂 '; drop table sources; --", isoDate: "2026-10-24T08:30:00Z" },
    ];
    expect(computeFeedFreshness(items, NOW).newestItemAt).toBe("2026-10-24T08:30:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// A hostile or broken feed can carry a pre-1990 date. parseDate accepts year 0
// and negative years, and Postgres rejects those in jsonb_to_recordset
// (`date/time field value out of range`, `time zone displacement out of
// range`), which fails the whole batched fetch-state write for every source.
// They must never leave this helper.
// ---------------------------------------------------------------------------

describe("computeFeedFreshness: implausibly old dates are ignored", () => {
  const OLD: ReadonlyArray<readonly [string, RawFeedItem]> = [
    ["year 0 (ISO)", { isoDate: "0000-01-01T00:00:00Z" }],
    ["year 0 (pubDate)", { pubDate: "0000-01-01T00:00:00Z" }],
    ["year 0, zone-less (Istanbul wall clock rolls it to year -1)", { pubDate: "0000-01-01 00:00:00" }],
    ["a negative year", { isoDate: "-000100-01-01T00:00:00Z" }],
    ["year 1", { isoDate: "0001-01-01T00:00:00Z" }],
    ["1969-12-31", { isoDate: "1969-12-31T23:59:59Z" }],
    ["the Unix epoch (RFC-822)", { pubDate: "Thu, 01 Jan 1970 00:00:00 +0000" }],
    ["one millisecond before the floor", { isoDate: "1989-12-31T23:59:59.999Z" }],
  ];

  it.each(OLD)("%s gives no newest item (the item is still counted)", (_name, item) => {
    expect(computeFeedFreshness([item], NOW)).toEqual({ newestItemAt: null, itemsCount: 1 });
  });

  it("a junk-old item never hides the real newest item of the feed", () => {
    const items: RawFeedItem[] = [
      { isoDate: "0000-01-01T00:00:00Z" },
      { isoDate: at(NOW - 30 * HOUR) },
      { pubDate: "0000-01-01 00:00:00" },
      { isoDate: "-000100-01-01T00:00:00Z" },
    ];
    expect(computeFeedFreshness(items, NOW)).toEqual({ newestItemAt: at(NOW - 30 * HOUR), itemsCount: 4 });
  });

  it("an item exactly at the floor is kept", () => {
    expect(computeFeedFreshness([{ isoDate: new Date(MIN_ITEM_DATE_MS).toISOString() }], NOW).newestItemAt).toBe(
      "1990-01-01T00:00:00.000Z",
    );
  });

  it("whatever it returns is safe to send to Postgres: null, or a four-digit-year ISO inside 1990..2100", () => {
    const hostile = [
      "0000-01-01T00:00:00Z",
      "0000-01-01 00:00:00",
      "-000100-01-01T00:00:00Z",
      "+275760-09-13T00:00:00Z",
      "9999-12-31T23:59:59Z",
      "2026-10-24T08:30:00Z",
    ];
    for (const d of hostile) {
      const out = computeFeedFreshness([{ isoDate: d }, { pubDate: d }], NOW).newestItemAt;
      if (out === null) continue;
      expect(out, d).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const ms = Date.parse(out);
      expect(ms, d).toBeGreaterThanOrEqual(MIN_ITEM_DATE_MS);
      expect(ms, d).toBeLessThan(MAX_ITEM_DATE_MS);
    }
  });
});

describe("storableItemDate (the last guard before the fetch-state RPC)", () => {
  it("passes a normal ISO timestamp through, normalised", () => {
    expect(storableItemDate("2026-10-24T08:30:00.000Z")).toBe("2026-10-24T08:30:00.000Z");
    expect(storableItemDate("2026-10-24T11:30:00+03:00")).toBe("2026-10-24T08:30:00.000Z");
  });

  it("keeps the bounds: 1990-01-01 in, 2100-12-31 in, 2101-01-01 out, 1989-12-31 out", () => {
    expect(storableItemDate("1990-01-01T00:00:00.000Z")).toBe("1990-01-01T00:00:00.000Z");
    expect(storableItemDate("2100-12-31T23:59:59.999Z")).toBe("2100-12-31T23:59:59.999Z");
    expect(storableItemDate("2101-01-01T00:00:00.000Z")).toBeNull();
    expect(storableItemDate("1989-12-31T23:59:59.999Z")).toBeNull();
  });

  it("drops year 0, negative and expanded years", () => {
    for (const d of ["0000-01-01T00:00:00.000Z", "-000001-12-31T21:00:00.000Z", "-000100-01-01T00:00:00.000Z", "+275760-09-13T00:00:00.000Z"]) {
      expect(storableItemDate(d), d).toBeNull();
    }
  });

  it("drops null, undefined, empty and unparseable input", () => {
    for (const d of [null, undefined, "", "   ", "not a date", "2026-13-45T99:99:99Z"]) {
      expect(storableItemDate(d), String(d)).toBeNull();
    }
  });
});
