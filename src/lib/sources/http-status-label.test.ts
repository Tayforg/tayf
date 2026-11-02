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
