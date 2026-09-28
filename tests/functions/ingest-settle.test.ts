import { describe, expect, it } from "vitest";
import {
  collectSourceIds,
  partitionDeferred,
  partitionWithRowErrorGrace,
} from "../../supabase/functions/ingest/settle.ts";

// silent-feeds: pure helpers that decide which deferred sources may have
// their fresh validators committed (all rows settled) and which are withheld.

describe("collectSourceIds", () => {
  it("adds every distinct source_id into the set", () => {
    const into = new Set<string>();
    collectSourceIds(
      [{ source_id: "a" }, { source_id: "b" }, { source_id: "a" }],
      into,
    );
    expect([...into].sort()).toEqual(["a", "b"]);
  });

  it("is additive across calls and tolerates an empty list", () => {
    const into = new Set<string>(["x"]);
    collectSourceIds([], into);
    expect([...into]).toEqual(["x"]);
    collectSourceIds([{ source_id: "y" }], into);
    expect([...into].sort()).toEqual(["x", "y"]);
  });

  it("ignores extra row fields", () => {
    const into = new Set<string>();
    collectSourceIds([{ source_id: "a", url: "https://e.com/1", title: "t" }], into);
    expect([...into]).toEqual(["a"]);
  });
});

describe("partitionDeferred", () => {
  it("splits into settled and withheld, preserving input order", () => {
    const { settled, withheld } = partitionDeferred(
      ["d", "a", "c", "b"],
      new Set(["a", "b"]),
    );
    expect(settled).toEqual(["d", "c"]);
    expect(withheld).toEqual(["a", "b"]);
  });

  it("everything is settled when nothing is unsettled", () => {
    expect(partitionDeferred(["a", "b"], new Set())).toEqual({
      settled: ["a", "b"],
      withheld: [],
    });
  });

  it("empty deferred input yields two empty lists", () => {
    expect(partitionDeferred([], new Set(["a"]))).toEqual({ settled: [], withheld: [] });
  });

  it("the two lists are disjoint and together cover the input", () => {
    const input = ["s1", "s2", "s3", "s4", "s5"];
    const { settled, withheld } = partitionDeferred(new Set(input), new Set(["s2", "s5", "zzz"]));
    expect(settled.filter((x) => withheld.includes(x))).toEqual([]);
    expect([...settled, ...withheld].sort()).toEqual(input);
  });

  it("accepts any iterable (Map keys)", () => {
    const m = new Map([["a", 1], ["b", 2]]);
    expect(partitionDeferred(m.keys(), new Set(["b"]))).toEqual({
      settled: ["a"],
      withheld: ["b"],
    });
  });
});

describe("partitionWithRowErrorGrace", () => {
  it("withholds row-error sources for max cycles, then commits (poison row)", () => {
    const streaks = new Map<string, number>();
    const run = () =>
      partitionWithRowErrorGrace(["a"], new Set(), new Set(["a"]), streaks, 3);
    expect(run().withheld).toEqual(["a"]);
    expect(run().withheld).toEqual(["a"]);
    expect(run().withheld).toEqual(["a"]);
    const fourth = run();
    expect(fourth.settled).toEqual(["a"]);
    expect(fourth.gaveUp).toEqual(["a"]);
    expect(run().settled).toEqual(["a"]);
  });

  it("always withholds deadline-unsettled sources without bumping the streak", () => {
    const streaks = new Map<string, number>();
    for (let i = 0; i < 5; i++) {
      const r = partitionWithRowErrorGrace(["a"], new Set(["a"]), new Set(["a"]), streaks, 3);
      expect(r.withheld).toEqual(["a"]);
    }
    expect(streaks.get("a")).toBeUndefined();
  });

  it("clears the streak once a deferred cycle has no row error", () => {
    const streaks = new Map<string, number>([["a", 2]]);
    const r = partitionWithRowErrorGrace(["a"], new Set(), new Set(), streaks, 3);
    expect(r.settled).toEqual(["a"]);
    expect(streaks.has("a")).toBe(false);
  });

  it("settles clean sources and reports streaks for withheld ones", () => {
    const streaks = new Map<string, number>();
    const r = partitionWithRowErrorGrace(["a", "b"], new Set(), new Set(["b"]), streaks);
    expect(r.settled).toEqual(["a"]);
    expect(r.withheld).toEqual(["b"]);
    expect(r.streakOf.get("b")).toBe(1);
  });
});
