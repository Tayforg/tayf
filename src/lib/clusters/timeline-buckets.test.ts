import { describe, expect, it } from "vitest";

import {
  bucketByHour,
  bucketCountLabel,
  bucketedRowCount,
  isTimelineTruncated,
} from "./timeline-buckets";
import type { ClusterRow } from "./timeline-query";

// h36-journeys-2: /timeline cuts the feed at TIMELINE_LIMIT rows, newest first,
// so the OLDEST hour bucket can hold only the tail of that hour. Its header used
// to print the row count as if it were the hour's total ("04 Kas 13:00 · 1
// küme" while 19 clusters existed). Fix: a truncated feed drops the oldest
// bucket, so every header that remains is a true total; a single truncated
// bucket is kept but marked "en az N küme".

function row(id: string, iso: string): ClusterRow {
  return {
    id,
    title_tr: `Küme ${id}`,
    title_tr_neutral: null,
    article_count: 2,
    first_published: iso,
  };
}

/** `count` rows inside the UTC hour starting at 2026-11-04T`hour`:00Z, newest first. */
function rowsInHour(hour: number, count: number): ClusterRow[] {
  const hh = String(hour).padStart(2, "0");
  return Array.from({ length: count }, (_, i) =>
    row(`h${hh}-${i}`, `2026-11-04T${hh}:${String(59 - i).padStart(2, "0")}:00.000Z`),
  );
}

// Newest hour first, like the SQL (ORDER BY first_published DESC).
const THREE_HOURS: ClusterRow[] = [
  ...rowsInHour(12, 5),
  ...rowsInHour(11, 7),
  ...rowsInHour(10, 3),
];

describe("bucketByHour", () => {
  it("groups rows by UTC top-of-hour, newest hour first, keeping row order", () => {
    const buckets = bucketByHour(THREE_HOURS, { truncated: false });

    expect(buckets.map((b) => b.hourISO)).toEqual([
      "2026-11-04T12:00:00.000Z",
      "2026-11-04T11:00:00.000Z",
      "2026-11-04T10:00:00.000Z",
    ]);
    expect(buckets.map((b) => b.rows.length)).toEqual([5, 7, 3]);
    expect(buckets[0]?.rows.map((r) => r.id)).toEqual(rowsInHour(12, 5).map((r) => r.id));
  });

  it("a minute-59 row and the next hour's minute-00 row land in different buckets", () => {
    const buckets = bucketByHour(
      [row("a", "2026-11-04T12:00:00.000Z"), row("b", "2026-11-04T11:59:59.999Z")],
      { truncated: false },
    );

    expect(buckets.map((b) => b.rows.map((r) => r.id))).toEqual([["a"], ["b"]]);
  });

  it("truncated=false keeps every bucket and marks none partial", () => {
    const buckets = bucketByHour(THREE_HOURS, { truncated: false });

    expect(buckets).toHaveLength(3);
    expect(buckets.every((b) => b.partial === false)).toBe(true);
  });

  it("truncated=true drops the oldest bucket; the remaining counts are unchanged", () => {
    const buckets = bucketByHour(THREE_HOURS, { truncated: true });

    expect(buckets.map((b) => b.hourISO)).toEqual([
      "2026-11-04T12:00:00.000Z",
      "2026-11-04T11:00:00.000Z",
    ]);
    expect(buckets.map((b) => b.rows.length)).toEqual([5, 7]);
    expect(buckets.every((b) => b.partial === false)).toBe(true);
  });

  it("truncated=true with exactly two buckets leaves the newest one", () => {
    const buckets = bucketByHour([...rowsInHour(12, 4), ...rowsInHour(11, 2)], {
      truncated: true,
    });

    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.hourISO).toBe("2026-11-04T12:00:00.000Z");
    expect(buckets[0]?.rows).toHaveLength(4);
    expect(buckets[0]?.partial).toBe(false);
  });

  it("a single truncated bucket is kept and flagged partial", () => {
    const buckets = bucketByHour(rowsInHour(12, 6), { truncated: true });

    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.rows).toHaveLength(6);
    expect(buckets[0]?.partial).toBe(true);
  });

  it("a single bucket of a complete feed is not partial", () => {
    const buckets = bucketByHour(rowsInHour(12, 6), { truncated: false });

    expect(buckets).toHaveLength(1);
    expect(buckets[0]?.partial).toBe(false);
  });

  it("no rows: no buckets, truncated or not", () => {
    expect(bucketByHour([], { truncated: false })).toEqual([]);
    expect(bucketByHour([], { truncated: true })).toEqual([]);
  });

  it("does not mutate the input rows", () => {
    const input = [...THREE_HOURS];
    bucketByHour(input, { truncated: true });

    expect(input).toEqual(THREE_HOURS);
  });
});

describe("bucketedRowCount", () => {
  it("sums the rows that are still shown after the oldest bucket was dropped", () => {
    expect(bucketedRowCount(bucketByHour(THREE_HOURS, { truncated: true }))).toBe(12);
    expect(bucketedRowCount(bucketByHour(THREE_HOURS, { truncated: false }))).toBe(15);
    expect(bucketedRowCount([])).toBe(0);
  });
});

describe("isTimelineTruncated", () => {
  it("a known total decides: true when it is larger than what was read", () => {
    expect(isTimelineTruncated(200, 256, 200)).toBe(true);
    expect(isTimelineTruncated(200, 201, 200)).toBe(true);
  });

  it("a known total decides: false when everything was read", () => {
    expect(isTimelineTruncated(200, 200, 200)).toBe(false);
    expect(isTimelineTruncated(3, 3, 200)).toBe(false);
    expect(isTimelineTruncated(0, 0, 200)).toBe(false);
  });

  // The count read failed (an error, a null count or the reader's abort), on a
  // day that filled the page: nothing says the feed was not cut, and the oldest
  // bucket would print its tail as the hour's total. A full page is treated as
  // cut; a short page cannot have been cut by the limit.
  it("an unknown total with a full page is treated as cut; with a short page it is not", () => {
    expect(isTimelineTruncated(200, null, 200)).toBe(true);
    expect(isTimelineTruncated(199, null, 200)).toBe(false);
    expect(isTimelineTruncated(0, null, 200)).toBe(false);
  });
});

describe("bucketCountLabel", () => {
  it("a complete bucket reads 'N küme'", () => {
    const [bucket] = bucketByHour(rowsInHour(12, 5), { truncated: false });

    expect(bucketCountLabel(bucket!)).toBe("5 küme");
  });

  it("a partial bucket reads 'en az N küme'", () => {
    const [bucket] = bucketByHour(rowsInHour(12, 5), { truncated: true });

    expect(bucketCountLabel(bucket!)).toBe("en az 5 küme");
  });

  it("groups four-digit counts with the tr-TR dot in both forms", () => {
    const big = Array.from({ length: 1234 }, (_, i) =>
      row(`b${i}`, new Date(Date.UTC(2026, 10, 4, 12, 0, 0) + i * 1000).toISOString()),
    );
    const [complete] = bucketByHour(big, { truncated: false });
    const [partial] = bucketByHour(big, { truncated: true });

    expect(bucketCountLabel(complete!)).toBe("1.234 küme");
    expect(bucketCountLabel(partial!)).toBe("en az 1.234 küme");
  });
});
