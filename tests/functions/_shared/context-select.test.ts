import { describe, it, expect } from "vitest";
import {
  selectContextClusterIds,
  stickyUpperBound,
  type ContextClusterRow,
} from "../../../supabase/functions/_shared/cluster/context-select.ts";

// The consumer's rolling context keeps the CAP most recently updated clusters.
// At peak those 200 clusters span only ~2 h, so a busy story that went quiet
// for 3 h dropped out of the window and its follow-ups opened a duplicate
// cluster. The "sticky" tail keeps recent, well-covered clusters matchable.

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const HOUR = 3_600_000;
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

const OPTS = {
  cap: 200,
  stickyMinArticles: 5,
  stickyHours: 12,
  stickyMax: 60,
  now: NOW,
};

function singletons(n: number, spanHours = 1): ContextClusterRow[] {
  // Newest first, spread over the last `spanHours`.
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    updated_at: iso((i / n) * spanHours),
    article_count: 1,
  }));
}

describe("selectContextClusterIds", () => {
  it("includes a 20-article cluster updated 3 h ago that the newest-200 window misses", () => {
    const rows = [...singletons(250), { id: "busy", updated_at: iso(3), article_count: 20 }];
    const ids = selectContextClusterIds(rows, OPTS);
    expect(ids).toContain("busy");
    // base is the 200 newest singletons, sticky follows.
    expect(ids.slice(0, 200)).toEqual(rows.slice(0, 200).map((r) => r.id));
    expect(ids[200]).toBe("busy");
    expect(ids).toHaveLength(201);
  });

  it("excludes the same cluster once it is older than the sticky horizon", () => {
    const rows = [...singletons(250), { id: "busy", updated_at: iso(13), article_count: 20 }];
    expect(selectContextClusterIds(rows, OPTS)).not.toContain("busy");
  });

  it("excludes thin clusters (< stickyMinArticles) from the sticky tail", () => {
    const rows = [...singletons(250), { id: "thin", updated_at: iso(3), article_count: 4 }];
    expect(selectContextClusterIds(rows, OPTS)).not.toContain("thin");
    const five = [...singletons(250), { id: "five", updated_at: iso(3), article_count: 5 }];
    expect(selectContextClusterIds(five, OPTS)).toContain("five");
  });

  it("never admits archived or merged clusters as sticky", () => {
    const rows: ContextClusterRow[] = [
      ...singletons(250),
      { id: "archived", updated_at: iso(3), article_count: 30, is_archived: true },
      { id: "merged", updated_at: iso(3), article_count: 30, merged_into: "other" },
      { id: "ok", updated_at: iso(3), article_count: 30, is_archived: false, merged_into: null },
    ];
    const ids = selectContextClusterIds(rows, OPTS);
    expect(ids).not.toContain("archived");
    expect(ids).not.toContain("merged");
    expect(ids).toContain("ok");
  });

  it("orders sticky rows by article_count desc, then updated_at desc, and honours stickyMax", () => {
    const rows: ContextClusterRow[] = [
      ...singletons(250),
      { id: "c10-old", updated_at: iso(8), article_count: 10 },
      { id: "c10-new", updated_at: iso(2), article_count: 10 },
      { id: "c30", updated_at: iso(9), article_count: 30 },
      { id: "c6", updated_at: iso(1.5), article_count: 6 },
    ];
    const ids = selectContextClusterIds(rows, OPTS);
    expect(ids.slice(200)).toEqual(["c30", "c10-new", "c10-old", "c6"]);

    const capped = selectContextClusterIds(rows, { ...OPTS, stickyMax: 2 });
    expect(capped.slice(200)).toEqual(["c30", "c10-new"]);
  });

  it("bounds the result to cap + stickyMax, with unique ids, and always keeps the cap newest rows", () => {
    const many: ContextClusterRow[] = Array.from({ length: 400 }, (_, i) => ({
      id: `m${i}`,
      updated_at: iso(i * 0.02),
      article_count: i % 7 === 0 ? 12 : 1,
    }));
    // A duplicated id must not be selected twice.
    const rows = [...many, { ...many[5]! }, { ...many[399]! }];
    const ids = selectContextClusterIds(rows, OPTS);
    expect(ids.length).toBeLessThanOrEqual(OPTS.cap + OPTS.stickyMax);
    expect(new Set(ids).size).toBe(ids.length);
    const newest = [...many]
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
      .slice(0, OPTS.cap)
      .map((r) => r.id);
    for (const id of newest) expect(ids).toContain(id);
  });

  it("sorts unordered input by updated_at when picking the base", () => {
    const shuffled = [...singletons(250)].reverse();
    const ids = selectContextClusterIds(shuffled, OPTS);
    expect(ids).toHaveLength(200);
    expect(ids[0]).toBe("s0");
    expect(ids).not.toContain("s249");
  });

  it("keeps archived / merged rows that are already in the newest-cap base (query 1 is unfiltered)", () => {
    const rows: ContextClusterRow[] = [
      { id: "arch-new", updated_at: iso(0.05), article_count: 9, is_archived: true },
      ...singletons(10, 1).map((r) => ({ ...r, id: `x${r.id}` })),
    ];
    expect(selectContextClusterIds(rows, { ...OPTS, cap: 5 })).toContain("arch-new");
  });

  it("returns everything (no sticky) when fewer rows than cap exist", () => {
    const rows = singletons(30);
    expect(selectContextClusterIds(rows, OPTS)).toEqual(rows.map((r) => r.id));
  });

  it("ignores sticky candidates with unparseable timestamps and handles empty input", () => {
    const rows: ContextClusterRow[] = [
      ...singletons(250),
      { id: "bad", updated_at: "not-a-date", article_count: 50 },
    ];
    expect(selectContextClusterIds(rows, OPTS)).not.toContain("bad");
    expect(selectContextClusterIds([], OPTS)).toEqual([]);
  });

  it("accepts a Date for now", () => {
    const rows = [...singletons(250), { id: "busy", updated_at: iso(3), article_count: 20 }];
    expect(selectContextClusterIds(rows, { ...OPTS, now: new Date(NOW) })).toContain("busy");
  });
});

describe("stickyUpperBound", () => {
  it("is null while the context is not full", () => {
    expect(stickyUpperBound(singletons(199), 200)).toBeNull();
    expect(stickyUpperBound([], 200)).toBeNull();
  });

  it("is the updated_at of the cap-th newest row once the context is full", () => {
    const rows = singletons(200);
    expect(stickyUpperBound(rows, 200)).toBe(rows[199]!.updated_at);
    const more = singletons(250);
    expect(stickyUpperBound(more, 200)).toBe(more[199]!.updated_at);
  });
});
