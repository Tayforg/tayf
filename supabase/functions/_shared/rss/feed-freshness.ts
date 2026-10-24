// supabase/functions/_shared/rss/feed-freshness.ts
//
// Feed freshness (migration 119): the newest item date a feed itself reports,
// and how many entries it holds. Ingest stores both on `sources`
// (`fetch_newest_item_at`, `fetch_items_count`) so a FROZEN feed (HTTP 200, but
// the newest item never changes: haberport, korkusuz, en-politik on
// 2026-10-24) can be told apart from a quiet outlet (the feed is current, the
// news just repeats) and from a blocked one (no 2xx at all).
//
// Two rules keep that signal honest:
//
//   * The date is read from the RAW parsed item (`isoDate ?? pubDate`, already
//     cleaned by the fetcher), never from the normalised `published_at`.
//     `parseDate` falls back to "now" for an unparseable date, so a frozen
//     feed with one undated item would look fresh on every poll.
//   * A date in the future is IGNORED, not clamped. A clamped one would be
//     "now" again. A small tolerance (clock skew between the outlet and the
//     Edge runtime) keeps an item stamped a few minutes ahead.
//   * A date before 1990 is IGNORED too. The feed is third-party input (a
//     hostile publisher, a MITM on a plain-http feed, or a CMS that writes
//     zero-dates), and `parseDate` accepts year 0 and negative years. Postgres
//     rejects those in `jsonb_to_recordset` ("date/time field value out of
//     range"), which would fail the one batched `ingest_set_source_fetch_state`
//     write for EVERY source of the cycle, not just the feed that sent it.
//     `storableItemDate` is the same bound as a last guard on the way out.
//
// `parseDate` and `isParseableFeedDate` are only imported here, never edited.

import { isParseableFeedDate } from "./dates.ts";
import type { RawFeedItem } from "./fetcher.ts";
import { parseDate } from "./normalize.ts";

/** An item dated further ahead of now than this is junk and is ignored. */
export const FUTURE_ITEM_TOLERANCE_MS = 10 * 60 * 1000;

/** An item dated before this (1990-01-01T00:00:00Z) is junk and is ignored. */
export const MIN_ITEM_DATE_MS = Date.UTC(1990, 0, 1);

/** Exclusive upper bound of a storable item date (2101-01-01T00:00:00Z). */
export const MAX_ITEM_DATE_MS = Date.UTC(2101, 0, 1);

/**
 * The value to send for `fetch_newest_item_at`: the timestamp normalised to
 * `YYYY-MM-DDTHH:mm:ss.sssZ` when it falls in 1990..2100, otherwise null.
 * `toISOString` writes a year outside 0000..9999 as an expanded year
 * (`-000001-...`) that Postgres refuses, and Postgres refuses year 0 as well.
 * Null means "no usable date": the writer then stores NULL next to the count.
 */
export function storableItemDate(iso: string | null | undefined): string | null {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms) || ms < MIN_ITEM_DATE_MS || ms >= MAX_ITEM_DATE_MS) return null;
  return new Date(ms).toISOString();
}

export interface FeedFreshness {
  /** ISO timestamp of the newest usable item date, or null when none. */
  newestItemAt: string | null;
  /** Raw parsed entries in the feed (dated or not). */
  itemsCount: number;
}

// The maximum ECMAScript date value. Passed as `parseDate`'s `nowMs` so its
// "never later than now" clamp can never fire: the clamp would turn a
// future-dated item into "now", which is exactly what must not happen here.
const NO_CLAMP_NOW_MS = 8.64e15;

export function computeFeedFreshness(
  items: readonly RawFeedItem[],
  nowMs: number,
  sourceSlug?: string,
): FeedFreshness {
  const ceiling = nowMs + FUTURE_ITEM_TOLERANCE_MS;
  let newest = Number.NEGATIVE_INFINITY;

  for (const item of items) {
    const raw = item.isoDate ?? item.pubDate;
    if (!isParseableFeedDate(raw, sourceSlug)) continue;
    const ms = Date.parse(
      parseDate(raw, { nowMs: NO_CLAMP_NOW_MS, sourceSlug }),
    );
    if (Number.isNaN(ms)) continue;
    if (ms > ceiling || ms < MIN_ITEM_DATE_MS) continue;
    if (ms > newest) newest = ms;
  }

  return {
    newestItemAt: Number.isFinite(newest) ? new Date(newest).toISOString() : null,
    itemsCount: items.length,
  };
}
