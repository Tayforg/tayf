import { describe, it, expect, vi, beforeEach } from "vitest";

// Migration 089 ("ADMIT") — /admin "Jev siyaset kabulü" reader + pure
// helpers. Mirrors jev-shadow-status.test.ts's shared-fake pattern.

const fixture = vi.hoisted(() => ({
  stats48: { hours: 48, claims: 0 } as Record<string, unknown>,
  stats168: { hours: 168, claims: 0 } as Record<string, unknown>,
  unreviewed: [] as unknown[],
  reviewed: [] as unknown[],
  sources: [] as unknown[],
  statsError: null as { message: string } | null,
  unreviewedError: null as { message: string } | null,
  reviewedError: null as { message: string } | null,
  sourcesError: null as { message: string } | null,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      jev_politics_admissions: (state) => {
        if (state.selectArgs[0]?.toString().includes("article:articles")) {
          if (fixture.unreviewedError) return { data: null, error: fixture.unreviewedError };
          return { data: fixture.unreviewed, error: null };
        }
        if (fixture.reviewedError) return { data: null, error: fixture.reviewedError };
        return { data: fixture.reviewed, error: null };
      },
      sources: () => {
        if (fixture.sourcesError) return { data: null, error: fixture.sourcesError };
        return { data: fixture.sources, error: null };
      },
    },
    rpc: {
      jev_politics_admission_stats: (args) => {
        if (fixture.statsError) return { data: null, error: fixture.statsError };
        const hours = (args as { p_hours: number } | undefined)?.p_hours;
        return { data: hours === 48 ? fixture.stats48 : fixture.stats168, error: null };
      },
    },
  });
});

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: () => supabaseFake.client,
}));

beforeEach(() => {
  fixture.stats48 = { hours: 48, claims: 0 };
  fixture.stats168 = { hours: 168, claims: 0 };
  fixture.unreviewed = [];
  fixture.reviewed = [];
  fixture.sources = [];
  fixture.statsError = null;
  fixture.unreviewedError = null;
  fixture.reviewedError = null;
  fixture.sourcesError = null;
});

import {
  JEV_ADMISSION_VERDICTS,
  JEV_ADMISSION_OUTCOMES,
  JEV_ADMISSION_REVIEW_TARGET,
  toAdmissionStats,
  zoneShares,
  inferMode,
  wilson,
  pickReviewBatch,
  getJevAdmissionStatus,
  type JevAdmissionReviewRow,
} from "./jev-admission";

describe("JEV_ADMISSION_VERDICTS / JEV_ADMISSION_OUTCOMES", () => {
  it("are the documented single-line literal arrays", () => {
    expect(JEV_ADMISSION_VERDICTS).toEqual([
      "domestic",
      "policy_adjacent",
      "foreign",
      "not_politics",
      "unsure",
    ]);
    expect(JEV_ADMISSION_OUTCOMES).toEqual([
      "matched",
      "created",
      "would_match",
      "would_create",
      "disabled",
      "rejected",
      "not_found",
    ]);
  });

  it("JEV_ADMISSION_REVIEW_TARGET is 80", () => {
    expect(JEV_ADMISSION_REVIEW_TARGET).toBe(80);
  });
});

describe("toAdmissionStats", () => {
  it("coerces every number field, including string numerics", () => {
    const stats = toAdmissionStats({
      hours: "48",
      claims: "10",
      claims_shadow: 8,
      claims_live: 2,
      claims_per_day: "5.5",
      by_category: { ekonomi: "3" },
      outcomes: { matched: 4 },
      fresh_scored_60m_share: "0.8",
      claim_lag_p50_min: null,
    });
    expect(stats.hours).toBe(48);
    expect(stats.claims).toBe(10);
    expect(stats.claimsShadow).toBe(8);
    expect(stats.claimsLive).toBe(2);
    expect(stats.claimsPerDay).toBe(5.5);
    expect(stats.byCategory).toEqual({ ekonomi: 3 });
    expect(stats.outcomes).toEqual({ matched: 4 });
    expect(stats.freshScored60mShare).toBe(0.8);
    expect(stats.claimLagP50Min).toBeNull();
  });

  it("never throws on garbage input", () => {
    expect(() => toAdmissionStats(null)).not.toThrow();
    expect(() => toAdmissionStats("not an object")).not.toThrow();
    expect(() => toAdmissionStats(undefined)).not.toThrow();
  });
});

describe("zoneShares", () => {
  it("maps bias counts to zone proportions, ignoring unknown keys", () => {
    const shares = zoneShares({
      pro_government: 3,
      opposition: 1,
      center: 1,
      not_a_real_bias: 99,
    });
    expect(shares.iktidar).toBeCloseTo(3 / 5);
    expect(shares.muhalefet).toBeCloseTo(1 / 5);
    expect(shares.bagimsiz).toBeCloseTo(1 / 5);
  });

  it("returns all zeros for an empty or all-unknown input", () => {
    expect(zoneShares({})).toEqual({ iktidar: 0, bagimsiz: 0, muhalefet: 0 });
    expect(zoneShares({ bogus: 5 })).toEqual({ iktidar: 0, bagimsiz: 0, muhalefet: 0 });
  });
});

describe("inferMode", () => {
  it("Canlı when claims_live > 0", () => {
    expect(inferMode(toAdmissionStats({ claims: 5, claims_live: 1 }))).toBe("Canlı");
  });
  it("Gölge when claims > 0 but no live claims", () => {
    expect(inferMode(toAdmissionStats({ claims: 5, claims_live: 0 }))).toBe("Gölge");
  });
  it("Kapalı ya da aday yok when there are no claims at all", () => {
    expect(inferMode(toAdmissionStats({ claims: 0, claims_live: 0 }))).toBe("Kapalı ya da aday yok");
  });
});

describe("wilson", () => {
  it("returns {lower:0, upper:0} for n<=0", () => {
    expect(wilson(0, 0)).toEqual({ lower: 0, upper: 0 });
  });
  it("returns a bound that brackets the observed proportion", () => {
    const { lower, upper } = wilson(23, 25);
    expect(lower).toBeGreaterThan(0.6);
    expect(lower).toBeLessThan(0.92);
    expect(upper).toBeGreaterThan(0.92);
    expect(upper).toBeLessThanOrEqual(1);
  });
});

describe("pickReviewBatch", () => {
  function row(id: string, category: string, claimedAt: string): JevAdmissionReviewRow {
    return {
      articleId: id,
      mode: "shadow",
      category,
      politicsP: 0.95,
      claimedAt,
      outcome: null,
      title: `Title ${id}`,
      description: null,
    };
  }

  it("round-robins across categories, least-reviewed category first", () => {
    const rows = [
      row("a1", "ekonomi", "2026-09-28T00:00:00Z"),
      row("a2", "ekonomi", "2026-09-28T01:00:00Z"),
      row("s1", "spor", "2026-09-28T02:00:00Z"),
    ];
    const batch = pickReviewBatch(rows, { ekonomi: 5, spor: 0 }, 10);
    // spor (0 reviewed) comes before ekonomi (5 reviewed) in round-robin order.
    expect(batch[0].category).toBe("spor");
    expect(batch[1].category).toBe("ekonomi");
  });

  it("orders newest-first within a category", () => {
    const rows = [
      row("a1", "ekonomi", "2026-09-28T00:00:00Z"),
      row("a2", "ekonomi", "2026-09-28T02:00:00Z"),
    ];
    const batch = pickReviewBatch(rows, {}, 10);
    expect(batch.map((r) => r.articleId)).toEqual(["a2", "a1"]);
  });

  it("caps at limit", () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      row(`a${i}`, "ekonomi", `2026-09-28T${String(i).padStart(2, "0")}:00:00Z`),
    );
    expect(pickReviewBatch(rows, {}, 10)).toHaveLength(10);
  });
});

describe("getJevAdmissionStatus", () => {
  it("fetches stats for both 48h and 168h windows", async () => {
    fixture.stats48 = { hours: 48, claims: 3 };
    fixture.stats168 = { hours: 168, claims: 20 };
    const status = await getJevAdmissionStatus();
    expect(status).not.toBeNull();
    expect(status!.stats48.hours).toBe(48);
    expect(status!.stats48.claims).toBe(3);
    expect(status!.stats168.hours).toBe(168);
    expect(status!.stats168.claims).toBe(20);
  });

  it("returns null on any error", async () => {
    fixture.statsError = { message: "boom" };
    const status = await getJevAdmissionStatus();
    expect(status).toBeNull();
  });

  it("never throws even if the client throws synchronously", async () => {
    fixture.unreviewedError = { message: "unavailable" };
    const status = await getJevAdmissionStatus();
    expect(status).toBeNull();
  });
});
