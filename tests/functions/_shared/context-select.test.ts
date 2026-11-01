import { describe, it, expect } from "vitest";
import {
  CANDIDATE_SIZE_TIEBREAK_MARGIN,
  MAX_TITLE_PROBE_CLUSTERS,
  mergeProbeIds,
  rankCandidates,
  selectContextClusterIds,
  stickyUpperBound,
  type ContextClusterRow,
} from "../../../supabase/functions/_shared/cluster/context-select.ts";

// The consumer's rolling context keeps the CAP most recently updated clusters.
// At peak those 200 clusters span only ~2 h, so a busy story that went quiet
// for 3 h dropped out of the window and its follow-ups opened a duplicate
// cluster. The "sticky" tail keeps recent, well-covered clusters matchable.

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const HOUR = 3_600_000;
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

const OPTS = {
  cap: 200,
  stickyMinArticles: 5,
  stickyHours: 12,
  stickyMax: 60,
  now: NOW,
};

function singletons(n: number, spanHours = 1): ContextClusterRow[] {
  // Newest first, spread over the last `spanHours`.
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    updated_at: iso((i / n) * spanHours),
    article_count: 1,
  }));
}

describe("selectContextClusterIds", () => {
  it("includes a 20-article cluster updated 3 h ago that the newest-200 window misses", () => {
    const rows = [...singletons(250), { id: "busy", updated_at: iso(3), article_count: 20 }];
    const ids = selectContextClusterIds(rows, OPTS);
    expect(ids).toContain("busy");
    // base is the 200 newest singletons, sticky follows.
    expect(ids.slice(0, 200)).toEqual(rows.slice(0, 200).map((r) => r.id));
    expect(ids[200]).toBe("busy");
    expect(ids).toHaveLength(201);
  });

  it("excludes the same cluster once it is older than the sticky horizon", () => {
    const rows = [...singletons(250), { id: "busy", updated_at: iso(13), article_count: 20 }];
    expect(selectContextClusterIds(rows, OPTS)).not.toContain("busy");
  });

  it("excludes thin clusters (< stickyMinArticles) from the sticky tail", () => {
    const rows = [...singletons(250), { id: "thin", updated_at: iso(3), article_count: 4 }];
    expect(selectContextClusterIds(rows, OPTS)).not.toContain("thin");
    const five = [...singletons(250), { id: "five", updated_at: iso(3), article_count: 5 }];
    expect(selectContextClusterIds(five, OPTS)).toContain("five");
  });

  it("never admits archived or merged clusters as sticky", () => {
    const rows: ContextClusterRow[] = [
      ...singletons(250),
      { id: "archived", updated_at: iso(3), article_count: 30, is_archived: true },
      { id: "merged", updated_at: iso(3), article_count: 30, merged_into: "other" },
      { id: "ok", updated_at: iso(3), article_count: 30, is_archived: false, merged_into: null },
    ];
    const ids = selectContextClusterIds(rows, OPTS);
    expect(ids).not.toContain("archived");
    expect(ids).not.toContain("merged");
    expect(ids).toContain("ok");
  });

  it("orders sticky rows by article_count desc, then updated_at desc, and honours stickyMax", () => {
    const rows: ContextClusterRow[] = [
      ...singletons(250),
      { id: "c10-old", updated_at: iso(8), article_count: 10 },
      { id: "c10-new", updated_at: iso(2), article_count: 10 },
      { id: "c30", updated_at: iso(9), article_count: 30 },
      { id: "c6", updated_at: iso(1.5), article_count: 6 },
    ];
    const ids = selectContextClusterIds(rows, OPTS);
    expect(ids.slice(200)).toEqual(["c30", "c10-new", "c10-old", "c6"]);

    const capped = selectContextClusterIds(rows, { ...OPTS, stickyMax: 2 });
    expect(capped.slice(200)).toEqual(["c30", "c10-new"]);
  });

  it("bounds the result to cap + stickyMax, with unique ids, and always keeps the cap newest rows", () => {
    const many: ContextClusterRow[] = Array.from({ length: 400 }, (_, i) => ({
      id: `m${i}`,
      updated_at: iso(i * 0.02),
      article_count: i % 7 === 0 ? 12 : 1,
    }));
    // A duplicated id must not be selected twice.
    const rows = [...many, { ...many[5]! }, { ...many[399]! }];
    const ids = selectContextClusterIds(rows, OPTS);
    expect(ids.length).toBeLessThanOrEqual(OPTS.cap + OPTS.stickyMax);
    expect(new Set(ids).size).toBe(ids.length);
    const newest = [...many]
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
      .slice(0, OPTS.cap)
      .map((r) => r.id);
    for (const id of newest) expect(ids).toContain(id);
  });

  it("sorts unordered input by updated_at when picking the base", () => {
    const shuffled = [...singletons(250)].reverse();
    const ids = selectContextClusterIds(shuffled, OPTS);
    expect(ids).toHaveLength(200);
    expect(ids[0]).toBe("s0");
    expect(ids).not.toContain("s249");
  });

  it("keeps archived / merged rows that are already in the newest-cap base (query 1 is unfiltered)", () => {
    const rows: ContextClusterRow[] = [
      { id: "arch-new", updated_at: iso(0.05), article_count: 9, is_archived: true },
      ...singletons(10, 1).map((r) => ({ ...r, id: `x${r.id}` })),
    ];
    expect(selectContextClusterIds(rows, { ...OPTS, cap: 5 })).toContain("arch-new");
  });

  it("returns everything (no sticky) when fewer rows than cap exist", () => {
    const rows = singletons(30);
    expect(selectContextClusterIds(rows, OPTS)).toEqual(rows.map((r) => r.id));
  });

  it("ignores sticky candidates with unparseable timestamps and handles empty input", () => {
    const rows: ContextClusterRow[] = [
      ...singletons(250),
      { id: "bad", updated_at: "not-a-date", article_count: 50 },
    ];
    expect(selectContextClusterIds(rows, OPTS)).not.toContain("bad");
    expect(selectContextClusterIds([], OPTS)).toEqual([]);
  });

  it("accepts a Date for now", () => {
    const rows = [...singletons(250), { id: "busy", updated_at: iso(3), article_count: 20 }];
    expect(selectContextClusterIds(rows, { ...OPTS, now: new Date(NOW) })).toContain("busy");
  });
});

describe("stickyUpperBound", () => {
  it("is null while the context is not full", () => {
    expect(stickyUpperBound(singletons(199), 200)).toBeNull();
    expect(stickyUpperBound([], 200)).toBeNull();
  });

  it("is the updated_at of the cap-th newest row once the context is full", () => {
    const rows = singletons(200);
    expect(stickyUpperBound(rows, 200)).toBe(rows[199]!.updated_at);
    const more = singletons(250);
    expect(stickyUpperBound(more, 200)).toBe(more[199]!.updated_at);
  });
});

// ---------------------------------------------------------------------------
// h12-cluster-1: twin clusters. Two pure helpers keep the consumer's candidate
// ordering and the exact-title probe testable without the Edge Function.
// ---------------------------------------------------------------------------

describe("CANDIDATE_SIZE_TIEBREAK_MARGIN", () => {
  it("is 0.10 (the Antalya sozcu pair: 0.87 vs 0.83 must pick the 18-article cluster)", () => {
    expect(CANDIDATE_SIZE_TIEBREAK_MARGIN).toBe(0.1);
  });
});

describe("rankCandidates", () => {
  const OPTS_RANK = { margin: CANDIDATE_SIZE_TIEBREAK_MARGIN, threshold: 0.4 };
  const cand = (clusterId: string, score: number) => ({ clusterId, score });
  const sizes = (m: Record<string, number>) => (id: string) => m[id] ?? 0;
  const ids = (rows: { clusterId: string }[]) => rows.map((r) => r.clusterId);

  it("returns an empty list for no candidates", () => {
    expect(rankCandidates([], sizes({}), OPTS_RANK)).toEqual([]);
  });

  it("top below the threshold: plain score sort, size is ignored", () => {
    const scored = [cand("big", 0.37), cand("small", 0.39), cand("mid", 0.38)];
    expect(ids(rankCandidates(scored, sizes({ big: 50, mid: 9, small: 1 }), OPTS_RANK))).toEqual([
      "small",
      "mid",
      "big",
    ]);
  });

  it("within the margin the larger cluster wins even with the lower score (0.83 [18] beats 0.87 [7])", () => {
    const scored = [cand("c2", 0.87), cand("c1", 0.83)];
    expect(ids(rankCandidates(scored, sizes({ c1: 18, c2: 7 }), OPTS_RANK))).toEqual(["c1", "c2"]);
  });

  it("outside the margin the higher score wins (0.76 [18] vs 0.87 [7])", () => {
    const scored = [cand("c1", 0.76), cand("c2", 0.87)];
    expect(ids(rankCandidates(scored, sizes({ c1: 18, c2: 7 }), OPTS_RANK))).toEqual(["c2", "c1"]);
  });

  it("the margin is inclusive: exactly top - 0.10 is still in the group (0.77 vs 0.87)", () => {
    const scored = [cand("c2", 0.87), cand("c1", 0.77)];
    expect(ids(rankCandidates(scored, sizes({ c1: 18, c2: 7 }), OPTS_RANK))[0]).toBe("c1");
  });

  it("a larger candidate below the threshold never outranks a smaller one above it (0.38 [20] vs 0.41 [2])", () => {
    const scored = [cand("c2", 0.41), cand("c1", 0.38)];
    expect(ids(rankCandidates(scored, sizes({ c1: 20, c2: 2 }), OPTS_RANK))).toEqual(["c2", "c1"]);
  });

  it("group order is size desc, then score desc, then id asc; the rest follows by score desc", () => {
    const scored = [
      cand("d", 0.9),
      cand("b", 0.85),
      cand("a", 0.85),
      cand("c", 0.88),
      cand("low1", 0.5),
      cand("low2", 0.6),
    ];
    const out = rankCandidates(scored, sizes({ a: 5, b: 5, c: 5, d: 2 }), OPTS_RANK);
    // group = score >= 0.40 and >= 0.80: d, c, b, a. Sizes 5,5,5 then 2 -> c(0.88) before a/b(0.85);
    // a and b tie on size and score -> id asc. d (size 2) closes the group.
    // low1/low2 are above the threshold but outside the margin: they follow by score desc.
    expect(ids(out)).toEqual(["c", "a", "b", "d", "low2", "low1"]);
  });

  it("equal size and equal score keeps a deterministic id order, independent of the input order", () => {
    const a = rankCandidates([cand("z", 0.8), cand("m", 0.8)], sizes({ z: 4, m: 4 }), OPTS_RANK);
    const b = rankCandidates([cand("m", 0.8), cand("z", 0.8)], sizes({ z: 4, m: 4 }), OPTS_RANK);
    expect(ids(a)).toEqual(["m", "z"]);
    expect(ids(b)).toEqual(["m", "z"]);
  });

  it("is stable below the threshold: equal scores keep their input order", () => {
    const scored = [cand("x", 0.37), cand("y", 0.37), cand("z", 0.37)];
    expect(ids(rankCandidates(scored, sizes({ x: 1, y: 9, z: 5 }), OPTS_RANK))).toEqual(["x", "y", "z"]);
  });

  it("does not mutate its input and keeps extra fields on the rows", () => {
    const scored = [
      { clusterId: "a", score: 0.5, fallbackScore: 0.1 },
      { clusterId: "b", score: 0.6, fallbackScore: 0.2 },
    ];
    const copy = scored.map((r) => ({ ...r }));
    const out = rankCandidates(scored, sizes({}), OPTS_RANK);
    expect(scored).toEqual(copy);
    expect(out[0]).toEqual({ clusterId: "b", score: 0.6, fallbackScore: 0.2 });
  });

  it("treats a missing / non-finite size as 0", () => {
    const scored = [cand("a", 0.8), cand("b", 0.79)];
    const out = rankCandidates(scored, (id) => (id === "a" ? Number.NaN : 3), OPTS_RANK);
    expect(ids(out)).toEqual(["b", "a"]);
  });

  it("a one-element list is returned as is", () => {
    expect(ids(rankCandidates([cand("only", 0.2)], sizes({}), OPTS_RANK))).toEqual(["only"]);
  });
});

describe("mergeProbeIds", () => {
  it("puts the probe ids first, then the candidates, in order", () => {
    expect(mergeProbeIds(["p1", "p2"], ["c1", "c2", "c3"])).toEqual(["p1", "p2", "c1", "c2", "c3"]);
  });

  it("de-duplicates: a probe id that is also a candidate appears once, in the probe position", () => {
    expect(mergeProbeIds(["p1", "c2"], ["c1", "c2", "c3"])).toEqual(["p1", "c2", "c1", "c3"]);
  });

  it("keeps at most three probe ids, in the order given", () => {
    expect(MAX_TITLE_PROBE_CLUSTERS).toBe(3);
    expect(mergeProbeIds(["p1", "p2", "p3", "p4", "p5"], ["c1"])).toEqual(["p1", "p2", "p3", "c1"]);
  });

  it("a probe id beyond the first three that is also a candidate stays in the candidate list", () => {
    expect(mergeProbeIds(["p1", "p2", "p3", "c1"], ["c1", "c2"])).toEqual(["p1", "p2", "p3", "c1", "c2"]);
  });

  it("duplicate probe ids count once toward the limit of three", () => {
    expect(mergeProbeIds(["p1", "p1", "p2", "p3", "p4"], [])).toEqual(["p1", "p2", "p3"]);
  });

  it("handles empty inputs", () => {
    expect(mergeProbeIds([], [])).toEqual([]);
    expect(mergeProbeIds([], ["c1"])).toEqual(["c1"]);
    expect(mergeProbeIds(["p1"], [])).toEqual(["p1"]);
  });

  it("does not cap the candidate list (probe ids bypass MAX_CANDIDATE_CLUSTERS)", () => {
    const candidates = Array.from({ length: 80 }, (_, i) => `c${i}`);
    const out = mergeProbeIds(["p1"], candidates);
    expect(out).toHaveLength(81);
    expect(out[0]).toBe("p1");
  });
});
