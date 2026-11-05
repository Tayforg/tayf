import { formatCountTr } from "@/lib/format/number-tr";

import type { ClusterRow } from "./timeline-query";

// Pure hour bucketing behind /timeline, kept out of the page so it is unit
// tested without rendering JSX.
//
// The feed is cut at TIMELINE_LIMIT rows, newest first, so when the day minted
// more clusters than that the cut falls MID-hour: the oldest bucket holds only
// the tail of its hour, and its header count would read as the hour's total
// ("04 Kas 13:00 · 1 küme" while 19 clusters existed). `truncated` says the
// feed was cut; the oldest bucket is then dropped, so every header that remains
// counts all of that hour's clusters inside the 24-hour window. On an uncapped
// day the window's first hour can start mid-hour; the page's "Son 24 saatte"
// scope covers that. No extra query is needed to know the feed was cut: the page
// already has the real total from the head count (isTimelineTruncated), and a
// full page stands in for it when that count failed.

export interface HourBucket {
  /**
   * ISO of the UTC top-of-hour the rows in this bucket belong to. Used as the
   * section key and as the input to the page's hour label formatter.
   */
  hourISO: string;
  rows: ClusterRow[];
  /**
   * True when `rows.length` is only a lower bound for the hour: the feed was
   * cut and this is the one bucket there is, so it could not be dropped. The
   * header then reads "en az N küme" (see bucketCountLabel).
   */
  partial: boolean;
}

/**
 * True when the feed holds fewer clusters than the window minted. With a known
 * total that is `total > rowCount`. An unknown total (the count read failed or
 * timed out) with a full page (`rowCount >= limit`) is treated as cut too:
 * nothing says it was not, and dropping one hour is safer than printing the
 * tail of the oldest hour as its total. An unknown total with a short page
 * cannot have been cut by the limit.
 */
export function isTimelineTruncated(
  rowCount: number,
  total: number | null,
  limit: number,
): boolean {
  return total !== null ? total > rowCount : rowCount >= limit;
}

/**
 * Buckets cluster rows by the UTC top-of-hour their first_published falls into.
 * `rows` must be newest first (the SQL is ORDER BY first_published DESC), so
 * buckets come out newest hour to oldest hour, and the oldest one is the last.
 *
 * With `truncated` and two or more buckets the oldest is dropped (it was cut
 * mid-hour). With `truncated` and exactly one bucket it is kept, flagged
 * `partial`. Without `truncated` every bucket is kept and none is partial.
 */
export function bucketByHour(
  rows: readonly ClusterRow[],
  { truncated }: { truncated: boolean },
): HourBucket[] {
  const byHour = new Map<string, ClusterRow[]>();
  for (const row of rows) {
    const d = new Date(row.first_published);
    // Top-of-hour in UTC. Two clusters published 14:03 and 14:57 land in the
    // same bucket; one published 15:01 starts a new one.
    d.setUTCMinutes(0, 0, 0);
    const key = d.toISOString();
    const bucket = byHour.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      byHour.set(key, [row]);
    }
  }

  const buckets: HourBucket[] = Array.from(byHour, ([hourISO, rowsForHour]) => ({
    hourISO,
    rows: rowsForHour,
    partial: false,
  }));

  if (!truncated) return buckets;
  if (buckets.length >= 2) return buckets.slice(0, -1);
  return buckets.map((bucket) => ({ ...bucket, partial: true }));
}

/** Rows still shown across the buckets (what the page subtitle calls "en yeni N"). */
export function bucketedRowCount(buckets: readonly HourBucket[]): number {
  let n = 0;
  for (const bucket of buckets) n += bucket.rows.length;
  return n;
}

/**
 * Count text for an hour header: "5 küme", or "en az 5 küme" for a partial
 * bucket. Counts go through formatCountTr ("1.234").
 */
export function bucketCountLabel(bucket: HourBucket): string {
  const label = `${formatCountTr(bucket.rows.length)} küme`;
  return bucket.partial ? `en az ${label}` : label;
}
