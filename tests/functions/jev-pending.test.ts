import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectPendingArticles, type PendingOrder } from "../../supabase/functions/_shared/jev-pending";

// ---------------------------------------------------------------------------
// jev-pending.ts (jev-pipeline). A fake fetchPage over an in-memory row
// array, oldest at index 0 -- i.e. row i has published_at earlier than row
// i+1, mirroring `published_at asc/desc, id asc` pagination in production.
// ---------------------------------------------------------------------------

interface Row {
  id: string;
}

function makeRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: `a${i}` }));
}

function fakeFetchPage(rows: Row[]) {
  const calls: Array<{ order: PendingOrder; from: number; to: number }> = [];
  const fetchPage = async (order: PendingOrder, from: number, to: number): Promise<Row[]> => {
    calls.push({ order, from, to });
    const ordered = order === "asc" ? rows : [...rows].reverse();
    return ordered.slice(from, to + 1);
  };
  return { fetchPage, calls };
}

function seenFactory(seenIds: Set<string>) {
  return async (ids: string[]): Promise<Set<string>> => {
    return new Set(ids.filter((id) => seenIds.has(id)));
  };
}

describe("collectPendingArticles", () => {
  it("the first call is 'desc'", async () => {
    const rows = makeRows(10);
    const { fetchPage, calls } = fakeFetchPage(rows);
    await collectPendingArticles({
      limit: 5,
      pageSize: 3,
      maxPages: 4,
      freshMaxPages: 2,
      fetchPage,
      seen: seenFactory(new Set()),
    });
    expect(calls[0]!.order).toBe("desc");
  });

  it("fresh unseen rows come before backlog rows", async () => {
    // 10 rows total, page size 3, freshMaxPages 1 (pass 1 sees rows 9,8,7 --
    // newest-first), all seen except a9. Backlog pass (asc) then picks up
    // the oldest unseen rows.
    const rows = makeRows(10);
    const seen = new Set(rows.map((r) => r.id).filter((id) => id !== "a9" && id !== "a0"));
    const { fetchPage } = fakeFetchPage(rows);
    const result = await collectPendingArticles({
      limit: 2,
      pageSize: 3,
      maxPages: 5,
      freshMaxPages: 1,
      fetchPage,
      seen: seenFactory(seen),
    });
    expect(result.rows.map((r) => r.id)).toEqual(["a9", "a0"]);
    expect(result.freshRows).toBe(1);
    expect(result.backfillRows).toBe(1);
  });

  it("the backlog pass is 'asc', runs only when under the limit, and total calls are <= maxPages", async () => {
    const rows = makeRows(20);
    const { fetchPage, calls } = fakeFetchPage(rows);
    const result = await collectPendingArticles({
      limit: 4,
      pageSize: 3,
      maxPages: 4,
      freshMaxPages: 2,
      fetchPage,
      seen: seenFactory(new Set()),
    });
    // Pass 1 fills the limit from page 0 (desc) alone -- no asc calls.
    expect(calls.every((c) => c.order === "desc")).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(result.rows.length).toBe(4);
  });

  it("when pass 1 doesn't fill the limit, pass 2 pages ascending and total calls stay <= maxPages", async () => {
    const rows = makeRows(20);
    // Everything seen except the very oldest (a0) and very newest (a19).
    const seen = new Set(rows.map((r) => r.id).filter((id) => id !== "a0" && id !== "a19"));
    const { fetchPage, calls } = fakeFetchPage(rows);
    const result = await collectPendingArticles({
      limit: 5,
      pageSize: 5,
      maxPages: 4,
      freshMaxPages: 2,
      fetchPage,
      seen: seenFactory(seen),
    });
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(calls.some((c) => c.order === "asc")).toBe(true);
    expect(result.rows.map((r) => r.id)).toContain("a19");
    expect(result.rows.map((r) => r.id)).toContain("a0");
    // fresh row(s) first, then backlog
    const idxNew = result.rows.findIndex((r) => r.id === "a19");
    const idxOld = result.rows.findIndex((r) => r.id === "a0");
    expect(idxNew).toBeLessThan(idxOld);
  });

  it("a window shorter than a page skips pass 2", async () => {
    const rows = makeRows(2); // shorter than pageSize
    const { fetchPage, calls } = fakeFetchPage(rows);
    const result = await collectPendingArticles({
      limit: 10,
      pageSize: 5,
      maxPages: 4,
      freshMaxPages: 2,
      fetchPage,
      seen: seenFactory(new Set()),
    });
    // Pass 1's single short page exhausts the window -- pass 2 never runs.
    expect(calls).toHaveLength(1);
    expect(result.rows).toHaveLength(2);
  });

  it("dedupes across passes, excludes seen rows, honours the limit, and an empty window returns []", async () => {
    const rows: Row[] = [];
    const { fetchPage } = fakeFetchPage(rows);
    const result = await collectPendingArticles({
      limit: 10,
      pageSize: 5,
      maxPages: 4,
      freshMaxPages: 2,
      fetchPage,
      seen: seenFactory(new Set()),
    });
    expect(result.rows).toEqual([]);
    expect(result.freshRows).toBe(0);
    expect(result.backfillRows).toBe(0);
  });

  it("honours the limit even when far more unseen rows exist", async () => {
    const rows = makeRows(50);
    const { fetchPage } = fakeFetchPage(rows);
    const result = await collectPendingArticles({
      limit: 7,
      pageSize: 10,
      maxPages: 8,
      freshMaxPages: 4,
      fetchPage,
      seen: seenFactory(new Set()),
    });
    expect(result.rows).toHaveLength(7);
    const ids = new Set(result.rows.map((r) => r.id));
    expect(ids.size).toBe(7);
  });

  it("regression: a 5,400-row window where only the newest 60 are unseen returns all 60 in one call (the old code found 0)", async () => {
    const rows = makeRows(5400);
    const newestIds = new Set(rows.slice(5340).map((r) => r.id)); // newest 60
    const seen = new Set(rows.map((r) => r.id).filter((id) => !newestIds.has(id)));
    const { fetchPage, calls } = fakeFetchPage(rows);
    const result = await collectPendingArticles({
      limit: 60,
      pageSize: 300,
      maxPages: 10,
      freshMaxPages: 4,
      fetchPage,
      seen: seenFactory(seen),
    });
    expect(result.rows).toHaveLength(60);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.order).toBe("desc");
  });
});

describe("jev-shadow/index.ts static guard (jev-pipeline)", () => {
  const indexTs = readFileSync(
    resolve(__dirname, "..", "..", "supabase", "functions", "jev-shadow", "index.ts"),
    "utf8",
  );

  it("wires fetchPendingArticles through collectPendingArticles", () => {
    expect(indexTs).toMatch(/collectPendingArticles\(/);
  });

  it("declares JEV_ARTICLE_FRESH_MAX_PAGES, smaller than JEV_ARTICLE_FETCH_MAX_PAGES", () => {
    expect(indexTs).toMatch(/JEV_ARTICLE_FRESH_MAX_PAGES/);
    const freshMatch = indexTs.match(/JEV_ARTICLE_FRESH_MAX_PAGES\s*=\s*(\d+)/);
    const maxMatch = indexTs.match(/JEV_ARTICLE_FETCH_MAX_PAGES\s*=\s*(\d+)/);
    expect(freshMatch).not.toBeNull();
    expect(maxMatch).not.toBeNull();
    expect(Number(freshMatch?.[1])).toBeLessThan(Number(maxMatch?.[1]));
  });
});
