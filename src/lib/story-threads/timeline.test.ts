import { describe, it, expect } from "vitest";

import { buildThreadTimeline, type ThreadMemberCluster } from "./timeline";

function member(over: Partial<ThreadMemberCluster> & { id: string }): ThreadMemberCluster {
  return {
    title_tr: "Başlık " + over.id,
    title_tr_neutral: null,
    first_published: "2026-09-01T10:00:00Z",
    article_count: 3,
    bias_distribution: null,
    ...over,
  };
}

describe("buildThreadTimeline", () => {
  it("returns dayCount 0 for an empty list", () => {
    const t = buildThreadTimeline([]);
    expect(t.dayCount).toBe(0);
    expect(t.clusterCount).toBe(0);
    expect(t.days).toEqual([]);
  });

  it("buckets by Europe/Istanbul day (23:30 UTC on the 1st is the 2nd)", () => {
    const t = buildThreadTimeline([
      member({ id: "a", first_published: "2026-09-01T23:30:00Z" }),
      member({ id: "b", first_published: "2026-09-01T20:30:00Z" }),
    ]);
    expect(t.days.map((d) => d.key)).toEqual(["2026-09-01", "2026-09-02"]);
    expect(t.days[1]!.clusters.map((c) => c.id)).toEqual(["a"]);
  });

  it("orders days ascending and clusters within a day by first_published", () => {
    const t = buildThreadTimeline([
      member({ id: "late", first_published: "2026-09-03T12:00:00Z" }),
      member({ id: "d1b", first_published: "2026-09-01T12:00:00Z" }),
      member({ id: "d1a", first_published: "2026-09-01T08:00:00Z" }),
    ]);
    expect(t.days.map((d) => d.key)).toEqual(["2026-09-01", "2026-09-03"]);
    expect(t.days[0]!.clusters.map((c) => c.id)).toEqual(["d1a", "d1b"]);
    expect(t.clusterCount).toBe(3);
    expect(t.dayCount).toBe(2);
    expect(t.firstLabel).toBe(t.days[0]!.label);
    expect(t.lastLabel).toBe(t.days[1]!.label);
  });

  it("labels days in tr-TR with weekday and long month", () => {
    const t = buildThreadTimeline([member({ id: "a", first_published: "2026-09-01T10:00:00Z" })]);
    expect(t.days[0]!.label).toContain("Eylül");
    expect(t.days[0]!.label).toContain("Salı");
  });

  it("prefers the neutral title unless blank", () => {
    const t = buildThreadTimeline([
      member({ id: "a", title_tr: "Orijinal", title_tr_neutral: "  Nötr  " }),
      member({ id: "b", title_tr: "Orijinal B", title_tr_neutral: "   ", first_published: "2026-09-01T11:00:00Z" }),
      member({ id: "c", title_tr: "Orijinal C", title_tr_neutral: null, first_published: "2026-09-01T12:00:00Z" }),
    ]);
    expect(t.days[0]!.clusters.map((c) => c.title)).toEqual(["Nötr", "Orijinal B", "Orijinal C"]);
  });

  it("sums distributions and ignores garbage keys and values", () => {
    const t = buildThreadTimeline([
      member({ id: "a", bias_distribution: { opposition: 2, center: 1, bogus: 9 } as never }),
      member({
        id: "b",
        first_published: "2026-09-01T11:00:00Z",
        bias_distribution: { opposition: 1, center: -3, pro_government: 1.5, nationalist: "4", state_media: null } as never,
      }),
      member({ id: "c", first_published: "2026-09-01T12:00:00Z", bias_distribution: "junk" as never }),
    ]);
    const d = t.days[0]!;
    expect(d.distribution.opposition).toBe(3);
    expect(d.distribution.center).toBe(1);
    expect(d.distribution.pro_government).toBe(0);
    expect(d.distribution.nationalist).toBe(0);
    expect(d.distribution.state_media).toBe(0);
    expect("bogus" in d.distribution).toBe(false);
    expect(d.sourceTotal).toBe(4);
  });

  it("skips members with an unparseable first_published", () => {
    const t = buildThreadTimeline([
      member({ id: "a", first_published: "not a date" }),
      member({ id: "b" }),
    ]);
    expect(t.clusterCount).toBe(1);
  });
});
