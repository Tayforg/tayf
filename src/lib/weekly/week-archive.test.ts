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
  calls: {
    gte: [] as Array<{ col: string; val: unknown }>,
    lt: [] as Array<{ col: string; val: unknown }>,
  },
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
      builder.lte = chain();
      builder.order = chain();
      builder.limit = chain();
      builder.returns = chain();
      builder.then = (resolve: (v: unknown) => void) =>
        resolve({ data: supabaseState.rows, error: supabaseState.error });
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
  supabaseState.calls.gte = [];
  supabaseState.calls.lt = [];
  clientFactories.createReaderClient.mockReset();
  clientFactories.createReaderClient.mockImplementation(() => makeFakeClient());
  clientFactories.createServerClient.mockReset();
  clientFactories.createServerClient.mockImplementation(() => {
    throw new Error("week-archive must use the capped createReaderClient()");
  });
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
});

describe("getWeekArchiveClusters", () => {
  it("records the gte/lt window filters for the requested week", async () => {
    const { getWeekArchiveClusters } = await import("./week-archive");
    supabaseState.rows = [{ id: "c1" }];

    const rows = await getWeekArchiveClusters("2026-W40");

    expect(rows).toEqual([{ id: "c1" }]);
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

  it("returns null on a Supabase error", async () => {
    const { getWeekArchiveClusters } = await import("./week-archive");
    supabaseState.error = { message: "boom" };

    const rows = await getWeekArchiveClusters("2026-W40");
    expect(rows).toBeNull();
  });

  it("returns null for an unparseable week key", async () => {
    const { getWeekArchiveClusters } = await import("./week-archive");
    const rows = await getWeekArchiveClusters("nope");
    expect(rows).toBeNull();
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

    await expect(getWeekArchiveClusters("2026-W40")).resolves.toEqual([{ id: "c1" }]);

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

    await expect(getWeekArchiveClusters("2026-W40")).resolves.toEqual([]);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("hours");
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
