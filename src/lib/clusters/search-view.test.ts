import { describe, it, expect } from "vitest";

import { composeSearchView } from "./search-view";
import type { ClusterBundle } from "./politics-query";

// h170-roadmap-1: the three fields the archive pager adds. Page 1 of a search whose typed call did not fill its page
// (every scenario of the first tests below) has none of them set, so those snapshots are the old ones plus these.
const NO_PAGER = { archiveHasNext: false, archivePageUnavailable: false, archiveEnd: false };

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
      archiveCapped: false,
      archiveTotal: 0,
      archiveCappedTotal: false,
      ...NO_PAGER,
    });
  });

  it("search null (query too short): archive [], archiveUnavailable false, emptySearch = inFeedIds.size === 0", () => {
    expect(
      composeSearchView({ q: "a", page: 1, inFeedIds: new Set(), search: null }),
    ).toEqual({
      archive: [],
      archiveUnavailable: false,
      emptySearch: true,
      archiveCapped: false,
      archiveTotal: 0,
      archiveCappedTotal: false,
      ...NO_PAGER,
    });

    expect(
      composeSearchView({
        q: "a",
        page: 1,
        inFeedIds: new Set(["x"]),
        search: null,
      }),
    ).toEqual({
      archive: [],
      archiveUnavailable: false,
      emptySearch: false,
      archiveCapped: false,
      archiveTotal: 0,
      archiveCappedTotal: false,
      ...NO_PAGER,
    });
  });

  it("search.ok false: archive [], archiveUnavailable true, emptySearch false", () => {
    expect(
      composeSearchView({
        q: "IŞIK",
        page: 1,
        inFeedIds: new Set(),
        search: { ok: false },
      }),
    ).toEqual({
      archive: [],
      archiveUnavailable: true,
      emptySearch: false,
      archiveCapped: false,
      archiveTotal: 0,
      archiveCappedTotal: false,
      ...NO_PAGER,
    });
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

  it("ok + page 1 + capped + non-empty archive: archiveCapped true", () => {
    const view = composeSearchView({
      q: "deprem",
      page: 1,
      inFeedIds: new Set(),
      search: { ok: true, bundles: [mkBundle("a")], capped: true },
    });
    expect(view).toEqual({
      archive: [expect.objectContaining({ cluster: expect.objectContaining({ id: "a" }) })],
      archiveUnavailable: false,
      emptySearch: false,
      archiveCapped: true,
      archiveTotal: 1,
      archiveCappedTotal: true,
      ...NO_PAGER,
    });
  });

  it("ok + page 1 + capped, in-feed ids filtered but some archive left: archiveCapped true", () => {
    const view = composeSearchView({
      q: "deprem",
      page: 1,
      inFeedIds: new Set(["a"]),
      search: { ok: true, bundles: [mkBundle("a"), mkBundle("b")], capped: true },
    });
    expect(view.archive.map((b) => b.cluster.id)).toEqual(["b"]);
    expect(view.archiveCapped).toBe(true);
  });

  it("ok + page 2: archiveCapped false even when capped", () => {
    const view = composeSearchView({
      q: "deprem",
      page: 2,
      inFeedIds: new Set(),
      search: { ok: true, bundles: [mkBundle("a")], capped: true },
    });
    expect(view.archive).toEqual([]);
    expect(view.archiveCapped).toBe(false);
  });

  it("capped but the archive is empty (all in feed, or none): archiveCapped false", () => {
    expect(
      composeSearchView({
        q: "deprem",
        page: 1,
        inFeedIds: new Set(["a"]),
        search: { ok: true, bundles: [mkBundle("a")], capped: true },
      }).archiveCapped,
    ).toBe(false);
    expect(
      composeSearchView({
        q: "deprem",
        page: 1,
        inFeedIds: new Set(),
        search: { ok: true, bundles: [], capped: true },
      }).archiveCapped,
    ).toBe(false);
  });

  it("not capped, or capped missing: archiveCapped false", () => {
    expect(
      composeSearchView({
        q: "deprem",
        page: 1,
        inFeedIds: new Set(),
        search: { ok: true, bundles: [mkBundle("a")], capped: false },
      }).archiveCapped,
    ).toBe(false);
    expect(
      composeSearchView({
        q: "deprem",
        page: 1,
        inFeedIds: new Set(),
        search: { ok: true, bundles: [mkBundle("a")] },
      }).archiveCapped,
    ).toBe(false);
  });

  describe("page-independent totals (archiveTotal / archiveCappedTotal)", () => {
    const bundles = [mkBundle("a"), mkBundle("b"), mkBundle("c")];

    it("page 1 and page 2 of one search report the same archive total and cap", () => {
      const args = {
        q: "deprem",
        inFeedIds: new Set(["a"]),
        search: { ok: true as const, bundles, capped: true },
      };
      const p1 = composeSearchView({ ...args, page: 1 });
      const p2 = composeSearchView({ ...args, page: 2 });
      expect(p1.archive.map((b) => b.cluster.id)).toEqual(["b", "c"]);
      expect(p2.archive).toEqual([]);
      expect(p1.archiveTotal).toBe(2);
      expect(p2.archiveTotal).toBe(2);
      expect(p1.archiveCappedTotal).toBe(true);
      expect(p2.archiveCappedTotal).toBe(true);
    });

    it("the visible archive list and cap flag stay page 1 only", () => {
      const view = composeSearchView({
        q: "deprem",
        page: 2,
        inFeedIds: new Set(),
        search: { ok: true, bundles, capped: true },
      });
      expect(view.archive).toEqual([]);
      expect(view.archiveCapped).toBe(false);
      expect(view.archiveTotal).toBe(3);
    });

    it("counts only rows that are not already in the feed", () => {
      const view = composeSearchView({
        q: "deprem",
        page: 3,
        inFeedIds: new Set(["a", "b", "c", "zzz"]),
        search: { ok: true, bundles },
      });
      expect(view.archiveTotal).toBe(0);
      expect(view.archiveCappedTotal).toBe(false);
    });

    it("is not capped when the RPC did not fill its page, or when nothing is left after the in-feed filter", () => {
      expect(
        composeSearchView({
          q: "deprem",
          page: 2,
          inFeedIds: new Set(),
          search: { ok: true, bundles, capped: false },
        }).archiveCappedTotal,
      ).toBe(false);
      expect(
        composeSearchView({
          q: "deprem",
          page: 2,
          inFeedIds: new Set(["a", "b", "c"]),
          search: { ok: true, bundles, capped: true },
        }).archiveCappedTotal,
      ).toBe(false);
    });

    it("is 0 and not capped when there is no query, no search or a failed search", () => {
      for (const search of [null, { ok: false as const }]) {
        const view = composeSearchView({
          q: "deprem",
          page: 2,
          inFeedIds: new Set(["a"]),
          search,
        });
        expect(view.archiveTotal).toBe(0);
        expect(view.archiveCappedTotal).toBe(false);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// h170-roadmap-1: archive pages (?arsiv=N). Page 1 is the view it always was; a later page lists
// its own rows of the ranking, without the in-feed ids, and says whether a next page exists.
// ---------------------------------------------------------------------------

describe("composeSearchView: archive pages (h170-roadmap-1)", () => {
  const bundles = [mkBundle("a"), mkBundle("b"), mkBundle("c")];
  const ids = (view: { archive: ClusterBundle[] }) => view.archive.map((b) => b.cluster.id);

  describe("archivePage 1", () => {
    it("omitting archivePage and passing 1 give the identical view (the page-1 snapshots above)", () => {
      const scenarios = [
        { q: undefined, page: 1, inFeedIds: new Set<string>(), search: { ok: true as const, bundles } },
        { q: "a", page: 1, inFeedIds: new Set<string>(), search: null },
        { q: "deprem", page: 1, inFeedIds: new Set<string>(), search: { ok: false as const } },
        { q: "deprem", page: 1, inFeedIds: new Set(["a"]), search: { ok: true as const, bundles, capped: true } },
        { q: "deprem", page: 2, inFeedIds: new Set<string>(), search: { ok: true as const, bundles, capped: true } },
        { q: "deprem", page: 1, inFeedIds: new Set<string>(), search: { ok: true as const, bundles: [] } },
      ];
      for (const args of scenarios) {
        expect(composeSearchView({ ...args, archivePage: 1 })).toEqual(composeSearchView(args));
      }
    });

    it("an archivePage that is not a whole number from 1 up reads as 1", () => {
      const base = { q: "deprem", page: 1, inFeedIds: new Set<string>(), search: { ok: true as const, bundles, capped: true as const, typedFull: true as const } };
      const first = composeSearchView(base);
      for (const archivePage of [0, -1, Number.NaN, 1.5, 2.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(composeSearchView({ ...base, archivePage }), String(archivePage)).toEqual(first);
      }
    });

    it("lists the archive-only rows of page 1 on in-feed page 1 and no rows on in-feed page 2, as before", () => {
      const args = { q: "deprem", inFeedIds: new Set(["a"]), search: { ok: true as const, bundles, capped: true as const } };
      expect(ids(composeSearchView({ ...args, page: 1, archivePage: 1 }))).toEqual(["b", "c"]);
      expect(ids(composeSearchView({ ...args, page: 2, archivePage: 1 }))).toEqual([]);
    });
  });

  describe("the pager on page 1 needs the TYPED call to have filled its page (typedFull)", () => {
    const search = (extra: { capped?: boolean; typedFull?: true }) => ({ ok: true as const, bundles, ...extra });

    it("typedFull on page 1: a next page exists", () => {
      const view = composeSearchView({ q: "enflasyon", page: 1, inFeedIds: new Set(), search: search({ capped: true, typedFull: true }) });
      expect(view.archiveHasNext).toBe(true);
      expect(view.archiveEnd).toBe(false);
      expect(view.archivePageUnavailable).toBe(false);
    });

    it("capped by the sibling or the locative call (no typedFull): no next page, though the page is capped", () => {
      const view = composeSearchView({ q: "elektrik zammı", page: 1, inFeedIds: new Set(), search: search({ capped: true }) });
      expect(view.archiveCapped).toBe(true);
      expect(view.archiveHasNext).toBe(false);
    });

    it("fewer than 24 hits: no next page", () => {
      const view = composeSearchView({ q: "deprem", page: 1, inFeedIds: new Set(), search: search({ capped: false }) });
      expect(view.archiveHasNext).toBe(false);
    });

    it("still a next page when every row of page 1 is already in the feed (the archive list is empty, page 2 is not)", () => {
      const view = composeSearchView({
        q: "deprem",
        page: 1,
        inFeedIds: new Set(["a", "b", "c"]),
        search: search({ capped: true, typedFull: true }),
      });
      expect(view.archive).toEqual([]);
      expect(view.archiveCapped).toBe(false);
      expect(view.archiveHasNext).toBe(true);
    });

    it("no pager on in-feed page 2 of a search (the archive list is page 1 of the feed only)", () => {
      const view = composeSearchView({ q: "deprem", page: 2, inFeedIds: new Set(), search: search({ capped: true, typedFull: true }) });
      expect(view.archiveHasNext).toBe(false);
    });

    it("no pager without a search result, for a failed search or without a query", () => {
      expect(composeSearchView({ q: "deprem", page: 1, inFeedIds: new Set(), search: { ok: false } }).archiveHasNext).toBe(false);
      expect(composeSearchView({ q: "a", page: 1, inFeedIds: new Set(), search: null }).archiveHasNext).toBe(false);
      expect(composeSearchView({ q: undefined, page: 1, inFeedIds: new Set(), search: search({ capped: true, typedFull: true }) }).archiveHasNext).toBe(false);
    });
  });

  describe("archivePage 2 and later", () => {
    it("lists the page's rows without the in-feed ids, whatever the in-feed page", () => {
      for (const page of [1, 2, 7]) {
        const view = composeSearchView({
          q: "enflasyon",
          page,
          archivePage: 2,
          inFeedIds: new Set(["b"]),
          search: { ok: true, bundles, capped: true },
        });
        expect(ids(view), String(page)).toEqual(["a", "c"]);
      }
    });

    it("keeps the ranking order of the page", () => {
      const view = composeSearchView({
        q: "enflasyon",
        page: 1,
        archivePage: 3,
        inFeedIds: new Set(),
        search: { ok: true, bundles: [mkBundle("z"), mkBundle("m"), mkBundle("a")], capped: false },
      });
      expect(ids(view)).toEqual(["z", "m", "a"]);
    });

    it("archiveHasNext = capped && page < 4", () => {
      const next = (archivePage: number, capped: boolean) =>
        composeSearchView({ q: "enflasyon", page: 1, archivePage, inFeedIds: new Set(), search: { ok: true, bundles, capped } }).archiveHasNext;
      expect(next(2, true)).toBe(true);
      expect(next(3, true)).toBe(true);
      expect(next(4, true)).toBe(false);
      expect(next(2, false)).toBe(false);
      expect(next(3, false)).toBe(false);
      expect(next(4, false)).toBe(false);
    });

    it("a later page needs no typedFull: capped (the v2 call returned 24 ids) is enough", () => {
      const view = composeSearchView({ q: "enflasyon", page: 1, archivePage: 2, inFeedIds: new Set(), search: { ok: true, bundles, capped: true } });
      expect(view.archiveHasNext).toBe(true);
    });

    it("archiveHasNext holds even when every row of the page is in the feed (the page is full, the next may not be)", () => {
      const view = composeSearchView({
        q: "enflasyon",
        page: 1,
        archivePage: 2,
        inFeedIds: new Set(["a", "b", "c"]),
        search: { ok: true, bundles, capped: true },
      });
      expect(view.archive).toEqual([]);
      expect(view.archiveHasNext).toBe(true);
    });

    it("archiveEnd: page 4 whose page is full says there is no more to show", () => {
      const end = (archivePage: number, capped: boolean) =>
        composeSearchView({ q: "enflasyon", page: 1, archivePage, inFeedIds: new Set(), search: { ok: true, bundles, capped } }).archiveEnd;
      expect(end(4, true)).toBe(true);
      expect(end(4, false)).toBe(false);
      expect(end(3, true)).toBe(false);
      expect(end(2, true)).toBe(false);
      expect(end(1, true)).toBe(false);
    });

    it("a page past 4 is page 4", () => {
      const view = composeSearchView({ q: "enflasyon", page: 1, archivePage: 99, inFeedIds: new Set(), search: { ok: true, bundles, capped: true } });
      expect(view.archiveHasNext).toBe(false);
      expect(view.archiveEnd).toBe(true);
    });

    it("an empty page is no 'empty search': the card that says nothing was found never shows on page 2", () => {
      const view = composeSearchView({ q: "enflasyon", page: 1, archivePage: 2, inFeedIds: new Set(), search: { ok: true, bundles: [], capped: false } });
      expect(view.archive).toEqual([]);
      expect(view.emptySearch).toBe(false);
      expect(view.archiveUnavailable).toBe(false);
    });

    it("an unavailable page (211 not applied): archivePageUnavailable, no rows, no next page", () => {
      const view = composeSearchView({ q: "enflasyon", page: 1, archivePage: 2, inFeedIds: new Set(["a"]), search: { ok: false, unavailablePage: true } });
      expect(view.archivePageUnavailable).toBe(true);
      expect(view.archiveUnavailable).toBe(true);
      expect(view.archive).toEqual([]);
      expect(view.archiveHasNext).toBe(false);
      expect(view.emptySearch).toBe(false);
    });

    it("a plain failure on a later page is archiveUnavailable only (the retry card), not archivePageUnavailable", () => {
      const view = composeSearchView({ q: "enflasyon", page: 1, archivePage: 3, inFeedIds: new Set(), search: { ok: false } });
      expect(view.archiveUnavailable).toBe(true);
      expect(view.archivePageUnavailable).toBe(false);
    });

    it("archiveCapped stays a page-1 flag: false on a later page, so the page-1 heading wording never leaks", () => {
      const view = composeSearchView({ q: "enflasyon", page: 1, archivePage: 2, inFeedIds: new Set(), search: { ok: true, bundles, capped: true } });
      expect(view.archiveCapped).toBe(false);
    });

    it("no query or no search on a later page: the page-1 shape (the page never passes one)", () => {
      expect(composeSearchView({ q: undefined, page: 1, archivePage: 3, inFeedIds: new Set(), search: null })).toEqual(
        composeSearchView({ q: undefined, page: 1, inFeedIds: new Set(), search: null }),
      );
      expect(composeSearchView({ q: "a", page: 1, archivePage: 3, inFeedIds: new Set(), search: null })).toEqual(
        composeSearchView({ q: "a", page: 1, inFeedIds: new Set(), search: null }),
      );
    });
  });
});
