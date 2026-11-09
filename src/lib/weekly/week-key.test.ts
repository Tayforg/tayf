import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  BLINDSPOT_VETO_COVERED_FROM,
  WEEK_ARCHIVE_FIRST,
  isArchiveWeekInRange,
  isBlindspotVetoCovered,
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

describe("isArchiveWeekInRange", () => {
  const CURRENT = "2026-W44";

  it("is false for a key before WEEK_ARCHIVE_FIRST", () => {
    expect(isArchiveWeekInRange("2026-W37", CURRENT)).toBe(false);
    expect(isArchiveWeekInRange("2025-W52", CURRENT)).toBe(false);
  });

  it("is false for a key after the current week", () => {
    expect(isArchiveWeekInRange("2026-W45", CURRENT)).toBe(false);
    expect(isArchiveWeekInRange("2099-W01", CURRENT)).toBe(false);
  });

  it("is true from WEEK_ARCHIVE_FIRST through the current week, both ends inclusive", () => {
    for (const key of [WEEK_ARCHIVE_FIRST, "2026-W40", "2026-W43", CURRENT]) {
      expect(isArchiveWeekInRange(key, CURRENT), key).toBe(true);
    }
  });

  it("crosses a year boundary lexicographically (2026-W53 sits after 2026-W44, before 2027-W01)", () => {
    expect(isArchiveWeekInRange("2026-W53", "2027-W01")).toBe(true);
    expect(isArchiveWeekInRange("2027-W01", "2027-W01")).toBe(true);
    expect(isArchiveWeekInRange("2027-W02", "2027-W01")).toBe(false);
  });

  it("is a pure string range check that does not parse: the caller rejects a malformed key first (parseWeekKey)", () => {
    // "2026-W4" sorts between "2026-W38" and "2026-W44", so the range check alone
    // says true; isServableWeekKey adds the shape check and says false.
    expect(isArchiveWeekInRange("2026-W4", CURRENT)).toBe(true);
    expect(isServableWeekKey("2026-W4", NOW)).toBe(false);
  });

  it("agrees with isServableWeekKey for every parsed key in a sweep around the window", () => {
    const current = weekKeyFromMs(NOW);
    for (let w = 30; w <= 50; w++) {
      const key = `2026-W${String(w).padStart(2, "0")}`;
      expect(isServableWeekKey(key, NOW), key).toBe(isArchiveWeekInRange(key, current));
    }
  });
});

// h92-weeklyarchive-1: W38 was never recall-checked and no week before W44 has
// the sibling-headline veto, so a closed week before the first covered week
// prints counts under a weaker withdrawal standard. The constant is the first
// ISO week judged by both filters; the predicate is a lexical compare because
// keys are zero-padded 'YYYY-Www'.
describe("isBlindspotVetoCovered", () => {
  it("pins the first week judged by both the recall check and the sibling-headline veto", () => {
    expect(BLINDSPOT_VETO_COVERED_FROM).toBe("2026-W44");
  });

  it("starts inside the archive window (an earlier constant would hide nothing)", () => {
    expect(isArchiveWeekInRange(BLINDSPOT_VETO_COVERED_FROM, "2026-W45")).toBe(true);
    expect(BLINDSPOT_VETO_COVERED_FROM > WEEK_ARCHIVE_FIRST).toBe(true);
  });

  it.each([
    ["2026-W38", false], // the archive's first week: 39 of 41 flags never recall-checked
    ["2026-W43", false], // last week before the sibling-headline veto
    ["2026-W44", true], // the first covered week, inclusive
    ["2026-W45", true],
    ["2027-W01", true], // a year boundary sorts after every 2026 key
  ])("%s -> %s", (key, covered) => {
    expect(isBlindspotVetoCovered(key)).toBe(covered);
  });

  it("is a lexical compare that stays chronological across the year boundary", () => {
    // Zero-padded 'YYYY-Www': '2026-W09' < '2026-W44', '2025-W52' < '2026-W44',
    // and a long year's W53 sits between 2026-W44 and 2027-W01.
    expect(isBlindspotVetoCovered("2026-W09")).toBe(false);
    expect(isBlindspotVetoCovered("2025-W52")).toBe(false);
    expect(isBlindspotVetoCovered("2026-W53")).toBe(true);
  });

  it("agrees with the constant for every week of 2026 (a sweep, not a spot check)", () => {
    for (let w = 1; w <= 53; w++) {
      const key = `2026-W${String(w).padStart(2, "0")}`;
      expect(isBlindspotVetoCovered(key), key).toBe(w >= 44);
    }
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
