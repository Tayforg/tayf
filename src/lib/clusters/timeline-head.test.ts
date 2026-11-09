import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PILL_STATUS_MS,
  TIMELINE_HEAD_LIMIT,
  TIMELINE_POLL_MAX_MS,
  TIMELINE_POLL_MIN_MS,
  TIMELINE_POLL_MS,
  TIMELINE_REFRESH_RETRY_MS,
  countNewClusters,
  newClustersLabel,
  nextPollDelay,
  pageSignature,
  parseTimelineHead,
  readHeadResponse,
  refreshOutcome,
  remainingMs,
  startHeadPolling,
  toTimelineHead,
  type HeadFetchResult,
  type HeadPollingDeps,
  type RefreshOutcome,
  type TimelineHeadRow,
} from "./timeline-head";

// ---------------------------------------------------------------------------
// Pure helpers behind the /timeline "N yeni küme · Yenile" pill. No React, no
// Next: the poller takes every side effect (fetch, clock, timers, visibility)
// as a dependency, so these tests drive it with fake timers and a fake tab.
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-09-18T10:00:00.000Z");

function row(i: number, minutesAgo = i): TimelineHeadRow {
  return {
    id: `c${i}`,
    first_published: new Date(T0 - minutesAgo * 60_000).toISOString(),
  };
}

describe("constants", () => {
  it("pins the documented limits", () => {
    expect(TIMELINE_HEAD_LIMIT).toBe(50);
    expect(TIMELINE_POLL_MS).toBe(120_000);
    expect(TIMELINE_POLL_MAX_MS).toBe(960_000);
    expect(TIMELINE_POLL_MIN_MS).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------
// h76-timeline-1: a pill click can be answered with the page's STALE ISR copy
// (the head, a dynamic route, re-reads the 'cluster-feed' entry; the page copy
// is only rebuilt when someone requests it after its window, and that request
// is itself served the old copy). The pill used to hide itself and announce
// "Liste güncellendi" anyway. These helpers let it compare the page before and
// after the refresh. Pure: the component only wires them to React.
// ---------------------------------------------------------------------------

describe("pageSignature", () => {
  const NEWEST = "2026-11-08T18:14:00.000Z";

  it("is deterministic: identical inputs give identical strings", () => {
    expect(pageSignature(NEWEST, ["a", "b", "c"])).toBe(
      pageSignature(NEWEST, ["a", "b", "c"]),
    );
    expect(typeof pageSignature(NEWEST, ["a"])).toBe("string");
  });

  it("differs when the newest first_published differs", () => {
    expect(pageSignature(NEWEST, ["a", "b"])).not.toBe(
      pageSignature("2026-11-08T18:27:09.000Z", ["a", "b"]),
    );
  });

  it("differs when the first id differs", () => {
    expect(pageSignature(NEWEST, ["a", "b"])).not.toBe(pageSignature(NEWEST, ["z", "b"]));
  });

  it("differs when an id is prepended (the length changes)", () => {
    expect(pageSignature(NEWEST, ["a", "b"])).not.toBe(
      pageSignature(NEWEST, ["new", "a", "b"]),
    );
  });

  it("differs when only the order of the ids differs", () => {
    expect(pageSignature(NEWEST, ["a", "b"])).not.toBe(pageSignature(NEWEST, ["b", "a"]));
  });

  it("does not let two different id lists run together into one string", () => {
    expect(pageSignature(NEWEST, ["a", "bc"])).not.toBe(pageSignature(NEWEST, ["ab", "c"]));
    expect(pageSignature(NEWEST, ["a,b"])).not.toBe(pageSignature(NEWEST, ["a", "b"]));
  });

  it("differs between a null newest (empty page) and a string newest", () => {
    expect(pageSignature(null, [])).not.toBe(pageSignature(NEWEST, []));
    expect(pageSignature(null, ["a"])).not.toBe(pageSignature(NEWEST, ["a"]));
    expect(pageSignature(null, [])).toBe(pageSignature(null, []));
  });

  it("an empty page and a page whose first id is empty text are not confused", () => {
    expect(pageSignature(null, [])).not.toBe(pageSignature(null, [""]));
  });

  it("does not mutate knownIds", () => {
    const ids = Object.freeze(["a", "b", "c"]) as readonly string[];
    expect(() => pageSignature(NEWEST, ids)).not.toThrow();
    expect([...ids]).toEqual(["a", "b", "c"]);
  });

  it("handles a full 50-id page", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
    expect(pageSignature(NEWEST, ids)).toBe(pageSignature(NEWEST, [...ids]));
    expect(pageSignature(NEWEST, ids)).not.toBe(pageSignature(NEWEST, ids.slice(1)));
  });
});

describe("refreshOutcome", () => {
  it("a different signature is 'changed' on the first and on the second attempt", () => {
    expect(refreshOutcome("before", "after", 0)).toBe("changed");
    expect(refreshOutcome("before", "after", 1)).toBe("changed");
  });

  it("the same signature on the first attempt is 'retry' (the stale ISR copy was served once)", () => {
    expect(refreshOutcome("same", "same", 0)).toBe("retry");
  });

  it("the same signature on the retry is 'unchanged' (say so, never a false confirmation)", () => {
    expect(refreshOutcome("same", "same", 1)).toBe("unchanged");
    expect(refreshOutcome("same", "same", 2)).toBe("unchanged");
    expect(refreshOutcome("same", "same", 50)).toBe("unchanged");
  });

  it("a NaN or negative attempt count counts as 0", () => {
    expect(refreshOutcome("same", "same", Number.NaN)).toBe("retry");
    expect(refreshOutcome("same", "same", -1)).toBe("retry");
    expect(refreshOutcome("same", "same", -100)).toBe("retry");
    expect(refreshOutcome("before", "after", Number.NaN)).toBe("changed");
    expect(refreshOutcome("before", "after", -3)).toBe("changed");
  });

  it("an infinite attempt count is treated as 'already retried'", () => {
    expect(refreshOutcome("same", "same", Infinity)).toBe("unchanged");
  });

  it("only ever returns one of the three outcomes", () => {
    const allowed: RefreshOutcome[] = ["changed", "retry", "unchanged"];
    for (const [b, a] of [["x", "x"], ["x", "y"], ["", ""]] as const) {
      for (const attempt of [Number.NaN, -1, 0, 1, 2, 9]) {
        expect(allowed).toContain(refreshOutcome(b, a, attempt));
      }
    }
  });

  it("composes with pageSignature: an unchanged page is 'retry', a page with a new first row is 'changed'", () => {
    const newest = "2026-11-08T18:14:00.000Z";
    const before = pageSignature(newest, ["a", "b"]);
    expect(refreshOutcome(before, pageSignature(newest, ["a", "b"]), 0)).toBe("retry");
    expect(
      refreshOutcome(before, pageSignature("2026-11-08T18:27:09.000Z", ["new", "a", "b"]), 0),
    ).toBe("changed");
  });
});

// The sequence observed live on 2026-11-08 (18:41:52Z-18:42:12Z): the head already
// listed 42fbd3e6, a pill click got the stale ISR copy without it (STALE, age
// 463), and a request 19 s later got the rebuilt copy with it first.
describe("refresh replay: stale ISR copy, then the rebuilt copy (h76-timeline-1)", () => {
  const head: TimelineHeadRow[] = [
    { id: "42fbd3e6-202f-445f-9296-e477993fb9db", first_published: "2026-11-08T18:27:09+00:00" },
    { id: "ed39dd51-b8da-4e17-bd7d-92df89794593", first_published: "2026-11-08T18:16:02+00:00" },
    { id: "757608d3-9d06-41bf-8651-64ebc282fa16", first_published: "2026-11-08T18:14:00+00:00" },
    { id: "37ba6f63-08d2-431f-aee6-51e80e3dd6fa", first_published: "2026-11-08T17:46:15+00:00" },
  ];
  const stalePage = {
    newest: "2026-11-08T18:14:00+00:00",
    ids: [head[2]!.id, head[3]!.id],
  };
  const freshPage = {
    newest: "2026-11-08T18:27:09+00:00",
    ids: head.map((r) => r.id),
  };

  it("the head makes the pill count the new clusters against the stale page, and none against the rebuilt one", () => {
    expect(
      countNewClusters(head, {
        floorPublished: null, // both pages hold fewer than 50 rows: no floor
        knownIds: new Set(stalePage.ids),
      }),
    ).toBe(2);
    expect(
      countNewClusters(head, {
        floorPublished: null,
        knownIds: new Set(freshPage.ids),
      }),
    ).toBe(0);
  });

  it("first click lands on the stale copy: 'retry'; the retry gets the rebuilt copy: 'changed' (never a false confirmation)", () => {
    const before = pageSignature(stalePage.newest, stalePage.ids);
    const afterClick = pageSignature(stalePage.newest, stalePage.ids); // STALE served again
    const afterRetry = pageSignature(freshPage.newest, freshPage.ids); // HIT, new date

    expect(refreshOutcome(before, afterClick, 0)).toBe("retry");
    expect(refreshOutcome(before, afterRetry, 1)).toBe("changed");
  });

  it("if the rebuild has not landed by the retry either, the verdict is 'unchanged', not 'changed'", () => {
    const before = pageSignature(stalePage.newest, stalePage.ids);
    expect(refreshOutcome(before, before, 0)).toBe("retry");
    expect(refreshOutcome(before, before, 1)).toBe("unchanged");
  });

  it("a click that already gets the fresh copy is 'changed' at once, with no retry", () => {
    const before = pageSignature(stalePage.newest, stalePage.ids);
    expect(
      refreshOutcome(before, pageSignature(freshPage.newest, freshPage.ids), 0),
    ).toBe("changed");
  });
});

describe("TIMELINE_REFRESH_RETRY_MS", () => {
  it("is long enough for the stale serve's background rebuild to land and short enough to feel like one click", () => {
    expect(TIMELINE_REFRESH_RETRY_MS).toBeGreaterThanOrEqual(3000);
    expect(TIMELINE_REFRESH_RETRY_MS).toBeLessThanOrEqual(6000);
    expect(Number.isInteger(TIMELINE_REFRESH_RETRY_MS)).toBe(true);
  });
});

describe("PILL_STATUS_MS", () => {
  it("is the six seconds the pill's outcome text stays up", () => {
    expect(PILL_STATUS_MS).toBe(6000);
  });
});

// ---------------------------------------------------------------------------
// react-L1: the pill's two timers (the automatic retry and the status text) are
// cleared when /timeline sits in a hidden <Activity> boundary (cacheComponents
// keeps the page while a cluster is open) and re-armed when it is revealed. The
// pill therefore pins an absolute DEADLINE per outcome and, on every (re-)arm,
// waits only for what is left. remainingMs is that subtraction; null means the
// moment has passed (or a clock was not a number), so the caller drops the
// action instead of firing it late.
// ---------------------------------------------------------------------------

describe("remainingMs", () => {
  it("returns the time left before the deadline", () => {
    expect(remainingMs(10_000, 4_000)).toBe(6_000);
    expect(remainingMs(T0 + 4000, T0)).toBe(4000);
    expect(remainingMs(10_000, 9_999)).toBe(1);
  });

  it("returns 0 exactly at the deadline (still due, not expired)", () => {
    expect(remainingMs(10_000, 10_000)).toBe(0);
    expect(remainingMs(0, 0)).toBe(0);
  });

  it("returns null once the deadline has passed", () => {
    expect(remainingMs(10_000, 10_001)).toBeNull();
    expect(remainingMs(T0, T0 + 60_000)).toBeNull();
    expect(remainingMs(-1, 0)).toBeNull();
  });

  it("returns null for NaN in either input", () => {
    expect(remainingMs(Number.NaN, 1)).toBeNull();
    expect(remainingMs(1, Number.NaN)).toBeNull();
    expect(remainingMs(Number.NaN, Number.NaN)).toBeNull();
  });

  it("returns null for Infinity in either input (never an unbounded wait)", () => {
    expect(remainingMs(Number.POSITIVE_INFINITY, 1)).toBeNull();
    expect(remainingMs(Number.NEGATIVE_INFINITY, 1)).toBeNull();
    expect(remainingMs(1, Number.POSITIVE_INFINITY)).toBeNull();
    expect(remainingMs(1, Number.NEGATIVE_INFINITY)).toBeNull();
    expect(remainingMs(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("never returns a negative number", () => {
    for (const [at, now] of [
      [0, 1],
      [5, 50],
      [-10, -5],
      [10, 10],
      [10, 0],
    ] as const) {
      const left = remainingMs(at, now);
      expect(left === null || left >= 0).toBe(true);
    }
  });

  it("a hidden boundary replay: a 4 s deadline re-armed at 1 s waits 3 s, re-armed at 5 s is dropped", () => {
    const deadlineAt = T0 + TIMELINE_REFRESH_RETRY_MS;
    expect(remainingMs(deadlineAt, T0 + 1000)).toBe(TIMELINE_REFRESH_RETRY_MS - 1000);
    expect(remainingMs(deadlineAt, T0 + 5000)).toBeNull();
    const statusAt = T0 + PILL_STATUS_MS;
    expect(remainingMs(statusAt, T0 + 2500)).toBe(PILL_STATUS_MS - 2500);
    expect(remainingMs(statusAt, T0 + PILL_STATUS_MS + 1)).toBeNull();
  });
});

describe("toTimelineHead", () => {
  it("keeps only id and first_published (titles and counts must not leak)", () => {
    const out = toTimelineHead([
      {
        id: "a",
        first_published: "2026-09-18T10:00:00.000Z",
        title_tr: "Gizli başlık",
        title_tr_neutral: null,
        article_count: 7,
      },
    ]);
    expect(out).toEqual([{ id: "a", first_published: "2026-09-18T10:00:00.000Z" }]);
    expect(Object.keys(out[0] ?? {}).sort()).toEqual(["first_published", "id"]);
    expect(JSON.stringify(out)).not.toContain("Gizli");
  });

  it("returns at most the first 50 rows, in order", () => {
    const rows = Array.from({ length: 200 }, (_, i) => row(i));
    const out = toTimelineHead(rows);
    expect(out).toHaveLength(50);
    expect(out[0]?.id).toBe("c0");
    expect(out[49]?.id).toBe("c49");
  });

  it("handles an empty list and a short list", () => {
    expect(toTimelineHead([])).toEqual([]);
    expect(toTimelineHead([row(1), row(2)])).toHaveLength(2);
  });

  it("does not mutate its input", () => {
    const rows = Array.from({ length: 60 }, (_, i) => row(i));
    toTimelineHead(rows);
    expect(rows).toHaveLength(60);
  });
});

describe("parseTimelineHead", () => {
  const ok = { clusters: [row(1), row(2)] };

  it("accepts a well-formed body", () => {
    expect(parseTimelineHead(ok)).toEqual(ok.clusters);
  });

  it("accepts an empty list", () => {
    expect(parseTimelineHead({ clusters: [] })).toEqual([]);
  });

  it("drops unknown keys from rows it accepts", () => {
    const parsed = parseTimelineHead({
      clusters: [{ ...row(1), title_tr: "x" }],
    });
    expect(parsed).toEqual([row(1)]);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "clusters"],
    ["a number", 42],
    ["an array", [row(1)]],
    ["an object without clusters", {}],
    ["clusters that is not an array", { clusters: "nope" }],
    ["clusters that is an object", { clusters: { 0: row(1) } }],
  ])("rejects %s", (_label, input) => {
    expect(parseTimelineHead(input)).toBeNull();
  });

  it.each([
    ["a null row", [null]],
    ["a primitive row", ["c1"]],
    ["a missing id", [{ first_published: "2026-09-18T10:00:00.000Z" }]],
    ["an empty id", [{ id: "", first_published: "2026-09-18T10:00:00.000Z" }]],
    ["a numeric id", [{ id: 5, first_published: "2026-09-18T10:00:00.000Z" }]],
    [
      "an id longer than 64 chars",
      [{ id: "x".repeat(65), first_published: "2026-09-18T10:00:00.000Z" }],
    ],
    ["a missing date", [{ id: "a" }]],
    ["a non-string date", [{ id: "a", first_published: 1_700_000_000_000 }]],
    ["an unparseable date", [{ id: "a", first_published: "yesterday" }]],
    ["an empty date", [{ id: "a", first_published: "" }]],
  ])("rejects the whole body for %s", (_label, clusters) => {
    expect(parseTimelineHead({ clusters })).toBeNull();
  });

  it("rejects the whole body when ONE row among good ones is bad", () => {
    expect(
      parseTimelineHead({ clusters: [row(1), { id: "b", first_published: "nope" }, row(3)] }),
    ).toBeNull();
  });

  it("accepts an id of exactly 64 chars", () => {
    const id = "x".repeat(64);
    expect(
      parseTimelineHead({ clusters: [{ id, first_published: "2026-09-18T10:00:00.000Z" }] }),
    ).toEqual([{ id, first_published: "2026-09-18T10:00:00.000Z" }]);
  });

  it("accepts exactly 50 rows and rejects 51", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => row(i));
    expect(parseTimelineHead({ clusters: fifty })).toHaveLength(50);
    expect(parseTimelineHead({ clusters: [...fifty, row(50)] })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// h103-timeline-1: a cluster enters the feed when it reaches article_count >= 2,
// i.e. when its second source is ingested (median 39 min after first_published).
// So a newly visible cluster usually has a first_published OLDER than the page's
// newest row, and the old "at or after the newest row" floor skipped it: about
// half of all new clusters (49 of 91 in 14 h) appeared silently inside closed
// hour sections. The floor is now the page's 50th row (the last row the head's
// 50-row window can hold): an unknown head row newer than that is new, an older
// one is page row 51+ moving up after an archive. Pages shorter than 50 rows
// have no floor at all.
// ---------------------------------------------------------------------------

describe("countNewClusters", () => {
  // The page's newest row is T0; its 50th row (the floor) is 60 min before it.
  const floor = new Date(T0 - 60 * 60_000).toISOString();

  /** A head row `minutes` before T0 (negative = after it). */
  const at = (id: string, minutes: number): TimelineHeadRow => ({
    id,
    first_published: new Date(T0 - minutes * 60_000).toISOString(),
  });

  it("(a) counts a late-visible cluster: first_published older than the page's newest row but newer than its 50th", () => {
    const head = [at("late", 20)];
    expect(
      countNewClusters(head, { floorPublished: floor, knownIds: new Set() }),
    ).toBe(1);
  });

  it("(a) still counts rows newer than the page's newest row", () => {
    const head = [at("n1", -5), at("n2", -1), at("seen", 0)];
    expect(
      countNewClusters(head, { floorPublished: floor, knownIds: new Set(["seen"]) }),
    ).toBe(2);
  });

  it("(b) does not count an unknown row older than the floor (page row 51+ surfacing after an archive)", () => {
    const head = [at("older", 90)];
    expect(
      countNewClusters(head, { floorPublished: floor, knownIds: new Set() }),
    ).toBe(0);
  });

  it("(b) an archived page row: row 51 moves into the head's window and is not announced", () => {
    // 50 page rows, one minute apart; the 50th (c49) is the floor. c10 is archived,
    // so the head is c0..c9, c11..c49 and c50 (page row 51, unknown to the page).
    const pageRows = Array.from({ length: 50 }, (_, i) => row(i));
    const ids = new Set(pageRows.map((r) => r.id));
    const headRows = [
      ...pageRows.filter((r) => r.id !== "c10"),
      row(50),
    ];
    expect(headRows).toHaveLength(50);
    expect(
      countNewClusters(headRows, {
        floorPublished: pageRows[49]!.first_published,
        knownIds: ids,
      }),
    ).toBe(0);
  });

  it("(c) does not count an unknown row exactly at the floor (it may be page row 51)", () => {
    const head = [{ id: "tie", first_published: floor }];
    expect(
      countNewClusters(head, { floorPublished: floor, knownIds: new Set() }),
    ).toBe(0);
  });

  it("(c) counts a row one millisecond after the floor", () => {
    const head = [{ id: "just", first_published: new Date(T0 - 60 * 60_000 + 1).toISOString() }];
    expect(
      countNewClusters(head, { floorPublished: floor, knownIds: new Set() }),
    ).toBe(1);
  });

  it("(d) with no floor (a page shorter than 50 rows) every unknown row counts, old ones included", () => {
    const head = [at("new", -5), at("late", 20), at("old", 600), at("ancient", 1400)];
    expect(
      countNewClusters(head, { floorPublished: null, knownIds: new Set() }),
    ).toBe(4);
  });

  it("(d) when the page rendered empty every unknown row counts", () => {
    const head = [row(1), row(2), row(3)];
    expect(
      countNewClusters(head, { floorPublished: null, knownIds: new Set(["c2"]) }),
    ).toBe(2);
  });

  it("(e) returns 0 rather than a false pill when the floor is unparseable", () => {
    expect(
      countNewClusters([at("x", -5)], { floorPublished: "garbage", knownIds: new Set() }),
    ).toBe(0);
    expect(
      countNewClusters([at("x", -5)], { floorPublished: "", knownIds: new Set() }),
    ).toBe(0);
  });

  it("(f) never counts a known id, even a newer one", () => {
    const head = [at("c1", -10)];
    expect(
      countNewClusters(head, { floorPublished: floor, knownIds: new Set(["c1"]) }),
    ).toBe(0);
    expect(
      countNewClusters(head, { floorPublished: null, knownIds: new Set(["c1"]) }),
    ).toBe(0);
  });

  it("(f) counts an id once even if the head repeats it", () => {
    const dup = at("dup", 5);
    expect(
      countNewClusters([dup, dup], { floorPublished: floor, knownIds: new Set() }),
    ).toBe(1);
    expect(
      countNewClusters([dup, dup], { floorPublished: null, knownIds: new Set() }),
    ).toBe(1);
  });

  it("returns 0 for an empty head", () => {
    expect(countNewClusters([], { floorPublished: floor, knownIds: new Set() })).toBe(0);
    expect(countNewClusters([], { floorPublished: null, knownIds: new Set() })).toBe(0);
  });

  it("skips a head row whose own date is unparseable (parseTimelineHead rejects these upstream)", () => {
    const head = [{ id: "bad", first_published: "nope" }, at("ok", 5)];
    expect(
      countNewClusters(head, { floorPublished: floor, knownIds: new Set() }),
    ).toBe(1);
    expect(
      countNewClusters(head, { floorPublished: null, knownIds: new Set() }),
    ).toBe(1);
  });

  it("does not mutate the head or the known set", () => {
    const head = [at("a", 5), at("b", 10)];
    const known = new Set(["k"]);
    countNewClusters(head, { floorPublished: floor, knownIds: known });
    expect(head).toHaveLength(2);
    expect([...known]).toEqual(["k"]);
  });

  // The live pair of GETs on 2026-11-09 (09:43:30Z and 09:57:44Z): the page's
  // newest row was 07:59Z and its 50th row 05:10Z; hour sections 06:00/08:00/10:00
  // went from 2/6/8 to 3/7/11 rows. Between the two reads 28 clusters became
  // visible: 25 newer than the page's newest and three late ones (07:33Z, 07:30Z,
  // 07:00:12Z) that the newest-row floor could not see.
  describe("(g) replay of the 09:57Z case", () => {
    const iso = (hhmm: string) => `2026-11-09T${hhmm}Z`;
    const ms = (s: string) => Date.parse(s);

    // 50 page rows from 07:59Z down to 05:10Z, evenly spaced.
    const first = ms(iso("07:59:00"));
    const last = ms(iso("05:10:00"));
    const pageRows: TimelineHeadRow[] = Array.from({ length: 50 }, (_, i) => ({
      id: `page-${i}`,
      first_published: new Date(first - ((first - last) * i) / 49).toISOString(),
    }));
    const lateRows: TimelineHeadRow[] = [
      { id: "late-0733", first_published: iso("07:33:00") },
      { id: "late-0730", first_published: iso("07:30:00") },
      { id: "late-070012", first_published: iso("07:00:12") },
    ];
    const newerRows: TimelineHeadRow[] = Array.from({ length: 25 }, (_, i) => ({
      id: `new-${i}`,
      first_published: new Date(ms(iso("08:00:00")) + i * 4 * 60_000).toISOString(),
    }));
    // The head is the first 50 rows of the new entry, newest first: the 28 new
    // ones plus the 22 newest page rows.
    const head = [...newerRows, ...lateRows, ...pageRows]
      .sort((a, b) => ms(b.first_published) - ms(a.first_published))
      .slice(0, TIMELINE_HEAD_LIMIT);
    const knownIds = new Set(pageRows.map((r) => r.id));

    it("the fixture is the shape the spec describes", () => {
      expect(pageRows[0]?.first_published).toBe("2026-11-09T07:59:00.000Z");
      expect(pageRows[49]?.first_published).toBe("2026-11-09T05:10:00.000Z");
      expect(head).toHaveLength(TIMELINE_HEAD_LIMIT);
      expect(head.filter((r) => !knownIds.has(r.id))).toHaveLength(28);
    });

    it("counts all 28 newly visible clusters, the three late ones included", () => {
      expect(
        countNewClusters(head, {
          floorPublished: pageRows[49]!.first_published,
          knownIds,
        }),
      ).toBe(28);
    });

    it("the old newest-row floor would have announced only the 25 newer ones", () => {
      const newestMs = ms(pageRows[0]!.first_published);
      const oldLogic = head.filter(
        (r) => !knownIds.has(r.id) && ms(r.first_published) >= newestMs,
      );
      expect(oldLogic).toHaveLength(25);
    });
  });
});

describe("newClustersLabel", () => {
  it("names the count", () => {
    expect(newClustersLabel(1)).toBe("1 yeni küme");
    expect(newClustersLabel(7)).toBe("7 yeni küme");
    expect(newClustersLabel(49)).toBe("49 yeni küme");
  });

  it("caps at 50+", () => {
    expect(newClustersLabel(50)).toBe("50+ yeni küme");
    expect(newClustersLabel(51)).toBe("50+ yeni küme");
    expect(newClustersLabel(10_000)).toBe("50+ yeni küme");
  });
});

describe("nextPollDelay", () => {
  it("doubles per failure from 120 s and caps at 960 s", () => {
    expect(nextPollDelay(0)).toBe(120_000);
    expect(nextPollDelay(1)).toBe(240_000);
    expect(nextPollDelay(2)).toBe(480_000);
    expect(nextPollDelay(3)).toBe(960_000);
    expect(nextPollDelay(4)).toBe(960_000);
    expect(nextPollDelay(50)).toBe(960_000);
  });

  it("honours a Retry-After above the backoff, capped at the max", () => {
    expect(nextPollDelay(1, 300_000)).toBe(300_000);
    expect(nextPollDelay(0, 600_000)).toBe(600_000);
    expect(nextPollDelay(1, 1e9)).toBe(960_000);
  });

  it("ignores a Retry-After below the backoff", () => {
    expect(nextPollDelay(2, 90_000)).toBe(480_000);
  });

  it("is never below 60 s whatever it is fed", () => {
    for (let failures = 0; failures <= 10; failures++) {
      for (const retryAfter of [undefined, -1, 0, Number.NaN, 1e9, Infinity, -Infinity]) {
        const d = nextPollDelay(failures, retryAfter);
        expect(d).toBeGreaterThanOrEqual(60_000);
        expect(d).toBeLessThanOrEqual(960_000);
        expect(Number.isFinite(d)).toBe(true);
      }
    }
  });

  it("treats bad failure counts as 0", () => {
    expect(nextPollDelay(-3)).toBe(120_000);
    expect(nextPollDelay(Number.NaN)).toBe(120_000);
  });
});

describe("readHeadResponse", () => {
  const body = { clusters: [row(1)] };

  function res(init: {
    ok?: boolean;
    retryAfter?: string | null;
    json?: () => Promise<unknown>;
  }) {
    return {
      ok: init.ok ?? true,
      headers: { get: (name: string) => (name === "Retry-After" ? (init.retryAfter ?? null) : null) },
      json: init.json ?? (() => Promise.resolve(body)),
    };
  }

  it("returns the parsed rows on a good 200", async () => {
    await expect(readHeadResponse(res({}))).resolves.toEqual({ ok: true, rows: body.clusters });
  });

  it("returns a failure with Retry-After in ms on a 429/503", async () => {
    await expect(readHeadResponse(res({ ok: false, retryAfter: "120" }))).resolves.toEqual({
      ok: false,
      retryAfterMs: 120_000,
    });
  });

  it("returns a failure without a usable Retry-After when the header is missing", async () => {
    const r = await readHeadResponse(res({ ok: false }));
    expect(r.ok).toBe(false);
    const ms = (r as { retryAfterMs?: number }).retryAfterMs;
    expect(ms === undefined || !(ms > 0)).toBe(true);
  });

  it("returns a failure when the 200 body does not parse", async () => {
    const r = await readHeadResponse(res({ json: () => Promise.resolve({ clusters: "x" }) }));
    expect(r.ok).toBe(false);
  });

  it("returns a failure when the body is not JSON", async () => {
    const r = await readHeadResponse(res({ json: () => Promise.reject(new SyntaxError("bad")) }));
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// startHeadPolling
// ---------------------------------------------------------------------------

interface Harness {
  deps: HeadPollingDeps;
  fetchHead: ReturnType<typeof vi.fn>;
  onRows: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  /** Time (ms since start) of each fetch. */
  fetchTimes: number[];
  signals: AbortSignal[];
  setVisible: (v: boolean, fire?: boolean) => void;
  visibilityListeners: () => number;
  start: number;
}

function harness(opts: {
  visible?: boolean;
  results?: HeadFetchResult[];
  fetchImpl?: (signal: AbortSignal) => Promise<HeadFetchResult>;
}): Harness {
  let visible = opts.visible ?? true;
  const listeners = new Set<() => void>();
  const results = [...(opts.results ?? [])];
  const start = Date.now();
  const fetchTimes: number[] = [];
  const signals: AbortSignal[] = [];
  const unsubscribe = vi.fn();

  const fetchHead = vi.fn((signal: AbortSignal) => {
    fetchTimes.push(Date.now() - start);
    signals.push(signal);
    if (opts.fetchImpl) return opts.fetchImpl(signal);
    const next = results.shift() ?? ({ ok: true, rows: [] } as HeadFetchResult);
    return Promise.resolve(next);
  });
  const onRows = vi.fn();

  const deps: HeadPollingDeps = {
    fetchHead,
    onRows,
    isVisible: () => visible,
    subscribeVisibility: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        unsubscribe();
      };
    },
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };

  return {
    deps,
    fetchHead,
    onRows,
    unsubscribe,
    fetchTimes,
    signals,
    start,
    visibilityListeners: () => listeners.size,
    setVisible: (v, fire = true) => {
      visible = v;
      if (fire) for (const cb of [...listeners]) cb();
    },
  };
}

describe("startHeadPolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never polls on mount: the first poll waits a full POLL_MS", async () => {
    const h = harness({});
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchHead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS - 1);
    expect(h.fetchHead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchHead).toHaveBeenCalledTimes(1);
    stop();
  });

  it("10 minutes visible gives exactly 5 fetches, 120 s apart", async () => {
    const h = harness({});
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.fetchHead).toHaveBeenCalledTimes(5);
    expect(h.fetchTimes).toEqual([120_000, 240_000, 360_000, 480_000, 600_000]);
    stop();
  });

  it("hands the rows of a successful poll to onRows", async () => {
    const rows = [row(1), row(2)];
    const h = harness({ results: [{ ok: true, rows }] });
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS);
    expect(h.onRows).toHaveBeenCalledTimes(1);
    expect(h.onRows).toHaveBeenCalledWith(rows);
    stop();
  });

  it("hidden the whole time: 0 fetches", async () => {
    const h = harness({ visible: false });
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.fetchHead).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("becoming visible after 5 min fetches once immediately, then every 120 s", async () => {
    const h = harness({ visible: false });
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.fetchHead).not.toHaveBeenCalled();

    h.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchTimes).toEqual([300_000]);

    await vi.advanceTimersByTimeAsync(119_999);
    expect(h.fetchHead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchHead).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.fetchHead).toHaveBeenCalledTimes(3);
    expect(h.fetchTimes).toEqual([300_000, 420_000, 540_000]);
    stop();
  });

  it("a timer that fires while hidden fetches nothing", async () => {
    const h = harness({});
    const stop = startHeadPolling(h.deps);
    // Hidden WITHOUT a visibility event (the timer must still check).
    h.setVisible(false, false);
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS * 3);
    expect(h.fetchHead).not.toHaveBeenCalled();
    stop();
  });

  it("going hidden clears the pending timer", async () => {
    const h = harness({});
    const stop = startHeadPolling(h.deps);
    expect(vi.getTimerCount()).toBe(1);
    h.setVisible(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS * 2);
    expect(h.fetchHead).not.toHaveBeenCalled();
    stop();
  });

  it("going visible early schedules only the remaining time, not a fresh 120 s", async () => {
    const h = harness({});
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(30_000);
    h.setVisible(false);
    await vi.advanceTimersByTimeAsync(30_000);
    h.setVisible(true); // 60 s since the (mount) attempt: 60 s remain
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchHead).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.fetchHead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchTimes).toEqual([120_000]);
    stop();
  });

  it("going visible exactly POLL_MS after the last attempt polls immediately", async () => {
    const h = harness({});
    const stop = startHeadPolling(h.deps);
    h.setVisible(false);
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS);
    h.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchTimes).toEqual([TIMELINE_POLL_MS]);
    stop();
  });

  it("a redundant visible event does not stack timers or fetches", async () => {
    const h = harness({});
    const stop = startHeadPolling(h.deps);
    h.setVisible(true);
    h.setVisible(true);
    h.setVisible(true);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS);
    expect(h.fetchHead).toHaveBeenCalledTimes(1);
    stop();
  });

  it("only one request is ever in flight", async () => {
    let release: (r: HeadFetchResult) => void = () => {};
    const h = harness({
      fetchImpl: () =>
        new Promise<HeadFetchResult>((resolve) => {
          release = resolve;
        }),
    });
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS);
    expect(h.fetchHead).toHaveBeenCalledTimes(1);

    // Tab bounces while the request hangs: must NOT start a second one.
    h.setVisible(false);
    await vi.advanceTimersByTimeAsync(600_000);
    h.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchHead).toHaveBeenCalledTimes(1);

    // Once it settles the loop resumes on the normal cadence.
    release({ ok: true, rows: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchHead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS);
    expect(h.fetchHead).toHaveBeenCalledTimes(2);
    stop();
  });

  it("failures back off 240k, 480k, 960k, 960k and a success resets to 120k", async () => {
    const fail: HeadFetchResult = { ok: false };
    const ok: HeadFetchResult = { ok: true, rows: [] };
    const h = harness({ results: [fail, fail, fail, fail, ok, ok] });
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(2_880_000);
    const gaps = h.fetchTimes.map((t, i) => t - (h.fetchTimes[i - 1] ?? 0));
    expect(gaps).toEqual([120_000, 240_000, 480_000, 960_000, 960_000, 120_000]);
    stop();
  });

  it("a rejected fetch counts as a failure (and never crashes the loop)", async () => {
    const h = harness({
      fetchImpl: () => Promise.reject(new TypeError("network down")),
    });
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(120_000 + 240_000 + 480_000);
    expect(h.fetchTimes).toEqual([120_000, 360_000, 840_000]);
    expect(h.onRows).not.toHaveBeenCalled();
    stop();
  });

  it("honours a Retry-After of 300 s over the 240 s backoff", async () => {
    const h = harness({
      results: [{ ok: false, retryAfterMs: 300_000 }, { ok: true, rows: [] }],
    });
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(120_000 + 300_000);
    expect(h.fetchTimes).toEqual([120_000, 420_000]);
    stop();
  });

  it("a Retry-After is spent on one gap only; the next success goes back to 120 s", async () => {
    const h = harness({
      results: [
        { ok: false, retryAfterMs: 300_000 },
        { ok: true, rows: [] },
        { ok: true, rows: [] },
      ],
    });
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(120_000 + 300_000 + 120_000);
    expect(h.fetchTimes).toEqual([120_000, 420_000, 540_000]);
    stop();
  });

  it("does not shorten a backoff by toggling visibility", async () => {
    const h = harness({ results: [{ ok: false }, { ok: true, rows: [] }] });
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(120_000); // fetch #1 fails -> next in 240 s
    h.setVisible(false);
    await vi.advanceTimersByTimeAsync(130_000);
    h.setVisible(true); // only 130 s since the attempt: 110 s of backoff remain
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchHead).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(110_000);
    expect(h.fetchHead).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stop() clears the timer, unsubscribes and stops all fetching", async () => {
    const h = harness({});
    const stop = startHeadPolling(h.deps);
    expect(h.visibilityListeners()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.visibilityListeners()).toBe(0);
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS * 10);
    expect(h.fetchHead).not.toHaveBeenCalled();
  });

  it("stop() aborts the in-flight request and drops its result", async () => {
    let release: (r: HeadFetchResult) => void = () => {};
    const h = harness({
      fetchImpl: () =>
        new Promise<HeadFetchResult>((resolve) => {
          release = resolve;
        }),
    });
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS);
    expect(h.signals[0]?.aborted).toBe(false);

    stop();
    expect(h.signals[0]?.aborted).toBe(true);

    release({ ok: true, rows: [row(1)] });
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS * 5);
    expect(h.onRows).not.toHaveBeenCalled();
    expect(h.fetchHead).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a visibility event after stop() does nothing", async () => {
    const h = harness({ visible: false });
    const stop = startHeadPolling(h.deps);
    stop();
    h.setVisible(true);
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS * 2);
    expect(h.fetchHead).not.toHaveBeenCalled();
  });

  it("stop() is idempotent", () => {
    const h = harness({});
    const stop = startHeadPolling(h.deps);
    stop();
    expect(() => stop()).not.toThrow();
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("a throwing onRows does not kill the loop", async () => {
    const h = harness({});
    h.onRows.mockImplementation(() => {
      throw new Error("boom");
    });
    const stop = startHeadPolling(h.deps);
    await vi.advanceTimersByTimeAsync(TIMELINE_POLL_MS * 3);
    expect(h.fetchHead).toHaveBeenCalledTimes(3);
    stop();
  });
});
