import { describe, expect, it } from "vitest";

import { trendBarTitle } from "./bar-title";

// The bar <title> is the chart bar's accessible name: a screen reader reads
// "3830" for the raw interpolation and "3.830" (the form the rest of /trends
// uses) for the tr-TR grouped one. h29-regress-2.
describe("trendBarTitle", () => {
  it("groups a four-digit count with a dot", () => {
    expect(trendBarTitle("2026-10-05", "İktidar", 3830)).toBe("2026-10-05 · İktidar: 3.830");
    expect(trendBarTitle("2026-10-05", "İktidar", 1146)).toBe("2026-10-05 · İktidar: 1.146");
  });

  it("leaves a count under 1000 as it is", () => {
    expect(trendBarTitle("2026-10-05", "Muhalefet", 4)).toBe("2026-10-05 · Muhalefet: 4");
    expect(trendBarTitle("2026-10-05", "Muhalefet", 999)).toBe("2026-10-05 · Muhalefet: 999");
  });

  it("groups a five- and a seven-digit count", () => {
    expect(trendBarTitle("2026-10-05", "Bağımsız", 12345)).toBe("2026-10-05 · Bağımsız: 12.345");
    expect(trendBarTitle("2026-10-05", "Bağımsız", 1234567)).toBe("2026-10-05 · Bağımsız: 1.234.567");
  });

  it("is one string with the day, the label and the count in that order", () => {
    expect(typeof trendBarTitle("2026-10-05", "İktidar", 0)).toBe("string");
    expect(trendBarTitle("2026-10-05", "İktidar", 0)).toBe("2026-10-05 · İktidar: 0");
  });
});
