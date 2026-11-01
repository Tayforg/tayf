import { describe, expect, it } from "vitest";

import { topicPageRobots } from "./topic-page-robots";

describe("topicPageRobots", () => {
  it("noindexes (follow kept) when the read failed (null result)", () => {
    expect(topicPageRobots(1, null)).toEqual({ index: false, follow: true });
    expect(topicPageRobots(3, null)).toEqual({ index: false, follow: true });
  });

  it("leaves an empty page 1 indexable (a real answer: no clusters this week)", () => {
    expect(topicPageRobots(1, { bundles: [] })).toBeUndefined();
  });

  it("noindexes (follow kept) an empty page past the first", () => {
    expect(topicPageRobots(2, { bundles: [] })).toEqual({ index: false, follow: true });
    expect(topicPageRobots(20, { bundles: [] })).toEqual({ index: false, follow: true });
  });

  it("leaves a non-empty page past the first indexable", () => {
    expect(topicPageRobots(2, { bundles: [{}] })).toBeUndefined();
  });

  it("leaves a non-empty page 1 indexable", () => {
    expect(topicPageRobots(1, { bundles: [{}, {}] })).toBeUndefined();
  });
});
