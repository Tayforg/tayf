import { describe, it, expect } from "vitest";
import {
  isClassifiedSource,
  countClassifiedSources,
  UNCLASSIFIED_LABEL_TR,
  UNCLASSIFIED_TITLE_TR,
} from "./classification";

describe("isClassifiedSource", () => {
  it("is true for a source with tagged factuality + ownership", () => {
    expect(isClassifiedSource("sabah")).toBe(true);
  });

  it("is true for another tagged source (state media)", () => {
    expect(isClassifiedSource("anadolu-ajansi")).toBe(true);
  });

  it("is false for a slug with no metadata entry", () => {
    expect(isClassifiedSource("bilinmeyen-kaynak")).toBe(false);
  });

  it("is false for an empty slug", () => {
    expect(isClassifiedSource("")).toBe(false);
  });
});

describe("countClassifiedSources", () => {
  it("counts tagged slugs only", () => {
    expect(countClassifiedSources(["sabah", "anadolu-ajansi"])).toBe(2);
  });

  it("excludes slugs with no metadata entry", () => {
    expect(countClassifiedSources(["sabah", "bilinmeyen-kaynak"])).toBe(1);
  });

  it("is 0 for an empty list", () => {
    expect(countClassifiedSources([])).toBe(0);
  });

  it("is 0 when every slug is unknown", () => {
    expect(
      countClassifiedSources(["bilinmeyen-kaynak", "baska-bilinmeyen"]),
    ).toBe(0);
  });
});

describe("classification copy", () => {
  it("labels are non-empty", () => {
    expect(UNCLASSIFIED_LABEL_TR.length).toBeGreaterThan(0);
    expect(UNCLASSIFIED_TITLE_TR.length).toBeGreaterThan(0);
  });

  it("the chip label is exactly lowercase 'sınıflandırılmamış'", () => {
    expect(UNCLASSIFIED_LABEL_TR).toBe("sınıflandırılmamış");
  });
});
