import { describe, expect, it, vi } from "vitest";

// weekly-wire.ts is pure, but WEEKLY_LIST_SIZE (the parity test below) comes
// from weekly-query.ts, which imports next/cache at module scope.
vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

import { WEEKLY_LIST_SIZE } from "./weekly-query";
import type {
  WeeklyBlindspot,
  WeeklySummary,
  WeeklyTopCluster,
} from "./weekly-query";
import {
  WEEKLY_WIRE_MAX_IDS,
  attachWeeklyWire,
  weeklyWireIds,
  wireSignalsFromMembers,
  type WeeklyWireMemberRow,
} from "./weekly-wire";

// h208-roadmap-1: the /hafta week pages count a wire redistribution in distinct
// texts, like every other surface. These tests pin the three pure steps: which
// ids a page reads members for, how members become an effective count, and how
// the verdict is attached to the displayed rows (and only to those).

const LONG_LEAD =
  "Cumhurbaşkanı açıklamasında önümüzdeki hafta yeni bir ekonomik paketin kamuoyuyla paylaşılacağını söyledi.";

function member(
  clusterId: string,
  n: number,
  overrides: {
    sourceId?: string;
    hash?: string | null;
    publishedAt?: string | null;
    description?: string | null;
  } = {},
): WeeklyWireMemberRow {
  return {
    cluster_id: clusterId,
    articles: {
      id: `${clusterId}-a${n}`,
      source_id: overrides.sourceId ?? `${clusterId}-s${n}`,
      published_at:
        overrides.publishedAt === undefined
          ? `2026-11-20T10:0${n}:00.000Z`
          : overrides.publishedAt,
      content_hash: overrides.hash === undefined ? `h-${clusterId}-${n}` : overrides.hash,
      description: overrides.description ?? null,
    },
  };
}

function topCluster(id: string, overrides: Partial<WeeklyTopCluster> = {}): WeeklyTopCluster {
  return {
    id,
    title: `Küme ${id}`,
    articleCount: 5,
    zonesCovered: 2,
    zoneCounts: { iktidar: 3, bagimsiz: 0, muhalefet: 2 },
    ...overrides,
  };
}

function blindspot(id: string, overrides: Partial<WeeklyBlindspot> = {}): WeeklyBlindspot {
  return {
    id,
    title: `Kör nokta ${id}`,
    articleCount: 4,
    side: "iktidar",
    counts: { iktidar: 4, bagimsiz: 0, muhalefet: 0 },
    share: 1,
    sharePct: 100,
    ...overrides,
  };
}

function summary(
  topClusters: WeeklyTopCluster[],
  blindspots: WeeklyBlindspot[],
): WeeklySummary {
  return {
    zoneCounts: { iktidar: 6, bagimsiz: 3, muhalefet: 1 },
    topClusters,
    blindspots,
    blindspotSideCounts: { iktidar: blindspots.length, bagimsiz: 0, muhalefet: 0 },
  };
}

describe("WEEKLY_WIRE_MAX_IDS", () => {
  it("is exactly the rows /hafta can show: two lists of WEEKLY_LIST_SIZE", () => {
    expect(WEEKLY_WIRE_MAX_IDS).toBe(2 * WEEKLY_LIST_SIZE);
  });
});

describe("weeklyWireIds", () => {
  it("lists the displayed ids of both lists, sorted, a cluster in both once", () => {
    const s = summary(
      [topCluster("c"), topCluster("a")],
      [blindspot("b"), blindspot("a")],
    );
    expect(weeklyWireIds(s)).toEqual(["a", "b", "c"]);
  });

  it("is empty for a summary with no rows", () => {
    expect(weeklyWireIds(summary([], []))).toEqual([]);
  });

  it("caps the list at WEEKLY_WIRE_MAX_IDS", () => {
    const many = Array.from({ length: 30 }, (_, i) => `id-${String(i).padStart(2, "0")}`);
    const s = summary(many.map((id) => topCluster(id)), []);
    const ids = weeklyWireIds(s);
    expect(ids).toHaveLength(WEEKLY_WIRE_MAX_IDS);
    expect(ids).toEqual([...ids].sort());
  });
});

describe("wireSignalsFromMembers", () => {
  it("a cluster whose members repeat one text carries its effective count and member count", () => {
    // Five sources, four of them the same text: 2 distinct texts of 5 (0.4 <= 0.5).
    const rows = [
      member("w", 1, { hash: "same" }),
      member("w", 2, { hash: "same" }),
      member("w", 3, { hash: "same" }),
      member("w", 4, { hash: "same" }),
      member("w", 5, { hash: "other" }),
    ];
    expect(wireSignalsFromMembers(rows)).toEqual({
      w: { effectiveArticleCount: 2, memberCount: 5 },
    });
  });

  it("a cluster of independent texts is left out entirely (non-wire is untouched)", () => {
    const rows = [member("p", 1), member("p", 2), member("p", 3), member("p", 4)];
    expect(wireSignalsFromMembers(rows)).toEqual({});
  });

  it("counts one article per source, the earliest, as the cluster page does", () => {
    // Source s1 published the same text three times; with one article per source the
    // cluster is 3 members (s1, s2, s3) and one text, not 5 members.
    const rows = [
      member("w", 1, { sourceId: "s1", hash: "x", publishedAt: "2026-11-20T10:00:00.000Z" }),
      member("w", 2, { sourceId: "s1", hash: "x", publishedAt: "2026-11-20T11:00:00.000Z" }),
      member("w", 3, { sourceId: "s1", hash: "y", publishedAt: "2026-11-20T12:00:00.000Z" }),
      member("w", 4, { sourceId: "s2", hash: "x", publishedAt: "2026-11-20T10:30:00.000Z" }),
      member("w", 5, { sourceId: "s3", hash: "x", publishedAt: "2026-11-20T10:40:00.000Z" }),
    ];
    expect(wireSignalsFromMembers(rows)).toEqual({
      w: { effectiveArticleCount: 1, memberCount: 3 },
    });
  });

  it("a shared agency lead under different hashes is one text", () => {
    const rows = [
      member("w", 1, { description: LONG_LEAD }),
      member("w", 2, { description: LONG_LEAD }),
      member("w", 3, { description: LONG_LEAD }),
      member("w", 4),
    ];
    // Three members share the lead, the fourth stands alone: 2 texts of 4.
    expect(wireSignalsFromMembers(rows)).toEqual({
      w: { effectiveArticleCount: 2, memberCount: 4 },
    });
  });

  it("fewer than three members is never wire, however alike", () => {
    const rows = [member("p", 1, { hash: "x" }), member("p", 2, { hash: "x" })];
    expect(wireSignalsFromMembers(rows)).toEqual({});
  });

  it("keeps clusters apart and answers only for the wire ones", () => {
    const rows = [
      member("w", 1, { hash: "x" }),
      member("p", 1),
      member("w", 2, { hash: "x" }),
      member("p", 2),
      member("w", 3, { hash: "x" }),
      member("p", 3),
    ];
    expect(Object.keys(wireSignalsFromMembers(rows))).toEqual(["w"]);
  });

  it("skips a row with no embedded article and reads a one-element array embed", () => {
    const rows: WeeklyWireMemberRow[] = [
      { cluster_id: "w", articles: null },
      member("w", 1, { hash: "x" }),
      member("w", 2, { hash: "x" }),
      { cluster_id: "w", articles: [member("w", 3, { hash: "x" }).articles!] as never },
    ];
    expect(wireSignalsFromMembers(rows)).toEqual({
      w: { effectiveArticleCount: 1, memberCount: 3 },
    });
  });

  it("does not throw on an unparseable or missing published_at", () => {
    const rows = [
      member("w", 1, { hash: "x", publishedAt: "not a date" }),
      member("w", 2, { hash: "x", publishedAt: null }),
      member("w", 3, { hash: "x" }),
    ];
    expect(() => wireSignalsFromMembers(rows)).not.toThrow();
    expect(wireSignalsFromMembers(rows).w?.memberCount).toBe(3);
  });

  it("answers {} for null, empty and non-array input", () => {
    expect(wireSignalsFromMembers(null)).toEqual({});
    expect(wireSignalsFromMembers([])).toEqual({});
    expect(wireSignalsFromMembers("nope" as never)).toEqual({});
  });
});

describe("attachWeeklyWire", () => {
  const SIGNALS = { w: { effectiveArticleCount: 2, memberCount: 5 } };

  it("flags a wire row in either list with its effective and member counts", () => {
    const s = summary([topCluster("w"), topCluster("p")], [blindspot("w"), blindspot("p")]);
    const out = attachWeeklyWire(s, SIGNALS);

    expect(out.topClusters[0]).toEqual({
      ...topCluster("w"),
      isWire: true,
      effectiveArticleCount: 2,
      memberCount: 5,
    });
    expect(out.blindspots[0]).toEqual({
      ...blindspot("w"),
      isWire: true,
      effectiveArticleCount: 2,
      memberCount: 5,
    });
  });

  it("leaves a non-wire row exactly as it was: the same object, no new keys", () => {
    const plain = topCluster("p");
    const plainBlind = blindspot("p");
    const out = attachWeeklyWire(summary([plain], [plainBlind]), SIGNALS);

    expect(out.topClusters[0]).toBe(plain);
    expect(out.blindspots[0]).toBe(plainBlind);
    expect(Object.keys(out.topClusters[0]!)).not.toContain("isWire");
  });

  it("a read error (null signals) or an empty answer returns the summary untouched", () => {
    const s = summary([topCluster("w")], [blindspot("w")]);
    expect(attachWeeklyWire(s, null)).toBe(s);
    expect(attachWeeklyWire(s, {})).toBe(s);
  });

  it("ignores an entry without a usable text count", () => {
    const s = summary([topCluster("w")], []);
    const bad = { w: { effectiveArticleCount: 0, memberCount: 5 } };
    expect(attachWeeklyWire(s, bad)).toBe(s);
    const nan = { w: { effectiveArticleCount: Number.NaN, memberCount: 5 } };
    expect(attachWeeklyWire(s, nan)).toBe(s);
  });

  it("does not mutate its input and keeps every other summary field", () => {
    const s = summary([topCluster("w")], [blindspot("w")]);
    const before = structuredClone(s);
    const out = attachWeeklyWire(s, SIGNALS);

    expect(s).toEqual(before);
    expect(out.zoneCounts).toEqual(s.zoneCounts);
    expect(out.blindspotSideCounts).toEqual(s.blindspotSideCounts);
    // The summary's own figures (article counts, zone counts) are not rewritten.
    expect(out.topClusters[0]!.articleCount).toBe(5);
    expect(out.topClusters[0]!.zoneCounts).toEqual({ iktidar: 3, bagimsiz: 0, muhalefet: 2 });
  });
});
