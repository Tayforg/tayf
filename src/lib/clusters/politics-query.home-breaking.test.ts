import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// h170-roadmap-2: the plain home feed's Son Dakika derivation, written once.
// HomeFeed (the strip and the ranked list) and /api/home/head (the probe behind
// the "yeni son dakika haberi" pill) both call splitHomeFeed, so the head and the
// strip cannot drift. knownBreakingIds is the page's side of the pill: every story
// it lists, with no clock (a story that aged out of the 2 h window between the cache
// fill and the render is still in the entry, and so still in the head).
//
// Pure functions only; the module's database half is mocked away.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: vi.fn(),
  createReaderClient: vi.fn(),
}));

import { countNewBreaking, toHomeHead } from "./home-head";
import {
  BREAKING_LIMIT,
  BREAKING_WINDOW_MS,
  knownBreakingIds,
  splitHomeFeed,
  type ClusterBundle,
} from "./politics-query";

const NOW = Date.UTC(2026, 10, 13, 9, 0, 0);

function bundle(id: string, title = `Haber ${id}`, minutesAgo = 10): ClusterBundle {
  return {
    cluster: {
      id,
      title_tr: title,
      first_published: new Date(NOW - minutesAgo * 60_000).toISOString(),
    },
    articles: [],
    sources: [],
  } as unknown as ClusterBundle;
}

const ids = (bundles: ClusterBundle[]) => bundles.map((b) => b.cluster.id);

describe("the breaking constants", () => {
  it("are the 2 h window and the 6 slots the strip has always had", () => {
    expect(BREAKING_WINDOW_MS).toBe(2 * 60 * 60 * 1000);
    expect(BREAKING_LIMIT).toBe(6);
  });
});

describe("splitHomeFeed", () => {
  it("the plain feed: the strip is breakingBundles as given, the list is the ranked set without them", () => {
    const feed = {
      breakingBundles: [bundle("s1"), bundle("s2")],
      bundles: [bundle("r1"), bundle("r2"), bundle("r3")],
    };
    const { filteredBreaking, filtered, ranked } = splitHomeFeed(feed);
    expect(ids(filteredBreaking)).toEqual(["s1", "s2"]);
    expect(ids(filtered)).toEqual(["r1", "r2", "r3"]);
    expect(ids(ranked)).toEqual(["r1", "r2", "r3"]);
  });

  it("dedupes: a story in both lists renders in the strip only", () => {
    const shared = bundle("both");
    const feed = {
      breakingBundles: [bundle("s1"), shared],
      bundles: [bundle("r1"), shared, bundle("r2")],
    };
    const { filteredBreaking, filtered, ranked } = splitHomeFeed(feed);
    expect(ids(filteredBreaking)).toEqual(["s1", "both"]);
    // `filtered` is the whole matching ranked set (the page's inFeedIds read it), `ranked` is the deduped list.
    expect(ids(filtered)).toEqual(["r1", "both", "r2"]);
    expect(ids(ranked)).toEqual(["r1", "r2"]);
  });

  it("keeps the strip's order (newest first, as the cache fill sorted it) and the bundle objects themselves", () => {
    const a = bundle("a");
    const b = bundle("b");
    const { filteredBreaking } = splitHomeFeed({ breakingBundles: [b, a], bundles: [] });
    expect(filteredBreaking[0]).toBe(b);
    expect(filteredBreaking[1]).toBe(a);
  });

  it("an optional predicate narrows the strip and the list alike (a search on the home page)", () => {
    const feed = {
      breakingBundles: [bundle("s1", "Deprem haberi"), bundle("s2", "Borsa haberi")],
      bundles: [bundle("r1", "Deprem sonrası"), bundle("r2", "Seçim"), bundle("s1", "Deprem haberi")],
    };
    const { filteredBreaking, filtered, ranked } = splitHomeFeed(feed, (b) =>
      b.cluster.title_tr.startsWith("Deprem"),
    );
    expect(ids(filteredBreaking)).toEqual(["s1"]);
    expect(ids(filtered)).toEqual(["r1", "s1"]);
    expect(ids(ranked)).toEqual(["r1"]);
  });

  it("caps the strip at 6 slots, like the cache fill does", () => {
    const nine = Array.from({ length: 9 }, (_, i) => bundle(`s${i}`));
    const { filteredBreaking } = splitHomeFeed({ breakingBundles: nine, bundles: [] });
    expect(ids(filteredBreaking)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5"]);
  });

  it("an empty feed is three empty lists", () => {
    expect(splitHomeFeed({ breakingBundles: [], bundles: [] })).toEqual({
      filteredBreaking: [],
      filtered: [],
      ranked: [],
    });
  });

  it("does not mutate the feed it is given", () => {
    const feed = {
      breakingBundles: [bundle("s1"), bundle("both")],
      bundles: [bundle("both"), bundle("r1")],
    };
    const before = JSON.stringify(feed);
    splitHomeFeed(feed);
    expect(JSON.stringify(feed)).toBe(before);
  });

  it("the result's lists are fresh arrays, so a caller can sort or push without touching the cached entry", () => {
    const feed = { breakingBundles: [bundle("s1")], bundles: [bundle("r1")] };
    const out = splitHomeFeed(feed);
    expect(out.filteredBreaking).not.toBe(feed.breakingBundles);
    expect(out.filtered).not.toBe(feed.bundles);
  });
});

describe("knownBreakingIds", () => {
  const item = (id: string, minutesAgo: number) => ({
    id,
    firstPublished: new Date(NOW - minutesAgo * 60_000).toISOString(),
  });

  it("returns every listed id, whatever its age: no clock, no window", () => {
    const out = knownBreakingIds([item("fresh", 5), item("hour", 60), item("old", 300), item("ancient", 60 * 24 * 30)]);
    expect(out).toEqual(["fresh", "hour", "old", "ancient"]);
  });

  it("keeps the order it was given and lists an id once", () => {
    const out = knownBreakingIds([item("b", 5), item("a", 6), item("b", 5)]);
    expect(out).toEqual(["b", "a"]);
  });

  it("does not read the date at all: an unparseable or future date is kept like any other", () => {
    const future = { id: "future", firstPublished: new Date(NOW + 60_000).toISOString() };
    const bad = { id: "bad", firstPublished: "not a date" };
    expect(knownBreakingIds([bad, future])).toEqual(["bad", "future"]);
    // Ids alone are enough: the helper takes `{ id }` rows.
    expect(knownBreakingIds([{ id: "x" }, { id: "y" }])).toEqual(["x", "y"]);
  });

  it("an empty list gives nothing", () => {
    expect(knownBreakingIds([])).toEqual([]);
  });

  it("returns a fresh array and does not mutate the list it is given", () => {
    const listed = [item("a", 1), item("b", 2)];
    const before = JSON.stringify(listed);
    const out = knownBreakingIds(listed);
    expect(JSON.stringify(listed)).toBe(before);
    expect(out).not.toBe(listed);
  });

  it("replay: every listed story is known, a strip story and a ranked story outside the window alike", () => {
    const listed = [item("strip1", 3), item("strip2", 40), item("ranked-in-window", 100), item("ranked-old", 600)];
    expect(knownBreakingIds(listed)).toEqual(["strip1", "strip2", "ranked-in-window", "ranked-old"]);
  });

  it("the cache fill's age is not the render's: a strip story that crossed 2 h after the fill is still known, so the head raises no false pill", () => {
    // The strip entry was filled at F with story S first published 2 h - 1 min before F (the fill's
    // window test passed). The page is rendered 3 minutes later, when S is already 2 h 2 min old by the
    // render clock. The entry, and the head read from it, still list S until the next fill (<= 300 s).
    const filledAt = NOW;
    const renderAt = filledAt + 3 * 60_000;
    const story = {
      id: "S",
      firstPublished: new Date(filledAt - (BREAKING_WINDOW_MS - 60_000)).toISOString(),
    };
    expect(renderAt - Date.parse(story.firstPublished)).toBeGreaterThan(BREAKING_WINDOW_MS);

    const ids = knownBreakingIds([{ id: story.id, firstPublished: story.firstPublished }]);
    expect(ids).toContain("S");

    const head = toHomeHead([{ id: story.id, first_published: story.firstPublished }]);
    expect(countNewBreaking(head, ids)).toBe(0);
  });
});
