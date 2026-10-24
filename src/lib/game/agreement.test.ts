import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// U-03 follow-through — per-outlet reader agreement aggregated from
// `zone_guesses` (migration 057). Mirrors src/lib/admin/archive-status.test.ts
// for the Supabase fake and src/lib/clusters/politics-query.test.ts for the
// next/cache stub (getSourceAgreement is a "use cache" fetcher).
//
// The published `n` is the source's TOTAL guess count, so the fetcher issues
// two `count: "exact", head: true` queries instead of pulling a row window;
// the fake answers them from `fixture.total` / `fixture.correct` and records
// every builder state so the query shape (head-only, aggregate-only) is
// pinned.

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  total: 0,
  correct: 0,
  nullCount: false,
  error: null as { message: string; hint?: string; code?: string } | null,
  /** Error only the second (`correct = true`) count query. */
  errorOnCorrect: null as { message: string } | null,
  states: [] as unknown[],
  /** The options object each `createClient(url, key, opts)` call received. */
  clientOpts: [] as unknown[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      zone_guesses: (state) => {
        fixture.states.push(state);
        if (fixture.error) return { data: null, error: fixture.error };
        if (
          fixture.errorOnCorrect &&
          state.eq.some((e) => e.col === "correct" && e.val === true)
        ) {
          return { data: null, error: fixture.errorOnCorrect };
        }
        if (fixture.nullCount) return { data: null, error: null, count: null };
        const wantsCorrect = state.eq.some(
          (e) => e.col === "correct" && e.val === true,
        );
        // head: true — PostgREST returns no rows, only the Content-Range count.
        return {
          data: null,
          error: null,
          count: wantsCorrect ? fixture.correct : fixture.total,
        };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, opts?: unknown) => {
    fixture.clientOpts.push(opts);
    return supabaseFake.client;
  },
}));

import { cacheLife } from "next/cache";
import {
  AGREEMENT_MIN_GUESSES,
  getSourceAgreement,
  summariseCounts,
} from "./agreement";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.total = 0;
  fixture.correct = 0;
  fixture.nullCount = false;
  fixture.error = null;
  fixture.errorOnCorrect = null;
  fixture.states = [];
  fixture.clientOpts = [];
  vi.mocked(cacheLife).mockClear();
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

function states(): BuilderState[] {
  return fixture.states as BuilderState[];
}

describe("AGREEMENT_MIN_GUESSES", () => {
  it("is 100 — raised from 30 so a forged-guess flood from one client cannot publish a number alone (web-3)", () => {
    expect(AGREEMENT_MIN_GUESSES).toBe(100);
  });
});

describe("summariseCounts", () => {
  it("returns null for an empty set", () => {
    expect(summariseCounts(0, 0)).toBeNull();
  });

  it("returns null one guess below the threshold (99 guesses)", () => {
    expect(summariseCounts(99, 99)).toBeNull();
  });

  it("does not publish the old 30-guess threshold any more", () => {
    expect(summariseCounts(30, 19)).toBeNull();
  });

  it("publishes exactly at the threshold: 100 guesses, 63 correct -> 0.63", () => {
    expect(summariseCounts(100, 63)).toEqual({ n: 100, share: 0.63 });
  });

  it("rounds the share to 3 decimals (2/3 of 300 -> 0.667)", () => {
    expect(summariseCounts(300, 200)).toEqual({ n: 300, share: 0.667 });
  });

  it("handles the boundary shares 0 and 1 without NaN", () => {
    expect(summariseCounts(100, 0)).toEqual({ n: 100, share: 0 });
    expect(summariseCounts(100, 100)).toEqual({ n: 100, share: 1 });
  });

  it("publishes the true total, not a capped window (120k guesses)", () => {
    expect(summariseCounts(120_000, 60_000)).toEqual({ n: 120_000, share: 0.5 });
  });

  it("never publishes a share above 1 or below 0", () => {
    expect(summariseCounts(100, 150)).toEqual({ n: 100, share: 1 });
    expect(summariseCounts(100, -5)).toEqual({ n: 100, share: 0 });
  });

  it("treats a non-finite count as unpublishable / zero", () => {
    expect(summariseCounts(Number.NaN, 10)).toBeNull();
    expect(summariseCounts(100, Number.NaN)).toEqual({ n: 100, share: 0 });
  });
});

describe("getSourceAgreement", () => {
  it("counts instead of windowing: two exact head counts, no limit, no order", async () => {
    fixture.total = 100;
    fixture.correct = 63;

    await getSourceAgreement("src-1");

    expect(states()).toHaveLength(2);
    const [all, correct] = states() as [BuilderState, BuilderState];

    expect(all.table).toBe("zone_guesses");
    expect(all.selectArgs[1]).toEqual({ count: "exact", head: true });
    expect(all.eq).toEqual([{ col: "source_id", val: "src-1" }]);
    expect(all.limit).toBeNull();
    expect(all.order).toEqual([]);

    expect(correct.table).toBe("zone_guesses");
    expect(correct.selectArgs[1]).toEqual({ count: "exact", head: true });
    expect(correct.eq).toEqual([
      { col: "source_id", val: "src-1" },
      { col: "correct", val: true },
    ]);
    expect(correct.limit).toBeNull();
  });

  it("never selects identifying columns (no article_id, no id, no *)", async () => {
    fixture.total = 100;

    await getSourceAgreement("src-1");

    for (const state of states()) {
      const select = String(state.selectArgs[0] ?? "");
      expect(select).not.toContain("article_id");
      expect(select).not.toContain("*");
      expect(select.split(",").map((c) => c.trim())).toEqual(["correct"]);
      // head: true is what guarantees no row ever leaves the database.
      expect(state.selectArgs[1]).toMatchObject({ head: true });
    }
  });

  it("returns null below the threshold (99 guesses) without a second query", async () => {
    fixture.total = 99;
    fixture.correct = 60;

    await expect(getSourceAgreement("src-1")).resolves.toBeNull();
    expect(states()).toHaveLength(1);
  });

  it("returns {n:100, share:0.63} for 100 guesses with 63 correct", async () => {
    fixture.total = 100;
    fixture.correct = 63;

    await expect(getSourceAgreement("src-1")).resolves.toEqual({
      n: 100,
      share: 0.63,
    });
  });

  it("publishes the real total once an outlet passes 5,000 guesses", async () => {
    fixture.total = 12_345;
    fixture.correct = 6_000;

    await expect(getSourceAgreement("src-1")).resolves.toEqual({
      n: 12_345,
      share: 0.486,
    });
  });

  it("returns null when there are no guesses at all", async () => {
    fixture.total = 0;

    await expect(getSourceAgreement("src-1")).resolves.toBeNull();
  });

  it("returns null when Supabase hands back a null count", async () => {
    fixture.nullCount = true;

    await expect(getSourceAgreement("src-1")).resolves.toBeNull();
  });

  it("returns null (never throws) on a query error and logs it once", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.error = { message: 'relation "zone_guesses" does not exist' };

    await expect(getSourceAgreement("src-1")).resolves.toBeNull();
    // The log line now comes from attemptCached (cache-resilience.ts), which
    // wraps the throwing fetch inside the "use cache" body.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      '[agreement] error: relation "zone_guesses" does not exist',
    );

    errorSpy.mockRestore();
  });

  it("returns null (never throws) when the Supabase env vars are missing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    await expect(getSourceAgreement("src-1")).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("returns null for an empty source id without querying", async () => {
    await expect(getSourceAgreement("")).resolves.toBeNull();
    expect(states()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cold-read resilience: the 4 s reader cap, and a cache lifetime that depends
// on the outcome. There is deliberately NO live retry here: the agreement
// number is decoration on /source/[slug] and `null` simply renders "Henüz
// yeterli tahmin yok", so a failure costs one cheap, cached "minutes" entry
// rather than a second 4 s wait inside the request.
// ---------------------------------------------------------------------------

/** A capped client is built with a custom `global.fetch`; a plain one is not. */
function isCappedClientOpts(opts: unknown): boolean {
  const g = (opts as { global?: { fetch?: unknown } } | undefined)?.global;
  return typeof g?.fetch === "function";
}

const TIMEOUT_ERROR = {
  message: "AbortError: Supabase request exceeded 4000 ms",
  hint: "Request was aborted (timeout or manual cancellation)",
  code: "",
};

describe("getSourceAgreement reader cap", () => {
  it("uses exactly one capped reader client for both count queries", async () => {
    fixture.total = 100;
    fixture.correct = 63;

    await getSourceAgreement("src-1");

    expect(fixture.clientOpts).toHaveLength(1);
    expect(isCappedClientOpts(fixture.clientOpts[0])).toBe(true);
  });
});

describe("getSourceAgreement cache lifetime", () => {
  it("a published result calls cacheLife exactly once with source-directory", async () => {
    fixture.total = 100;
    fixture.correct = 63;

    await getSourceAgreement("src-1");

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("source-directory");
  });

  it("below the threshold is a legitimate result: source-directory, not minutes", async () => {
    fixture.total = 99;

    await expect(getSourceAgreement("src-1")).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("source-directory");
  });

  it("a timeout on the first count returns null without throwing and is cached for minutes only", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.error = TIMEOUT_ERROR;

    await expect(getSourceAgreement("src-1")).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    // No live retry: one client, one query.
    expect(fixture.clientOpts).toHaveLength(1);
    expect(states()).toHaveLength(1);
  });

  it("an error on the second (correct = true) count also returns null and is cached for minutes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.total = 100;
    fixture.errorOnCorrect = { message: "statement timeout" };

    await expect(getSourceAgreement("src-1")).resolves.toBeNull();

    expect(states()).toHaveLength(2);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("a missing-env failure is cached for minutes and still never throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    await expect(getSourceAgreement("src-1")).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("an empty source id returns null before any cache entry or query", async () => {
    await expect(getSourceAgreement("")).resolves.toBeNull();

    expect(cacheLife).not.toHaveBeenCalled();
    expect(fixture.clientOpts).toHaveLength(0);
    expect(states()).toHaveLength(0);
  });
});
