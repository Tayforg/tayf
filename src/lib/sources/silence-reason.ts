// Why is a source silent? (migration 119; /kaynaklar/durum and
// ops_health_report row 13 `sources_newly_dark`.)
//
// Pure on purpose: no next/* imports, so the ops tests can read the constants
// and the page can share them. The labels and the order of the checks below are
// the SQL's, and tests/migrations/119-feed-freshness.test.ts pins the parity:
//
//   1. erişim yok   -- the feed could not be fetched: quarantined, a failure
//                      streak, no status yet, or a last status that is not 2xx
//                      or 304 (blocked 403/404/5xx, DNS or timeout = 0);
//   2. akış donmuş  -- the feed answers but is not updating: it holds no items,
//                      or its newest item is more than 72 hours old;
//   3. sessiz       -- the feed is current (or was never measured); the outlet
//                      just published nothing Tayf had not already stored, or
//                      paused for under 72 hours (a night, a weekend).
//
// WHY 72 hours and not 24: ops_health_report row 13 lists a source only after
// 24 hours with no STORED article. Ingest stores every usable item within a few
// minutes of the feed publishing it, so by the time a source is listed its
// newest feed item is already about 24 hours old. A threshold of 24 hours would
// therefore label every listed source frozen, including an outlet that merely
// paused overnight. 72 hours is the window of dead_feeds and of the app's own
// silence gate (FEED_YIELD_WINDOW_MS), and tests/migrations/119 pins all three
// together with the SQL.

export type SilenceReason = "akis_donmus" | "erisim_yok" | "sessiz";

/** A feed whose newest item is older than this is frozen (strictly older). */
export const FROZEN_FEED_MS = 72 * 60 * 60 * 1000;

export const SILENCE_REASON_LABEL: Readonly<Record<SilenceReason, string>> = {
  akis_donmus: "akış donmuş",
  erisim_yok: "erişim yok",
  sessiz: "sessiz",
};

export interface SilenceInput {
  /** sources.fetch_last_status: null = never fetched, 0 = no HTTP answer. */
  lastHttpStatus: number | null;
  /** sources.fetch_fail_streak. */
  failStreak: number;
  /** True while fetch_quarantined_until is in the future. */
  quarantined: boolean;
  /** sources.fetch_newest_item_at (ISO), null when unmeasured or undated. */
  newestFeedItemAt: string | null | undefined;
  /** sources.fetch_items_count, null when unmeasured. */
  feedItemsCount: number | null | undefined;
}

function isReachableStatus(status: number | null): boolean {
  if (status === null) return false;
  return (status >= 200 && status <= 299) || status === 304;
}

export function classifySilence(input: SilenceInput, nowMs: number): SilenceReason {
  if (
    input.quarantined ||
    input.failStreak > 0 ||
    !isReachableStatus(input.lastHttpStatus)
  ) {
    return "erisim_yok";
  }

  const empty = input.feedItemsCount === 0;
  const newest = input.newestFeedItemAt;
  const stale =
    typeof newest === "string" && nowMs - Date.parse(newest) > FROZEN_FEED_MS;
  if (empty || stale) return "akis_donmus";

  return "sessiz";
}
