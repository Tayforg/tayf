import { describe, it, expect } from "vitest";
import { dailyTeaserSlot } from "./daily-teaser";

// 2026-09-28 12:00 Istanbul (09:00Z) = the epoch day, puzzle #1.
const EPOCH_NOON_MS = Date.parse("2026-09-28T09:00:00.000Z");

describe("dailyTeaserSlot", () => {
  it("is null on page 2+", () => {
    expect(dailyTeaserSlot({ page: 2, q: undefined, hasInFeedMatches: true, nowMs: EPOCH_NOON_MS })).toBeNull();
  });
  it("is null on a search", () => {
    expect(dailyTeaserSlot({ page: 1, q: "erdoğan", hasInFeedMatches: true, nowMs: EPOCH_NOON_MS })).toBeNull();
  });
  it("is null with no in-feed matches", () => {
    expect(dailyTeaserSlot({ page: 1, q: undefined, hasInFeedMatches: false, nowMs: EPOCH_NOON_MS })).toBeNull();
  });
  it("puzzle number is 1 on the epoch day in Istanbul time", () => {
    expect(dailyTeaserSlot({ page: 1, q: undefined, hasInFeedMatches: true, nowMs: EPOCH_NOON_MS })).toEqual({ puzzleNumber: 1 });
    // 21:30Z on 09-27 is already 00:30 Istanbul on 09-28.
    const justAfterIstanbulMidnight = Date.parse("2026-09-27T21:30:00.000Z");
    expect(dailyTeaserSlot({ page: 1, q: "", hasInFeedMatches: true, nowMs: justAfterIstanbulMidnight })).toEqual({ puzzleNumber: 1 });
  });
  it("omits puzzleNumber before the epoch", () => {
    const before = Date.parse("2026-09-20T09:00:00.000Z");
    expect(dailyTeaserSlot({ page: 1, q: undefined, hasInFeedMatches: true, nowMs: before })).toEqual({});
  });
  it("increments the next day", () => {
    const next = Date.parse("2026-09-29T09:00:00.000Z");
    expect(dailyTeaserSlot({ page: 1, q: undefined, hasInFeedMatches: true, nowMs: next })).toEqual({ puzzleNumber: 2 });
  });
});
