import { describe, it, expect } from "vitest";

import { groupMembersByZone } from "./framing";
import type { Source } from "@/types";

// Grouping helper behind the "Aynı Haber, Farklı Dünyalar" framing
// comparison: buckets cluster members into the three Medya DNA zones and
// sorts each bucket newest-first so the freshest headline of each world
// leads its column.

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

function mkMember(
  id: string,
  bias: Source["bias"],
  publishedAt: string,
) {
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

describe("groupMembersByZone", () => {
  it("buckets members into their Medya DNA zones", () => {
    const grouped = groupMembersByZone([
      mkMember("gov", "pro_government", "2026-07-01T10:00:00Z"),
      mkMember("nat", "nationalist", "2026-07-01T10:00:00Z"),
      mkMember("ctr", "center", "2026-07-01T10:00:00Z"),
      mkMember("opp", "opposition", "2026-07-01T10:00:00Z"),
    ]);

    expect(grouped.iktidar.map((m) => m.source.id)).toEqual(
      expect.arrayContaining(["gov", "nat"]),
    );
    expect(grouped.bagimsiz.map((m) => m.source.id)).toEqual(["ctr"]);
    expect(grouped.muhalefet.map((m) => m.source.id)).toEqual(["opp"]);
  });

  it("sorts each zone newest-first", () => {
    const grouped = groupMembersByZone([
      mkMember("old", "opposition", "2026-07-01T08:00:00Z"),
      mkMember("new", "opposition_leaning", "2026-07-01T12:00:00Z"),
      mkMember("mid", "opposition", "2026-07-01T10:00:00Z"),
    ]);

    expect(grouped.muhalefet.map((m) => m.source.id)).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });

  it("always returns all three zones, empty ones as empty arrays", () => {
    const grouped = groupMembersByZone([
      mkMember("gov", "gov_leaning", "2026-07-01T10:00:00Z"),
    ]);

    expect(grouped.iktidar).toHaveLength(1);
    expect(grouped.bagimsiz).toEqual([]);
    expect(grouped.muhalefet).toEqual([]);
  });

  it("keeps a stable order for unparseable timestamps (sorted last)", () => {
    const grouped = groupMembersByZone([
      mkMember("bad", "center", "not-a-date"),
      mkMember("good", "international", "2026-07-01T10:00:00Z"),
    ]);

    expect(grouped.bagimsiz.map((m) => m.source.id)).toEqual(["good", "bad"]);
  });
});
