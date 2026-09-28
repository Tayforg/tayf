import { describe, it, expect } from "vitest";
import {
  isQuarantined,
  nextQuarantineState,
  QUARANTINE_AFTER_FAILURES,
  QUARANTINE_BACKOFF_MS,
} from "../../supabase/functions/_shared/rss/quarantine.ts";

const NOW = Date.parse("2026-09-28T15:00:00Z");

describe("nextQuarantineState", () => {
  it("increments the streak on a failure below the threshold, with no quarantine", () => {
    const state = nextQuarantineState(5, false, NOW);
    expect(state).toEqual({ fetch_fail_streak: 6, fetch_quarantined_until: null });
  });

  it("treats a null/undefined previous streak as 0", () => {
    const state = nextQuarantineState(null, false, NOW);
    expect(state.fetch_fail_streak).toBe(1);
    expect(nextQuarantineState(undefined, false, NOW).fetch_fail_streak).toBe(1);
  });

  it("19 -> 20 crosses the threshold and does NOT quarantine yet (< 20)", () => {
    const state = nextQuarantineState(18, false, NOW);
    expect(state.fetch_fail_streak).toBe(19);
    expect(state.fetch_quarantined_until).toBeNull();
  });

  it("streak 20 (19 -> 20) quarantines for 1h", () => {
    const state = nextQuarantineState(19, false, NOW);
    expect(state.fetch_fail_streak).toBe(QUARANTINE_AFTER_FAILURES);
    expect(state.fetch_quarantined_until).toBe(
      new Date(NOW + QUARANTINE_BACKOFF_MS[0]!).toISOString(),
    );
  });

  it("streak 21 quarantines for 6h", () => {
    const state = nextQuarantineState(20, false, NOW);
    expect(state.fetch_fail_streak).toBe(21);
    expect(state.fetch_quarantined_until).toBe(
      new Date(NOW + QUARANTINE_BACKOFF_MS[1]!).toISOString(),
    );
  });

  it("streak 22 and beyond quarantines for 24h (capped)", () => {
    for (const prev of [21, 22, 50]) {
      const state = nextQuarantineState(prev, false, NOW);
      expect(state.fetch_quarantined_until).toBe(
        new Date(NOW + QUARANTINE_BACKOFF_MS[2]!).toISOString(),
      );
    }
  });

  it("a success resets the streak to 0 and clears quarantine, from any prior streak", () => {
    for (const prev of [0, 5, 19, 20, 30]) {
      expect(nextQuarantineState(prev, true, NOW)).toEqual({
        fetch_fail_streak: 0,
        fetch_quarantined_until: null,
      });
    }
  });
});

describe("isQuarantined", () => {
  it("is true when fetch_quarantined_until is in the future", () => {
    const until = new Date(NOW + 60_000).toISOString();
    expect(isQuarantined({ fetch_quarantined_until: until }, NOW)).toBe(true);
  });

  it("is false when fetch_quarantined_until is in the past", () => {
    const until = new Date(NOW - 60_000).toISOString();
    expect(isQuarantined({ fetch_quarantined_until: until }, NOW)).toBe(false);
  });

  it("is false exactly at the boundary (until === now)", () => {
    const until = new Date(NOW).toISOString();
    expect(isQuarantined({ fetch_quarantined_until: until }, NOW)).toBe(false);
  });

  it("is false when null or undefined", () => {
    expect(isQuarantined({ fetch_quarantined_until: null }, NOW)).toBe(false);
    expect(isQuarantined({}, NOW)).toBe(false);
  });

  it("is false (never throws/NaN-compares true) on an unparseable string", () => {
    expect(isQuarantined({ fetch_quarantined_until: "not-a-date" }, NOW)).toBe(false);
  });
});
