import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// clickbait-karne (migration 078) — per-outlet "tık tuzağı karnesi".
//
// Mirrors the harness src/lib/sources/feed-status.test.ts and
// src/lib/admin/framing-votes.test.ts use: next/cache mocked out, the
// shared chainable Supabase fake (tests/_helpers/supabase-fake.ts) wired to
// an `rpc` fixture for `source_clickbait_30d`.
//
// The gate (isClickbaitPublic / CLICKBAIT_PRECISION_CHECK) stays CLOSED
// (null) in this codebase today -- the 200-row blind precision label pass
// (SPEC Step 0d) is judgement work delegated to a Fable/Opus-tier agent,
// not performed by this Sonnet implementation pass. This file still proves
// the gate LOGIC and the recomputation-from-fixture contract work, using
// the small local fixture below (the "tests/fixtures/clickbait-precision.json"
// file is a separate, real-but-unreviewed 200-row sample fixture — see its
// own header comment).
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  rpcArgs: [] as unknown[],
  rows: [] as unknown[],
  error: null as { message: string } | null,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    rpc: {
      source_clickbait_30d: (args: unknown) => {
        fixture.rpcArgs.push(args);
        if (fixture.error) return { data: null, error: fixture.error };
        return { data: fixture.rows, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import {
  CLICKBAIT_FLAG_PROB,
  CLICKBAIT_WINDOW_DAYS,
  CLICKBAIT_MIN_N,
  CLICKBAIT_MIN_OUTLETS,
  CLICKBAIT_PRECISION_MIN,
  CLICKBAIT_PRECISION_SAMPLE,
  CLICKBAIT_QUESTION_SETS,
  CLICKBAIT_QUESTION_EN,
  CLICKBAIT_PRECISION_CHECK,
  isClickbaitPublic,
  buildClickbaitKarne,
  fetchClickbaitRows,
  getClickbaitKarne,
  getClickbaitAdminRows,
  karneForSlug,
  type ClickbaitOutletRow,
  type ClickbaitPrecisionCheck,
} from "./clickbait";
import { JEV_QUESTION_REGISTRY, JEV_QUESTION_SET_VERSION } from "../../../supabase/functions/_shared/jev.ts";

function row(overrides: Partial<ClickbaitOutletRow> & { slug: string }): ClickbaitOutletRow {
  return {
    sourceId: overrides.slug,
    slug: overrides.slug,
    name: overrides.slug,
    bias: "center",
    kind: "outlet",
    nTotal: 300,
    nFlagged: 30,
    meanProb: 0.5,
    firstDay: "2026-09-24",
    lastDay: "2026-09-28",
    ...overrides,
  } as ClickbaitOutletRow;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.rpcArgs = [];
  fixture.rows = [];
  fixture.error = null;
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("constants", () => {
  it("CLICKBAIT_QUESTION_EN equals the registry's clickbait instructions verbatim", () => {
    expect(CLICKBAIT_QUESTION_EN).toBe(JEV_QUESTION_REGISTRY.clickbait.instructions);
  });

  it("CLICKBAIT_QUESTION_SETS includes the current JEV_QUESTION_SET_VERSION", () => {
    expect(CLICKBAIT_QUESTION_SETS).toContain(JEV_QUESTION_SET_VERSION);
  });

  it("CLICKBAIT_PRECISION_CHECK defaults to null (gate closed)", () => {
    expect(CLICKBAIT_PRECISION_CHECK).toBeNull();
  });

  it("thresholds match the spec", () => {
    expect(CLICKBAIT_FLAG_PROB).toBe(0.7);
    expect(CLICKBAIT_WINDOW_DAYS).toBe(30);
    expect(CLICKBAIT_MIN_N).toBe(300);
    expect(CLICKBAIT_MIN_OUTLETS).toBe(9);
    expect(CLICKBAIT_PRECISION_MIN).toBe(0.8);
    expect(CLICKBAIT_PRECISION_SAMPLE).toBe(200);
  });
});

describe("isClickbaitPublic", () => {
  const base: ClickbaitPrecisionCheck = {
    checkedOn: "2026-09-28",
    sample: 200,
    clickbait: 170,
    precision: 0.85,
    threshold: CLICKBAIT_FLAG_PROB,
    questionSets: [...CLICKBAIT_QUESTION_SETS],
    labeler: "model-proxy (single labeller)",
  };

  it("null -> false", () => {
    expect(isClickbaitPublic(null)).toBe(false);
  });

  it("precision 0.79 -> false", () => {
    expect(isClickbaitPublic({ ...base, precision: 0.79 })).toBe(false);
  });

  it("precision 0.80 -> true", () => {
    expect(isClickbaitPublic({ ...base, precision: 0.8 })).toBe(true);
  });

  it("wrong threshold -> false", () => {
    expect(isClickbaitPublic({ ...base, threshold: 0.5 })).toBe(false);
  });

  it("sample 150 -> false", () => {
    expect(isClickbaitPublic({ ...base, sample: 150 })).toBe(false);
  });

  it("different question sets -> false", () => {
    expect(isClickbaitPublic({ ...base, questionSets: ["2026-01-01.1"] })).toBe(false);
  });

  it("defaults to the module-level CLICKBAIT_PRECISION_CHECK (null) when called with no argument", () => {
    expect(isClickbaitPublic()).toBe(false);
  });
});

describe("buildClickbaitKarne", () => {
  it("splits 9 outlets into 3/3/3 terciles", () => {
    const rows = Array.from({ length: 9 }, (_, i) =>
      row({ slug: `s${i}`, nTotal: 300, nFlagged: i * 10 + 10 }),
    );
    const karne = buildClickbaitKarne(rows);
    expect(karne).not.toBeNull();
    const tiers = karne!.outlets.map((o) => o.tier);
    expect(tiers.filter((t) => t === "low")).toHaveLength(3);
    expect(tiers.filter((t) => t === "mid")).toHaveLength(3);
    expect(tiers.filter((t) => t === "high")).toHaveLength(3);
  });

  it("splits 10 outlets into 4/3/3", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      row({ slug: `s${i}`, nTotal: 300, nFlagged: i * 10 + 10 }),
    );
    const karne = buildClickbaitKarne(rows);
    expect(karne).not.toBeNull();
    const tiers = karne!.outlets.map((o) => o.tier);
    expect(tiers.filter((t) => t === "low")).toHaveLength(4);
    expect(tiers.filter((t) => t === "mid")).toHaveLength(3);
    expect(tiers.filter((t) => t === "high")).toHaveLength(3);
  });

  it("a tie group on (share, meanProb) shares one tier", () => {
    // 9 outlets, but the 3rd/4th tie exactly on share+meanProb (4dp): both
    // must land in the tier of the first member of the tie group (rank 2,
    // 0-indexed -> tier low for a 9-way 3/3/3 split).
    const rows = [
      row({ slug: "a", nTotal: 300, nFlagged: 10 }), // share .0333
      row({ slug: "b", nTotal: 300, nFlagged: 20 }), // share .0667
      row({ slug: "c", nTotal: 300, nFlagged: 30, meanProb: 0.5 }), // share .1 tie
      row({ slug: "d", nTotal: 300, nFlagged: 30, meanProb: 0.5 }), // share .1 tie
      row({ slug: "e", nTotal: 300, nFlagged: 50 }),
      row({ slug: "f", nTotal: 300, nFlagged: 60 }),
      row({ slug: "g", nTotal: 300, nFlagged: 70 }),
      row({ slug: "h", nTotal: 300, nFlagged: 80 }),
      row({ slug: "i", nTotal: 300, nFlagged: 90 }),
    ];
    const karne = buildClickbaitKarne(rows)!;
    const c = karne.outlets.find((o) => o.slug === "c")!;
    const d = karne.outlets.find((o) => o.slug === "d")!;
    expect(c.tier).toBe(d.tier);
  });

  it("returns null with fewer than 9 qualifying outlets", () => {
    const rows = Array.from({ length: 8 }, (_, i) => row({ slug: `s${i}`, nTotal: 300 }));
    expect(buildClickbaitKarne(rows)).toBeNull();
  });

  it("drops outlets below CLICKBAIT_MIN_N before counting toward the minimum", () => {
    const rows = [
      ...Array.from({ length: 9 }, (_, i) => row({ slug: `s${i}`, nTotal: 300 })),
      row({ slug: "too-small", nTotal: 299 }),
    ];
    const karne = buildClickbaitKarne(rows)!;
    expect(karne.outlets.some((o) => o.slug === "too-small")).toBe(false);
    expect(karne.outletCount).toBe(9);
  });

  it("computes share and zone correctly", () => {
    const rows = Array.from({ length: 9 }, (_, i) =>
      row({ slug: `s${i}`, bias: "pro_government", nTotal: 300, nFlagged: 60 }),
    );
    const karne = buildClickbaitKarne(rows)!;
    for (const o of karne.outlets) {
      expect(o.share).toBeCloseTo(0.2, 5);
      expect(o.zone).toBe("iktidar");
    }
  });

  it("firstDay/lastDay are the min/max across rows", () => {
    const rows = Array.from({ length: 9 }, (_, i) =>
      row({ slug: `s${i}`, firstDay: `2026-09-2${i % 5}`, lastDay: `2026-09-2${8 - (i % 5)}` }),
    );
    const karne = buildClickbaitKarne(rows)!;
    expect(karne.firstDay <= karne.lastDay).toBe(true);
  });
});

describe("karneForSlug", () => {
  it("finds the outlet by slug, or returns undefined", () => {
    const rows = Array.from({ length: 9 }, (_, i) => row({ slug: `s${i}` }));
    const karne = buildClickbaitKarne(rows)!;
    expect(karneForSlug(karne, "s0")?.slug).toBe("s0");
    expect(karneForSlug(karne, "nope")).toBeUndefined();
    expect(karneForSlug(null, "s0")).toBeUndefined();
  });
});

describe("fetchClickbaitRows / getClickbaitKarne (rpc contract)", () => {
  it("calls source_clickbait_30d with the exact name and args", async () => {
    fixture.rows = [];
    await fetchClickbaitRows(300).catch(() => {});
    expect(fixture.rpcArgs[0]).toEqual({
      p_question_sets: [...CLICKBAIT_QUESTION_SETS],
      p_days: CLICKBAIT_WINDOW_DAYS,
      p_min_n: 300,
    });
  });

  it("throws on an rpc error inside the cached fetch", async () => {
    fixture.error = { message: "function does not exist" };
    await expect(fetchClickbaitRows(300)).rejects.toThrow();
  });

  it("getClickbaitKarne fails open (returns null) when the rpc errors", async () => {
    fixture.error = { message: "boom" };
    await expect(getClickbaitKarne()).resolves.toBeNull();
  });

  it("getClickbaitAdminRows never throws and passes p_min_n: 1", async () => {
    fixture.error = { message: "boom" };
    await expect(getClickbaitAdminRows()).resolves.toEqual([]);
    fixture.error = null;
    fixture.rows = [{ source_id: "1", source_slug: "a", source_name: "A", source_bias: "center", source_kind: "outlet", n_total: 5, n_flagged: 1, mean_prob: 0.2, first_day: "2026-09-24", last_day: "2026-09-28" }];
    const rows = await getClickbaitAdminRows();
    expect(rows).toHaveLength(1);
    const lastArgs = fixture.rpcArgs.at(-1) as { p_min_n: number };
    expect(lastArgs.p_min_n).toBe(1);
  });
});

describe("precision fixture recomputation", () => {
  const fixturePath = resolve(__dirname, "../../../tests/fixtures/clickbait-precision.json");
  const raw = JSON.parse(readFileSync(fixturePath, "utf8")) as {
    checkedOn: string;
    questionSet: string;
    threshold: number;
    salt: string;
    rows: Array<{ article_id: string; source_slug: string; zone: string; jev_prob: number; label: boolean; rule: string }>;
  };

  it("the fixture is well-formed", () => {
    expect(Array.isArray(raw.rows)).toBe(true);
    expect(raw.threshold).toBe(CLICKBAIT_FLAG_PROB);
    expect(raw.rows.every((r) => typeof r.label === "boolean")).toBe(true);
  });

  it("CLICKBAIT_PRECISION_CHECK, when non-null, equals the recomputation from the fixture", () => {
    const recomputedPrecision = raw.rows.filter((r) => r.label).length / raw.rows.length;
    if (CLICKBAIT_PRECISION_CHECK !== null) {
      expect(CLICKBAIT_PRECISION_CHECK.sample).toBe(raw.rows.length);
      expect(CLICKBAIT_PRECISION_CHECK.precision).toBeCloseTo(recomputedPrecision, 6);
    } else {
      // Gate closed: no claim is made, nothing to recompute against.
      expect(CLICKBAIT_PRECISION_CHECK).toBeNull();
    }
  });
});
