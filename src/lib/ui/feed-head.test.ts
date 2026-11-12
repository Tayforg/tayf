import { describe, expect, it } from "vitest";

import { FEED_HEAD_CARDS, splitFeedHead } from "./feed-head";

// h166-perf-3: /blindspots and /gundem/[key] render the first FEED_HEAD_CARDS
// cards in the boundary that holds the page head, and the rest of the long list
// in a nested boundary after it. splitFeedHead is the one place that decides
// where the list is cut, so the two pages cannot disagree about it.

describe("FEED_HEAD_CARDS", () => {
  it("is 2: card 0 (the LCP banner) and card 1 stay in the head", () => {
    expect(FEED_HEAD_CARDS).toBe(2);
  });
});

describe("splitFeedHead", () => {
  const five = ["a", "b", "c", "d", "e"];

  it("5 items: the first 2 are the head, the other 3 the tail, which starts at index 2", () => {
    expect(splitFeedHead(five)).toEqual({
      head: ["a", "b"],
      tail: ["c", "d", "e"],
      tailStart: 2,
    });
  });

  it("2 items (exactly the head size): everything is head, there is no tail", () => {
    expect(splitFeedHead(["a", "b"])).toEqual({
      head: ["a", "b"],
      tail: [],
      tailStart: 2,
    });
  });

  it("3 items (one over): a tail of exactly one item", () => {
    expect(splitFeedHead(["a", "b", "c"])).toEqual({
      head: ["a", "b"],
      tail: ["c"],
      tailStart: 2,
    });
  });

  it("1 item: the head is the item, the tail is empty, tailStart is the clamped length", () => {
    expect(splitFeedHead(["a"])).toEqual({ head: ["a"], tail: [], tailStart: 1 });
  });

  it("0 items: empty head and tail, tailStart 0", () => {
    expect(splitFeedHead([])).toEqual({ head: [], tail: [], tailStart: 0 });
  });

  it("head 0: everything is tail and the tail starts at 0", () => {
    expect(splitFeedHead(five, 0)).toEqual({ head: [], tail: five, tailStart: 0 });
    expect(splitFeedHead([], 0)).toEqual({ head: [], tail: [], tailStart: 0 });
  });

  it("an explicit head size is honoured", () => {
    expect(splitFeedHead(five, 4)).toEqual({
      head: ["a", "b", "c", "d"],
      tail: ["e"],
      tailStart: 4,
    });
  });

  it("a head larger than the list clamps to the list length", () => {
    expect(splitFeedHead(five, 99)).toEqual({ head: five, tail: [], tailStart: 5 });
  });

  it("a negative head clamps to 0", () => {
    expect(splitFeedHead(five, -3)).toEqual({ head: [], tail: five, tailStart: 0 });
  });

  it("a fractional head is cut to a whole number of items", () => {
    const out = splitFeedHead(five, 2.9);
    expect(out.head).toEqual(["a", "b"]);
    expect(out.tailStart).toBe(2);
    expect(out.tail).toEqual(["c", "d", "e"]);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("a non-finite head (%s) falls back to FEED_HEAD_CARDS", (_label, bad) => {
    expect(splitFeedHead(five, bad)).toEqual(splitFeedHead(five));
    expect(splitFeedHead(five, bad).tailStart).toBe(FEED_HEAD_CARDS);
  });

  it("an undefined head means the default", () => {
    expect(splitFeedHead(five, undefined)).toEqual(splitFeedHead(five, FEED_HEAD_CARDS));
  });

  it("tailStart is always head.length, and head followed by tail is the input in order", () => {
    for (const n of [0, 1, 2, 3, 4, 7]) {
      const items = Array.from({ length: n }, (_, i) => i);
      for (const h of [-1, 0, 1, 2, 3, 50]) {
        const out = splitFeedHead(items, h);
        expect(out.tailStart).toBe(out.head.length);
        expect([...out.head, ...out.tail]).toEqual(items);
      }
    }
  });

  it("does not mutate its input and returns new arrays, also for a readonly input", () => {
    const frozen: readonly string[] = Object.freeze(["a", "b", "c"]);
    const out = splitFeedHead(frozen);
    expect(frozen).toEqual(["a", "b", "c"]);
    expect(out.head).not.toBe(frozen);
    expect(out.tail).not.toBe(frozen);
  });

  it("keeps object identity: the items are the same references, not copies", () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const out = splitFeedHead(items);
    expect(out.head[0]).toBe(items[0]);
    expect(out.head[1]).toBe(items[1]);
    expect(out.tail[0]).toBe(items[2]);
  });

  it("splits a 10k-item list without losing or reordering any item", () => {
    const items = Array.from({ length: 10_000 }, (_, i) => i);
    const out = splitFeedHead(items);
    expect(out.head).toEqual([0, 1]);
    expect(out.tail).toHaveLength(9_998);
    expect(out.tail[0]).toBe(2);
    expect(out.tail[9_997]).toBe(9_999);
    expect(out.tailStart).toBe(2);
  });
});
