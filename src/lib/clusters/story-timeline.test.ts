import { describe, it, expect } from "vitest";

import type { ZoneFeedHealth, ZoneHealth } from "@/lib/clusters/feed-health";
import type { BiasCategory } from "@/types";

import {
  buildStoryTimeline,
  formatLag,
  formatStoryClock,
  missingZones,
  timelineMembersFrom,
  timelineOffsetPct,
  votingSourceCount,
  type StoryTimelineMember,
} from "./story-timeline";

let seq = 0;
function member(
  sourceName: string,
  bias: BiasCategory,
  publishedAt: string,
  overrides: Partial<StoryTimelineMember> = {},
): StoryTimelineMember {
  seq += 1;
  return {
    articleId: overrides.articleId ?? `a${seq}`,
    sourceId: overrides.sourceId ?? `s-${sourceName}`,
    sourceName,
    bias,
    title: overrides.title ?? `${sourceName} başlığı`,
    url: overrides.url ?? `https://example.com/${seq}`,
    publishedAt,
  };
}

function zoneHealth(degraded: boolean): ZoneHealth {
  return {
    total: 10,
    fetchOk: degraded ? 2 : 10,
    fetchOkShare: degraded ? 0.2 : 1,
    delivering: degraded ? 2 : 10,
    deliveringShare: degraded ? 0.2 : 1,
    healthy: degraded ? 2 : 10,
    healthyShare: degraded ? 0.2 : 1,
    degraded,
  };
}

function health(degraded: Partial<Record<keyof ZoneFeedHealth, boolean>>): ZoneFeedHealth {
  return {
    iktidar: zoneHealth(degraded.iktidar ?? false),
    bagimsiz: zoneHealth(degraded.bagimsiz ?? false),
    muhalefet: zoneHealth(degraded.muhalefet ?? false),
  };
}

// 09:12 Istanbul == 06:12Z (Europe/Istanbul is UTC+3 all year).
const BASE = [
  member("Sabah", "pro_government", "2026-09-27T06:12:00Z"),
  member("Karar", "center", "2026-09-27T06:40:00Z"),
  member("Sözcü", "opposition_leaning", "2026-09-27T08:22:00Z"),
];

describe("buildStoryTimeline — ordering and first mover", () => {
  it("orders points by time and picks the earliest source as first", () => {
    const t = buildStoryTimeline([BASE[2], BASE[0], BASE[1]], null, null);
    expect(t).not.toBeNull();
    expect(t!.points.map((p) => p.sourceName)).toEqual(["Sabah", "Karar", "Sözcü"]);
    expect(t!.first.sourceName).toBe("Sabah");
    expect(t!.first.zone).toBe("iktidar");
    expect(t!.first.tie).toBe(false);
    expect(t!.summary).toBe(
      "İlk: Sabah · 09:12 — Bağımsız 28 dk sonra katıldı — Muhalefet 2 sa 10 dk sonra katıldı",
    );
  });

  it("reports per-zone join time and lag relative to the first mover", () => {
    const t = buildStoryTimeline(BASE, null, null)!;
    expect(t.zoneJoin.iktidar?.lagMin).toBe(0);
    expect(t.zoneJoin.bagimsiz?.lagMin).toBe(28);
    expect(t.zoneJoin.muhalefet?.lagMin).toBe(130);
    expect(t.absentZones).toEqual([]);
  });

  it("keeps one point per source (its earliest article)", () => {
    const early = member("Sabah", "pro_government", "2026-09-27T06:12:00Z", {
      sourceId: "s-sabah",
      title: "erken",
    });
    const late = member("Sabah", "pro_government", "2026-09-27T07:00:00Z", {
      sourceId: "s-sabah",
      title: "geç",
    });
    const t = buildStoryTimeline([late, BASE[1], early, BASE[2]], null, null)!;
    expect(t.points).toHaveLength(3);
    const sabah = t.points.filter((p) => p.sourceName === "Sabah");
    expect(sabah).toHaveLength(1);
    expect(sabah[0].title).toBe("erken");
  });

  it("places points on a first→last axis with padding, never touching the edges", () => {
    const t = buildStoryTimeline(BASE, null, null)!;
    const offsets = t.points.map((p) => p.offsetPct);
    expect(offsets[0]).toBeGreaterThan(0);
    expect(offsets[2]).toBeLessThan(100);
    expect(offsets[0]).toBeLessThan(offsets[1]);
    expect(offsets[1]).toBeLessThan(offsets[2]);
    // Symmetric padding: first and last sit equally far from their edge.
    expect(offsets[0]).toBeCloseTo(100 - offsets[2], 5);
  });
});

describe("buildStoryTimeline — effective time (seenAt clamp)", () => {
  it("clamps a future published_at to Tayf's created_at (CNN Türk +2.84 h)", () => {
    const cnn = member("CNN Türk", "gov_leaning", "2026-09-27T09:00:00Z", {
      articleId: "cnn",
    });
    const members = [cnn, BASE[1], BASE[2]];
    const seenAt = { cnn: "2026-09-27T06:10:00Z" };
    const t = buildStoryTimeline(members, seenAt, null)!;
    expect(t.first.sourceName).toBe("CNN Türk");
    expect(t.first.t).toBe(Date.parse("2026-09-27T06:10:00Z"));
  });

  it("never moves a point later than its published_at", () => {
    const sabah = member("Sabah", "pro_government", "2026-09-27T06:12:00Z", {
      articleId: "sabah",
    });
    const t = buildStoryTimeline(
      [sabah, BASE[1], BASE[2]],
      { sabah: "2026-09-27T09:00:00Z" },
      null,
    )!;
    expect(t.first.t).toBe(Date.parse("2026-09-27T06:12:00Z"));
  });

  it("falls back to published times when seenAt is null", () => {
    const cnn = member("CNN Türk", "gov_leaning", "2026-09-27T09:00:00Z");
    const t = buildStoryTimeline([cnn, BASE[1], BASE[2]], null, null)!;
    expect(t.first.sourceName).toBe("Karar");
    expect(t.points.at(-1)?.sourceName).toBe("CNN Türk");
  });

  it("drops members with no valid time and uses seenAt when published_at is garbage", () => {
    const broken = member("Bozuk", "center", "not-a-date", { articleId: "broken" });
    const rescued = member("Kurtarılan", "opposition", "also-bad", { articleId: "rescued" });
    const t = buildStoryTimeline(
      [broken, rescued, ...BASE],
      { rescued: "2026-09-27T06:00:00Z" },
      null,
    )!;
    expect(t.points.map((p) => p.sourceName)).not.toContain("Bozuk");
    expect(t.first.sourceName).toBe("Kurtarılan");
  });
});

describe("buildStoryTimeline — gating", () => {
  it("returns null below 3 distinct sources", () => {
    expect(buildStoryTimeline(BASE.slice(0, 2), null, null)).toBeNull();
  });

  it("returns null when 3 rows come from only 2 sources", () => {
    const dup = member("Sabah", "pro_government", "2026-09-27T07:00:00Z", {
      sourceId: BASE[0].sourceId,
    });
    expect(buildStoryTimeline([BASE[0], dup, BASE[1]], null, null)).toBeNull();
  });

  it("returns null when fewer than 3 sources carry a valid time", () => {
    const broken = member("Bozuk", "center", "nope");
    expect(buildStoryTimeline([BASE[0], BASE[2], broken], null, null)).toBeNull();
  });
});

describe("buildStoryTimeline — ties", () => {
  it("names every source inside the same minute as the first mover", () => {
    const a = member("Haber7", "gov_leaning", "2026-09-27T08:43:00Z");
    const b = member("Haber Global", "gov_leaning", "2026-09-27T08:43:30Z");
    const c = member("BirGün", "opposition", "2026-09-27T08:44:00Z");
    const t = buildStoryTimeline([a, b, c], null, null)!;
    expect(t.first.tie).toBe(true);
    expect(t.first.tiedWith).toEqual(["Haber Global"]);
    expect(t.summary.startsWith("İlk: Haber7 ve Haber Global aynı dakikada · 11:43")).toBe(true);
  });

  it("uses 'aynı dakikada' for a zone that joined within 60 s", () => {
    const a = member("Sabah", "pro_government", "2026-09-27T06:12:00Z");
    const b = member("BirGün", "opposition", "2026-09-27T06:12:40Z");
    const c = member("Karar", "center", "2026-09-27T07:12:00Z");
    const t = buildStoryTimeline([a, b, c], null, null)!;
    expect(t.summary).toContain("— Muhalefet aynı dakikada katıldı");
  });

  it("does not treat exactly 60 s as a tie", () => {
    const a = member("Sabah", "pro_government", "2026-09-27T06:12:00Z");
    const b = member("BirGün", "opposition", "2026-09-27T06:13:00Z");
    const c = member("Karar", "center", "2026-09-27T07:12:00Z");
    const t = buildStoryTimeline([a, b, c], null, null)!;
    expect(t.first.tie).toBe(false);
    expect(t.summary).toContain("— Muhalefet 1 dk sonra katıldı");
  });

  it("caps a long tie list", () => {
    const names = ["A", "B", "C", "D", "E"];
    const ms = names.map((n) => member(n, "pro_government", "2026-09-27T06:12:00Z"));
    const t = buildStoryTimeline(ms, null, null)!;
    expect(t.summary.startsWith("İlk: A, B ve 3 kaynak daha aynı dakikada · 09:12")).toBe(true);
  });
});

describe("buildStoryTimeline — absent zones (never a claim of silence)", () => {
  const twoZones = [
    member("Sabah", "pro_government", "2026-09-27T06:12:00Z"),
    member("A Haber", "pro_government", "2026-09-27T06:20:00Z"),
    member("Sözcü", "opposition_leaning", "2026-09-27T08:22:00Z"),
  ];

  it("says 'bu kümede haber yok' for a zone with no member", () => {
    const t = buildStoryTimeline(twoZones, null, health({}))!;
    expect(t.absentZones).toEqual(["bagimsiz"]);
    expect(t.degradedAbsentZones).toEqual([]);
    expect(t.zoneJoin.bagimsiz).toBeNull();
    expect(t.summary).toBe(
      "İlk: Sabah · 09:12 — Bağımsız kaynaklardan bu kümede haber yok — Muhalefet 2 sa 10 dk sonra katıldı",
    );
    expect(t.summary).not.toMatch(/yazmad/);
  });

  it("says the feed is broken when the absent zone is degraded", () => {
    const t = buildStoryTimeline(twoZones, null, health({ bagimsiz: true }))!;
    expect(t.degradedAbsentZones).toEqual(["bagimsiz"]);
    expect(t.summary).toContain("— Bağımsız kaynakların akışı şu an sorunlu");
    expect(t.summary).not.toContain("bu kümede haber yok");
  });

  it("uses the possessive form for pole zones", () => {
    const noMuhalefet = [
      member("Sabah", "pro_government", "2026-09-27T06:12:00Z"),
      member("Karar", "center", "2026-09-27T06:40:00Z"),
      member("BBC", "international", "2026-09-27T07:00:00Z"),
    ];
    expect(buildStoryTimeline(noMuhalefet, null, null)!.summary).toContain(
      "— Muhalefet kaynaklarından bu kümede haber yok",
    );
    expect(
      buildStoryTimeline(noMuhalefet, null, health({ muhalefet: true }))!.summary,
    ).toContain("— Muhalefet kaynaklarının akışı şu an sorunlu");
  });

  it("ignores a degraded zone that is present (health only explains absence)", () => {
    const t = buildStoryTimeline(BASE, null, health({ muhalefet: true }))!;
    expect(t.degradedAbsentZones).toEqual([]);
    expect(t.summary).not.toContain("sorunlu");
  });

  it("treats null health as not degraded (fail open)", () => {
    const t = buildStoryTimeline(twoZones, null, null)!;
    expect(t.degradedAbsentZones).toEqual([]);
  });

  it("counts a member with no valid time as zone coverage, not absence", () => {
    const undated = member("Karar", "center", "bad-date");
    const t = buildStoryTimeline([...twoZones, undated], null, null)!;
    expect(t.absentZones).toEqual([]);
    expect(t.zoneJoin.bagimsiz).toBeNull();
    expect(t.summary).not.toContain("Bağımsız");
  });
});

describe("timelineOffsetPct", () => {
  // The axis is the first→last span padded by 5% of the span on each side
  // (10% in total), so first sits at 0.05/1.1 = 4.545…% and last at 95.45…%.
  it("pads the axis so the first and last points never touch an edge", () => {
    expect(timelineOffsetPct(0, 0, 100)).toBeCloseTo(100 * (0.05 / 1.1), 6);
    expect(timelineOffsetPct(100, 0, 100)).toBeCloseTo(100 * (1.05 / 1.1), 6);
    expect(timelineOffsetPct(0, 0, 100)).toBeGreaterThan(0);
    expect(timelineOffsetPct(100, 0, 100)).toBeLessThan(100);
  });

  it("puts the midpoint at 50 and keeps the padding symmetric", () => {
    expect(timelineOffsetPct(50, 0, 100)).toBeCloseTo(50, 6);
    expect(timelineOffsetPct(0, 0, 100)).toBeCloseTo(100 - timelineOffsetPct(100, 0, 100), 6);
  });

  it("works on epoch-ms magnitudes (offset is translation-invariant)", () => {
    const first = Date.parse("2026-09-27T06:12:00Z");
    const last = Date.parse("2026-09-27T08:22:00Z");
    expect(timelineOffsetPct(first, first, last)).toBeCloseTo(timelineOffsetPct(0, 0, 130 * 60_000), 6);
    expect(timelineOffsetPct((first + last) / 2, first, last)).toBeCloseTo(50, 6);
  });

  it("returns 50 for a zero or negative span", () => {
    expect(timelineOffsetPct(5, 5, 5)).toBe(50);
    expect(timelineOffsetPct(5, 10, 0)).toBe(50);
  });

  it("returns 50 for any non-finite input", () => {
    expect(timelineOffsetPct(Number.NaN, 0, 100)).toBe(50);
    expect(timelineOffsetPct(50, Number.NaN, 100)).toBe(50);
    expect(timelineOffsetPct(50, 0, Number.NaN)).toBe(50);
    expect(timelineOffsetPct(Number.POSITIVE_INFINITY, 0, 100)).toBe(50);
    expect(timelineOffsetPct(50, 0, Number.POSITIVE_INFINITY)).toBe(50);
    expect(timelineOffsetPct(50, Number.NEGATIVE_INFINITY, 100)).toBe(50);
  });

  it("clamps a point outside the axis to the 0..100 range", () => {
    expect(timelineOffsetPct(1_000, 0, 100)).toBe(100);
    expect(timelineOffsetPct(-1_000, 0, 100)).toBe(0);
  });
});

describe("buildStoryTimeline — layout uses timelineOffsetPct", () => {
  it("places every point exactly where the helper says (axis = first→last)", () => {
    const t = buildStoryTimeline(BASE, null, null)!;
    const firstT = t.points[0].t;
    const lastT = t.points[t.points.length - 1].t;
    for (const p of t.points) {
      expect(p.offsetPct).toBe(timelineOffsetPct(p.t, firstT, lastT));
    }
  });

  it("pins the BASE offsets so a refactor of the axis math is caught", () => {
    const t = buildStoryTimeline(BASE, null, null)!;
    expect(t.points[0].offsetPct).toBeCloseTo(4.5454545, 5);
    expect(t.points[1].offsetPct).toBeCloseTo(((28 + 6.5) / 143) * 100, 5);
    expect(t.points[2].offsetPct).toBeCloseTo(95.4545454, 5);
  });

  it("centres every dot when all sources share one instant", () => {
    const ms = ["A", "B", "C"].map((n) => member(n, "pro_government", "2026-09-27T06:12:00Z"));
    const t = buildStoryTimeline(ms, null, null)!;
    expect(t.points.map((p) => p.offsetPct)).toEqual([50, 50, 50]);
  });
});

describe("buildStoryTimeline — default nonVoting is a no-op", () => {
  it("gives identical output with the argument omitted or an empty list", () => {
    const omitted = buildStoryTimeline(BASE, null, null);
    const empty = buildStoryTimeline(BASE, null, null, []);
    expect(empty).toEqual(omitted);
    expect(omitted!.summary).toBe(
      "İlk: Sabah · 09:12 — Bağımsız 28 dk sonra katıldı — Muhalefet 2 sa 10 dk sonra katıldı",
    );
    expect(omitted!.points.every((p) => p.voting)).toBe(true);
  });
});

describe("buildStoryTimeline — non-voting (toplayıcı / niş) members", () => {
  // 08:12 Istanbul: an hour before Sabah.
  const early = member("Haberler.com", "center", "2026-09-27T05:12:00Z");

  it("plots a non-voting member without changing the first mover or summary", () => {
    const base = buildStoryTimeline(BASE, null, null)!;
    const t = buildStoryTimeline(BASE, null, null, [early])!;
    expect(t.first).toEqual(base.first);
    expect(t.first.sourceName).toBe("Sabah");
    expect(t.summary).toBe(base.summary);
    expect(t.zoneJoin).toEqual(base.zoneJoin);
    expect(t.zoneFirsts).toEqual(base.zoneFirsts);
    expect(t.zoneLine).toBe(base.zoneLine);

    const nv = t.points.find((p) => p.sourceName === "Haberler.com")!;
    expect(nv.voting).toBe(false);
    expect(nv.zone).toBe("bagimsiz");
    expect(nv.offsetPct).toBeGreaterThanOrEqual(0);
    expect(nv.offsetPct).toBeLessThanOrEqual(100);
    expect(t.points.filter((p) => p.voting).map((p) => p.sourceName)).toEqual([
      "Sabah",
      "Karar",
      "Sözcü",
    ]);
  });

  it("lets non-voting points stretch the axis (min/max over ALL points)", () => {
    const base = buildStoryTimeline(BASE, null, null)!;
    const t = buildStoryTimeline(BASE, null, null, [early])!;
    const sabah = t.points.find((p) => p.sourceName === "Sabah")!;
    expect(sabah.offsetPct).toBeGreaterThan(5);
    expect(sabah.offsetPct).toBeGreaterThan(base.points[0].offsetPct);
    // The earliest point (non-voting) now owns the left padding.
    expect(t.points[0].sourceName).toBe("Haberler.com");
    expect(t.points[0].offsetPct).toBeCloseTo(4.5454545, 5);
    const firstT = t.points[0].t;
    const lastT = t.points[t.points.length - 1].t;
    for (const p of t.points) {
      expect(p.offsetPct).toBe(timelineOffsetPct(p.t, firstT, lastT));
    }
  });

  it("merges points by time, then by name (tr locale)", () => {
    const tie1 = member("Çarşı", "center", "2026-09-27T06:12:00Z");
    const tie2 = member("Abc", "center", "2026-09-27T06:12:00Z");
    const t = buildStoryTimeline(BASE, null, null, [tie1, tie2])!;
    expect(t.points.map((p) => p.sourceName)).toEqual(["Abc", "Çarşı", "Sabah", "Karar", "Sözcü"]);
    // Sabah (voting) is still the first mover; the niche ties don't make it a tie.
    expect(t.first.sourceName).toBe("Sabah");
    expect(t.first.tie).toBe(false);
    expect(t.first.tiedWith).toEqual([]);
  });

  it("returns null when the voting side has <3 sources, however many non-voting exist", () => {
    const twoVoting = BASE.slice(0, 2);
    const nonVoting = ["Agg1", "Agg2", "Agg3"].map((n, i) =>
      member(n, "center", `2026-09-27T06:${20 + i}:00Z`),
    );
    expect(buildStoryTimeline(twoVoting, null, null, nonVoting)).toBeNull();
  });

  it("never counts a non-voting member as zone coverage", () => {
    const twoZones = [
      member("Sabah", "pro_government", "2026-09-27T06:12:00Z"),
      member("A Haber", "pro_government", "2026-09-27T06:20:00Z"),
      member("Sözcü", "opposition_leaning", "2026-09-27T08:22:00Z"),
    ];
    const niche = member("Nişçi", "center", "2026-09-27T06:30:00Z");
    const t = buildStoryTimeline(twoZones, null, health({ bagimsiz: true }), [niche])!;
    expect(t.absentZones).toEqual(["bagimsiz"]);
    expect(t.degradedAbsentZones).toEqual(["bagimsiz"]);
    expect(t.zoneJoin.bagimsiz).toBeNull();
    expect(t.summary).toContain("— Bağımsız kaynakların akışı şu an sorunlu");
    expect(t.zoneFirsts.map((z) => z.zone)).toEqual(["iktidar", "muhalefet"]);
    expect(t.points.find((p) => p.sourceName === "Nişçi")?.voting).toBe(false);
  });

  it("never moves a zone's join time (an earlier non-voting zone member is ignored)", () => {
    const nicheOpposition = member("Niş Muhalefet", "opposition", "2026-09-27T06:50:00Z");
    const base = buildStoryTimeline(BASE, null, null)!;
    const t = buildStoryTimeline(BASE, null, null, [nicheOpposition])!;
    expect(t.zoneJoin).toEqual(base.zoneJoin);
    expect(t.summary).toBe(base.summary);
  });

  it("keeps one point per non-voting source (its earliest article)", () => {
    const a = member("Haberler.com", "center", "2026-09-27T07:00:00Z", {
      sourceId: "s-agg",
      title: "geç",
    });
    const b = member("Haberler.com", "center", "2026-09-27T06:30:00Z", {
      sourceId: "s-agg",
      title: "erken",
    });
    const t = buildStoryTimeline(BASE, null, null, [a, b])!;
    const agg = t.points.filter((p) => p.sourceName === "Haberler.com");
    expect(agg).toHaveLength(1);
    expect(agg[0].title).toBe("erken");
  });

  it("drops a non-voting member with no valid time and clamps a future pubDate to seenAt", () => {
    const broken = member("Bozuk Niş", "center", "not-a-date");
    const future = member("Gelecek Niş", "center", "2026-09-27T12:00:00Z", {
      articleId: "future",
    });
    const t = buildStoryTimeline(BASE, { future: "2026-09-27T06:30:00Z" }, null, [broken, future])!;
    expect(t.points.map((p) => p.sourceName)).not.toContain("Bozuk Niş");
    const f = t.points.find((p) => p.sourceName === "Gelecek Niş")!;
    expect(f.t).toBe(Date.parse("2026-09-27T06:30:00Z"));
  });

  it("only adds the day to clocks when the axis crosses Istanbul midnight", () => {
    const base = buildStoryTimeline(BASE, null, null)!;
    expect(base.crossesMidnight).toBe(false);
    // 23:30 on the 26th, Istanbul — the voting story itself is all on the 27th.
    const night = member("Gece Niş", "center", "2026-09-26T20:30:00Z");
    const t = buildStoryTimeline(BASE, null, null, [night])!;
    expect(t.crossesMidnight).toBe(true);
    expect(t.points[0].clock).toBe("26 Eyl 23:30");
    expect(t.points.find((p) => p.sourceName === "Sabah")?.clock).toBe("27 Eyl 09:12");
    // The voting-only summary and zone line are not touched by the niche source.
    expect(t.summary).toBe(base.summary);
    expect(t.zoneLine).toBe(base.zoneLine);
  });
});

describe("buildStoryTimeline — per-zone first-report list", () => {
  it("lists each zone's first voting report in join order (BASE)", () => {
    const t = buildStoryTimeline(BASE, null, null)!;
    expect(t.zoneFirsts).toEqual([
      { zone: "iktidar", label: "İktidar", clock: "09:12", lag: null },
      { zone: "bagimsiz", label: "Bağımsız", clock: "09:40", lag: "+28 dk" },
      { zone: "muhalefet", label: "Muhalefet", clock: "11:22", lag: "+2 sa 10 dk" },
    ]);
    expect(t.zoneLine).toBe(
      "İlk haber: İktidar 09:12 · Bağımsız +28 dk · Muhalefet +2 sa 10 dk",
    );
  });

  it("orders by join time, not spectrum order, and the earliest zone gets no lag", () => {
    const ms = [
      member("BirGün", "opposition", "2026-09-27T06:12:00Z"),
      member("Karar", "center", "2026-09-27T06:20:00Z"),
      member("Sabah", "pro_government", "2026-09-27T07:12:00Z"),
    ];
    const t = buildStoryTimeline(ms, null, null)!;
    expect(t.zoneFirsts.map((z) => [z.zone, z.lag])).toEqual([
      ["muhalefet", null],
      ["bagimsiz", "+8 dk"],
      ["iktidar", "+1 sa"],
    ]);
    expect(t.zoneLine).toBe("İlk haber: Muhalefet 09:12 · Bağımsız +8 dk · İktidar +1 sa");
  });

  it("uses a zone's FIRST report, not a later one from the same zone", () => {
    const ms = [
      member("Sabah", "pro_government", "2026-09-27T06:12:00Z"),
      member("A Haber", "pro_government", "2026-09-27T06:13:00Z"),
      member("Karar", "center", "2026-09-27T06:40:00Z"),
      member("Yeni Şafak", "pro_government", "2026-09-27T06:50:00Z"),
      member("Sözcü", "opposition_leaning", "2026-09-27T08:22:00Z"),
    ];
    const t = buildStoryTimeline(ms, null, null)!;
    expect(t.zoneFirsts.map((z) => z.zone)).toEqual(["iktidar", "bagimsiz", "muhalefet"]);
    expect(t.zoneFirsts[0].clock).toBe("09:12");
  });

  it("says 'aynı dakikada' for a zone that joined within 60 s", () => {
    const a = member("Sabah", "pro_government", "2026-09-27T06:12:00Z");
    const b = member("BirGün", "opposition", "2026-09-27T06:12:40Z");
    const c = member("Karar", "center", "2026-09-27T07:12:00Z");
    const t = buildStoryTimeline([a, b, c], null, null)!;
    expect(t.zoneFirsts.map((z) => z.lag)).toEqual([null, "aynı dakikada", "+1 sa"]);
    expect(t.zoneLine).toBe("İlk haber: İktidar 09:12 · Muhalefet aynı dakikada · Bağımsız +1 sa");
  });

  it("does not call exactly 60 s the same minute", () => {
    const a = member("Sabah", "pro_government", "2026-09-27T06:12:00Z");
    const b = member("BirGün", "opposition", "2026-09-27T06:13:00Z");
    const c = member("Karar", "center", "2026-09-27T07:12:00Z");
    const t = buildStoryTimeline([a, b, c], null, null)!;
    expect(t.zoneFirsts[1].lag).toBe("+1 dk");
  });

  it("omits a zone with no member at all", () => {
    const twoZones = [
      member("Sabah", "pro_government", "2026-09-27T06:12:00Z"),
      member("A Haber", "pro_government", "2026-09-27T06:20:00Z"),
      member("Sözcü", "opposition_leaning", "2026-09-27T08:22:00Z"),
    ];
    const t = buildStoryTimeline(twoZones, null, null)!;
    expect(t.zoneFirsts.map((z) => z.zone)).toEqual(["iktidar", "muhalefet"]);
    expect(t.zoneLine).toBe("İlk haber: İktidar 09:12 · Muhalefet +2 sa 10 dk");
    expect(t.zoneLine).not.toContain("Bağımsız");
  });

  it("omits a zone whose only member has no valid time", () => {
    const ms = [
      member("Sabah", "pro_government", "2026-09-27T06:12:00Z"),
      member("A Haber", "pro_government", "2026-09-27T06:30:00Z"),
      member("Sözcü", "opposition_leaning", "2026-09-27T08:22:00Z"),
      member("Karar", "center", "bad-date"),
    ];
    const t = buildStoryTimeline(ms, null, null)!;
    expect(t.absentZones).toEqual([]); // undated is still coverage...
    expect(t.zoneFirsts.map((z) => z.zone)).toEqual(["iktidar", "muhalefet"]); // ...but not placeable
  });

  it("carries the day on clocks when the voting story crosses midnight", () => {
    const a = member("Sabah", "pro_government", "2026-09-27T20:30:00Z"); // 27 Eyl 23:30
    const b = member("Karar", "center", "2026-09-27T20:50:00Z");
    const c = member("Sözcü", "opposition", "2026-09-27T21:20:00Z"); // 28 Eyl 00:20
    const t = buildStoryTimeline([a, b, c], null, null)!;
    expect(t.zoneFirsts[0].clock).toBe("27 Eyl 23:30");
    expect(t.zoneLine).toBe("İlk haber: İktidar 27 Eyl 23:30 · Bağımsız +20 dk · Muhalefet +50 dk");
  });
});

describe("clock formatting", () => {
  it("formats in Europe/Istanbul regardless of the host TZ", () => {
    expect(formatStoryClock(Date.parse("2026-09-27T06:12:00Z"), false)).toBe("09:12");
    expect(formatStoryClock(Date.parse("2026-01-15T21:05:00Z"), false)).toBe("00:05");
  });

  it("adds the day when the span crosses Istanbul midnight", () => {
    const a = member("Sabah", "pro_government", "2026-09-27T20:30:00Z"); // 23:30
    const b = member("Karar", "center", "2026-09-27T20:50:00Z"); // 23:50
    const c = member("Sözcü", "opposition", "2026-09-27T21:20:00Z"); // 00:20 next day
    const t = buildStoryTimeline([a, b, c], null, null)!;
    expect(t.crossesMidnight).toBe(true);
    expect(t.summary.startsWith("İlk: Sabah · 27 Eyl 23:30")).toBe(true);
    expect(t.points[2].clock).toBe("28 Eyl 00:20");
  });

  it("keeps the short clock when a UTC-midnight crossing is not an Istanbul one", () => {
    const a = member("Sabah", "pro_government", "2026-09-27T23:30:00Z"); // 02:30
    const b = member("Karar", "center", "2026-09-28T00:10:00Z"); // 03:10
    const c = member("Sözcü", "opposition", "2026-09-28T00:20:00Z"); // 03:20
    const t = buildStoryTimeline([a, b, c], null, null)!;
    expect(t.crossesMidnight).toBe(false);
    expect(t.points.map((p) => p.clock)).toEqual(["02:30", "03:10", "03:20"]);
  });
});

describe("formatLag boundaries", () => {
  it.each([
    [0, "<1 dk"],
    [59_000, "<1 dk"],
    [60_000, "1 dk"],
    [59 * 60_000, "59 dk"],
    [60 * 60_000, "1 sa"],
    [130 * 60_000, "2 sa 10 dk"],
    [(23 * 60 + 59) * 60_000, "23 sa 59 dk"],
    [24 * 3_600_000, "1 gün"],
    [25 * 3_600_000, "1 gün"],
    [49 * 3_600_000, "2 gün"],
  ])("formatLag(%i) = %s", (ms, expected) => {
    expect(formatLag(ms)).toBe(expected);
  });
});

describe("helpers", () => {
  it("timelineMembersFrom maps ClusterDetailMember rows", () => {
    const rows = timelineMembersFrom([
      {
        source: {
          id: "s1",
          name: "Sabah",
          slug: "sabah",
          url: "https://sabah.com.tr",
          rss_url: "https://sabah.com.tr/rss",
          bias: "pro_government",
          logo_url: null,
          active: true,
          trustee_since: null,
          trustee_note: null,
        },
        article: {
          id: "a1",
          title: "Başlık",
          url: "https://sabah.com.tr/x",
          published_at: "2026-09-27T06:12:00Z",
          image_url: null,
          content_hash: null,
        },
      },
    ]);
    expect(rows).toEqual([
      {
        articleId: "a1",
        sourceId: "s1",
        sourceName: "Sabah",
        bias: "pro_government",
        title: "Başlık",
        url: "https://sabah.com.tr/x",
        publishedAt: "2026-09-27T06:12:00Z",
      },
    ]);
  });

  it("votingSourceCount and missingZones", () => {
    expect(votingSourceCount(BASE)).toBe(3);
    expect(missingZones(BASE)).toEqual([]);
    expect(missingZones(BASE.slice(0, 1))).toEqual(["bagimsiz", "muhalefet"]);
  });
});
