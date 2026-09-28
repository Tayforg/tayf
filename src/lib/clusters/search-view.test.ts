import { describe, it, expect } from "vitest";

import { composeSearchView } from "./search-view";
import type { ClusterBundle } from "./politics-query";

function mkBundle(id: string): ClusterBundle {
  return {
    cluster: {
      id,
      title_tr: `Cluster ${id}`,
      summary_tr: "",
      bias_distribution: {
        pro_government: 0,
        gov_leaning: 0,
        state_media: 0,
        islamist_conservative: 0,
        center: 0,
        international: 0,
        pro_kurdish: 0,
        opposition_leaning: 0,
        opposition: 0,
        nationalist: 0,
      },
      is_blindspot: false,
      blindspot_side: null,
      article_count: 2,
      first_published: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
    articles: [],
    sources: [],
  };
}

describe("composeSearchView", () => {
  it("no q: archive [], archiveUnavailable false, emptySearch false", () => {
    const view = composeSearchView({
      q: undefined,
      page: 1,
      inFeedIds: new Set(),
      search: { ok: true, bundles: [mkBundle("a")] },
    });
    expect(view).toEqual({
      archive: [],
      archiveUnavailable: false,
      emptySearch: false,
    });
  });

  it("search null (query too short): archive [], archiveUnavailable false, emptySearch = inFeedIds.size === 0", () => {
    expect(
      composeSearchView({ q: "a", page: 1, inFeedIds: new Set(), search: null }),
    ).toEqual({ archive: [], archiveUnavailable: false, emptySearch: true });

    expect(
      composeSearchView({
        q: "a",
        page: 1,
        inFeedIds: new Set(["x"]),
        search: null,
      }),
    ).toEqual({ archive: [], archiveUnavailable: false, emptySearch: false });
  });

  it("search.ok false: archive [], archiveUnavailable true, emptySearch false", () => {
    expect(
      composeSearchView({
        q: "IŞIK",
        page: 1,
        inFeedIds: new Set(),
        search: { ok: false },
      }),
    ).toEqual({ archive: [], archiveUnavailable: true, emptySearch: false });
  });

  it("ok + page 1: archive filters out in-feed ids", () => {
    const view = composeSearchView({
      q: "deprem",
      page: 1,
      inFeedIds: new Set(["a"]),
      search: { ok: true, bundles: [mkBundle("a"), mkBundle("b")] },
    });
    expect(view.archive.map((b) => b.cluster.id)).toEqual(["b"]);
    expect(view.archiveUnavailable).toBe(false);
    expect(view.emptySearch).toBe(false);
  });

  it("ok + page > 1: archive is always []", () => {
    const view = composeSearchView({
      q: "deprem",
      page: 2,
      inFeedIds: new Set(),
      search: { ok: true, bundles: [mkBundle("a")] },
    });
    expect(view.archive).toEqual([]);
  });

  it("ok, no in-feed matches and no archive results: emptySearch true", () => {
    const view = composeSearchView({
      q: "hiçbirşey",
      page: 1,
      inFeedIds: new Set(),
      search: { ok: true, bundles: [] },
    });
    expect(view.emptySearch).toBe(true);
  });

  it("ok, no in-feed matches but archive has results: emptySearch false", () => {
    const view = composeSearchView({
      q: "deprem",
      page: 1,
      inFeedIds: new Set(),
      search: { ok: true, bundles: [mkBundle("a")] },
    });
    expect(view.emptySearch).toBe(false);
    expect(view.archive).toHaveLength(1);
  });
});
