import { describe, it, expect } from "vitest";
import {
  formatTurkishTimeAgo,
  formatTurkishDate,
  ABSOLUTE_AFTER_MS,
} from "./time";

// Fixed base instant so the suite is independent of the machine clock and
// of the process TZ (see the `TZ=America/Los_Angeles` run in the worker
// brief — `formatTurkishDate` pins `Europe/Istanbul` explicitly, so it must
// not budge no matter what TZ the test runner itself uses).
const NOW = Date.parse("2026-06-15T12:00:00Z");

function isoMsAgo(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

describe("formatTurkishTimeAgo", () => {
  it("30s ago -> az önce", () => {
    expect(formatTurkishTimeAgo(isoMsAgo(30 * SECOND_MS), { now: NOW })).toBe(
      "az önce",
    );
  });

  it("1 minute ago -> 1 dakika önce", () => {
    expect(formatTurkishTimeAgo(isoMsAgo(MINUTE_MS), { now: NOW })).toBe(
      "1 dakika önce",
    );
  });

  it("3 hours ago -> 3 saat önce", () => {
    expect(formatTurkishTimeAgo(isoMsAgo(3 * HOUR_MS), { now: NOW })).toBe(
      "3 saat önce",
    );
  });

  it("47h59m ago -> 1 gün önce (just under the 48h threshold)", () => {
    const delta = 47 * HOUR_MS + 59 * MINUTE_MS;
    expect(formatTurkishTimeAgo(isoMsAgo(delta), { now: NOW })).toBe(
      "1 gün önce",
    );
  });

  it("exactly 48h ago -> absolute date", () => {
    const dateISO = isoMsAgo(ABSOLUTE_AFTER_MS);
    expect(formatTurkishTimeAgo(dateISO, { now: NOW })).toBe(
      formatTurkishDate(dateISO),
    );
  });

  it("5 days ago -> absolute date", () => {
    const dateISO = isoMsAgo(5 * DAY_MS);
    expect(formatTurkishTimeAgo(dateISO, { now: NOW })).toBe(
      formatTurkishDate(dateISO),
    );
  });

  it("a future date -> az önce (Math.max(0, …) clamp)", () => {
    const future = new Date(NOW + HOUR_MS).toISOString();
    expect(formatTurkishTimeAgo(future, { now: NOW })).toBe("az önce");
  });

  it("empty string -> ''", () => {
    expect(formatTurkishTimeAgo("", { now: NOW })).toBe("");
  });

  it("unparseable input -> ''", () => {
    expect(formatTurkishTimeAgo("not-a-date", { now: NOW })).toBe("");
  });

  it("defaults `now` to Date.now() when omitted (no opts arg required)", () => {
    // Backwards-compat: the single-arg call shape must still compile and
    // run — a "just now" timestamp should still read "az önce".
    expect(formatTurkishTimeAgo(new Date().toISOString())).toBe("az önce");
  });

  it("a custom absoluteAfterMs still returns the relative ladder at 72h", () => {
    const dateISO = isoMsAgo(72 * HOUR_MS);
    expect(
      formatTurkishTimeAgo(dateISO, {
        now: NOW,
        absoluteAfterMs: 7 * DAY_MS,
      }),
    ).toBe("3 gün önce");
  });
});

describe("formatTurkishDate", () => {
  it("pins Europe/Istanbul regardless of the runtime TZ", () => {
    // 21:30 UTC is 00:30 the *next* day in Istanbul (UTC+3) — a formatter
    // that forgot to pin the zone would render '1 Eylül 2026' here.
    expect(formatTurkishDate("2026-09-01T21:30:00Z")).toBe("2 Eylül 2026");
  });

  it("returns '' for an unparseable input", () => {
    expect(formatTurkishDate("not-a-date")).toBe("");
  });

  it("returns '' for an empty string", () => {
    expect(formatTurkishDate("")).toBe("");
  });
});
