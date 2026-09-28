import { describe, it, expect } from "vitest";

import {
  parseBulkKeepIds,
  summariseDryRun,
  JEV_UNLINK_BULK_MAX,
  JEV_UNLINK_PRECISION_MIN_N,
  JEV_UNLINK_DRYRUN_READ_LIMIT,
  JEV_UNLINK_LIKELY_JACCARD_MAX,
} from "./jev-unlink-triage";

describe("parseBulkKeepIds", () => {
  it("accepts a valid array of positive safe integers", () => {
    expect(parseBulkKeepIds([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("dedupes repeated ids", () => {
    expect(parseBulkKeepIds([1, 1, 2, 2, 3])).toEqual([1, 2, 3]);
  });

  it("rejects more than JEV_UNLINK_BULK_MAX ids", () => {
    expect(JEV_UNLINK_BULK_MAX).toBe(50);
    const ids = Array.from({ length: 51 }, (_, i) => i + 1);
    expect(parseBulkKeepIds(ids)).toBeNull();
  });

  it("accepts exactly JEV_UNLINK_BULK_MAX ids", () => {
    const ids = Array.from({ length: 50 }, (_, i) => i + 1);
    expect(parseBulkKeepIds(ids)).toHaveLength(50);
  });

  it("rejects 0, negative, float and string entries", () => {
    expect(parseBulkKeepIds([0])).toBeNull();
    expect(parseBulkKeepIds([-1])).toBeNull();
    expect(parseBulkKeepIds([1.5])).toBeNull();
    expect(parseBulkKeepIds(["1"])).toBeNull();
  });

  it("rejects an empty array", () => {
    expect(parseBulkKeepIds([])).toBeNull();
  });

  it("rejects non-array input", () => {
    expect(parseBulkKeepIds(null)).toBeNull();
    expect(parseBulkKeepIds(undefined)).toBeNull();
    expect(parseBulkKeepIds({ ids: [1] })).toBeNull();
    expect(parseBulkKeepIds(1)).toBeNull();
  });
});

function dryRunRow(overrides: Record<string, unknown> = {}) {
  return {
    candidate_id: 1,
    jev_prob: 0.05,
    title_jaccard: 0.1,
    cluster_size: 5,
    would_unlink: true,
    skip_reasons: [],
    first_evaluated_at: "2026-09-28T00:00:00.000Z",
    candidate: {
      status: "pending",
      article: { title: "Haber" },
      cluster: { title_tr: "Küme", title_tr_neutral: null },
    },
    ...overrides,
  };
}

describe("summariseDryRun", () => {
  it("counts evaluated/wouldUnlink/guarded and tallies reasons", () => {
    const rows = [
      dryRunRow({ candidate_id: 1, would_unlink: true, skip_reasons: [] }),
      dryRunRow({
        candidate_id: 2,
        would_unlink: false,
        skip_reasons: ["small_cluster"],
      }),
      dryRunRow({
        candidate_id: 3,
        would_unlink: false,
        skip_reasons: ["small_cluster", "earliest_member"],
      }),
    ];
    const summary = summariseDryRun(rows);
    expect(summary.evaluated).toBe(3);
    expect(summary.wouldUnlink).toBe(1);
    expect(summary.guarded).toBe(2);
    expect(summary.reasons.small_cluster).toBe(2);
    expect(summary.reasons.earliest_member).toBe(1);
    expect(summary.reasons.not_member).toBe(0);
    expect(summary.reasons.pair_positive).toBe(0);
    expect(summary.reasons.title_match).toBe(0);
  });

  it("computes precision only at or above JEV_UNLINK_PRECISION_MIN_N decided rows", () => {
    expect(JEV_UNLINK_PRECISION_MIN_N).toBe(10);

    const fewDecided = Array.from({ length: 9 }, (_, i) =>
      dryRunRow({
        candidate_id: i + 1,
        would_unlink: true,
        candidate: { status: "unlinked", article: { title: "x" }, cluster: { title_tr: "y" } },
      }),
    );
    expect(summariseDryRun(fewDecided).policyA.precision).toBeNull();

    const tenDecided = Array.from({ length: 10 }, (_, i) =>
      dryRunRow({
        candidate_id: i + 1,
        would_unlink: true,
        candidate: {
          status: i < 8 ? "unlinked" : "kept",
          article: { title: "x" },
          cluster: { title_tr: "y" },
        },
      }),
    );
    const summary = summariseDryRun(tenDecided);
    expect(summary.policyA.decided).toBe(10);
    expect(summary.policyA.unlinked).toBe(8);
    expect(summary.policyA.kept).toBe(2);
    expect(summary.policyA.precision).toBeCloseTo(0.8);
  });

  it("policyB only counts would_unlink rows with title_jaccard not null and below the threshold", () => {
    expect(JEV_UNLINK_LIKELY_JACCARD_MAX).toBe(0.2);
    const rows = [
      dryRunRow({ candidate_id: 1, would_unlink: true, title_jaccard: 0.1 }),
      dryRunRow({ candidate_id: 2, would_unlink: true, title_jaccard: 0.3 }),
      dryRunRow({ candidate_id: 3, would_unlink: true, title_jaccard: null }),
      dryRunRow({ candidate_id: 4, would_unlink: false, title_jaccard: 0.05 }),
    ];
    const summary = summariseDryRun(rows);
    expect(summary.policyA.decided + summary.policyA.pending).toBe(3);
    expect(summary.policyB.decided + summary.policyB.pending).toBe(1);
  });

  it("tolerates object, array and null embed shapes", () => {
    const objectShape = dryRunRow({
      candidate: {
        status: "pending",
        article: { title: "A" },
        cluster: { title_tr: "K" },
      },
    });
    const arrayShape = dryRunRow({
      candidate: [
        {
          status: "pending",
          article: [{ title: "A2" }],
          cluster: [{ title_tr: "K2", title_tr_neutral: null }],
        },
      ],
    });
    const nullShape = dryRunRow({ candidate: null });

    const summary = summariseDryRun([objectShape, arrayShape, nullShape]);
    expect(summary.evaluated).toBe(3);
    expect(summary.recent[0]?.articleTitle).toBe("A");
    expect(summary.recent[1]?.articleTitle).toBe("A2");
    expect(summary.recent[1]?.clusterTitle).toBe("K2");
    expect(summary.recent[2]?.articleTitle).toBe("");
    expect(summary.recent[2]?.clusterTitle).toBe("(başlıksız)");
  });

  it("caps recent at 10 rows regardless of input size", () => {
    const rows = Array.from({ length: 30 }, (_, i) => dryRunRow({ candidate_id: i + 1 }));
    const summary = summariseDryRun(rows);
    expect(summary.recent).toHaveLength(10);
  });

  it("sets truncated when the row count reaches JEV_UNLINK_DRYRUN_READ_LIMIT", () => {
    expect(JEV_UNLINK_DRYRUN_READ_LIMIT).toBe(500);
    const under = Array.from({ length: 499 }, (_, i) => dryRunRow({ candidate_id: i + 1 }));
    const at = Array.from({ length: 500 }, (_, i) => dryRunRow({ candidate_id: i + 1 }));
    expect(summariseDryRun(under).truncated).toBe(false);
    expect(summariseDryRun(at).truncated).toBe(true);
  });

  it("never throws on null/non-array input", () => {
    expect(() => summariseDryRun(null)).not.toThrow();
    expect(summariseDryRun(null).evaluated).toBe(0);
    expect(() => summariseDryRun(undefined)).not.toThrow();
    expect(() => summariseDryRun("garbage")).not.toThrow();
  });
});
