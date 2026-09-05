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

function mkMember(id: string, bias: Source["bias"], publishedAt: string) {
  return {
    source: mkSource(id, bias),
    article: {
      id: `a-${id}`,
      title: `Headline ${id}`,
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
