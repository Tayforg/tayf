import { describe, it, expect } from "vitest";

import type { ZoneFeedHealth, ZoneHealth } from "@/lib/clusters/feed-health";
import type { BiasCategory } from "@/types";

import {
  buildStoryTimeline,
  formatLag,
  formatStoryClock,
  missingZones,
  timelineMembersFrom,
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
