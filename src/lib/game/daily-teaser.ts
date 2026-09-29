import { istanbulDateKey, puzzleNumber } from "@/lib/game/daily-set";

/**
 * Whether the home feed shows the "Günün Tayf'ı" teaser, and with which
 * puzzle number. Page 1 without a search and with at least one in-feed
 * match only; `puzzleNumber` is omitted before the game epoch.
 */
export function dailyTeaserSlot(input: {
  page: number;
  q: string | undefined;
  hasInFeedMatches: boolean;
  nowMs: number;
}): { puzzleNumber?: number } | null {
  if (input.page !== 1 || input.q || !input.hasInFeedMatches) return null;
  const n = puzzleNumber(istanbulDateKey(input.nowMs));
  return n >= 1 ? { puzzleNumber: n } : {};
}
