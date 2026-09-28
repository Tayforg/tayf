import { describe, it, expect } from "vitest";
import { zoneCountsFromSources, formatZoneLine } from "./zone-line";

describe("zoneCountsFromSources", () => {
  it("tallies each source into its Medya DNA zone", () => {
    const counts = zoneCountsFromSources([
      { bias: "pro_government" },
      { bias: "gov_leaning" },
      { bias: "center" },
      { bias: "opposition" },
      { bias: "opposition" },
    ]);
    expect(counts).toEqual({ iktidar: 2, bagimsiz: 1, muhalefet: 2 });
  });

  it("returns all zeros for an empty list", () => {
    expect(zoneCountsFromSources([])).toEqual({
      iktidar: 0,
      bagimsiz: 0,
      muhalefet: 0,
    });
  });
});

describe("formatZoneLine", () => {
  it("formats in İktidar/Bağımsız/Muhalefet order with a middle dot separator", () => {
    expect(
      formatZoneLine({ iktidar: 3, bagimsiz: 1, muhalefet: 5 }),
    ).toBe("İktidar 3 · Bağımsız 1 · Muhalefet 5");
  });

  it("formats zeros the same way as any other count", () => {
    expect(
      formatZoneLine({ iktidar: 0, bagimsiz: 0, muhalefet: 0 }),
    ).toBe("İktidar 0 · Bağımsız 0 · Muhalefet 0");
  });
});
