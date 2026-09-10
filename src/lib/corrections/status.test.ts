import { describe, it, expect } from "vitest";
import {
  CORRECTION_STATUSES,
  CORRECTION_STATUS_LABELS_TR,
  correctionStatusLabel,
  isCorrectionStatus,
} from "./status";

describe("CORRECTION_STATUSES", () => {
  it("is exactly open, reviewed, dismissed in order", () => {
    expect(CORRECTION_STATUSES).toEqual(["open", "reviewed", "dismissed"]);
  });
});

describe("isCorrectionStatus", () => {
  it("accepts each known status", () => {
    for (const status of CORRECTION_STATUSES) {
      expect(isCorrectionStatus(status)).toBe(true);
    }
  });

  it("rejects the retired 033 vocabulary", () => {
    expect(isCorrectionStatus("new")).toBe(false);
    expect(isCorrectionStatus("resolved")).toBe(false);
  });

  it("rejects other invalid inputs", () => {
    expect(isCorrectionStatus("")).toBe(false);
    expect(isCorrectionStatus(null)).toBe(false);
    expect(isCorrectionStatus(undefined)).toBe(false);
    expect(isCorrectionStatus(0)).toBe(false);
    expect(isCorrectionStatus("OPEN")).toBe(false);
  });
});

describe("CORRECTION_STATUS_LABELS_TR", () => {
  it("has a non-empty Turkish label for every status", () => {
    for (const status of CORRECTION_STATUSES) {
      expect(typeof CORRECTION_STATUS_LABELS_TR[status]).toBe("string");
      expect(CORRECTION_STATUS_LABELS_TR[status].length).toBeGreaterThan(0);
    }
  });
});

describe("correctionStatusLabel", () => {
  it("returns the Turkish label for a known status", () => {
    expect(correctionStatusLabel("open")).toBe("Açık");
    expect(correctionStatusLabel("reviewed")).toBe("İncelendi");
    expect(correctionStatusLabel("dismissed")).toBe("Reddedildi");
  });

  it("returns the raw value for a legacy/unknown status", () => {
    expect(correctionStatusLabel("new")).toBe("new");
    expect(correctionStatusLabel("resolved")).toBe("resolved");
  });
});
