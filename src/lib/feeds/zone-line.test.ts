import { describe, it, expect } from "vitest";
import {
  zoneCountsFromSources,
  votingZoneCounts,
  formatZoneLine,
} from "./zone-line";

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

describe("votingZoneCounts", () => {
  it("counts outlet and wire sources", () => {
    const counts = votingZoneCounts([
      { bias: "pro_government", kind: "outlet" },
      { bias: "state_media", kind: "wire" },
      { bias: "center", kind: "outlet" },
      { bias: "opposition", kind: "wire" },
    ]);
    expect(counts).toEqual({ iktidar: 2, bagimsiz: 1, muhalefet: 1 });
  });

  it("excludes aggregator and niche sources (they never vote)", () => {
    const counts = votingZoneCounts([
      { bias: "pro_government", kind: "outlet" },
      { bias: "opposition", kind: "aggregator" },
      { bias: "opposition", kind: "niche" },
      { bias: "center", kind: "aggregator" },
    ]);
    expect(counts).toEqual({ iktidar: 1, bagimsiz: 0, muhalefet: 0 });
  });

  it("counts a source with kind undefined (isVotingKind's default)", () => {
    const counts = votingZoneCounts([
      { bias: "center" },
      { bias: "opposition", kind: undefined },
    ]);
    expect(counts).toEqual({ iktidar: 0, bagimsiz: 1, muhalefet: 1 });
  });

  it("counts a source with kind null (legacy row, isVotingKind's default)", () => {
    const counts = votingZoneCounts([
      { bias: "pro_government", kind: null },
      { bias: "opposition", kind: null },
    ]);
    expect(counts).toEqual({ iktidar: 1, bagimsiz: 0, muhalefet: 1 });
  });

  it("returns all zeros for an empty list", () => {
    expect(votingZoneCounts([])).toEqual({
      iktidar: 0,
      bagimsiz: 0,
      muhalefet: 0,
    });
  });

  it("returns all zeros when every source is non-voting", () => {
    expect(
      votingZoneCounts([
        { bias: "center", kind: "aggregator" },
        { bias: "opposition", kind: "niche" },
      ]),
    ).toEqual({ iktidar: 0, bagimsiz: 0, muhalefet: 0 });
  });

  it("does not change zoneCountsFromSources, which stays the raw tally", () => {
    const sources = [
      { bias: "center", kind: "aggregator" },
      { bias: "center", kind: "outlet" },
    ] as const;
    expect(zoneCountsFromSources(sources)).toEqual({
      iktidar: 0,
      bagimsiz: 2,
      muhalefet: 0,
    });
    expect(votingZoneCounts(sources)).toEqual({
      iktidar: 0,
      bagimsiz: 1,
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
