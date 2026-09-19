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
  error: null as { message: string } | null,
  states: [] as unknown[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      zone_guesses: (state) => {
        fixture.states.push(state);
        if (fixture.error) return { data: null, error: fixture.error };
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
  createClient: () => supabaseFake.client,
}));

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
  fixture.states = [];
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
  it("is 30 — the publication threshold agreed with the deck (U-03)", () => {
    expect(AGREEMENT_MIN_GUESSES).toBe(30);
  });
});

describe("summariseCounts", () => {
  it("returns null for an empty set", () => {
    expect(summariseCounts(0, 0)).toBeNull();
  });

  it("returns null one guess below the threshold (29 guesses)", () => {
    expect(summariseCounts(29, 29)).toBeNull();
  });

  it("publishes exactly at the threshold: 30 guesses, 19 correct -> 0.633", () => {
    expect(summariseCounts(30, 19)).toEqual({ n: 30, share: 0.633 });
  });

  it("rounds the share to 3 decimals (2/3 of 60 -> 0.667)", () => {
    expect(summariseCounts(60, 40)).toEqual({ n: 60, share: 0.667 });
  });

  it("handles the boundary shares 0 and 1 without NaN", () => {
    expect(summariseCounts(30, 0)).toEqual({ n: 30, share: 0 });
    expect(summariseCounts(30, 30)).toEqual({ n: 30, share: 1 });
  });

  it("publishes the true total, not a capped window (120k guesses)", () => {
    expect(summariseCounts(120_000, 60_000)).toEqual({ n: 120_000, share: 0.5 });
  });

  it("never publishes a share above 1 or below 0", () => {
    expect(summariseCounts(30, 45)).toEqual({ n: 30, share: 1 });
    expect(summariseCounts(30, -5)).toEqual({ n: 30, share: 0 });
  });

  it("treats a non-finite count as unpublishable / zero", () => {
    expect(summariseCounts(Number.NaN, 10)).toBeNull();
    expect(summariseCounts(30, Number.NaN)).toEqual({ n: 30, share: 0 });
  });
});

describe("getSourceAgreement", () => {
  it("counts instead of windowing: two exact head counts, no limit, no order", async () => {
    fixture.total = 30;
    fixture.correct = 19;

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
    fixture.total = 30;

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

  it("returns null below the threshold (29 guesses) without a second query", async () => {
    fixture.total = 29;
    fixture.correct = 20;

    await expect(getSourceAgreement("src-1")).resolves.toBeNull();
    expect(states()).toHaveLength(1);
  });

  it("returns {n:30, share:0.633} for 30 guesses with 19 correct", async () => {
    fixture.total = 30;
    fixture.correct = 19;

    await expect(getSourceAgreement("src-1")).resolves.toEqual({
      n: 30,
      share: 0.633,
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

  it("returns null (never throws) on a query error and logs it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.error = { message: 'relation "zone_guesses" does not exist' };

    await expect(getSourceAgreement("src-1")).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      '[agreement] reader agreement unavailable: relation "zone_guesses" does not exist',
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
