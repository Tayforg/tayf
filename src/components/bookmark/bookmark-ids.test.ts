import { describe, expect, it } from "vitest";

import {
  normaliseBookmarkId,
  normaliseBookmarkIds,
  toggleBookmarkId,
} from "@/components/bookmark/bookmark-ids";

// h32-livebk-1: a bookmark saved from an upper-case /cluster/<ID> URL was stored
// case-sensitively, /saved listed the row under the RPC's lower-case uuid, and
// removing it ADDED a lower-case phantom ([upper, lower]) instead of removing
// the entry. Ids are now folded to lower case on read, toggle and has(). There
// is deliberately no UUID requirement: a legacy non-UUID id is kept as-is.

const UPPER = "F85BC48E-692D-41BE-8F6B-0D0ECD1D2281";
const LOWER = "f85bc48e-692d-41be-8f6b-0d0ecd1d2281";

describe("normaliseBookmarkId", () => {
  it("lower-cases an id", () => {
    expect(normaliseBookmarkId(UPPER)).toBe(LOWER);
  });

  it("leaves a lower-case id alone", () => {
    expect(normaliseBookmarkId(LOWER)).toBe(LOWER);
  });

  it("trims surrounding whitespace", () => {
    expect(normaliseBookmarkId(" x ")).toBe("x");
    expect(normaliseBookmarkId(`\t${UPPER}\n`)).toBe(LOWER);
  });

  it("returns null for an empty or whitespace-only string", () => {
    expect(normaliseBookmarkId("")).toBeNull();
    expect(normaliseBookmarkId("   ")).toBeNull();
  });

  it("returns null for a non-string", () => {
    expect(normaliseBookmarkId(null)).toBeNull();
    expect(normaliseBookmarkId(undefined)).toBeNull();
    expect(normaliseBookmarkId(42)).toBeNull();
    expect(normaliseBookmarkId({})).toBeNull();
    expect(normaliseBookmarkId(["a"])).toBeNull();
    expect(normaliseBookmarkId(true)).toBeNull();
  });

  it("does not require a UUID: legacy ids are never dropped", () => {
    expect(normaliseBookmarkId("Legacy-Id_7")).toBe("legacy-id_7");
    expect(normaliseBookmarkId("c1")).toBe("c1");
  });

  it("is locale independent (Turkish dotted/dotless I does not leak in)", () => {
    // toLocaleLowerCase('tr') would map 'I' to dotless 'ı'; toLowerCase must not.
    expect(normaliseBookmarkId("ID-I")).toBe("id-i");
  });
});

describe("normaliseBookmarkIds", () => {
  it("lower-cases, drops non-strings and de-duplicates in first-seen order", () => {
    expect(normaliseBookmarkIds([UPPER, LOWER, "c1", 7, null])).toEqual([LOWER, "c1"]);
  });

  it("keeps first-seen order across distinct ids", () => {
    expect(normaliseBookmarkIds(["b", "A", "b", "a", "C"])).toEqual(["b", "a", "c"]);
  });

  it("returns [] for a non-array", () => {
    expect(normaliseBookmarkIds(null)).toEqual([]);
    expect(normaliseBookmarkIds(undefined)).toEqual([]);
    expect(normaliseBookmarkIds("abc")).toEqual([]);
    expect(normaliseBookmarkIds({ 0: "a", length: 1 })).toEqual([]);
    expect(normaliseBookmarkIds(5)).toEqual([]);
  });

  it("returns [] for an empty array", () => {
    expect(normaliseBookmarkIds([])).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = [UPPER, LOWER];
    normaliseBookmarkIds(input);
    expect(input).toEqual([UPPER, LOWER]);
  });

  it("copes with a large stored list", () => {
    const big = Array.from({ length: 10_000 }, (_, i) => `ID-${i % 5000}`);
    const out = normaliseBookmarkIds(big);
    expect(out).toHaveLength(5000);
    expect(out[0]).toBe("id-0");
  });
});

describe("toggleBookmarkId", () => {
  it("removes the entry when a stored upper-case id is toggled by its lower-case form (the phantom regression)", () => {
    const stored = new Set(normaliseBookmarkIds([UPPER]));
    const result = toggleBookmarkId(stored, LOWER);
    expect(result).not.toBeNull();
    expect(result?.added).toBe(false);
    expect(result?.key).toBe(LOWER);
    expect(Array.from(result?.next ?? ["x"])).toEqual([]);
  });

  it("adds the lower-case key when an upper-case id is toggled on an empty set", () => {
    const result = toggleBookmarkId(new Set<string>(), UPPER);
    expect(result).not.toBeNull();
    expect(result?.added).toBe(true);
    expect(result?.key).toBe(LOWER);
    expect(Array.from(result?.next ?? [])).toEqual([LOWER]);
  });

  it("toggling twice returns to the starting set", () => {
    const first = toggleBookmarkId(new Set<string>(), UPPER);
    const second = toggleBookmarkId(first?.next ?? new Set<string>(), UPPER);
    expect(second?.added).toBe(false);
    expect(Array.from(second?.next ?? ["x"])).toEqual([]);
  });

  it("returns null for an empty id", () => {
    expect(toggleBookmarkId(new Set(["a"]), "")).toBeNull();
    expect(toggleBookmarkId(new Set(["a"]), "   ")).toBeNull();
  });

  it("does not mutate the set it is given", () => {
    const stored = new Set<string>([LOWER]);
    const result = toggleBookmarkId(stored, UPPER);
    expect(Array.from(stored)).toEqual([LOWER]);
    expect(result?.next).not.toBe(stored);
  });

  it("keeps the other entries when one is removed or added", () => {
    const stored = new Set<string>(["a", LOWER, "b"]);
    const removed = toggleBookmarkId(stored, UPPER);
    expect(Array.from(removed?.next ?? [])).toEqual(["a", "b"]);
    const added = toggleBookmarkId(stored, "C");
    expect(Array.from(added?.next ?? [])).toEqual(["a", LOWER, "b", "c"]);
  });

  it("does not require a UUID", () => {
    const result = toggleBookmarkId(new Set<string>(), "Legacy-1");
    expect(result?.key).toBe("legacy-1");
    expect(result?.added).toBe(true);
  });
});
