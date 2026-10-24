import { describe, expect, it } from "vitest";

import {
  classifySilence,
  FROZEN_FEED_MS,
  SILENCE_REASON_LABEL,
  type SilenceInput,
} from "./silence-reason";

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

function input(overrides: Partial<SilenceInput> = {}): SilenceInput {
  return {
    lastHttpStatus: 200,
    failStreak: 0,
    quarantined: false,
    newestFeedItemAt: ago(HOUR),
    feedItemsCount: 20,
    ...overrides,
  };
}

describe("silence-reason constants", () => {
  it("FROZEN_FEED_MS is 72 hours, clearly longer than the 24 h silence window of ops_health_report row 13", () => {
    expect(FROZEN_FEED_MS).toBe(72 * 60 * 60 * 1000);
    expect(FROZEN_FEED_MS).toBeGreaterThan(24 * 60 * 60 * 1000);
  });

  it("has the three Turkish labels the page and ops_health_report share", () => {
    expect(SILENCE_REASON_LABEL).toEqual({
      akis_donmus: "akış donmuş",
      erisim_yok: "erişim yok",
      sessiz: "sessiz",
    });
  });
});

describe("classifySilence", () => {
  it("exactly 72 h is not frozen; 72 h + 1 ms is", () => {
    expect(classifySilence(input({ newestFeedItemAt: ago(FROZEN_FEED_MS) }), NOW)).toBe("sessiz");
    expect(classifySilence(input({ newestFeedItemAt: ago(FROZEN_FEED_MS + 1) }), NOW)).toBe("akis_donmus");
  });

  it("an empty feed (count 0) is frozen even without a newest date", () => {
    expect(classifySilence(input({ feedItemsCount: 0, newestFeedItemAt: null }), NOW)).toBe("akis_donmus");
  });

  it("status 0 (network error) and 500 are erisim_yok", () => {
    expect(classifySilence(input({ lastHttpStatus: 0 }), NOW)).toBe("erisim_yok");
    expect(classifySilence(input({ lastHttpStatus: 500 }), NOW)).toBe("erisim_yok");
    expect(classifySilence(input({ lastHttpStatus: 403 }), NOW)).toBe("erisim_yok");
    expect(classifySilence(input({ lastHttpStatus: 404 }), NOW)).toBe("erisim_yok");
  });

  it("an unknown last status (null) is erisim_yok", () => {
    expect(classifySilence(input({ lastHttpStatus: null }), NOW)).toBe("erisim_yok");
  });

  it("304 counts as reachable: a fresh newest item gives sessiz", () => {
    expect(classifySilence(input({ lastHttpStatus: 304 }), NOW)).toBe("sessiz");
  });

  it("any 2xx is reachable", () => {
    for (const status of [200, 201, 204, 299]) {
      expect(classifySilence(input({ lastHttpStatus: status }), NOW), String(status)).toBe("sessiz");
    }
    expect(classifySilence(input({ lastHttpStatus: 300 }), NOW)).toBe("erisim_yok");
    expect(classifySilence(input({ lastHttpStatus: 199 }), NOW)).toBe("erisim_yok");
  });

  it("200 with failStreak 2 is erisim_yok (the last parse failed)", () => {
    expect(classifySilence(input({ failStreak: 2 }), NOW)).toBe("erisim_yok");
  });

  it("a quarantined source is erisim_yok whatever its feed said last", () => {
    expect(classifySilence(input({ quarantined: true }), NOW)).toBe("erisim_yok");
    expect(
      classifySilence(input({ quarantined: true, newestFeedItemAt: ago(100 * HOUR) }), NOW),
    ).toBe("erisim_yok");
  });

  it("erisim_yok wins over a frozen feed (same order as the SQL)", () => {
    expect(
      classifySilence(input({ lastHttpStatus: 403, newestFeedItemAt: ago(100 * HOUR), feedItemsCount: 0 }), NOW),
    ).toBe("erisim_yok");
  });

  it("null / null (never measured) is sessiz, not frozen", () => {
    expect(classifySilence(input({ newestFeedItemAt: null, feedItemsCount: null }), NOW)).toBe("sessiz");
  });

  it("an undated feed (count > 0, newest null) is sessiz", () => {
    expect(classifySilence(input({ newestFeedItemAt: null, feedItemsCount: 12 }), NOW)).toBe("sessiz");
  });

  it("a frozen feed is akis_donmus when reachable", () => {
    expect(classifySilence(input({ newestFeedItemAt: ago(100 * HOUR) }), NOW)).toBe("akis_donmus");
    expect(classifySilence(input({ lastHttpStatus: 304, newestFeedItemAt: ago(100 * HOUR) }), NOW)).toBe(
      "akis_donmus",
    );
  });

  it("an outlet that merely paused (newest feed item 25-71 h old, HTTP 200, no failures) is sessiz, not frozen", () => {
    for (const hours of [25, 30, 48, 71]) {
      expect(classifySilence(input({ newestFeedItemAt: ago(hours * HOUR) }), NOW), `${hours} h`).toBe("sessiz");
    }
  });

  it("an unparseable newest date is never frozen", () => {
    expect(classifySilence(input({ newestFeedItemAt: "not a date" }), NOW)).toBe("sessiz");
  });

  it("a newest item in the future is not frozen", () => {
    expect(classifySilence(input({ newestFeedItemAt: new Date(NOW + HOUR).toISOString() }), NOW)).toBe("sessiz");
  });
});
