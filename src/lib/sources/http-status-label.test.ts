import { describe, expect, it } from "vitest";
import { httpStatusLabel } from "./http-status-label";

describe("httpStatusLabel", () => {
  it.each([
    [100, "100"],
    [200, "200"],
    [304, "304"],
    [403, "403"],
    [599, "599"],
  ])("renders the real HTTP status %i as its digits", (status, label) => {
    expect(httpStatusLabel(status)).toBe(label);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["0 (no HTTP answer: DNS failure or timeout)", 0],
    ["-1", -1],
    ["NaN", Number.NaN],
    ["99 (below the 1xx range)", 99],
    ["600 (above the 5xx range)", 600],
    ["99.5 (not an integer)", 99.5],
    ["200.5 (not an integer)", 200.5],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("renders %s as a dash, never a bare number", (_name, status) => {
    expect(httpStatusLabel(status)).toBe("—");
  });
});

describe("httpStatusLabel with a fail streak (h49-ops-1)", () => {
  // A parsed 2xx/304 resets fetch_fail_streak to 0, so a success code that sits
  // next to a streak above 0 means the body was refused (HTML page, parse error).
  it.each([
    [200, 5, "200 · geçersiz akış"],
    [200, 60, "200 · geçersiz akış"],
    [200, 1, "200 · geçersiz akış"],
    [204, 3, "204 · geçersiz akış"],
    [299, 3, "299 · geçersiz akış"],
    [304, 1, "304 · geçersiz akış"],
  ])("marks the success code %i with streak %i as an invalid feed", (status, failStreak, label) => {
    expect(httpStatusLabel(status, { failStreak })).toBe(label);
  });

  it.each([
    ["streak 0", { failStreak: 0 }],
    ["no failStreak key", {}],
    ["streak null", { failStreak: null }],
    ["streak undefined", { failStreak: undefined }],
    ["a negative streak", { failStreak: -1 }],
    ["a NaN streak", { failStreak: Number.NaN }],
  ])("keeps a healthy 200 as its digits with %s", (_name, opts) => {
    expect(httpStatusLabel(200, opts)).toBe("200");
  });

  it("keeps a healthy 304 as its digits with streak 0", () => {
    expect(httpStatusLabel(304, { failStreak: 0 })).toBe("304");
  });

  it("is unchanged for existing one-argument callers", () => {
    expect(httpStatusLabel(200)).toBe("200");
    expect(httpStatusLabel(304)).toBe("304");
    expect(httpStatusLabel(403)).toBe("403");
  });

  it.each([
    [100, "100"],
    [301, "301"],
    [403, "403"],
    [404, "404"],
    [500, "500"],
    [530, "530"],
  ])("never relabels the non-success status %i, whatever the streak", (status, label) => {
    expect(httpStatusLabel(status, { failStreak: 9 })).toBe(label);
  });

  it.each([
    ["0 (no HTTP answer)", 0],
    ["null", null],
    ["undefined", undefined],
  ])("renders %s as a dash even with a streak", (_name, status) => {
    expect(httpStatusLabel(status, { failStreak: 9 })).toBe("—");
  });

  it("does not turn an invalid status into a label", () => {
    expect(httpStatusLabel(200.5, { failStreak: 9 })).toBe("—");
    expect(httpStatusLabel(600, { failStreak: 9 })).toBe("—");
  });
});
