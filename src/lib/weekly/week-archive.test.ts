import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  isoWeekKeyOf,
  weekKeyFromMs,
  parseWeekKey,
  weekRange,
  shiftWeek,
  weekLabelTr,
  WEEK_ARCHIVE_FIRST,
  WEEK_ARCHIVE_MAX_WEEKS,
  WEEK_ARCHIVE_CLUSTER_SELECT,
} from "./week-archive";

describe("isoWeekKeyOf / weekKeyFromMs — ISO-8601 vectors", () => {
  it("2026-09-28 -> 2026-W40", () => {
    expect(isoWeekKeyOf("2026-09-28")).toBe("2026-W40");
  });

  it("2026-09-27 -> 2026-W39", () => {
    expect(isoWeekKeyOf("2026-09-27")).toBe("2026-W39");
  });

  it("2026-01-01 -> 2026-W01", () => {
    expect(isoWeekKeyOf("2026-01-01")).toBe("2026-W01");
  });

  it("2025-12-29 -> 2026-W01", () => {
    expect(isoWeekKeyOf("2025-12-29")).toBe("2026-W01");
  });

  it("2027-01-01 -> 2026-W53 (long ISO year)", () => {
    expect(isoWeekKeyOf("2027-01-01")).toBe("2026-W53");
  });

  it("weekKeyFromMs takes the Istanbul date before the week (fixed +03)", () => {
    // 2026-09-27T22:00:00Z is 2026-09-28T01:00 Istanbul -> already W40,
    // even though the UTC calendar date is still the 27th (W39).
    const ms = Date.parse("2026-09-27T22:00:00.000Z");
    expect(weekKeyFromMs(ms)).toBe("2026-W40");
  });

  it("weekKeyFromMs just before the Istanbul day rollover stays in the prior week", () => {
    // 2026-09-27T20:59:59Z is 2026-09-27T23:59:59 Istanbul -> still W39.
    const ms = Date.parse("2026-09-27T20:59:59.000Z");
    expect(weekKeyFromMs(ms)).toBe("2026-W39");
  });
});

describe("parseWeekKey", () => {
  it("rejects W00", () => {
    expect(parseWeekKey("2026-W00")).toBeNull();
  });

  it("rejects W54", () => {
    expect(parseWeekKey("2026-W54")).toBeNull();
  });

  it("rejects W53 in a 52-week year (2025)", () => {
    expect(parseWeekKey("2025-W53")).toBeNull();
  });

  it("accepts W53 in a 53-week year (2026)", () => {
    expect(parseWeekKey("2026-W53")).toEqual({ isoYear: 2026, week: 53 });
  });

  it("rejects a malformed key '2026-40'", () => {
    expect(parseWeekKey("2026-40")).toBeNull();
  });

  it("rejects 'x'", () => {
    expect(parseWeekKey("x")).toBeNull();
  });
});

describe("weekRange", () => {
  it("2026-W40 = [Monday 00:00 +03, next Monday 00:00 +03)", () => {
    expect(weekRange("2026-W40")).toEqual({
      startIso: "2026-09-27T21:00:00.000Z",
      endIso: "2026-10-04T21:00:00.000Z",
    });
  });

  it("returns null for an invalid key", () => {
    expect(weekRange("2026-W54")).toBeNull();
  });
});

describe("shiftWeek", () => {
  it("shifts backward by n weeks", () => {
    expect(shiftWeek("2026-W40", -1)).toBe("2026-W39");
    expect(shiftWeek("2026-W40", -2)).toBe("2026-W38");
  });

  it("shifts forward by n weeks", () => {
    expect(shiftWeek("2026-W39", 1)).toBe("2026-W40");
  });

  it("returns null for an invalid key", () => {
    expect(shiftWeek("nope", 1)).toBeNull();
  });
});

describe("weekLabelTr", () => {
  it("formats '2026, 39. hafta · 21–27 Eylül'", () => {
    expect(weekLabelTr("2026-W39")).toBe("2026, 39. hafta · 21–27 Eylül");
  });

  it("returns '' for an invalid key", () => {
    expect(weekLabelTr("bad")).toBe("");
  });
});

describe("constants", () => {
  it("WEEK_ARCHIVE_FIRST is 2026-W38", () => {
    expect(WEEK_ARCHIVE_FIRST).toBe("2026-W38");
  });

  it("WEEK_ARCHIVE_MAX_WEEKS is 12", () => {
    expect(WEEK_ARCHIVE_MAX_WEEKS).toBe(12);
  });
});

describe("WEEK_ARCHIVE_CLUSTER_SELECT parity with weekly-query.ts", () => {
  it("matches weekly-query.ts's (unexported) CLUSTER_SELECT source", () => {
    const src = readFileSync(
      resolve(__dirname, "weekly-query.ts"),
      "utf8",
    );
    const m = src.match(/const CLUSTER_SELECT =\s*\n?\s*"([^"]+)"/);
    expect(m).not.toBeNull();
    expect(WEEK_ARCHIVE_CLUSTER_SELECT).toBe(m?.[1]);
  });
});

// ---------------------------------------------------------------------------
// Data layer — mocked Supabase, following weekly-query.test.ts's shape.
// ---------------------------------------------------------------------------

const supabaseState = vi.hoisted(() => ({
  rows: [] as unknown[],
  error: null as { message: string } | null,
  /** When set, only requests whose range starts at or after this row fail. */
  errorFromRow: null as number | null,
  calls: {
    gte: [] as Array<{ col: string; val: unknown }>,
    lt: [] as Array<{ col: string; val: unknown }>,
    lte: [] as Array<{ col: string; val: unknown }>,
  },
  /** One entry per awaited clusters request (one per page), in order. */
  requests: [] as Array<{
    orders: Array<{ col: string; opts: unknown }>;
    range: { from: number; to: number } | null;
    limit: number | null;
  }>,
}));

// The fetcher must use the capped createReaderClient (4 s fail-fast).
// createServerClient throws so a regression to the plain client fails every
// data-layer test, not just the explicit assertion below.
const clientFactories = vi.hoisted(() => ({
  createReaderClient: vi.fn(),
  createServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createReaderClient: clientFactories.createReaderClient,
  createServerClient: clientFactories.createServerClient,
}));

function makeFakeClient() {
  return {
    from: () => {
      const request: (typeof supabaseState.requests)[number] = { orders: [], range: null, limit: null };
      const builder: Record<string, unknown> = {};
      const chain = (fn?: (...args: unknown[]) => void) =>
        (...args: unknown[]) => {
          fn?.(...args);
          return builder;
        };
      builder.select = chain();
      builder.eq = chain();
      builder.gte = chain((col, val) => supabaseState.calls.gte.push({ col: col as string, val }));
      builder.lt = chain((col, val) => supabaseState.calls.lt.push({ col: col as string, val }));
      builder.lte = chain((col, val) => supabaseState.calls.lte.push({ col: col as string, val }));
      builder.order = chain((col, opts) => request.orders.push({ col: col as string, opts }));
      builder.range = chain((from, to) => {
        request.range = { from: Number(from), to: Number(to) };
      });
      builder.limit = chain((n) => {
        request.limit = Number(n);
      });
      builder.returns = chain();
      builder.then = (resolve: (v: unknown) => void) => {
        supabaseState.requests.push(request);
        const failing =
          supabaseState.error !== null &&
          (supabaseState.errorFromRow === null || (request.range?.from ?? 0) >= supabaseState.errorFromRow);
        // Like PostgREST: rows from..to inclusive of the ordered table.
        const data = request.range
          ? supabaseState.rows.slice(request.range.from, request.range.to + 1)
          : supabaseState.rows;
        resolve(failing ? { data: null, error: supabaseState.error } : { data, error: null });
      };
      return builder;
    },
  };
}

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

import { cacheLife, cacheTag } from "next/cache";

beforeEach(() => {
  supabaseState.rows = [];
  supabaseState.error = null;
  supabaseState.errorFromRow = null;
  supabaseState.calls.gte = [];
  supabaseState.calls.lt = [];
  supabaseState.calls.lte = [];
  supabaseState.requests = [];
  clientFactories.createReaderClient.mockReset();
  clientFactories.createReaderClient.mockImplementation(() => makeFakeClient());
  clientFactories.createServerClient.mockReset();
  clientFactories.createServerClient.mockImplementation(() => {
    throw new Error("week-archive must use the capped createReaderClient()");
  });
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
});

/** A closed week of `n` rows in query order (article_count desc, id asc). */
function archiveRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `c${String(i).padStart(5, "0")}`,
    article_count: 20 - Math.floor(i / 120),
  }));
}

describe("getWeekArchiveClusters", () => {
  it("records the gte/lt window filters for the requested week", async () => {
    const { getWeekArchiveClusters } = await import("./week-archive");
    supabaseState.rows = [{ id: "c1" }];

    const read = await getWeekArchiveClusters("2026-W40");

    expect(read).toEqual({ rows: [{ id: "c1" }], truncated: false });
    const gteCols = supabaseState.calls.gte.map((c) => c.col);
    const ltCols = supabaseState.calls.lt.map((c) => c.col);
    expect(gteCols).toContain("first_published");
    expect(ltCols).toContain("first_published");
    const firstPublishedGte = supabaseState.calls.gte.find(
      (c) => c.col === "first_published",
    );
    const firstPublishedLt = supabaseState.calls.lt.find(
      (c) => c.col === "first_published",
    );
    expect(firstPublishedGte?.val).toBe("2026-09-27T21:00:00.000Z");
    expect(firstPublishedLt?.val).toBe("2026-10-04T21:00:00.000Z");
  });

  it("pages the week with the same deterministic order as /hafta: article_count desc, then id asc, via .range()", async () => {
    const { getWeekArchiveClusters } = await import("./week-archive");

    await getWeekArchiveClusters("2026-W40");

    expect(supabaseState.requests).toHaveLength(1);
    expect(supabaseState.requests[0]!.orders).toEqual([
      { col: "article_count", opts: { ascending: false } },
      { col: "id", opts: { ascending: true } },
    ]);
    expect(supabaseState.requests[0]!.range).toEqual({ from: 0, to: 999 });
    // `.limit()` is clamped to 1,000 by PostgREST; paging replaces it.
    expect(supabaseState.requests[0]!.limit).toBeNull();
  });

  it("reads every cluster of a 1,991-row week (rows 1001-1991 are no longer lost to the 1,000-row cap)", async () => {
    const { getWeekArchiveClusters } = await import("./week-archive");
    supabaseState.rows = archiveRows(1991);

    const read = await getWeekArchiveClusters("2026-W40");

    expect(read?.truncated).toBe(false);
    expect(read?.rows).toHaveLength(1991);
    expect(read?.rows.map((r) => (r as { id: string }).id)).toEqual(
      (supabaseState.rows as Array<{ id: string }>).map((r) => r.id),
    );
    expect(supabaseState.requests.map((r) => r.range)).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
    ]);
    for (const r of supabaseState.requests) {
      expect(r.orders.map((o) => o.col)).toEqual(["article_count", "id"]);
    }
    // One clock read, one window: every page carries the same bounds.
    const upper = supabaseState.calls.lte.filter((c) => c.col === "first_published");
    expect(new Set(upper.map((c) => c.val)).size).toBe(1);
    expect(upper).toHaveLength(2);
    // And a single reader client for the whole paged read.
    expect(clientFactories.createReaderClient).toHaveBeenCalledTimes(1);
  });

  it("is truncated only at its own ceiling: five full pages, exactly five requests", async () => {
    const { getWeekArchiveClusters } = await import("./week-archive");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    supabaseState.rows = archiveRows(5000);

    try {
      const read = await getWeekArchiveClusters("2026-W40");
      expect(read?.truncated).toBe(true);
      expect(read?.rows).toHaveLength(5000);
      expect(supabaseState.requests).toHaveLength(5);
    } finally {
      warn.mockRestore();
    }
  });

  it("returns null on a Supabase error", async () => {
    const { getWeekArchiveClusters } = await import("./week-archive");
    supabaseState.error = { message: "boom" };

    const read = await getWeekArchiveClusters("2026-W40");
    expect(read).toBeNull();
  });

  it("returns null (no partial week) when page 2 errors", async () => {
    const { getWeekArchiveClusters } = await import("./week-archive");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    supabaseState.rows = archiveRows(1991);
    supabaseState.error = { message: "boom" };
    supabaseState.errorFromRow = 1000;

    try {
      await expect(getWeekArchiveClusters("2026-W40")).resolves.toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
    expect(supabaseState.requests.map((r) => r.range?.from)).toEqual([0, 1000]);
  });

  it("returns null for an unparseable week key", async () => {
    const { getWeekArchiveClusters } = await import("./week-archive");
    const read = await getWeekArchiveClusters("nope");
    expect(read).toBeNull();
  });
});

describe("getWeekArchiveClusters read profile + cache lifetime", () => {
  const TIMEOUT_MESSAGE = "AbortError: Supabase request exceeded 4000 ms";

  it("builds its data client with the capped createReaderClient, never the plain one", async () => {
    const { getWeekArchiveClusters } = await import("./week-archive");
    await getWeekArchiveClusters("2026-W40");
    expect(clientFactories.createReaderClient).toHaveBeenCalled();
    expect(clientFactories.createServerClient).not.toHaveBeenCalled();
  });

  it("rows: cached for hours, exactly one cacheLife, tagged before the fetch", async () => {
    const { getWeekArchiveClusters } = await import("./week-archive");
    supabaseState.rows = [{ id: "c1" }];

    await expect(getWeekArchiveClusters("2026-W40")).resolves.toEqual({
      rows: [{ id: "c1" }],
      truncated: false,
    });

    expect(cacheTag).toHaveBeenCalledWith("clusters-politics");
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("hours");
    expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
    );
  });

  it("an empty week is a successful answer: [] cached for hours", async () => {
    const { getWeekArchiveClusters } = await import("./week-archive");
    supabaseState.rows = [];

    await expect(getWeekArchiveClusters("2026-W40")).resolves.toEqual({ rows: [], truncated: false });
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("hours");
  });

  it("a multi-page read is still one cacheLife('hours')", async () => {
    const { getWeekArchiveClusters } = await import("./week-archive");
    supabaseState.rows = archiveRows(1991);

    await getWeekArchiveClusters("2026-W40");

    expect(supabaseState.requests).toHaveLength(2);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("hours");
  });

  it("an error on page 2 is cached for 'minutes' only, exactly one cacheLife", async () => {
    const { getWeekArchiveClusters } = await import("./week-archive");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    supabaseState.rows = archiveRows(1991);
    supabaseState.error = { message: TIMEOUT_MESSAGE };
    supabaseState.errorFromRow = 1000;

    try {
      await expect(getWeekArchiveClusters("2026-W40")).resolves.toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("hours");
  });

  it("a timeout resolves null and calls cacheLife('minutes') exactly once", async () => {
    const { getWeekArchiveClusters } = await import("./week-archive");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    supabaseState.error = { message: TIMEOUT_MESSAGE };

    try {
      await expect(getWeekArchiveClusters("2026-W40")).resolves.toBeNull();
    } finally {
      errorSpy.mockRestore();
    }

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("hours");
  });

  it("an invalid key resolves null BEFORE the cache: no client, no cacheTag, no cacheLife", async () => {
    const { getWeekArchiveClusters } = await import("./week-archive");

    await expect(getWeekArchiveClusters("nope")).resolves.toBeNull();
    await expect(getWeekArchiveClusters("2026-W54")).resolves.toBeNull();
    await expect(getWeekArchiveClusters("")).resolves.toBeNull();

    expect(clientFactories.createReaderClient).not.toHaveBeenCalled();
    expect(cacheLife).not.toHaveBeenCalled();
    expect(cacheTag).not.toHaveBeenCalled();
  });

  it("a thrown client (cannot be built) resolves null and is cached for 'minutes' only", async () => {
    const { getWeekArchiveClusters } = await import("./week-archive");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    clientFactories.createReaderClient.mockImplementation(() => {
      throw new Error("no env");
    });
    try {
      await expect(getWeekArchiveClusters("2026-W40")).resolves.toBeNull();
    } finally {
      errorSpy.mockRestore();
    }

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("a failed read is tagged before its 'minutes' lifetime too", async () => {
    const { getWeekArchiveClusters } = await import("./week-archive");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    supabaseState.error = { message: "boom" };
    try {
      await getWeekArchiveClusters("2026-W40");
    } finally {
      errorSpy.mockRestore();
    }

    expect(cacheTag).toHaveBeenCalledWith("clusters-politics");
    expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
    );
  });
});

describe("getRecentWeekKeys (pure cached body, unchanged)", () => {
  it("is a single cacheLife('hours') with no client", async () => {
    const { getRecentWeekKeys } = await import("./week-archive");
    const keys = await getRecentWeekKeys();
    expect(keys.current).toMatch(/^\d{4}-W\d{2}$/);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("hours");
    expect(clientFactories.createReaderClient).not.toHaveBeenCalled();
  });
});
