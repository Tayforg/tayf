import { describe, it, expect } from "vitest";

import { pickOtherSide } from "./read-across";
import type { Source } from "@/types";

// Fixture shape mirrors framing.test.ts's mkSource/mkMember helpers.

function mkSource(id: string, bias: Source["bias"]): Source {
  return {
    id,
    name: `Source ${id}`,
    slug: `source-${id}`,
    url: `https://example.com/${id}`,
    rss_url: `https://example.com/${id}/rss`,
    bias,
    logo_url: null,
    active: true,
  } as Source;
}

function mkMember(id: string, bias: Source["bias"], publishedAt: string, title = `Headline ${id}`) {
  return {
    source: mkSource(id, bias),
    article: {
      id: `a-${id}`,
      title,
      url: `https://example.com/${id}/article`,
      published_at: publishedAt,
      image_url: null,
    },
  };
}

describe("pickOtherSide", () => {
  it("picks the pole with fewer members", () => {
    const result = pickOtherSide([
      mkMember("gov1", "pro_government", "2026-07-01T10:00:00Z"),
      mkMember("gov2", "pro_government", "2026-07-01T09:00:00Z"),
      mkMember("gov3", "pro_government", "2026-07-01T08:00:00Z"),
      mkMember("opp1", "opposition", "2026-07-01T11:00:00Z"),
    ]);
    expect(result.zone).toBe("muhalefet");
    expect(result.member?.source.id).toBe("opp1");
  });

  it("on a tie, sends the reader to muhalefet", () => {
    const result = pickOtherSide([
      mkMember("gov1", "pro_government", "2026-07-01T10:00:00Z"),
      mkMember("gov2", "pro_government", "2026-07-01T09:00:00Z"),
      mkMember("opp1", "opposition", "2026-07-01T11:00:00Z"),
      mkMember("opp2", "opposition", "2026-07-01T08:00:00Z"),
    ]);
    expect(result.zone).toBe("muhalefet");
  });

  it("on a tie with a dominant bagimsiz, also sends the reader to muhalefet", () => {
    const result = pickOtherSide([
      mkMember("gov1", "pro_government", "2026-07-01T10:00:00Z"),
      mkMember("opp1", "opposition", "2026-07-01T11:00:00Z"),
      mkMember("ctr1", "center", "2026-07-01T09:00:00Z"),
      mkMember("ctr2", "center", "2026-07-01T08:00:00Z"),
      mkMember("ctr3", "international", "2026-07-01T07:00:00Z"),
    ]);
    expect(result.zone).toBe("muhalefet");
  });

  it("picks the fewer pole even when bagimsiz dominates the whole cluster", () => {
    const result = pickOtherSide([
      mkMember("gov1", "pro_government", "2026-07-01T10:00:00Z"),
      mkMember("opp1", "opposition", "2026-07-01T11:00:00Z"),
      mkMember("opp2", "opposition", "2026-07-01T09:30:00Z"),
      mkMember("ctr1", "center", "2026-07-01T09:00:00Z"),
      mkMember("ctr2", "center", "2026-07-01T08:30:00Z"),
      mkMember("ctr3", "center", "2026-07-01T08:00:00Z"),
      mkMember("ctr4", "international", "2026-07-01T07:30:00Z"),
      mkMember("ctr5", "international", "2026-07-01T07:00:00Z"),
    ]);
    expect(result.zone).toBe("iktidar");
    expect(result.member?.source.id).toBe("gov1");
  });

  it("returns a null member when the picked pole has zero coverage", () => {
    const result = pickOtherSide([
      mkMember("gov1", "pro_government", "2026-07-01T10:00:00Z"),
      mkMember("gov2", "pro_government", "2026-07-01T09:00:00Z"),
    ]);
    expect(result.zone).toBe("muhalefet");
    expect(result.member).toBeNull();
  });

  it("returns muhalefet with a null member and all-zero counts for an empty cluster", () => {
    const result = pickOtherSide([]);
    expect(result.zone).toBe("muhalefet");
    expect(result.member).toBeNull();
    expect(result.counts).toEqual({ iktidar: 0, bagimsiz: 0, muhalefet: 0 });
  });

  it("never picks a member with an unparseable published_at over a parseable one", () => {
    const result = pickOtherSide([
      mkMember("gov1", "pro_government", "2026-07-01T10:00:00Z"),
      mkMember("gov2", "pro_government", "2026-07-01T09:00:00Z"),
      mkMember("gov3", "pro_government", "2026-07-01T08:00:00Z"),
      mkMember("opp_bad", "opposition", "not-a-date"),
      mkMember("opp_ok", "opposition", "2026-07-01T09:30:00Z"),
    ]);
    expect(result.zone).toBe("muhalefet");
    expect(result.member?.source.id).toBe("opp_ok");
  });

  it("picks the newest article in the chosen pole", () => {
    const result = pickOtherSide([
      mkMember("gov1", "pro_government", "2026-07-01T10:00:00Z"),
      mkMember("gov2", "pro_government", "2026-07-01T09:00:00Z"),
      mkMember("gov3", "pro_government", "2026-07-01T08:00:00Z"),
      mkMember("opp_old", "opposition", "2026-07-01T08:30:00Z"),
      mkMember("opp_new", "opposition", "2026-07-01T12:00:00Z"),
      mkMember("opp_mid", "opposition", "2026-07-01T09:30:00Z"),
    ]);
    expect(result.zone).toBe("muhalefet");
    expect(result.member?.source.id).toBe("opp_new");
  });
});

// h138-roadmap2-3: the CTA took the newest member of the chosen pole with no
// content check, so it could send the reader to an SEO biography ("... kimdir,
// kaç yaşında, nereli?") instead of that side's coverage. Only the member within
// the chosen pole changes: pole choice and counts stay exactly as before.
describe("pickOtherSide skips explainer titles within the chosen pole (h138-roadmap2-3)", () => {
  const KIMDIR = "Şahap Kavcıoğlu kimdir, kaç yaşında, nereli? Hangi görevlerde bulundu?";
  const REPORT = "Fon iddiaları gündem olmuştu! BDDK Başkanı Şahap Kavcıoğlu, istifa etti";

  // Three iktidar members make muhalefet the minority pole under test.
  const gov = () => [
    mkMember("gov1", "pro_government", "2026-07-01T10:00:00Z"),
    mkMember("gov2", "pro_government", "2026-07-01T09:00:00Z"),
    mkMember("gov3", "pro_government", "2026-07-01T08:00:00Z"),
  ];

  it("(a) returns the older real report when the newest member of the pole is an explainer, with the same zone and counts", () => {
    const result = pickOtherSide([
      ...gov(),
      mkMember("opp_new", "opposition", "2026-07-01T12:00:00Z", KIMDIR),
      mkMember("opp_old", "opposition", "2026-07-01T09:30:00Z", REPORT),
    ]);
    expect(result.zone).toBe("muhalefet");
    expect(result.member?.source.id).toBe("opp_old");
    expect(result.member?.article.title).toBe(REPORT);
    expect(result.counts).toEqual({ iktidar: 3, bagimsiz: 0, muhalefet: 2 });
  });

  it.each([
    ["a biyografisi title", "Mehmet Şimşek biyografisi: hayatı ve kariyeri"],
    ["a short kimdir? title", "Ali Koç kimdir?"],
    ["a nedir? title", "Asgari ücret nedir?"],
    ["an upper-case KİMDİR title", "ALİ KOÇ KİMDİR?"],
  ])("(b) skips %s the same way", (_label, explainer) => {
    const result = pickOtherSide([
      ...gov(),
      mkMember("opp_new", "opposition", "2026-07-01T12:00:00Z", explainer),
      mkMember("opp_old", "opposition", "2026-07-01T09:30:00Z", REPORT),
    ]);
    expect(result.zone).toBe("muhalefet");
    expect(result.member?.source.id).toBe("opp_old");
    expect(result.counts).toEqual({ iktidar: 3, bagimsiz: 0, muhalefet: 2 });
  });

  it("skips several newer explainers and takes the newest non-explainer", () => {
    const result = pickOtherSide([
      ...gov(),
      mkMember("opp_a", "opposition", "2026-07-01T12:00:00Z", KIMDIR),
      mkMember("opp_b", "opposition", "2026-07-01T11:00:00Z", "Ali Koç kimdir?"),
      mkMember("opp_c", "opposition", "2026-07-01T10:00:00Z", REPORT),
    ]);
    expect(result.zone).toBe("muhalefet");
    expect(result.member?.source.id).toBe("opp_c");
    expect(result.counts.muhalefet).toBe(3);
  });

  it("(c) falls back to today's pick, the newest member, when every member of the pole is an explainer", () => {
    const result = pickOtherSide([
      ...gov(),
      mkMember("opp_new", "opposition", "2026-07-01T12:00:00Z", KIMDIR),
      mkMember("opp_old", "opposition", "2026-07-01T09:30:00Z", "Ali Koç kimdir?"),
    ]);
    expect(result.zone).toBe("muhalefet");
    expect(result.member?.source.id).toBe("opp_new");
    expect(result.counts).toEqual({ iktidar: 3, bagimsiz: 0, muhalefet: 2 });
  });

  it("does not move the pole choice when the fewer pole holds only explainers", () => {
    const result = pickOtherSide([
      mkMember("gov1", "pro_government", "2026-07-01T10:00:00Z", KIMDIR),
      mkMember("opp1", "opposition", "2026-07-01T11:00:00Z", REPORT),
      mkMember("opp2", "opposition", "2026-07-01T09:30:00Z", "Haber 2"),
    ]);
    expect(result.zone).toBe("iktidar");
    expect(result.member?.source.id).toBe("gov1");
    expect(result.counts).toEqual({ iktidar: 1, bagimsiz: 0, muhalefet: 2 });
  });

  it("(d) still returns a null member and the same zone when the chosen pole is empty", () => {
    const result = pickOtherSide([
      mkMember("gov1", "pro_government", "2026-07-01T10:00:00Z", KIMDIR),
      mkMember("gov2", "pro_government", "2026-07-01T09:00:00Z"),
      mkMember("gov3", "pro_government", "2026-07-01T08:00:00Z"),
    ]);
    expect(result.zone).toBe("muhalefet");
    expect(result.member).toBeNull();
    expect(result.counts).toEqual({ iktidar: 3, bagimsiz: 0, muhalefet: 0 });
  });

  it("(e) keeps the newest when its title is a live report, not an explainer ('Canlıya bağlandı')", () => {
    const result = pickOtherSide([
      ...gov(),
      mkMember("opp_new", "opposition", "2026-07-01T12:00:00Z", "Canlıya bağlandı: Özgür Özel Meclis'te konuştu"),
      mkMember("opp_old", "opposition", "2026-07-01T09:30:00Z", REPORT),
    ]);
    expect(result.member?.source.id).toBe("opp_new");
  });

  it("(f) reports counts identical to the unfiltered grouping in every case", () => {
    const cases = [
      [mkMember("opp_new", "opposition", "2026-07-01T12:00:00Z", KIMDIR), mkMember("opp_old", "opposition", "2026-07-01T09:30:00Z", REPORT)],
      [mkMember("opp_new", "opposition", "2026-07-01T12:00:00Z", KIMDIR)],
      [mkMember("opp_new", "opposition", "2026-07-01T12:00:00Z", REPORT), mkMember("ctr1", "center", "2026-07-01T08:00:00Z", "Ali Koç kimdir?")],
    ];
    for (const extra of cases) {
      const result = pickOtherSide([...gov(), ...extra]);
      expect(result.counts).toEqual({
        iktidar: 3,
        bagimsiz: extra.filter((m) => m.source.bias === "center").length,
        muhalefet: extra.filter((m) => m.source.bias === "opposition").length,
      });
    }
  });

  it("treats a missing or non-string title as not an explainer and never throws", () => {
    const noTitle = mkMember("opp_new", "opposition", "2026-07-01T12:00:00Z");
    (noTitle.article as { title: unknown }).title = undefined;
    const result = pickOtherSide([
      ...gov(),
      noTitle,
      mkMember("opp_old", "opposition", "2026-07-01T09:30:00Z", REPORT),
    ]);
    expect(result.member?.source.id).toBe("opp_new");
  });
});
