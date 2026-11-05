import { describe, expect, it } from "vitest";

import { topicPageRobots } from "./topic-page-robots";
import { TOPIC_INDEX_MIN_CLUSTERS, TOPIC_PAGE_SIZE } from "./topic-query";

const NOINDEX = { index: false, follow: true };

/** n placeholder bundles; the helper only reads `.length`. */
function bundles(n: number): unknown[] {
  return Array.from({ length: n }, () => ({}));
}

describe("TOPIC_INDEX_MIN_CLUSTERS", () => {
  it("is 20 and never above one page, so a full page needs no count read", () => {
    expect(TOPIC_INDEX_MIN_CLUSTERS).toBe(20);
    expect(TOPIC_INDEX_MIN_CLUSTERS).toBeLessThanOrEqual(TOPIC_PAGE_SIZE);
  });
});

describe("topicPageRobots", () => {
  it("noindexes (follow kept) when the read failed (null result)", () => {
    expect(topicPageRobots(1, null)).toEqual(NOINDEX);
    expect(topicPageRobots(3, null)).toEqual(NOINDEX);
  });

  describe("page 1 of a hub too thin to be a topic feed", () => {
    it("noindexes (follow kept) an empty page 1 (narrows the old 'empty page 1 stays indexable' rule)", () => {
      expect(topicPageRobots(1, { bundles: [], hasMore: false })).toEqual(NOINDEX);
    });

    it("noindexes (follow kept) a short page 1 with no next page (10 clusters, as /konu/spor and /konu/teknoloji hold today)", () => {
      expect(topicPageRobots(1, { bundles: bundles(10), hasMore: false })).toEqual(NOINDEX);
    });

    it("the threshold is TOPIC_INDEX_MIN_CLUSTERS: one below noindexes, exactly at it is indexable", () => {
      expect(
        topicPageRobots(1, {
          bundles: bundles(TOPIC_INDEX_MIN_CLUSTERS - 1),
          hasMore: false,
        }),
      ).toEqual(NOINDEX);
      expect(
        topicPageRobots(1, {
          bundles: bundles(TOPIC_INDEX_MIN_CLUSTERS),
          hasMore: false,
        }),
      ).toBeUndefined();
    });
  });

  describe("page 1 of a hub that has enough to list", () => {
    it("leaves a full page 1 (30 clusters) indexable", () => {
      expect(
        topicPageRobots(1, { bundles: bundles(TOPIC_PAGE_SIZE), hasMore: false }),
      ).toBeUndefined();
    });

    it("leaves a page 1 with a next page indexable, however few cards survived the member filter", () => {
      expect(topicPageRobots(1, { bundles: bundles(30), hasMore: true })).toBeUndefined();
      expect(topicPageRobots(1, { bundles: bundles(10), hasMore: true })).toBeUndefined();
    });
  });

  describe("pages past the first (rule unchanged)", () => {
    it("noindexes (follow kept) an empty page past the first", () => {
      expect(topicPageRobots(2, { bundles: [], hasMore: false })).toEqual(NOINDEX);
      expect(topicPageRobots(20, { bundles: [], hasMore: false })).toEqual(NOINDEX);
    });

    it("leaves a non-empty page past the first indexable, even a short last page", () => {
      expect(topicPageRobots(2, { bundles: bundles(1), hasMore: false })).toBeUndefined();
      expect(topicPageRobots(2, { bundles: bundles(30), hasMore: true })).toBeUndefined();
    });
  });
});
