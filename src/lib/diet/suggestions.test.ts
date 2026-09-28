import { describe, it, expect } from "vitest";
import { pickZoneSuggestions } from "./suggestions";
import type { ClusterBundle } from "@/lib/clusters/politics-query";
import type { BiasDistribution } from "@/types";

function emptyDist(): BiasDistribution {
  return {
    pro_government: 0,
    gov_leaning: 0,
    state_media: 0,
    islamist_conservative: 0,
    center: 0,
    international: 0,
    pro_kurdish: 0,
    opposition_leaning: 0,
    opposition: 0,
    nationalist: 0,
  };
}

function bundle(id: string, title: string, dist: Partial<BiasDistribution>): ClusterBundle {
  return {
    cluster: {
      id,
      title_tr: title,
      summary_tr: "",
      bias_distribution: { ...emptyDist(), ...dist },
      is_blindspot: false,
      blindspot_side: null,
      article_count: 0,
      first_published: "2026-09-28T00:00:00Z",
      updated_at: "2026-09-28T00:00:00Z",
    },
    articles: [],
    sources: [],
  };
}

describe("pickZoneSuggestions", () => {
  it("excludes a bundle below the multi-source floor (total 2)", () => {
    const bundles = [bundle("a", "Below floor", { pro_government: 2 })];
    const result = pickZoneSuggestions(bundles);
    expect(result.iktidar).toEqual([]);
  });

  it("includes a bundle at the multi-source floor (total 3) with strong zone presence", () => {
    const bundles = [bundle("a", "At floor", { pro_government: 2, opposition: 1 })];
    const result = pickZoneSuggestions(bundles);
    expect(result.iktidar.map((s) => s.id)).toEqual(["a"]);
  });

  it("orders strong candidates by zone vote share, not raw count", () => {
    // b: 2/3 share for iktidar (higher share, later rank)
    // a: 2/4 share for iktidar (lower share, earlier rank)
    const bundles = [
      bundle("a", "Low share", { pro_government: 2, opposition: 1, center: 1 }),
      bundle("b", "High share", { pro_government: 2, opposition: 1 }),
    ];
    const result = pickZoneSuggestions(bundles);
    expect(result.iktidar.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("ties in share fall back to input (home-rank) order", () => {
    const bundles = [
      bundle("first", "First", { pro_government: 2, opposition: 1 }),
      bundle("second", "Second", { pro_government: 2, opposition: 1 }),
    ];
    const result = pickZoneSuggestions(bundles);
    expect(result.iktidar.map((s) => s.id)).toEqual(["first", "second"]);
  });

  it("fills up to 3 with weak (count>=1) presence when strong candidates run short", () => {
    const bundles = [
      bundle("strong", "Strong", { pro_government: 3, opposition: 1 }),
      bundle("weak1", "Weak one", { pro_government: 1, opposition: 1, center: 1 }),
      bundle("weak2", "Weak two", { pro_government: 1, opposition: 1, center: 1 }),
      bundle("none", "No iktidar", { opposition: 2, center: 1 }),
    ];
    const result = pickZoneSuggestions(bundles);
    expect(result.iktidar.map((s) => s.id)).toEqual(["strong", "weak1", "weak2"]);
  });

  it("caps each zone's list at 3", () => {
    const bundles = Array.from({ length: 5 }, (_, i) =>
      bundle(`c${i}`, `Cluster ${i}`, { pro_government: 2, opposition: 1 }),
    );
    const result = pickZoneSuggestions(bundles);
    expect(result.iktidar).toHaveLength(3);
  });

  it("never lists the same cluster twice within a zone", () => {
    const bundles = [bundle("a", "Only one", { pro_government: 2, opposition: 1 })];
    const result = pickZoneSuggestions(bundles);
    const ids = result.iktidar.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns an empty list for a zone with no eligible bundles", () => {
    const bundles = [bundle("a", "No muhalefet presence", { pro_government: 2, center: 1 })];
    const result = pickZoneSuggestions(bundles);
    expect(result.muhalefet).toEqual([]);
  });

  it("returns empty lists for every zone given no bundles", () => {
    const result = pickZoneSuggestions([]);
    expect(result).toEqual({ iktidar: [], bagimsiz: [], muhalefet: [] });
  });

  it("reports zoneCount and totalCount from the tally", () => {
    const bundles = [bundle("a", "Tallied", { pro_government: 2, opposition: 1 })];
    const result = pickZoneSuggestions(bundles);
    expect(result.iktidar[0]).toMatchObject({ id: "a", title: "Tallied", zoneCount: 2, totalCount: 3 });
  });
});
