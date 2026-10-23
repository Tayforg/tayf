import { describe, expect, it } from "vitest";

import { roundPercents } from "@/lib/bias/round-percents";
import { SAVED_MIX_LABELS, SAVED_MIX_MIN_STORIES, savedMix } from "./saved-mix";

type Row = { bias_distribution: unknown };

function rows(...dists: unknown[]): Row[] {
  return dists.map((bias_distribution) => ({ bias_distribution }));
}

function ok(result: ReturnType<typeof savedMix>) {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result;
}

describe("savedMix constants", () => {
  it("requires 3 stories", () => {
    expect(SAVED_MIX_MIN_STORIES).toBe(3);
  });

  it("labels the three balance tiers", () => {
    expect(SAVED_MIX_LABELS).toEqual({
      dengeli: "Dengeli",
      yakin: "Tek tarafa yakın",
      tek: "Tek tarafta",
    });
  });
});

describe("savedMix status", () => {
  it.each([0, 1, 2])("gives too-few for %i rows", (n) => {
    const input = rows(...Array.from({ length: n }, () => ({ pro_government: 9 })));
    expect(savedMix(input)).toEqual({ status: "too-few", stories: n });
  });

  it("gives no-votes when 3 rows have empty or invalid distributions", () => {
    expect(savedMix(rows({}, null, undefined))).toEqual({ status: "no-votes", stories: 3 });
    expect(savedMix(rows("x", 7, [1, 2, 3]))).toEqual({ status: "no-votes", stories: 3 });
    expect(savedMix(rows({ pro_government: 0 }, { foo: 4 }, { center: -2 }))).toEqual({
      status: "no-votes",
      stories: 3,
    });
  });

  it("counts every row in stories, including ones without votes", () => {
    const r = ok(savedMix(rows({ opposition: 2 }, {}, null, { center: 1 })));
    expect(r.stories).toBe(4);
    expect(r.total).toBe(3);
  });
});

describe("savedMix counts and percents", () => {
  const input = rows({ pro_government: 2 }, { center: 1, opposition: 1 }, { opposition: 3 });

  it("sums source votes per zone across stories (not a per-story average)", () => {
    const r = ok(savedMix(input));
    expect(r.counts).toEqual({ iktidar: 2, bagimsiz: 1, muhalefet: 4 });
    expect(r.total).toBe(7);
    expect(r.stories).toBe(3);
  });

  it("uses roundPercents and always adds to 100", () => {
    const r = ok(savedMix(input));
    const [a, b, c] = roundPercents([2, 1, 4]);
    expect(r.percents).toEqual({ iktidar: a, bagimsiz: b, muhalefet: c });
    expect(r.percents.iktidar + r.percents.bagimsiz + r.percents.muhalefet).toBe(100);
  });

  it("adds to 100 for awkward splits (1:1:1)", () => {
    const r = ok(savedMix(rows({ pro_government: 1 }, { center: 1 }, { opposition: 1 })));
    expect(r.percents.iktidar + r.percents.bagimsiz + r.percents.muhalefet).toBe(100);
  });

  it("collapses the 10 bias keys onto the 3 zones", () => {
    const r = ok(
      savedMix(
        rows(
          { gov_leaning: 1, state_media: 1, islamist_conservative: 1, nationalist: 1 },
          { international: 2, pro_kurdish: 1 },
          { opposition_leaning: 2 },
        ),
      ),
    );
    expect(r.counts).toEqual({ iktidar: 4, bagimsiz: 3, muhalefet: 2 });
  });

  it("ignores unknown keys, negative values, NaN, Infinity, strings, arrays and null", () => {
    const r = ok(
      savedMix(
        rows(
          { pro_government: 2, mystery: 50, center: -4, opposition: Number.NaN },
          [5, 5, 5],
          { opposition: Number.POSITIVE_INFINITY, center: "3", international: 1 },
          null,
        ),
      ),
    );
    expect(r.counts).toEqual({ iktidar: 2, bagimsiz: 1, muhalefet: 0 });
    expect(r.total).toBe(3);
  });

  it("ignores inherited prototype keys such as toString", () => {
    const r = ok(savedMix(rows({ toString: 5, constructor: 5, center: 3 }, {}, {})));
    expect(r.counts).toEqual({ iktidar: 0, bagimsiz: 3, muhalefet: 0 });
  });

  it("handles a large number of saved stories", () => {
    const many = Array.from({ length: 10_000 }, (_, i) => ({
      bias_distribution: i % 2 === 0 ? { pro_government: 1 } : { opposition: 1 },
    }));
    const r = ok(savedMix(many));
    expect(r.total).toBe(10_000);
    expect(r.percents).toEqual({ iktidar: 50, bagimsiz: 0, muhalefet: 50 });
  });
});

describe("savedMix balance", () => {
  it("labels {5,0,0} as Tek tarafta with score 0", () => {
    const r = ok(savedMix(rows({ pro_government: 3 }, { gov_leaning: 2 }, {})));
    expect(r.balance).toEqual({ score: 0, label: "Tek tarafta" });
  });

  it("labels {2,2,2} as Dengeli with score 100", () => {
    const r = ok(savedMix(rows({ pro_government: 2 }, { center: 2 }, { opposition: 2 })));
    expect(r.balance).toEqual({ score: 100, label: "Dengeli" });
  });

  it("labels {3,3,0} as Tek tarafa yakın with score 63", () => {
    const r = ok(savedMix(rows({ pro_government: 3 }, { center: 3 }, {})));
    expect(r.balance).toEqual({ score: 63, label: "Tek tarafa yakın" });
  });

  it("returns balance null below 5 classified sources (total 4)", () => {
    const r = ok(savedMix(rows({ pro_government: 2 }, { center: 1 }, { opposition: 1 })));
    expect(r.total).toBe(4);
    expect(r.balance).toBeNull();
  });

  it("computes the balance at exactly 5 classified sources", () => {
    const r = ok(savedMix(rows({ pro_government: 2 }, { center: 2 }, { opposition: 1 })));
    expect(r.total).toBe(5);
    expect(r.balance).not.toBeNull();
  });
});

describe("savedMix purity", () => {
  it("does not mutate the input rows or their distributions", () => {
    const input = rows({ pro_government: 2, mystery: 1 }, { center: 1, opposition: 1 }, { opposition: 3 });
    const before = JSON.stringify(input);
    const frozen = input.map((r) => Object.freeze({ ...r }));
    Object.freeze(frozen);
    savedMix(frozen);
    expect(JSON.stringify(input)).toBe(before);
  });
});
