import { describe, expect, it } from "vitest";

import { UPDATE_CUE_MIN_MS, clusterUpdateCue } from "./update-cue";

const FIRST = "2026-09-06T10:00:00.000Z";
const UPDATED = "2026-09-06T12:00:00.000Z";

describe("UPDATE_CUE_MIN_MS", () => {
  it("is 30 minutes", () => {
    expect(UPDATE_CUE_MIN_MS).toBe(30 * 60_000);
  });
});

describe("clusterUpdateCue", () => {
  it("returns the latest member time as ISO when it is 2 h after the first", () => {
    expect(clusterUpdateCue(FIRST, UPDATED, [FIRST, "2026-09-06T12:00:00.000Z"])).toBe(
      "2026-09-06T12:00:00.000Z",
    );
  });

  it("normalises an offset timestamp to a UTC ISO string", () => {
    expect(
      clusterUpdateCue(FIRST, UPDATED, [FIRST, "2026-09-06T14:00:00+03:00"]),
    ).toBe("2026-09-06T11:00:00.000Z");
  });

  it("returns null when the latest member is exactly 30 minutes after the first", () => {
    expect(clusterUpdateCue(FIRST, UPDATED, [FIRST, "2026-09-06T10:30:00.000Z"])).toBeNull();
  });

  it("returns an ISO one millisecond past the 30 minute threshold", () => {
    expect(clusterUpdateCue(FIRST, UPDATED, [FIRST, "2026-09-06T10:30:00.001Z"])).toBe(
      "2026-09-06T10:30:00.001Z",
    );
  });

  it("returns null when the latest member is only 10 minutes after the first", () => {
    expect(clusterUpdateCue(FIRST, UPDATED, [FIRST, "2026-09-06T10:10:00.000Z"])).toBeNull();
  });

  it("uses the maximum member time, not the last in the list", () => {
    expect(
      clusterUpdateCue(FIRST, UPDATED, [
        "2026-09-06T11:45:00.000Z",
        FIRST,
        "2026-09-06T10:05:00.000Z",
      ]),
    ).toBe("2026-09-06T11:45:00.000Z");
  });

  it("clamps a future-dated member to updatedAt", () => {
    expect(
      clusterUpdateCue(FIRST, UPDATED, [FIRST, "2026-09-07T09:00:00.000Z"]),
    ).toBe("2026-09-06T12:00:00.000Z");
  });

  it("returns null when the clamped time is still within the threshold", () => {
    expect(
      clusterUpdateCue(FIRST, "2026-09-06T10:20:00.000Z", [
        FIRST,
        "2026-09-07T09:00:00.000Z",
      ]),
    ).toBeNull();
  });

  it("does not cap when updatedAt is unparseable", () => {
    expect(
      clusterUpdateCue(FIRST, "not-a-date", [FIRST, "2026-09-06T13:00:00.000Z"]),
    ).toBe("2026-09-06T13:00:00.000Z");
  });

  it("returns null for an empty member list", () => {
    expect(clusterUpdateCue(FIRST, UPDATED, [])).toBeNull();
  });

  it("returns null when firstPublished is unparseable", () => {
    expect(clusterUpdateCue("garbage", UPDATED, [FIRST, UPDATED])).toBeNull();
    expect(clusterUpdateCue("", UPDATED, [FIRST, UPDATED])).toBeNull();
  });

  it("returns null when no member time parses", () => {
    expect(clusterUpdateCue(FIRST, UPDATED, ["garbage", "", "yesterday"])).toBeNull();
  });

  it("ignores unparseable member times alongside valid ones", () => {
    expect(
      clusterUpdateCue(FIRST, UPDATED, ["garbage", "2026-09-06T11:00:00.000Z"]),
    ).toBe("2026-09-06T11:00:00.000Z");
  });

  it("returns null when every member is at or before the first published time", () => {
    expect(
      clusterUpdateCue(FIRST, UPDATED, ["2026-09-06T09:00:00.000Z", FIRST]),
    ).toBeNull();
  });
});
