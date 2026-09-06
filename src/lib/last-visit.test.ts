import { describe, expect, it } from "vitest";

import { countNewSince, LAST_VISIT_KEY } from "./last-visit";

const ts = ["2026-09-07T10:00:00Z", "2026-09-07T08:00:00Z", "2026-09-06T08:00:00Z"];

describe("countNewSince", () => {
  it("counts timestamps strictly after the stamp", () => {
    expect(countNewSince(ts, "2026-09-07T09:00:00Z")).toBe(1);
  });

  it("treats an equal timestamp as not new", () => {
    expect(countNewSince(ts, "2026-09-07T10:00:00Z")).toBe(0);
  });

  it("returns 0 for a null stamp (first visit)", () => {
    expect(countNewSince(ts, null)).toBe(0);
  });

  it("returns 0 for an unparseable stamp", () => {
    expect(countNewSince(ts, "garbage")).toBe(0);
  });

  it("ignores unparseable entries", () => {
    expect(countNewSince(["nope", ...ts], "2026-09-01T00:00:00Z")).toBe(3);
  });

  it("exposes the storage key", () => {
    expect(LAST_VISIT_KEY).toBe("tayf:last-visit");
  });
});
