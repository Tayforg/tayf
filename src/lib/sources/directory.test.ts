import { describe, it, expect } from "vitest";

import { weeklyCountFromPerDay, sortGroupedByActivity } from "./directory";

describe("weeklyCountFromPerDay", () => {
  it("exact round-trip for counts 0..500", () => {
    for (let weekly = 0; weekly <= 500; weekly++) {
      const perDay = Math.round((weekly / 7) * 10) / 10;
      expect(weeklyCountFromPerDay(perDay)).toBe(weekly);
    }
  });
});

interface Row {
  slug: string;
  name: string;
}

function mkGrouped(rows: Row[]): Record<"a", Row[]> {
  return { a: rows };
}

describe("sortGroupedByActivity", () => {
  it("orders by count desc, then name, when counts are provided", () => {
    const grouped = mkGrouped([
      { slug: "b", name: "Bravo" },
      { slug: "a", name: "Alpha" },
      { slug: "c", name: "Charlie" },
    ]);
    const counts = { a: 10, b: 20, c: 10 };
    const sorted = sortGroupedByActivity(grouped, counts);
    expect(sorted.a.map((s) => s.slug)).toEqual(["b", "a", "c"]);
  });

  it("falls back to name order (tr locale) when counts is null", () => {
    const grouped = mkGrouped([
      { slug: "z", name: "İzmir" },
      { slug: "a", name: "Ankara" },
    ]);
    const sorted = sortGroupedByActivity(grouped, null);
    expect(sorted.a.map((s) => s.slug)).toEqual(["a", "z"]);
  });

  it("treats a source missing from counts as 0", () => {
    const grouped = mkGrouped([
      { slug: "known", name: "Known" },
      { slug: "unknown", name: "Unknown" },
    ]);
    const sorted = sortGroupedByActivity(grouped, { known: 5 });
    expect(sorted.a.map((s) => s.slug)).toEqual(["known", "unknown"]);
  });

  it("does not mutate the input", () => {
    const original = mkGrouped([
      { slug: "b", name: "Bravo" },
      { slug: "a", name: "Alpha" },
    ]);
    const originalOrder = original.a.map((s) => s.slug);
    sortGroupedByActivity(original, { a: 100, b: 1 });
    expect(original.a.map((s) => s.slug)).toEqual(originalOrder);
  });
});
