import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  collectPendingArticles,
  JEV_PRIORITY_MAX_PAGES_DEFAULT,
  parsePriorityShare,
  type PendingOrder,
} from "../../supabase/functions/_shared/jev-pending";

// ---------------------------------------------------------------------------
// jev-pending.ts: the cluster-priority pass. Only politics-gate articles
// (articles.category in ('politika','son_dakika')) are ever clustered, so a
// capped shadow budget has to reach them FIRST. These tests run the pure pager
// against an in-memory article list, oldest at index 0, exactly like
// jev-pending.test.ts -- fetchPage walks every category, fetchPriorityPage
// walks the politics subset newest-first.
// ---------------------------------------------------------------------------

type Category = "politika" | "son_dakika" | "spor" | "ekonomi";

interface Row {
  id: string;
  category: Category;
}

const POLITICS = new Set<Category>(["politika", "son_dakika"]);

/** Every 4th row (a0, a4, a8, ...) is politics; every 8th of those is son_dakika. */
function makeMixedRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i): Row => {
    let category: Category = i % 2 === 0 ? "spor" : "ekonomi";
    if (i % 4 === 0) category = i % 8 === 0 ? "politika" : "son_dakika";
    return { id: `a${i}`, category };
  });
}

function fakePages(rows: Row[]) {
  const fetchCalls: Array<{ order: PendingOrder; from: number; to: number }> = [];
  const priorityCalls: Array<{ from: number; to: number }> = [];
  const fetchPage = async (order: PendingOrder, from: number, to: number): Promise<Row[]> => {
    fetchCalls.push({ order, from, to });
    const ordered = order === "asc" ? rows : [...rows].reverse();
    return ordered.slice(from, to + 1);
  };
  const fetchPriorityPage = async (from: number, to: number): Promise<Row[]> => {
    priorityCalls.push({ from, to });
    return [...rows]
      .reverse()
      .filter((r) => POLITICS.has(r.category))
      .slice(from, to + 1);
  };
  return { fetchPage, fetchPriorityPage, fetchCalls, priorityCalls };
}

function seenFactory(seenIds: Set<string>) {
  const calls: string[][] = [];
  const seen = async (ids: string[]): Promise<Set<string>> => {
    calls.push([...ids]);
    return new Set(ids.filter((id) => seenIds.has(id)));
  };
  return { seen, calls };
}

const ids = (rows: Row[]): string[] => rows.map((r) => r.id);

describe("collectPendingArticles: priority pass", () => {
  it("priority rows come first, newest politics first, ahead of newer non-politics rows", async () => {
    const rows = makeMixedRows(40); // politics: a0, a4, ..., a36 (10 rows)
    const { fetchPage, fetchPriorityPage } = fakePages(rows);
    const result = await collectPendingArticles({
      limit: 12,
      pageSize: 5,
      maxPages: 8,
      freshMaxPages: 2,
      fetchPage,
      fetchPriorityPage,
      priorityMaxPages: 3,
      seen: seenFactory(new Set()).seen,
    });
    // a39 / a38 / a37 are newer than a36 but are not politics: they trail.
    expect(ids(result.rows)).toEqual([
      "a36", "a32", "a28", "a24", "a20", "a16", "a12", "a8", "a4", "a0", // priority
      "a39", "a38", // fresh pass fills the rest
    ]);
    expect(result.priorityRows).toBe(10);
    expect(result.freshRows).toBe(2);
    expect(result.backfillRows).toBe(0);
    expect(result.priorityFailed).toBe(false);
    expect(result.stoppedAtDeadline).toBe(false);
  });

  it("every priority row is a politics-gate row", async () => {
    const rows = makeMixedRows(60);
    const { fetchPage, fetchPriorityPage } = fakePages(rows);
    const result = await collectPendingArticles({
      limit: 8,
      pageSize: 4,
      maxPages: 8,
      freshMaxPages: 2,
      fetchPage,
      fetchPriorityPage,
      seen: seenFactory(new Set()).seen,
    });
    const first = result.rows.slice(0, result.priorityRows);
    expect(first.length).toBe(8);
    expect(first.every((r) => POLITICS.has(r.category))).toBe(true);
  });

  it("skips already-seen politics rows and counts only unseen ones as priority rows", async () => {
    const rows = makeMixedRows(40);
    const { fetchPage, fetchPriorityPage } = fakePages(rows);
    const result = await collectPendingArticles({
      limit: 3,
      pageSize: 5,
      maxPages: 8,
      freshMaxPages: 2,
      fetchPage,
      fetchPriorityPage,
      seen: seenFactory(new Set(["a36", "a32"])).seen,
    });
    expect(ids(result.rows)).toEqual(["a28", "a24", "a20"]);
    expect(result.priorityRows).toBe(3);
  });

  it("dedupes against the later passes: a priority row is never picked, or anti-joined, twice", async () => {
    const rows = makeMixedRows(40);
    const { fetchPage, fetchPriorityPage } = fakePages(rows);
    const { seen, calls } = seenFactory(new Set());
    const result = await collectPendingArticles({
      limit: 30,
      pageSize: 10,
      maxPages: 8,
      freshMaxPages: 4,
      fetchPage,
      fetchPriorityPage,
      seen,
    });
    const picked = ids(result.rows);
    expect(new Set(picked).size).toBe(picked.length);
    // a36 is a politics row: it is asked of the anti-join exactly once (in the
    // priority pass); the fresh pass filters it out before calling seen().
    expect(calls.flat().filter((id) => id === "a36")).toHaveLength(1);
    // 30 rows were requested and the window holds 40: priority (10) + fresh (20).
    expect(picked).toHaveLength(30);
    expect(result.priorityRows).toBe(10);
    expect(result.freshRows).toBe(20);
  });

  it("respects the limit: when the priority pass alone fills it, no other page is fetched", async () => {
    const rows = makeMixedRows(40);
    const { fetchPage, fetchPriorityPage, fetchCalls } = fakePages(rows);
    const result = await collectPendingArticles({
      limit: 7,
      pageSize: 5,
      maxPages: 8,
      freshMaxPages: 2,
      fetchPage,
      fetchPriorityPage,
      seen: seenFactory(new Set()).seen,
    });
    expect(result.rows).toHaveLength(7);
    expect(result.priorityRows).toBe(7);
    expect(result.freshRows).toBe(0);
    expect(fetchCalls).toHaveLength(0);
  });

  it("priorityShare caps the share of the limit the priority pass may take; the fresh pass gets the remainder", async () => {
    const rows = makeMixedRows(40);
    const { fetchPage, fetchPriorityPage } = fakePages(rows);
    const result = await collectPendingArticles({
      limit: 10,
      pageSize: 5,
      maxPages: 8,
      freshMaxPages: 4,
      fetchPage,
      fetchPriorityPage,
      priorityShare: 0.3, // floor(10 * 0.3) = 3
      seen: seenFactory(new Set()).seen,
    });
    expect(result.priorityRows).toBe(3);
    expect(ids(result.rows).slice(0, 3)).toEqual(["a36", "a32", "a28"]);
    expect(result.freshRows).toBe(7);
    expect(ids(result.rows).slice(3)).toEqual(["a39", "a38", "a37", "a35", "a34", "a33", "a31"]);
  });

  it("priorityShare 0 disables the pass entirely (no priority fetch) and matches the legacy order", async () => {
    const rows = makeMixedRows(40);
    const base = { limit: 10, pageSize: 5, maxPages: 8, freshMaxPages: 2 };
    const legacy = fakePages(rows);
    const expected = await collectPendingArticles({
      ...base,
      fetchPage: legacy.fetchPage,
      seen: seenFactory(new Set()).seen,
    });
    const wired = fakePages(rows);
    const result = await collectPendingArticles({
      ...base,
      fetchPage: wired.fetchPage,
      fetchPriorityPage: wired.fetchPriorityPage,
      priorityShare: 0,
      seen: seenFactory(new Set()).seen,
    });
    expect(wired.priorityCalls).toHaveLength(0);
    expect(ids(result.rows)).toEqual(ids(expected.rows));
    expect(wired.fetchCalls).toEqual(legacy.fetchCalls);
    expect(result.priorityRows).toBe(0);
    expect(result.priorityFailed).toBe(false);
  });

  it("an out-of-range priorityShare is clamped to [0, 1]", async () => {
    const rows = makeMixedRows(40);
    const over = fakePages(rows);
    const resultOver = await collectPendingArticles({
      limit: 4,
      pageSize: 5,
      maxPages: 8,
      freshMaxPages: 2,
      fetchPage: over.fetchPage,
      fetchPriorityPage: over.fetchPriorityPage,
      priorityShare: 7,
      seen: seenFactory(new Set()).seen,
    });
    expect(resultOver.priorityRows).toBe(4);
    const under = fakePages(rows);
    const resultUnder = await collectPendingArticles({
      limit: 4,
      pageSize: 5,
      maxPages: 8,
      freshMaxPages: 2,
      fetchPage: under.fetchPage,
      fetchPriorityPage: under.fetchPriorityPage,
      priorityShare: -3,
      seen: seenFactory(new Set()).seen,
    });
    expect(resultUnder.priorityRows).toBe(0);
    expect(under.priorityCalls).toHaveLength(0);
  });

  it("a non-finite priorityShare falls back to the default share of 1", async () => {
    const rows = makeMixedRows(40);
    const pages = fakePages(rows);
    const result = await collectPendingArticles({
      limit: 4,
      pageSize: 5,
      maxPages: 8,
      freshMaxPages: 2,
      fetchPage: pages.fetchPage,
      fetchPriorityPage: pages.fetchPriorityPage,
      priorityShare: Number.NaN,
      seen: seenFactory(new Set()).seen,
    });
    expect(result.priorityRows).toBe(4);
  });

  it("an empty priority page falls through to the legacy passes unchanged", async () => {
    const rows = makeMixedRows(40);
    const base = { limit: 10, pageSize: 5, maxPages: 8, freshMaxPages: 2 };
    const legacy = fakePages(rows);
    const expected = await collectPendingArticles({
      ...base,
      fetchPage: legacy.fetchPage,
      seen: seenFactory(new Set()).seen,
    });
    const wired = fakePages(rows);
    const result = await collectPendingArticles({
      ...base,
      fetchPage: wired.fetchPage,
      fetchPriorityPage: async (from, to) => {
        wired.priorityCalls.push({ from, to });
        return [];
      },
      seen: seenFactory(new Set()).seen,
    });
    expect(ids(result.rows)).toEqual(ids(expected.rows));
    expect(wired.fetchCalls).toEqual(legacy.fetchCalls);
    expect(wired.priorityCalls).toHaveLength(1);
    expect(result.priorityRows).toBe(0);
    expect(result.priorityFailed).toBe(false);
    expect(result.pagesRead).toBe(expected.pagesRead + 1);
  });

  it("a short priority page ends the priority pass but does NOT mark the whole window exhausted", async () => {
    // 3 politics rows < pageSize 5: one priority call, then the fresh pass
    // still runs over the other categories.
    const rows = makeMixedRows(12); // politics: a0, a4, a8
    const { fetchPage, fetchPriorityPage, fetchCalls, priorityCalls } = fakePages(rows);
    const result = await collectPendingArticles({
      limit: 10,
      pageSize: 5,
      maxPages: 8,
      freshMaxPages: 3,
      fetchPage,
      fetchPriorityPage,
      seen: seenFactory(new Set()).seen,
    });
    expect(priorityCalls).toHaveLength(1);
    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(ids(result.rows).slice(0, 3)).toEqual(["a8", "a4", "a0"]);
    expect(result.rows).toHaveLength(10);
    expect(new Set(ids(result.rows)).size).toBe(10);
  });

  it("dedupes ids repeated across priority pages (offset drift while rows arrive)", async () => {
    const rows = makeMixedRows(40);
    const politicsNewestFirst = [...rows].reverse().filter((r) => POLITICS.has(r.category));
    // Page 2 repeats the last row of page 1, as an arriving row would cause.
    const pages: Row[][] = [politicsNewestFirst.slice(0, 5), politicsNewestFirst.slice(4, 9)];
    let call = 0;
    const result = await collectPendingArticles({
      limit: 20,
      pageSize: 5,
      maxPages: 8,
      freshMaxPages: 1,
      fetchPage: fakePages(rows).fetchPage,
      fetchPriorityPage: async () => pages[call++] ?? [],
      priorityMaxPages: 3,
      seen: seenFactory(new Set()).seen,
    });
    const picked = ids(result.rows);
    expect(new Set(picked).size).toBe(picked.length);
    expect(picked.slice(0, 9)).toEqual(ids(politicsNewestFirst.slice(0, 9)));
    expect(result.priorityRows).toBe(9);
  });
});

describe("collectPendingArticles: priority pass page budget", () => {
  it("priority pages count against maxPages: priority + fresh + backlog never exceed it", async () => {
    const rows = makeMixedRows(400);
    const { fetchPage, fetchPriorityPage, fetchCalls, priorityCalls } = fakePages(rows);
    const result = await collectPendingArticles({
      limit: 100000, // never reached: every page is read
      pageSize: 10,
      maxPages: 6,
      freshMaxPages: 4,
      fetchPage,
      fetchPriorityPage,
      priorityMaxPages: 3,
      seen: seenFactory(new Set()).seen,
    });
    expect(priorityCalls).toHaveLength(3);
    expect(fetchCalls.length + priorityCalls.length).toBeLessThanOrEqual(6);
    expect(result.pagesRead).toBe(fetchCalls.length + priorityCalls.length);
    // 6 - 3 priority = 3 left: fresh is capped by what remains, not by freshMaxPages.
    expect(fetchCalls.filter((c) => c.order === "desc")).toHaveLength(3);
    expect(fetchCalls.filter((c) => c.order === "asc")).toHaveLength(0);
  });

  it("priorityMaxPages is capped by maxPages", async () => {
    const rows = makeMixedRows(400);
    const { fetchPage, fetchPriorityPage, fetchCalls, priorityCalls } = fakePages(rows);
    await collectPendingArticles({
      limit: 100000,
      pageSize: 10,
      maxPages: 2,
      freshMaxPages: 4,
      fetchPage,
      fetchPriorityPage,
      priorityMaxPages: 9,
      seen: seenFactory(new Set()).seen,
    });
    expect(priorityCalls).toHaveLength(2);
    expect(fetchCalls).toHaveLength(0);
  });

  it("priorityMaxPages defaults to JEV_PRIORITY_MAX_PAGES_DEFAULT", async () => {
    const rows = makeMixedRows(2000);
    const { fetchPage, fetchPriorityPage, priorityCalls } = fakePages(rows);
    await collectPendingArticles({
      limit: 100000,
      pageSize: 10,
      maxPages: 50,
      freshMaxPages: 1,
      fetchPage,
      fetchPriorityPage,
      seen: seenFactory(new Set()).seen,
    });
    expect(JEV_PRIORITY_MAX_PAGES_DEFAULT).toBeGreaterThanOrEqual(1);
    expect(priorityCalls).toHaveLength(JEV_PRIORITY_MAX_PAGES_DEFAULT);
  });

  it("priorityMaxPages of 0 or less reads no priority page", async () => {
    const rows = makeMixedRows(40);
    const zero = fakePages(rows);
    await collectPendingArticles({
      limit: 5,
      pageSize: 5,
      maxPages: 8,
      freshMaxPages: 2,
      fetchPage: zero.fetchPage,
      fetchPriorityPage: zero.fetchPriorityPage,
      priorityMaxPages: 0,
      seen: seenFactory(new Set()).seen,
    });
    expect(zero.priorityCalls).toHaveLength(0);
    const negative = fakePages(rows);
    await collectPendingArticles({
      limit: 5,
      pageSize: 5,
      maxPages: 8,
      freshMaxPages: 2,
      fetchPage: negative.fetchPage,
      fetchPriorityPage: negative.fetchPriorityPage,
      priorityMaxPages: -2,
      seen: seenFactory(new Set()).seen,
    });
    expect(negative.priorityCalls).toHaveLength(0);
  });
});

describe("collectPendingArticles: priority pass deadline", () => {
  it("a deadline already past before the first page fetches nothing at all", async () => {
    const { fetchPage, fetchPriorityPage, fetchCalls, priorityCalls } = fakePages(makeMixedRows(40));
    const result = await collectPendingArticles({
      limit: 10,
      pageSize: 5,
      maxPages: 8,
      freshMaxPages: 2,
      fetchPage,
      fetchPriorityPage,
      seen: seenFactory(new Set()).seen,
      isPastDeadline: () => true,
    });
    expect(priorityCalls).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
    expect(result.rows).toEqual([]);
    expect(result.stoppedAtDeadline).toBe(true);
  });

  it("a deadline reached after the first priority page returns those rows and skips every later page", async () => {
    const rows = makeMixedRows(40);
    const { fetchPage, fetchPriorityPage, fetchCalls, priorityCalls } = fakePages(rows);
    const result = await collectPendingArticles({
      limit: 20,
      pageSize: 5,
      maxPages: 8,
      freshMaxPages: 2,
      fetchPage,
      fetchPriorityPage,
      seen: seenFactory(new Set()).seen,
      isPastDeadline: () => priorityCalls.length >= 1,
    });
    expect(priorityCalls).toHaveLength(1);
    expect(fetchCalls).toHaveLength(0);
    expect(ids(result.rows)).toEqual(["a36", "a32", "a28", "a24", "a20"]);
    expect(result.stoppedAtDeadline).toBe(true);
    expect(result.pagesRead).toBe(1);
    expect(result.priorityRows).toBe(5);
  });

  it("a deadline reached between the priority pass and pass 1 keeps the priority rows and skips pass 1 and 2", async () => {
    const rows = makeMixedRows(12); // 3 politics rows: one short priority page
    const { fetchPage, fetchPriorityPage, fetchCalls } = fakePages(rows);
    let priorityDone = false;
    const result = await collectPendingArticles({
      limit: 10,
      pageSize: 5,
      maxPages: 8,
      freshMaxPages: 2,
      fetchPage,
      fetchPriorityPage: async (from, to) => {
        const page = await fetchPriorityPage(from, to);
        priorityDone = true;
        return page;
      },
      seen: seenFactory(new Set()).seen,
      isPastDeadline: () => priorityDone,
    });
    expect(fetchCalls).toHaveLength(0);
    expect(ids(result.rows)).toEqual(["a8", "a4", "a0"]);
    expect(result.stoppedAtDeadline).toBe(true);
  });
});

describe("collectPendingArticles: priority pass failure", () => {
  const base = { limit: 10, pageSize: 5, maxPages: 8, freshMaxPages: 2 };

  it("a throwing priority fetch falls back to the legacy passes instead of failing the tick", async () => {
    const rows = makeMixedRows(40);
    const legacy = fakePages(rows);
    const expected = await collectPendingArticles({
      ...base,
      fetchPage: legacy.fetchPage,
      seen: seenFactory(new Set()).seen,
    });
    const wired = fakePages(rows);
    const boom = new Error("jev-shadow: fetchPendingArticles priority failed: canceling statement due to statement timeout");
    const errors: unknown[] = [];
    let priorityCalls = 0;
    const result = await collectPendingArticles({
      ...base,
      fetchPage: wired.fetchPage,
      fetchPriorityPage: async () => {
        priorityCalls++;
        throw boom;
      },
      onPriorityError: (err) => errors.push(err),
      seen: seenFactory(new Set()).seen,
    });
    expect(ids(result.rows)).toEqual(ids(expected.rows));
    expect(wired.fetchCalls).toEqual(legacy.fetchCalls);
    expect(result.priorityFailed).toBe(true);
    expect(result.priorityRows).toBe(0);
    expect(priorityCalls).toBe(1); // no retry loop on a failing query
    expect(errors).toEqual([boom]);
  });

  it("works without an onPriorityError callback", async () => {
    const rows = makeMixedRows(40);
    const { fetchPage } = fakePages(rows);
    const result = await collectPendingArticles({
      ...base,
      fetchPage,
      fetchPriorityPage: async () => {
        throw new Error("nope");
      },
      seen: seenFactory(new Set()).seen,
    });
    expect(result.priorityFailed).toBe(true);
    expect(result.rows).toHaveLength(10);
  });

  it("a failure on the second priority page keeps the first page's rows and still runs the legacy passes", async () => {
    const rows = makeMixedRows(40);
    const { fetchPage, fetchPriorityPage, fetchCalls } = fakePages(rows);
    let call = 0;
    const result = await collectPendingArticles({
      ...base,
      fetchPage,
      fetchPriorityPage: async (from, to) => {
        call++;
        if (call === 2) throw new Error("page 2 failed");
        return fetchPriorityPage(from, to);
      },
      priorityMaxPages: 3,
      seen: seenFactory(new Set()).seen,
    });
    expect(ids(result.rows).slice(0, 5)).toEqual(["a36", "a32", "a28", "a24", "a20"]);
    expect(result.priorityRows).toBe(5);
    expect(result.priorityFailed).toBe(true);
    expect(fetchCalls.length).toBeGreaterThan(0);
    expect(result.rows).toHaveLength(10);
    expect(new Set(ids(result.rows)).size).toBe(10);
  });

  it("a seen() failure inside the priority pass also falls back; the next seen() call serves the legacy passes", async () => {
    const rows = makeMixedRows(40);
    const { fetchPage, fetchPriorityPage } = fakePages(rows);
    let seenCalls = 0;
    const result = await collectPendingArticles({
      ...base,
      fetchPage,
      fetchPriorityPage,
      seen: async (): Promise<Set<string>> => {
        seenCalls++;
        if (seenCalls === 1) throw new Error("anti-join failed");
        return new Set();
      },
    });
    expect(result.priorityFailed).toBe(true);
    expect(result.priorityRows).toBe(0);
    expect(result.rows).toHaveLength(10);
  });

  it("a seen() failure that persists into the legacy passes still propagates, exactly as before", async () => {
    const rows = makeMixedRows(40);
    const { fetchPage, fetchPriorityPage } = fakePages(rows);
    await expect(
      collectPendingArticles({
        ...base,
        fetchPage,
        fetchPriorityPage,
        seen: async () => {
          throw new Error("db down");
        },
      }),
    ).rejects.toThrow("db down");
  });

  it("a throwing onPriorityError never breaks the pager", async () => {
    const rows = makeMixedRows(40);
    const { fetchPage } = fakePages(rows);
    const result = await collectPendingArticles({
      ...base,
      fetchPage,
      fetchPriorityPage: async () => {
        throw new Error("nope");
      },
      onPriorityError: () => {
        throw new Error("logger exploded");
      },
      seen: seenFactory(new Set()).seen,
    });
    expect(result.priorityFailed).toBe(true);
    expect(result.rows).toHaveLength(10);
  });
});

describe("collectPendingArticles: priority pass absent (legacy contract)", () => {
  it("returns exactly the legacy result shape, with no priority keys", async () => {
    const rows = makeMixedRows(20);
    const { fetchPage } = fakePages(rows);
    const result = await collectPendingArticles({
      limit: 5,
      pageSize: 5,
      maxPages: 4,
      freshMaxPages: 2,
      fetchPage,
      seen: seenFactory(new Set()).seen,
    });
    expect(Object.keys(result).sort()).toEqual(["backfillRows", "freshRows", "pagesRead", "rows", "stoppedAtDeadline"]);
  });

  it("priorityMaxPages / priorityShare / onPriorityError are inert without fetchPriorityPage", async () => {
    const rows = makeMixedRows(40);
    const base = { limit: 10, pageSize: 5, maxPages: 8, freshMaxPages: 2 };
    const plain = fakePages(rows);
    const expected = await collectPendingArticles({
      ...base,
      fetchPage: plain.fetchPage,
      seen: seenFactory(new Set()).seen,
    });
    const withKnobs = fakePages(rows);
    const result = await collectPendingArticles({
      ...base,
      fetchPage: withKnobs.fetchPage,
      priorityMaxPages: 5,
      priorityShare: 0.5,
      onPriorityError: () => {
        throw new Error("must never be called");
      },
      seen: seenFactory(new Set()).seen,
    });
    expect(result).toStrictEqual(expected);
    expect(withKnobs.fetchCalls).toEqual(plain.fetchCalls);
  });
});

describe("collectPendingArticles: priority pass at production scale", () => {
  it("a 12,000-row window with the newest 400 unseen: politics first, <= maxPages round trips, limit honoured", async () => {
    const rows = makeMixedRows(12000); // 25% politics -- a heavier mix than the real ~22%
    const newest400 = new Set(rows.slice(-400).map((r) => r.id));
    const seenIds = new Set(rows.map((r) => r.id).filter((id) => !newest400.has(id)));
    const { fetchPage, fetchPriorityPage, fetchCalls, priorityCalls } = fakePages(rows);
    const result = await collectPendingArticles({
      limit: 150,
      pageSize: 300,
      maxPages: 10,
      freshMaxPages: 4,
      fetchPage,
      fetchPriorityPage,
      priorityMaxPages: 3,
      seen: seenFactory(seenIds).seen,
    });
    expect(result.rows).toHaveLength(150);
    expect(new Set(ids(result.rows)).size).toBe(150);
    // 400 newest rows hold 100 politics rows: they are the first 100, then 50 others.
    expect(result.rows.slice(0, 100).every((r) => POLITICS.has(r.category))).toBe(true);
    expect(result.priorityRows).toBe(100);
    expect(result.freshRows).toBe(50);
    expect(fetchCalls.length + priorityCalls.length).toBeLessThanOrEqual(10);
  });
});

describe("collectPendingArticles: priority pass reaches the middle of the window", () => {
  it("regression: politics rows stranded between the newest 1,200 and the oldest 1,800 rows are invisible to the legacy passes but found by pass 0", async () => {
    // A ~10k-row 24h window. The UTC-day cap left the politics rows of the
    // afternoon unscored: they sit in the middle of the window, outside both
    // the newest pages (pass 1) and the oldest pages (pass 2).
    const rows = makeMixedRows(10000);
    const index = new Map(rows.map((r, i) => [r.id, i]));
    const stranded = new Set(
      rows.filter((r, i) => i >= 6000 && i < 8800 && POLITICS.has(r.category)).map((r) => r.id),
    );
    expect(stranded.size).toBe(700);
    const seenIds = new Set(rows.map((r) => r.id).filter((id) => !stranded.has(id)));
    const base = { limit: 150, pageSize: 300, maxPages: 10, freshMaxPages: 4 };

    const legacy = fakePages(rows);
    const before = await collectPendingArticles({
      ...base,
      fetchPage: legacy.fetchPage,
      seen: seenFactory(seenIds).seen,
    });
    expect(before.rows).toEqual([]);

    const wired = fakePages(rows);
    const after = await collectPendingArticles({
      ...base,
      fetchPage: wired.fetchPage,
      fetchPriorityPage: wired.fetchPriorityPage,
      seen: seenFactory(seenIds).seen,
    });
    expect(after.rows).toHaveLength(150);
    expect(after.priorityRows).toBe(150);
    expect(after.rows.every((r) => stranded.has(r.id))).toBe(true);
    // newest stranded politics rows first
    const positions = after.rows.map((r) => index.get(r.id) as number);
    expect([...positions].sort((a, b) => b - a)).toEqual(positions);
    expect(wired.fetchCalls.length + wired.priorityCalls.length).toBeLessThanOrEqual(10);
  });
});

describe("parsePriorityShare", () => {
  it("defaults to 1 for an absent, empty or non-numeric value", () => {
    expect(parsePriorityShare(undefined)).toBe(1);
    expect(parsePriorityShare(null)).toBe(1);
    expect(parsePriorityShare("")).toBe(1);
    expect(parsePriorityShare("   ")).toBe(1);
    expect(parsePriorityShare("abc")).toBe(1);
    expect(parsePriorityShare("NaN")).toBe(1);
    expect(parsePriorityShare("Infinity")).toBe(1);
  });

  it("honours 0 as the kill switch rather than treating it as missing", () => {
    expect(parsePriorityShare("0")).toBe(0);
    expect(parsePriorityShare("0.0")).toBe(0);
  });

  it("parses fractions and clamps to [0, 1]", () => {
    expect(parsePriorityShare("0.25")).toBe(0.25);
    expect(parsePriorityShare(" 0.5 ")).toBe(0.5);
    expect(parsePriorityShare("1")).toBe(1);
    expect(parsePriorityShare("1.5")).toBe(1);
    expect(parsePriorityShare("-1")).toBe(0);
  });
});

describe("jev-shadow/index.ts static guard (cluster priority)", () => {
  const indexTs = readFileSync(
    resolve(__dirname, "..", "..", "supabase", "functions", "jev-shadow", "index.ts"),
    "utf8",
  );
  const start = indexTs.indexOf("async fetchPendingArticles(");
  const end = indexTs.indexOf("async fetchRecentClusters(");
  const pendingFn = indexTs.slice(start, end);

  it("locates the fetchPendingArticles port body", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it("hands collectPendingArticles a politics-only, newest-first priority page fetcher", () => {
    expect(pendingFn).toMatch(/async fetchPriorityPage\s*\(/);
    expect(pendingFn).toContain('.in("category", JEV_POLITICS_CATEGORIES as unknown as string[])');
    // the priority query orders newest-first and keeps the id tiebreak
    const priorityBody = pendingFn.slice(pendingFn.indexOf("async fetchPriorityPage("), pendingFn.indexOf("seen:"));
    expect(priorityBody).toContain('.order("published_at", { ascending: false })');
    expect(priorityBody).toContain('.order("id", { ascending: true })');
    expect(priorityBody).toContain('.gte("published_at", sinceIso)');
  });

  it("reads the share knob through parsePriorityShare and logs the priority outcome", () => {
    expect(pendingFn).toContain('parsePriorityShare(Deno.env.get("JEV_PRIORITY_SHARE"))');
    expect(pendingFn).toContain("priority=${result.priorityRows ?? 0}");
    expect(pendingFn).toContain("priority_failed=${result.priorityFailed ?? false}");
    // the legacy log fields stay (jev-pending.test.ts pins deadline_stop)
    expect(pendingFn).toContain("deadline_stop=${result.stoppedAtDeadline}");
  });

  it("declares JEV_ARTICLE_PRIORITY_MAX_PAGES below the overall page cap and passes it on", () => {
    const priorityMatch = indexTs.match(/JEV_ARTICLE_PRIORITY_MAX_PAGES\s*=\s*(\d+)/);
    const maxMatch = indexTs.match(/JEV_ARTICLE_FETCH_MAX_PAGES\s*=\s*(\d+)/);
    expect(priorityMatch).not.toBeNull();
    expect(Number(priorityMatch?.[1])).toBeLessThan(Number(maxMatch?.[1]));
    expect(pendingFn).toContain("priorityMaxPages: JEV_ARTICLE_PRIORITY_MAX_PAGES");
  });

  it("does not add a pass-2 (oldest-first) change: the legacy fetchPage still orders by the requested direction", () => {
    expect(pendingFn).toContain('.order("published_at", { ascending: order === "asc" })');
  });
});
