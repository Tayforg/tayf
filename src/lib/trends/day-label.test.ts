import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { dayLabelTr } from "./day-label";

// h63-timezones-1: the label helper the /trends chart table already used
// ("4 Ekim"), now shared with the "Yükselen Konular" card so that card prints
// the date of the day it ranked instead of a "Bugün"/"Dün" word that goes stale
// inside a cache entry served past Istanbul midnight.

describe("dayLabelTr", () => {
  it("turns '2026-10-04' into '4 Ekim'", () => {
    expect(dayLabelTr("2026-10-04")).toBe("4 Ekim");
  });

  it.each([
    ["2026-10-04", "4 Ekim"],
    ["2026-01-01", "1 Ocak"],
    ["2026-08-31", "31 Ağustos"],
    ["2026-12-09", "9 Aralık"],
    ["2026-02-10", "10 Şubat"],
    ["2026-03-15", "15 Mart"],
    ["2026-04-20", "20 Nisan"],
    ["2026-05-02", "2 Mayıs"],
    ["2026-06-30", "30 Haziran"],
    ["2026-07-07", "7 Temmuz"],
    ["2026-09-21", "21 Eylül"],
    ["2026-11-02", "2 Kasım"],
    ["2026-11-07", "7 Kasım"],
    ["2026-11-08", "8 Kasım"],
  ])("%s reads %s (full month name, no leading zero)", (day, label) => {
    expect(dayLabelTr(day)).toBe(label);
  });

  it.each([
    "bad",
    "",
    "2026-10",
    "2026-10-4",
    "2026-13-01",
    "2026-00-10",
    "2026-10-00",
    "2026-10-32",
    "2026-10-04T00:00",
  ])("returns the raw key %j as is when it is not a valid YYYY-MM-DD", (day) => {
    expect(dayLabelTr(day)).toBe(day);
  });
});

describe("day-label.ts: source guard", () => {
  const source = readFileSync(resolve(__dirname, "day-label.ts"), "utf8");
  // Strip comments so prose mentioning Date/Intl does not trip the guard.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("is pure: no Date, no Intl, so server, browsers and tests print the same label", () => {
    expect(code).not.toMatch(/\bDate\b/);
    expect(code).not.toMatch(/\bIntl\b/);
  });

  it("keeps its own month table instead of importing from the weekly files", () => {
    expect(code).toContain("MONTHS_TR");
    expect(code).not.toMatch(/from\s+["'][^"']*weekly/);
  });

  it("exports dayLabelTr", () => {
    expect(code).toMatch(/export function dayLabelTr\(/);
  });
});
