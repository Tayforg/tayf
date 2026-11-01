import { afterEach, describe, expect, it, vi } from "vitest";

import { POSTGREST_MAX_ROWS, readAllPages } from "./paging";

type Page = { data: number[] | null; error: { message: string } | null };

/** Rows `from..to` (inclusive) of a table with `total` rows, like PostgREST. */
function tableOf(total: number) {
  const calls: Array<[number, number]> = [];
  const fetchPage = async (from: number, to: number): Promise<Page> => {
    calls.push([from, to]);
    const data: number[] = [];
    for (let i = from; i <= to && i < total; i++) data.push(i);
    return { data, error: null };
  };
  return { calls, fetchPage };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readAllPages", () => {
  it("exposes the PostgREST response cap", () => {
    expect(POSTGREST_MAX_ROWS).toBe(1000);
  });

  it("reads 1000 + 1000 + 300 rows in three inclusive ranges and is not truncated", async () => {
    const { calls, fetchPage } = tableOf(2300);

    const out = await readAllPages(fetchPage, { label: "t", maxPages: 10 });

    expect(calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
    expect(out.rows).toHaveLength(2300);
    expect(out.rows[0]).toBe(0);
    expect(out.rows[2299]).toBe(2299);
    expect(out.truncated).toBe(false);
  });

  it("an exact multiple of the page size costs one extra (empty) call and is not truncated", async () => {
    const { calls, fetchPage } = tableOf(1000);

    const out = await readAllPages(fetchPage, { label: "t", maxPages: 10 });

    expect(calls).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(out.rows).toHaveLength(1000);
    expect(out.truncated).toBe(false);
  });

  it("a single short page makes one call", async () => {
    const { calls, fetchPage } = tableOf(7);

    const out = await readAllPages(fetchPage, { label: "t", maxPages: 10 });

    expect(calls).toEqual([[0, 999]]);
    expect(out.rows).toHaveLength(7);
    expect(out.truncated).toBe(false);
  });

  it("treats a null data envelope as an empty page", async () => {
    const fetchPage = vi.fn(async (): Promise<Page> => ({ data: null, error: null }));

    const out = await readAllPages(fetchPage, { label: "t", maxPages: 3 });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ rows: [], truncated: false });
  });

  it("stops at maxPages with a full last page: truncated, one warning naming the label", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchPage = vi.fn(async (from: number, to: number): Promise<Page> => ({
      data: Array.from({ length: to - from + 1 }, (_, i) => from + i),
      error: null,
    }));

    const out = await readAllPages(fetchPage, { label: "fetchTickerPage coverage TURSG", maxPages: 10 });

    expect(fetchPage).toHaveBeenCalledTimes(10);
    expect(out.rows).toHaveLength(10_000);
    expect(out.truncated).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("fetchTickerPage coverage TURSG");
    expect(String(warn.mock.calls[0]![0])).toContain("10x1000");
  });

  it("does not warn or truncate when the last allowed page is short", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { calls, fetchPage } = tableOf(2500);

    const out = await readAllPages(fetchPage, { label: "t", maxPages: 3 });

    expect(calls).toHaveLength(3);
    expect(out.rows).toHaveLength(2500);
    expect(out.truncated).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("honours a custom pageSize", async () => {
    const calls: Array<[number, number]> = [];
    const fetchPage = async (from: number, to: number): Promise<Page> => {
      calls.push([from, to]);
      return { data: from === 0 ? [1, 2] : [3], error: null };
    };

    const out = await readAllPages(fetchPage, { label: "t", maxPages: 5, pageSize: 2 });

    expect(calls).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(out.rows).toEqual([1, 2, 3]);
  });

  it.each([0, -1, 1001, 2.5, Number.NaN])("rejects a pageSize PostgREST would clamp or that makes no sense (%s)", async (pageSize) => {
    const fetchPage = vi.fn(async (): Promise<Page> => ({ data: [], error: null }));

    await expect(readAllPages(fetchPage, { label: "x", maxPages: 2, pageSize })).rejects.toThrow(/x: pageSize/);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("rejects with an Error naming the label and the message when a page errors", async () => {
    const fetchPage = async (): Promise<Page> => ({ data: null, error: { message: "boom" } });

    const err = await readAllPages(fetchPage, { label: "fetchTickerPage coverage TURSG", maxPages: 4 }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("fetchTickerPage coverage TURSG");
    expect((err as Error).message).toContain("boom");
  });

  it("an error on a later page discards the earlier pages (no partial result)", async () => {
    let n = 0;
    const fetchPage = async (): Promise<Page> =>
      n++ === 0
        ? { data: Array.from({ length: 1000 }, (_, i) => i), error: null }
        : { data: null, error: { message: "second page down" } };

    await expect(readAllPages(fetchPage, { label: "x", maxPages: 4 })).rejects.toThrow(/x: second page down/);
  });
});
