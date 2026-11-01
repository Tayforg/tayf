import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  WEEK_ARCHIVE_FIRST,
  isServableWeekKey,
  isoWeekKeyOf,
  parseWeekKey,
  weekKeyFromMs,
} from "./week-key";

// 2026-11-01 12:00 UTC is a Sunday: ISO week 2026-W44 (Mon 26 Oct - Sun 1 Nov).
const NOW = Date.UTC(2026, 10, 1, 12);

describe("week-key — basics", () => {
  it("exposes the first archive week", () => {
    expect(WEEK_ARCHIVE_FIRST).toBe("2026-W38");
  });

  it("parseWeekKey accepts a well-formed key", () => {
    expect(parseWeekKey("2026-W44")).toEqual({ isoYear: 2026, week: 44 });
  });

  it("parseWeekKey rejects W00, W54, malformed and lower-case keys", () => {
    for (const bad of ["2026-W00", "2026-W54", "2026-W4", "2026-w44", "garbage", ""]) {
      expect(parseWeekKey(bad), bad).toBeNull();
    }
  });

  it("parseWeekKey rejects W53 in a 52-week year and accepts it in a long one", () => {
    expect(parseWeekKey("2025-W53")).toBeNull();
    expect(parseWeekKey("2026-W53")).toEqual({ isoYear: 2026, week: 53 });
  });

  it("weekKeyFromMs keys the Istanbul calendar date (fixed +03)", () => {
    expect(weekKeyFromMs(NOW)).toBe("2026-W44");
    // 22:00Z on Sunday 27 Sep is already Monday 28 Sep in Istanbul.
    expect(weekKeyFromMs(Date.parse("2026-09-27T22:00:00.000Z"))).toBe("2026-W40");
    expect(weekKeyFromMs(Date.parse("2026-09-27T20:59:59.000Z"))).toBe("2026-W39");
  });

  it("isoWeekKeyOf maps a plain date key", () => {
    expect(isoWeekKeyOf("2027-01-01")).toBe("2026-W53");
  });
});

describe("isServableWeekKey", () => {
  it("rejects garbage, malformed, lower-case, pre-archive, future and absurd keys", () => {
    for (const key of [
      "garbage",
      "",
      "2026-W4",
      "2026-w44",
      "2026-W37", // before WEEK_ARCHIVE_FIRST
      "2026-W45", // next week
      "2099-W01",
      "2026-W00",
      "2026-W54",
      " 2026-W44",
      "2026-W44 ",
    ]) {
      expect(isServableWeekKey(key, NOW), key).toBe(false);
    }
  });

  it("serves the first archive week, a middle week and the current week", () => {
    for (const key of ["2026-W38", "2026-W43", "2026-W44"]) {
      expect(isServableWeekKey(key, NOW), key).toBe(true);
    }
  });

  it("the current week rolls over with the Istanbul calendar, not UTC", () => {
    // Sunday 1 Nov 22:00Z is Monday 2 Nov 01:00 in Istanbul: W45 is now current.
    const rolled = Date.UTC(2026, 10, 1, 22);
    expect(isServableWeekKey("2026-W45", rolled)).toBe(true);
    expect(isServableWeekKey("2026-W45", Date.UTC(2026, 10, 1, 20))).toBe(false);
  });

  it("an out-of-year long week (W53) is only servable once it exists", () => {
    const lateDec = Date.UTC(2026, 11, 30, 12); // 2026-W53
    expect(weekKeyFromMs(lateDec)).toBe("2026-W53");
    expect(isServableWeekKey("2026-W53", lateDec)).toBe(true);
    expect(isServableWeekKey("2026-W53", NOW)).toBe(false);
  });
});

describe("week-key — module hygiene", () => {
  it("has no import statements (it is bundled into the Edge middleware)", () => {
    const src = readFileSync(resolve(__dirname, "week-key.ts"), "utf8");
    expect(src).not.toMatch(/^\s*import[\s{*"']/m);
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).not.toMatch(/\bimport\(/);
  });
});
