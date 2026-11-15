import { describe, it, expect } from "vitest";
import {
  zoneCountsFromSources,
  votingZoneCounts,
  formatZoneLine,
  sourceCountHead,
  wireSourceCountHead,
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

describe("sourceCountHead", () => {
  it("adds the classified (voting) count in parentheses when some members do not vote", () => {
    expect(
      sourceCountHead(10, { iktidar: 8, bagimsiz: 0, muhalefet: 0 }),
    ).toBe("10 kaynak (8 sınıflandırılmış)");
  });

  it("prints the bare count when every member votes (zone sum equals the total)", () => {
    expect(
      sourceCountHead(7, { iktidar: 4, bagimsiz: 2, muhalefet: 1 }),
    ).toBe("7 kaynak");
  });

  it("says 0 sınıflandırılmış when no member votes", () => {
    expect(
      sourceCountHead(3, { iktidar: 0, bagimsiz: 0, muhalefet: 0 }),
    ).toBe("3 kaynak (0 sınıflandırılmış)");
  });

  it("keeps the bare count when the zones sum to more than the total (defensive: synthetic or stale tallies)", () => {
    expect(
      sourceCountHead(2, { iktidar: 4, bagimsiz: 1, muhalefet: 0 }),
    ).toBe("2 kaynak");
  });

  it("prints an empty cluster as 0 kaynak, with no parentheses", () => {
    expect(
      sourceCountHead(0, { iktidar: 0, bagimsiz: 0, muhalefet: 0 }),
    ).toBe("0 kaynak");
  });

  it("never changes the number of ' · ' parts of a description built around it", () => {
    for (const [total, counts] of [
      [10, { iktidar: 8, bagimsiz: 0, muhalefet: 0 }],
      [7, { iktidar: 4, bagimsiz: 2, muhalefet: 1 }],
      [3, { iktidar: 0, bagimsiz: 0, muhalefet: 0 }],
    ] as const) {
      const description = `${sourceCountHead(total, counts)} · ${formatZoneLine(counts)}`;
      expect(description.split(" · ")).toHaveLength(4);
    }
  });
});

// h190-share-1: the share surfaces (embed legend, rozet badge, OG pill) print the
// distinct-text count of a wire redistribution as 'N kaynak' next to percents
// over MORE votes (3 kaynak beside %50/%50: 4 + 4 votes). For a wire cluster
// whose classified votes M exceed N the head says so, in the text-context form
// 'N kaynak · M sınıflandırılmış'. Every other case is sourceCountHead's.
describe("wireSourceCountHead", () => {
  it("532ee77c: a wire cluster with 3 distinct texts and 8 votes reads '3 kaynak · 8 sınıflandırılmış'", () => {
    expect(
      wireSourceCountHead(3, { iktidar: 4, bagimsiz: 4, muhalefet: 0 }, true),
    ).toBe("3 kaynak · 8 sınıflandırılmış");
  });

  it("pins the existing stale-tally rule: the same counts without the wire flag keep the bare count", () => {
    expect(
      wireSourceCountHead(3, { iktidar: 4, bagimsiz: 4, muhalefet: 0 }, false),
    ).toBe("3 kaynak");
    expect(
      wireSourceCountHead(3, { iktidar: 4, bagimsiz: 4, muhalefet: 0 }, false),
    ).toBe(sourceCountHead(3, { iktidar: 4, bagimsiz: 4, muhalefet: 0 }));
  });

  it("a wire cluster whose votes are below the count is sourceCountHead's parenthesised form", () => {
    const counts = { iktidar: 8, bagimsiz: 0, muhalefet: 0 };
    expect(wireSourceCountHead(10, counts, true)).toBe("10 kaynak (8 sınıflandırılmış)");
    expect(wireSourceCountHead(10, counts, true)).toBe(sourceCountHead(10, counts));
  });

  it("a wire cluster whose votes equal the count keeps the bare count", () => {
    expect(
      wireSourceCountHead(7, { iktidar: 4, bagimsiz: 2, muhalefet: 1 }, true),
    ).toBe("7 kaynak");
  });

  it("an empty cluster is '0 kaynak', wire or not, even with a stale tally", () => {
    const zero = { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
    expect(wireSourceCountHead(0, zero, true)).toBe("0 kaynak");
    expect(wireSourceCountHead(0, zero, false)).toBe("0 kaynak");
    expect(
      wireSourceCountHead(0, { iktidar: 2, bagimsiz: 0, muhalefet: 0 }, true),
    ).toBe("0 kaynak");
  });

  it("is exactly as long as the parenthesised head, so the embed's layout budget is unchanged", () => {
    const parenthesised = sourceCountHead(3, { iktidar: 2, bagimsiz: 0, muhalefet: 0 });
    expect(parenthesised).toBe("3 kaynak (2 sınıflandırılmış)");
    expect(parenthesised).toHaveLength(29);
    const wire = wireSourceCountHead(3, { iktidar: 4, bagimsiz: 4, muhalefet: 0 }, true);
    expect(wire).toHaveLength(parenthesised.length);
  });

  it("leaves sourceCountHead itself on the bare-count rule for a stale tally", () => {
    expect(
      sourceCountHead(3, { iktidar: 4, bagimsiz: 4, muhalefet: 0 }),
    ).toBe("3 kaynak");
  });
});
