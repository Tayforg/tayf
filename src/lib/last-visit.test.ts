import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { afterEach, vi } from "vitest";

import {
  buildSeenRecord,
  countNewSince,
  countNewSinceVisit,
  LAST_VISIT_KEY,
  LAST_VISIT_SEEN_KEY,
  LAST_VISIT_SEEN_MAX,
  parseLastVisitSeen,
  readLastVisitSeen,
  recordVisit,
  shouldStampLastVisit,
  type LastVisitSeen,
} from "./last-visit";

const ts = ["2026-09-07T10:00:00Z", "2026-09-07T08:00:00Z", "2026-09-06T08:00:00Z"];

describe("countNewSince", () => {
  it("counts timestamps strictly after the stamp", () => {
    expect(countNewSince(ts, "2026-09-07T09:00:00Z")).toBe(1);
  });

  it("treats an equal timestamp as not new", () => {
    expect(countNewSince(ts, "2026-09-07T10:00:00Z")).toBe(0);
  });

  it("returns 0 for a null stamp (first visit)", () => {
    expect(countNewSince(ts, null)).toBe(0);
  });

  it("returns 0 for an unparseable stamp", () => {
    expect(countNewSince(ts, "garbage")).toBe(0);
  });

  it("ignores unparseable entries", () => {
    expect(countNewSince(["nope", ...ts], "2026-09-01T00:00:00Z")).toBe(3);
  });

  it("exposes the storage key", () => {
    expect(LAST_VISIT_KEY).toBe("tayf:last-visit");
  });
});

// h55-personal-3: the stamp is "the reader saw the feed", so only a render that
// actually showed it may write it. A search view, ?page=N and the outage shell
// used to stamp too, and the next session's pill then dropped every story
// published in between that the reader never saw on the feed.
describe("shouldStampLastVisit", () => {
  it("stamps page 1 without a search when the feed rendered", () => {
    expect(shouldStampLastVisit({ page: 1, q: undefined, feedOk: true })).toBe(true);
  });

  it("does not stamp ?page=N (page 2 is not the top of the feed)", () => {
    expect(shouldStampLastVisit({ page: 2, q: undefined, feedOk: true })).toBe(false);
  });

  it("does not stamp a /?q= search view", () => {
    expect(shouldStampLastVisit({ page: 1, q: "seçim", feedOk: true })).toBe(false);
  });

  it("does not stamp when the feed did not render (FeedUnavailable shell)", () => {
    expect(shouldStampLastVisit({ page: 1, q: undefined, feedOk: false })).toBe(false);
  });

  it("a search on a later page, or a failed feed with a search, never stamps", () => {
    expect(shouldStampLastVisit({ page: 3, q: "seçim", feedOk: true })).toBe(false);
    expect(shouldStampLastVisit({ page: 1, q: "seçim", feedOk: false })).toBe(false);
    expect(shouldStampLastVisit({ page: 2, q: undefined, feedOk: false })).toBe(false);
  });

  it("treats an empty-string query like no query (page.tsx maps blank to undefined)", () => {
    expect(shouldStampLastVisit({ page: 1, q: "", feedOk: true })).toBe(true);
  });
});

describe("the stamp is wired through the pill and the page (source guard: effects need a browser)", () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");
  const page = read("../app/page.tsx");
  const pill = read("../components/home/new-since-last-visit.tsx");

  /** Opening tag of every <NewSinceLastVisit ...> mount, up to its closing "/>". */
  function mounts(src: string): string[] {
    const out: string[] = [];
    let from = src.indexOf("<NewSinceLastVisit");
    while (from !== -1) {
      const end = src.indexOf("/>", from);
      out.push(src.slice(from, end + 2));
      from = src.indexOf("<NewSinceLastVisit", end);
    }
    return out;
  }

  it("page.tsx has exactly two mounts, and both pass a stamp prop and a listed prop", () => {
    const all = mounts(page);
    expect(all).toHaveLength(2);
    for (const tag of all) expect(tag).toContain("stamp={");
    for (const tag of all) expect(tag).toContain("listed={");
  });

  it("the FeedUnavailable shell never stamps", () => {
    const shell = mounts(page).filter((tag) => tag.includes("items={[]}"));
    expect(shell).toHaveLength(1);
    expect(shell[0]).toContain("stamp={false}");
    expect(shell[0]).toContain("listed={[]}");
  });

  it("the main mount stamps through shouldStampLastVisit with the clamped page and q", () => {
    const main = mounts(page).filter((tag) => tag.includes("renderedItems"));
    expect(main).toHaveLength(1);
    expect(main[0]).toContain("stamp={shouldStampLastVisit({ page: safePage, q, feedOk: true })}");
    expect(page).toContain('import { shouldStampLastVisit } from "@/lib/last-visit";');
  });

  it("the main mount's `listed` is every cluster the plain feed lists: the breaking strip plus ALL ranked rows, not this page's slice (h113 correctness-1)", () => {
    const main = mounts(page).filter((tag) => tag.includes("renderedItems"));
    expect(main).toHaveLength(1);
    expect(main[0]).toContain("listed={listedItems}");
    expect(page).toMatch(
      /const listedItems = \[\.\.\.breaking, \.\.\.ranked\]\.map\(\(b\) => \(\{\s*id: b\.cluster\.id,\s*firstPublished: b\.cluster\.first_published,\s*\}\)\);/,
    );
  });

  it("the pill takes a required boolean stamp and writes only when it is true", () => {
    expect(pill).toContain("stamp: boolean;");
    expect(pill).not.toContain("stamp?:");
    // h112-follows-1 / h113 correctness-1: the one guarded effect writes the stamp AND the seen
    // record (recordVisit) from the latest `listed` prop (every cluster the plain feed lists,
    // not just this page's rows); it still re-runs only when `stamp` flips.
    expect(pill).toContain("listed: VisitItem[];");
    expect(pill).toContain("if (stamp) recordVisit(new Date().toISOString(), listedRef.current);");
    expect(pill).not.toContain("recordVisit(new Date().toISOString(), itemsRef.current)");
    expect(pill).toContain("}, [stamp]);");
    // ?page>=2 and ?q= views (stamp=false) count with the stamp rule alone: a record is only
    // meaningful against the listing it was built from.
    expect(pill).toContain("countNewSinceVisit(items, stamp ? visit.seen : null, visit.stamp)");
    // The guarded call is the only write: no unconditional one is left behind.
    expect(pill.split("recordVisit(").length - 1).toBe(1);
    expect(pill).not.toContain("writeLastVisit(");
  });
});

// ---------------------------------------------------------------------------
// h112-follows-1: the pill used to count "first_published > stamp". Every listing
// surface needs article_count >= 2, but first_published is the OLDEST member's
// time, so a story that became visible (2nd source) after the visit while its
// first_published was before it never counted, and the next stamp consumed it.
// The visit now also remembers WHICH clusters it showed and the oldest of them.
// ---------------------------------------------------------------------------

const T = "2026-11-10T12:00:00.000Z";
const T_MS = Date.parse(T);
const iso = (ms: number) => new Date(ms).toISOString();
const H = 3_600_000;
const MIN = 60_000;

const IDS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((c) => c.repeat(8) + "-0000-4000-8000-000000000000");
/** A..J, newest first, first published 1h .. 4h before T. */
const shown = IDS.map((id, i) => ({ id, firstPublished: iso(T_MS - H - i * 20 * MIN) }));
const seen: LastVisitSeen = { v: 1, ids: IDS, floor: iso(T_MS - 5 * H) };

/** A window with an in-memory localStorage; `over` replaces single methods. Pair with vi.unstubAllGlobals(). */
function stubStorage(over: Partial<Record<"getItem" | "setItem" | "removeItem", (...a: string[]) => unknown>> = {}) {
  const store = new Map<string, string>();
  const calls: string[] = [];
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        calls.push(`set ${k}`);
        store.set(k, v);
      },
      removeItem: (k: string) => {
        calls.push(`remove ${k}`);
        store.delete(k);
      },
      ...over,
    },
  });
  return { store, calls };
}

describe("countNewSinceVisit", () => {
  it("(1) counts a story that became listed after the stamp but was first published before it", () => {
    const k = { id: "kkkkkkkk-0000-4000-8000-000000000000", firstPublished: iso(T_MS - 40 * MIN) };
    expect(countNewSince([...shown, k].map((i) => i.firstPublished), T)).toBe(0); // today's rule misses it
    expect(countNewSinceVisit([...shown, k], seen, T)).toBe(1);
  });

  it("(2) an unknown id older than the floor counts 0 (a resurfaced old story is not news)", () => {
    const old = { id: "oooooooo-0000-4000-8000-000000000000", firstPublished: iso(T_MS - 6 * H) };
    expect(countNewSinceVisit([...shown, old], seen, T)).toBe(0);
  });

  it("(3) a tie at the floor counts 0 (that row may have been below the cut)", () => {
    const tie = { id: "tttttttt-0000-4000-8000-000000000000", firstPublished: seen.floor };
    expect(countNewSinceVisit([...shown, tie], seen, T)).toBe(0);
    const justAbove = { id: "uuuuuuuu-0000-4000-8000-000000000000", firstPublished: iso(T_MS - 5 * H + 1) };
    expect(countNewSinceVisit([...shown, justAbove], seen, T)).toBe(1);
  });

  it("(4) a missing record gives exactly today's stamp count", () => {
    const items = [
      { id: "x1", firstPublished: iso(T_MS + 10 * MIN) },
      { id: "x2", firstPublished: iso(T_MS - 10 * MIN) },
      { id: "x3", firstPublished: iso(T_MS + 1 * H) },
    ];
    const expected = countNewSince(items.map((i) => i.firstPublished), T);
    expect(expected).toBe(2);
    expect(countNewSinceVisit(items, null, T)).toBe(expected);
    expect(countNewSinceVisit(items, undefined, T)).toBe(expected);
    expect(countNewSinceVisit(items, null, null)).toBe(0);
  });

  it("(5) garbage JSON, or a record of the wrong shape, gives the fallback", () => {
    const items = [{ id: "x1", firstPublished: iso(T_MS + 10 * MIN) }];
    const late = { id: "kkkkkkkk-0000-4000-8000-000000000000", firstPublished: iso(T_MS - 40 * MIN) };
    for (const bad of [
      "not json",
      "",
      "null",
      "[]",
      '{"v":2,"ids":[],"floor":"2026-11-10T07:00:00.000Z"}',
      '{"v":1,"ids":"abc","floor":"2026-11-10T07:00:00.000Z"}',
      '{"v":1,"ids":[1,2],"floor":"2026-11-10T07:00:00.000Z"}',
      '{"v":1,"ids":["a"],"floor":"garbage"}',
      '{"v":1,"ids":["a"]}',
      JSON.stringify({ v: 1, ids: Array.from({ length: LAST_VISIT_SEEN_MAX + 1 }, (_, i) => `id${i}`), floor: seen.floor }),
    ]) {
      expect(countNewSinceVisit(items, bad, T), bad).toBe(1);
      expect(countNewSinceVisit([late], bad, T), bad).toBe(0);
    }
  });

  it("accepts the record as stored JSON text or as the parsed object", () => {
    const k = { id: "kkkkkkkk-0000-4000-8000-000000000000", firstPublished: iso(T_MS - 40 * MIN) };
    expect(countNewSinceVisit([...shown, k], JSON.stringify(seen), T)).toBe(1);
    expect(countNewSinceVisit([...shown, k], seen, T)).toBe(1);
  });

  it("(6) duplicate ids count once, whatever their case", () => {
    const k = { id: "kkkkkkkk-0000-4000-8000-000000000000", firstPublished: iso(T_MS - 40 * MIN) };
    const k2 = { id: k.id.toUpperCase(), firstPublished: k.firstPublished };
    expect(countNewSinceVisit([k, k, k2], seen, T)).toBe(1);
  });

  it("matches the stored ids case-insensitively (the writer lower-cases them)", () => {
    const upper = shown.map((i) => ({ ...i, id: i.id.toUpperCase() }));
    expect(countNewSinceVisit(upper, seen, T)).toBe(0);
  });

  it("an unparseable first_published is never new, and never hides a duplicate that is", () => {
    const bad = { id: "bbbbbbbb-1111-4000-8000-000000000000", firstPublished: "garbage" };
    const good = { id: bad.id, firstPublished: iso(T_MS - 40 * MIN) };
    expect(countNewSinceVisit([bad], seen, T)).toBe(0);
    expect(countNewSinceVisit([bad, good], seen, T)).toBe(1);
  });

  it("an empty page counts 0 with or without a record", () => {
    expect(countNewSinceVisit([], seen, T)).toBe(0);
    expect(countNewSinceVisit([], null, T)).toBe(0);
  });

  it("an item the stamped render showed is never new again, even when its time is above the floor", () => {
    expect(countNewSinceVisit(shown, seen, T)).toBe(0);
  });
});

describe("buildSeenRecord", () => {
  it("lower-cases the ids and takes the minimum first_published as the floor", () => {
    const rec = buildSeenRecord([
      { id: "AAAAAAAA-0000-4000-8000-000000000000", firstPublished: "2026-11-10T10:00:00.000Z" },
      { id: "bbbbbbbb-0000-4000-8000-000000000000", firstPublished: "2026-11-10T06:30:00.000Z" },
    ]);
    expect(rec).toEqual({
      v: 1,
      ids: ["aaaaaaaa-0000-4000-8000-000000000000", "bbbbbbbb-0000-4000-8000-000000000000"],
      floor: "2026-11-10T06:30:00.000Z",
    });
  });

  it("keeps the first_published text as the API gave it", () => {
    const rec = buildSeenRecord([{ id: "a-1", firstPublished: "2026-11-10T06:30:00.123456+00:00" }]);
    expect(rec?.floor).toBe("2026-11-10T06:30:00.123456+00:00");
  });

  it("caps the ids at 200 by keeping the NEWEST, and the floor is the minimum of the kept ones", () => {
    expect(LAST_VISIT_SEEN_MAX).toBe(200);
    const items = Array.from({ length: 250 }, (_, i) => ({
      id: `id-${i}`,
      firstPublished: iso(T_MS - i * MIN),
    }));
    const rec = buildSeenRecord(items);
    expect(rec?.ids).toHaveLength(LAST_VISIT_SEEN_MAX);
    expect(rec?.ids[0]).toBe("id-0");
    expect(rec?.ids).toContain("id-199");
    expect(rec?.ids).not.toContain("id-200");
    expect(rec?.floor).toBe(iso(T_MS - 199 * MIN));
    // a dropped story is older than the floor, so it can never be counted as new
    expect(countNewSinceVisit([{ id: "id-245", firstPublished: items[245]!.firstPublished }], rec, T)).toBe(0);
  });

  it("drops duplicate ids (the floor still counts the oldest row shown) and items whose time cannot be parsed", () => {
    const rec = buildSeenRecord([
      { id: "a-1", firstPublished: "2026-11-10T10:00:00.000Z" },
      { id: "A-1", firstPublished: "2026-11-10T09:00:00.000Z" },
      { id: "b-2", firstPublished: "garbage" },
    ]);
    expect(rec?.ids).toEqual(["a-1"]);
    expect(rec?.floor).toBe("2026-11-10T09:00:00.000Z");
  });

  it("is null when nothing usable was shown (the stamp rule then applies)", () => {
    expect(buildSeenRecord([])).toBeNull();
    expect(buildSeenRecord([{ id: "a-1", firstPublished: "garbage" }])).toBeNull();
  });
});

describe("parseLastVisitSeen", () => {
  it("round-trips a built record", () => {
    const rec = buildSeenRecord(shown);
    expect(parseLastVisitSeen(JSON.stringify(rec))).toEqual(rec);
  });

  it("lower-cases hand-edited ids and rejects anything else that is off", () => {
    expect(parseLastVisitSeen('{"v":1,"ids":["ABC"],"floor":"2026-11-10T07:00:00.000Z"}')?.ids).toEqual(["abc"]);
    expect(parseLastVisitSeen(null)).toBeNull();
    expect(parseLastVisitSeen("{")).toBeNull();
    expect(parseLastVisitSeen("5")).toBeNull();
    expect(parseLastVisitSeen('{"v":1,"ids":[],"floor":"x"}')).toBeNull();
  });

  it("accepts 200 ids and rejects 201 (h113 correctness-1: the bound moved from 80 to 200)", () => {
    const rec = (n: number) => ({
      v: 1,
      ids: Array.from({ length: n }, (_, i) => `id${i}`),
      floor: "2026-11-10T07:00:00.000Z",
    });
    expect(parseLastVisitSeen(JSON.stringify(rec(200)))?.ids).toHaveLength(200);
    expect(parseLastVisitSeen(rec(200))?.ids).toHaveLength(200);
    expect(parseLastVisitSeen(JSON.stringify(rec(201)))).toBeNull();
    expect(parseLastVisitSeen(rec(201))).toBeNull();
  });

  it("keeps an empty id list when the floor is valid", () => {
    expect(parseLastVisitSeen('{"v":1,"ids":[],"floor":"2026-11-10T07:00:00.000Z"}')).toEqual({
      v: 1,
      ids: [],
      floor: "2026-11-10T07:00:00.000Z",
    });
  });
});

describe("seen record storage (never throws)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("exposes the storage key", () => {
    expect(LAST_VISIT_SEEN_KEY).toBe("tayf:last-visit-seen");
  });

  it("recordVisit writes the stamp and the seen record from the items it is given", () => {
    const { store } = stubStorage();
    recordVisit("2026-11-10T12:00:00.000Z", shown);
    expect(store.get(LAST_VISIT_KEY)).toBe("2026-11-10T12:00:00.000Z");
    expect(JSON.parse(store.get(LAST_VISIT_SEEN_KEY)!)).toEqual(buildSeenRecord(shown));
    expect(readLastVisitSeen()).toEqual(buildSeenRecord(shown));
  });

  it("recordVisit with nothing usable removes an older record, so a stale one never meets the new stamp", () => {
    const { store, calls } = stubStorage();
    store.set(LAST_VISIT_SEEN_KEY, JSON.stringify(seen));
    recordVisit("2026-11-10T13:00:00.000Z", []);
    expect(store.get(LAST_VISIT_KEY)).toBe("2026-11-10T13:00:00.000Z");
    expect(store.has(LAST_VISIT_SEEN_KEY)).toBe(false);
    expect(calls).toContain(`remove ${LAST_VISIT_SEEN_KEY}`);
  });

  it("falls back to removing the record when the write fails (quota), and never throws", () => {
    const { store } = stubStorage({
      setItem: (k: string) => {
        if (k === LAST_VISIT_SEEN_KEY) throw new Error("QuotaExceededError");
        store.set(k, "x");
      },
    });
    store.set(LAST_VISIT_SEEN_KEY, JSON.stringify(seen));
    expect(() => recordVisit("2026-11-10T13:00:00.000Z", shown)).not.toThrow();
    expect(store.has(LAST_VISIT_SEEN_KEY)).toBe(false);
  });

  it("a blocked localStorage never throws on read or write", () => {
    const boom = () => {
      throw new Error("SecurityError");
    };
    stubStorage({ getItem: boom, setItem: boom, removeItem: boom });
    expect(readLastVisitSeen()).toBeNull();
    expect(() => recordVisit(T, shown)).not.toThrow();
  });

  it("read returns null for a missing or garbage value and without a window", () => {
    const { store } = stubStorage();
    expect(readLastVisitSeen()).toBeNull();
    store.set(LAST_VISIT_SEEN_KEY, "{oops");
    expect(readLastVisitSeen()).toBeNull();
    vi.unstubAllGlobals();
    expect(typeof window).toBe("undefined");
    expect(readLastVisitSeen()).toBeNull();
    expect(() => recordVisit(T, shown)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// h113 correctness-1: the page lists the top 30 by score, not by first_published,
// and page 2 is disjoint from page 1. A record built from page 1 alone made every
// page-2 story newer than page 1's floor read as new after a page-1 visit (13 of
// the 14 on production at 02:09Z). The record is now built from EVERY cluster the
// plain feed lists, and a record keeps the ids of the previous one, so a story
// that dropped out of one listing and came back is not counted either.
// ---------------------------------------------------------------------------

describe("recordVisit: the whole listing, merged with the previous record (h113 correctness-1)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const cid = (tag: string, i: number) => `${tag}${String(i).padStart(7, "0")}-0000-4000-8000-000000000000`;
  const at = (hoursAgo: number) => iso(T_MS - hoursAgo * H);

  // A live-shaped feed: page 1 is in SCORE order (not time order), its oldest story 19.4 h old;
  // page 2 holds 14 other stories, 13 of them newer than page 1's floor and one older.
  const PAGE1_AGES = [3.2, 19.4, 1.1, 7.5, 2.0, 12.3, 0.9, 5.5, 15.0, 4.1, 9.8, 6.2, 8.4, 10.7, 13.9, 2.8];
  const PAGE2_AGES = [1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5, 13.5, 30];
  const page1 = PAGE1_AGES.map((h, i) => ({ id: cid("p1", i), firstPublished: at(h) }));
  const page2 = PAGE2_AGES.map((h, i) => ({ id: cid("p2", i), firstPublished: at(h) }));

  it("(a) page 2 is not new after a visit that listed both pages, where a page-1-only record counts 13", () => {
    expect(page1).toHaveLength(16);
    expect(page2.filter((i) => Date.parse(i.firstPublished) > Date.parse(at(19.4)))).toHaveLength(13);
    // what a record of page 1 alone does to page 2 (the production symptom)
    expect(countNewSinceVisit(page2, buildSeenRecord(page1), T)).toBe(13);

    stubStorage();
    recordVisit(T, [...page1, ...page2]);
    expect(countNewSinceVisit(page2, readLastVisitSeen(), T)).toBe(0);
    expect(countNewSinceVisit(page1, readLastVisitSeen(), T)).toBe(0);
  });

  it("(b) A/B/C: a story listed at A, missing from B's listing and back at C is not new at C", () => {
    const old = [10, 11, 12].map((h, i) => ({ id: cid("old", i), firstPublished: at(h) }));
    const s = { id: cid("s", 0), firstPublished: at(1) }; // newer than B's floor (10 h)
    const TB = iso(T_MS + 2 * H);

    const { store } = stubStorage();
    recordVisit(T, [s, ...old]); // A
    expect(JSON.parse(store.get(LAST_VISIT_SEEN_KEY)!).ids).toContain(s.id);

    recordVisit(TB, old); // B: S dropped out of the listing
    const atC = readLastVisitSeen();
    expect(atC?.ids).toContain(s.id); // B's record keeps A's ids
    expect(atC?.floor).toBe(at(12)); // while the floor comes from B's own listing
    expect(countNewSinceVisit([s, ...old], atC, TB)).toBe(0); // C
    // a record built from B's listing alone would have counted it
    expect(countNewSinceVisit([s, ...old], buildSeenRecord(old), TB)).toBe(1);
  });

  it("(c) a cluster in no listed set, first published before the stamp but above the floor, still counts 1 (h112-follows-1)", () => {
    stubStorage();
    recordVisit(T, shown);
    const late = { id: "kkkkkkkk-0000-4000-8000-000000000000", firstPublished: iso(T_MS - 40 * MIN) };
    expect(countNewSinceVisit([...shown, late], readLastVisitSeen(), T)).toBe(1);
    // and one older than the floor still does not
    const resurfaced = { id: "oooooooo-0000-4000-8000-000000000000", firstPublished: iso(T_MS - 6 * H) };
    expect(countNewSinceVisit([...shown, resurfaced], readLastVisitSeen(), T)).toBe(0);
  });

  it("the merged ids keep the current listing first, then the previous record's, without duplicates, capped at 200", () => {
    const { store } = stubStorage();
    const previousIds = Array.from({ length: 200 }, (_, i) => cid("prev", i));
    // the previous record also knows one of the current ids: it must appear once, in the current block
    previousIds[5] = page1[0]!.id;
    store.set(LAST_VISIT_SEEN_KEY, JSON.stringify({ v: 1, ids: previousIds, floor: at(40) }));

    const current = page1.slice(0, 3);
    recordVisit(T, current);

    const rec = JSON.parse(store.get(LAST_VISIT_SEEN_KEY)!) as LastVisitSeen;
    const currentNewestFirst = buildSeenRecord(current)!.ids;
    expect(rec.ids).toHaveLength(LAST_VISIT_SEEN_MAX);
    expect(rec.ids.slice(0, 3)).toEqual(currentNewestFirst);
    expect(rec.ids.slice(3, 8)).toEqual(previousIds.slice(0, 5)); // prev-0 .. prev-4
    expect(new Set(rec.ids).size).toBe(rec.ids.length);
    expect(rec.ids.filter((id) => id === page1[0]!.id)).toHaveLength(1);
    // the tail of the previous record is what the cap cut
    expect(rec.ids).not.toContain(previousIds[199]);
    // the floor comes from the current listing only, never from the previous record's older floor
    expect(rec.floor).toBe(buildSeenRecord(current)!.floor);
    expect(rec.floor).not.toBe(at(40));
  });

  it("a current listing larger than the cap is cut to the cap before anything is merged", () => {
    const { store } = stubStorage();
    store.set(LAST_VISIT_SEEN_KEY, JSON.stringify({ v: 1, ids: [cid("prev", 0)], floor: at(40) }));
    const big = Array.from({ length: 230 }, (_, i) => ({ id: cid("big", i), firstPublished: iso(T_MS - i * MIN) }));
    recordVisit(T, big);
    const rec = JSON.parse(store.get(LAST_VISIT_SEEN_KEY)!) as LastVisitSeen;
    expect(rec.ids).toHaveLength(LAST_VISIT_SEEN_MAX);
    expect(rec.ids).not.toContain(cid("prev", 0));
    expect(rec.floor).toBe(iso(T_MS - 199 * MIN));
  });

  it("a garbage or missing previous record is ignored: the new record is the current listing alone", () => {
    const { store } = stubStorage();
    recordVisit(T, shown);
    expect(JSON.parse(store.get(LAST_VISIT_SEEN_KEY)!)).toEqual(buildSeenRecord(shown));
    store.set(LAST_VISIT_SEEN_KEY, "{oops");
    recordVisit(T, shown);
    expect(JSON.parse(store.get(LAST_VISIT_SEEN_KEY)!)).toEqual(buildSeenRecord(shown));
  });

  it("nothing usable listed still drops the previous record (there is no floor to pair its ids with)", () => {
    const { store } = stubStorage();
    recordVisit(T, shown);
    expect(store.has(LAST_VISIT_SEEN_KEY)).toBe(true);
    recordVisit(T, []);
    expect(store.has(LAST_VISIT_SEEN_KEY)).toBe(false);
  });

  it("a blocked localStorage never throws while merging", () => {
    const boom = () => {
      throw new Error("SecurityError");
    };
    stubStorage({ getItem: boom, setItem: boom, removeItem: boom });
    expect(() => recordVisit(T, [...page1, ...page2])).not.toThrow();
  });
});
