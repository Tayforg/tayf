import { describe, it, expect } from "vitest";

import {
  pickBlindspotList,
  sortBlindspotClaims,
  type PickableClaim,
} from "./blindspot-pick";
import type { MediaDnaZone } from "@/types";

// h53-consistency-1: /blindspots used to show the 30 most lopsided of the 50
// most recently updated claims, so a 41 Iktidar : 9 Muhalefet week printed as
// 28 : 2. The pick below is side-balanced (round-robin across the sides) and
// then ordered by how lopsided each claim is.

const T0 = Date.parse("2026-11-05T12:00:00.000Z");

function claim(
  id: string,
  zone: MediaDnaZone,
  pct: number,
  updatedMinutesAgo = 0,
): PickableClaim {
  return {
    cluster: {
      id,
      updated_at: new Date(T0 - updatedMinutesAgo * 60_000).toISOString(),
    },
    dominantZone: zone,
    dominantPct: pct,
  };
}

const ids = (rows: readonly PickableClaim[]) => rows.map((r) => r.cluster.id);

/** 41 Iktidar claims at 0.86..1.0 and 9 Muhalefet claims at 0.80..0.83. */
function weekFixture(): PickableClaim[] {
  const iktidar = Array.from({ length: 41 }, (_, i) =>
    claim(`ik-${String(i).padStart(2, "0")}`, "iktidar", 0.86 + (0.14 * i) / 40, i),
  );
  const muhalefet = Array.from({ length: 9 }, (_, i) =>
    claim(`mu-${i}`, "muhalefet", 0.8 + (0.03 * i) / 8, i),
  );
  return [...iktidar, ...muhalefet];
}

describe("pickBlindspotList: the prod week (41 Iktidar : 9 Muhalefet)", () => {
  it("returns 30 rows that contain all 9 Muhalefet claims", () => {
    const picked = pickBlindspotList(weekFixture(), 30);

    expect(picked).toHaveLength(30);
    const muhalefet = picked.filter((c) => c.dominantZone === "muhalefet");
    expect(muhalefet).toHaveLength(9);
    expect(ids(muhalefet).sort()).toEqual(
      Array.from({ length: 9 }, (_, i) => `mu-${i}`).sort(),
    );
    // Round-robin: 9 rounds of one each, then the Iktidar side takes the rest.
    expect(picked.filter((c) => c.dominantZone === "iktidar")).toHaveLength(21);
  });

  it("takes the 21 most lopsided Iktidar claims, not an arbitrary 21", () => {
    const picked = pickBlindspotList(weekFixture(), 30);
    const iktidarIds = ids(picked.filter((c) => c.dominantZone === "iktidar"));
    // ik-40 is the 1.0 claim, ik-20 the 21st best (0.86 + 0.14 * 20 / 40).
    expect(iktidarIds).toEqual(
      expect.arrayContaining(Array.from({ length: 21 }, (_, i) => `ik-${40 - i}`)),
    );
    expect(iktidarIds).not.toContain("ik-19");
  });

  it("is sorted by dominantPct descending", () => {
    const picked = pickBlindspotList(weekFixture(), 30);
    for (let i = 1; i < picked.length; i += 1) {
      expect(picked[i - 1]!.dominantPct).toBeGreaterThanOrEqual(picked[i]!.dominantPct);
    }
  });
});

describe("pickBlindspotList: ordering", () => {
  it("breaks equal dominantPct on cluster.updated_at, newest first", () => {
    const picked = pickBlindspotList(
      [
        claim("old", "iktidar", 0.9, 300),
        claim("new", "iktidar", 0.9, 5),
        claim("mid", "iktidar", 0.9, 60),
      ],
      30,
    );
    expect(ids(picked)).toEqual(["new", "mid", "old"]);
  });

  it("breaks a full tie (same pct, same instant) on the cluster id, so input order never matters", () => {
    const a = claim("a", "iktidar", 0.9, 10);
    const b = claim("b", "iktidar", 0.9, 10);
    expect(ids(pickBlindspotList([b, a], 30))).toEqual(["a", "b"]);
    expect(ids(pickBlindspotList([a, b], 30))).toEqual(["a", "b"]);
  });

  it("orders each side by share, then updated_at, so the better claim is taken first", () => {
    const picked = pickBlindspotList(
      [
        claim("ik-old", "iktidar", 0.9, 500),
        claim("ik-new", "iktidar", 0.9, 1),
        claim("mu-1", "muhalefet", 0.85, 2),
      ],
      2,
    );
    // Round 1 takes each side's best: ik-new (newer of the two 0.9s) and mu-1.
    expect(ids(picked).sort()).toEqual(["ik-new", "mu-1"]);
  });

  it("returns a fresh array and never mutates its input", () => {
    const input = weekFixture();
    const snapshot = JSON.stringify(input);
    const picked = pickBlindspotList(input, 30);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(picked).not.toBe(input);
  });
});

describe("pickBlindspotList: round-robin across sides", () => {
  const spread = (): PickableClaim[] => [
    claim("ik-1", "iktidar", 0.99),
    claim("ik-2", "iktidar", 0.95),
    claim("ik-3", "iktidar", 0.9),
    claim("ik-4", "iktidar", 0.88),
    claim("ik-5", "iktidar", 0.86),
    claim("mu-1", "muhalefet", 0.85),
    claim("mu-2", "muhalefet", 0.81),
    claim("bg-1", "bagimsiz", 0.92),
  ];

  it("takes one per side per round, sides ordered by their top share (iktidar 0.99, bagimsiz 0.92, muhalefet 0.85)", () => {
    // Round 1: ik-1, bg-1, mu-1. Round 2 starts with ik-2. Output by share.
    expect(ids(pickBlindspotList(spread(), 4))).toEqual(["ik-1", "ik-2", "bg-1", "mu-1"]);
  });

  it("keeps cycling and skips an exhausted side", () => {
    // Round 1: ik-1, bg-1, mu-1. Round 2: ik-2, mu-2 (bagimsiz is out). Round 3: ik-3.
    expect(ids(pickBlindspotList(spread(), 6))).toEqual([
      "ik-1",
      "ik-2",
      "bg-1",
      "ik-3",
      "mu-1",
      "mu-2",
    ]);
  });

  it("orders sides by top share even when the smaller side owns the single best claim", () => {
    const picked = pickBlindspotList(
      [
        claim("mu-top", "muhalefet", 1),
        claim("ik-1", "iktidar", 0.9),
        claim("ik-2", "iktidar", 0.88),
      ],
      1,
    );
    expect(ids(picked)).toEqual(["mu-top"]);
  });

  it("ties on a side's top share go iktidar, then muhalefet, then bagimsiz", () => {
    const rows = [
      claim("bg", "bagimsiz", 0.9),
      claim("mu", "muhalefet", 0.9),
      claim("ik", "iktidar", 0.9),
    ];
    expect(ids(pickBlindspotList(rows, 1))).toEqual(["ik"]);
    expect(ids(pickBlindspotList(rows, 2)).sort()).toEqual(["ik", "mu"]);
    expect(ids(pickBlindspotList(rows, 3)).sort()).toEqual(["bg", "ik", "mu"]);
  });

  it("returns every claim, ordered, when there are fewer than size", () => {
    const picked = pickBlindspotList(spread(), 30);
    expect(picked).toHaveLength(8);
    expect(ids(picked)).toEqual(ids(sortBlindspotClaims(spread())));
  });

  it("a single-side input just takes the best `size` of that side", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      claim(`mu-${i}`, "muhalefet", 0.8 + i / 100),
    );
    const picked = pickBlindspotList(rows, 5);
    expect(ids(picked)).toEqual(["mu-11", "mu-10", "mu-9", "mu-8", "mu-7"]);
  });
});

describe("pickBlindspotList: size and degenerate input", () => {
  it("defaults to 30", () => {
    const rows = Array.from({ length: 45 }, (_, i) => claim(`c${i}`, "iktidar", 0.8 + i / 1000));
    expect(pickBlindspotList(rows)).toHaveLength(30);
  });

  it.each([0, -1, -100, Number.NaN])("size %s returns []", (size) => {
    expect(pickBlindspotList(weekFixture(), size)).toEqual([]);
  });

  it("floors a fractional size", () => {
    expect(pickBlindspotList(weekFixture(), 2.9)).toHaveLength(2);
  });

  it("returns [] for no claims", () => {
    expect(pickBlindspotList([], 30)).toEqual([]);
  });

  it("is deterministic: equal inputs, and the same inputs in any order, give the same rows", () => {
    const base = weekFixture();
    const first = ids(pickBlindspotList(base, 30));
    expect(ids(pickBlindspotList(weekFixture(), 30))).toEqual(first);
    expect(ids(pickBlindspotList([...base].reverse(), 30))).toEqual(first);
    const shuffled = [...base].sort((a, b) =>
      a.cluster.id.length - b.cluster.id.length || (a.cluster.id < b.cluster.id ? 1 : -1),
    );
    expect(ids(pickBlindspotList(shuffled, 30))).toEqual(first);
  });

  it("treats a non-finite share or an unparseable timestamp as the lowest rank instead of throwing", () => {
    const bad = claim("bad", "iktidar", Number.NaN);
    const badDate: PickableClaim = {
      cluster: { id: "bad-date", updated_at: "not-a-date" },
      dominantZone: "iktidar",
      dominantPct: 0.9,
    };
    const good = claim("good", "iktidar", 0.9, 5);
    expect(ids(pickBlindspotList([bad, badDate, good], 30))).toEqual(["good", "bad-date", "bad"]);
  });
});

describe("sortBlindspotClaims", () => {
  it("is the same ordering the pick output uses and does not mutate", () => {
    const input = [claim("b", "iktidar", 0.85), claim("a", "muhalefet", 0.95)];
    const sorted = sortBlindspotClaims(input);
    expect(ids(sorted)).toEqual(["a", "b"]);
    expect(ids(input)).toEqual(["b", "a"]);
  });
});
