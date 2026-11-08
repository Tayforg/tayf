import { describe, expect, it } from "vitest";

import {
  BIAS_KEYS,
  BLINDSPOT,
} from "../../../supabase/functions/_shared/cluster/blindspot";
import {
  distributionsEqual,
  holdsBlindspotRule,
  votingDistribution,
} from "./voting-recount";

type M = { source: { bias?: string | null; kind?: string | null } };

const m = (bias: string | null | undefined, kind?: string | null): M => ({
  source: { bias, kind },
});

const many = (n: number, bias: string, kind = "outlet"): M[] =>
  Array.from({ length: n }, () => m(bias, kind));

describe("votingDistribution", () => {
  it("returns all ten keys at zero for an empty list", () => {
    const d = votingDistribution([]);
    expect(Object.keys(d)).toEqual([...BIAS_KEYS]);
    expect(Object.values(d).every((n) => n === 0)).toBe(true);
  });

  it("does not count aggregator or niche members (the 861b4249 shape)", () => {
    const d = votingDistribution([
      m("gov_leaning", "aggregator"),
      ...many(4, "center"),
      m("opposition", "niche"),
    ]);
    expect(d.center).toBe(4);
    expect(d.gov_leaning).toBe(0);
    expect(d.opposition).toBe(0);
  });

  it("counts outlet and wire members", () => {
    const d = votingDistribution([
      m("pro_government", "wire"),
      m("pro_government", "outlet"),
      m("opposition", "wire"),
    ]);
    expect(d.pro_government).toBe(2);
    expect(d.opposition).toBe(1);
  });

  it("counts one vote per article, so a repeated source votes twice (migration 034)", () => {
    // recompute_bias_distribution joins cluster_articles -> articles -> sources
    // with no distinct: two articles of one outlet are two votes.
    const d = votingDistribution([m("center", "outlet"), m("center", "outlet")]);
    expect(d.center).toBe(2);
  });

  it("lets a member without a kind vote, like the column default", () => {
    const d = votingDistribution([m("center"), m("center", null), m("center", "not-a-kind")]);
    expect(d.center).toBe(3);
  });

  it("ignores null, undefined and unknown bias values without polluting the result", () => {
    const d = votingDistribution([
      m(null),
      m(undefined),
      m("independent"),
      m("__proto__"),
      m("constructor"),
      m("center"),
    ]);
    expect(Object.keys(d)).toEqual([...BIAS_KEYS]);
    expect(d.center).toBe(1);
    expect(Object.values(d).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("is pure: the same input gives equal output and does not share state between calls", () => {
    const input = [m("center"), m("opposition")];
    const a = votingDistribution(input);
    a.center = 99;
    const b = votingDistribution(input);
    expect(b.center).toBe(1);
  });

  it("handles a large member list", () => {
    const d = votingDistribution(many(20_000, "nationalist"));
    expect(d.nationalist).toBe(20_000);
  });
});

describe("distributionsEqual", () => {
  it("is true for equal counts and false when any key differs", () => {
    const a = votingDistribution([m("center"), m("opposition")]);
    const b = votingDistribution([m("opposition"), m("center")]);
    expect(distributionsEqual(a, b)).toBe(true);
    expect(distributionsEqual(a, votingDistribution([m("center")]))).toBe(false);
    expect(
      distributionsEqual(a, votingDistribution([m("center"), m("pro_kurdish")])),
    ).toBe(false);
  });
});

describe("holdsBlindspotRule", () => {
  it("fails below BLINDSPOT.minSources voting members even when one zone owns all", () => {
    const d = votingDistribution(many(BLINDSPOT.minSources - 1, "center"));
    expect(holdsBlindspotRule(d)).toBe(false);
  });

  it("holds at exactly minSources in one zone", () => {
    const d = votingDistribution(many(BLINDSPOT.minSources, "center"));
    expect(holdsBlindspotRule(d)).toBe(true);
  });

  it("holds at exactly the dominant share (4 of 5) and fails just under it (3 of 5)", () => {
    const four = votingDistribution([...many(3, "center"), m("pro_kurdish"), m("opposition")]);
    // center + pro_kurdish are both bagimsiz: 4 of 5 = 0.8.
    expect(holdsBlindspotRule(four)).toBe(true);
    const three = votingDistribution([...many(3, "center"), m("opposition"), m("pro_government")]);
    expect(holdsBlindspotRule(three)).toBe(false);
  });

  it("measures the share by zone, not by category", () => {
    // 5 categories in the iktidar zone, no single category above 1.
    const d = votingDistribution([
      m("pro_government"),
      m("gov_leaning"),
      m("state_media"),
      m("islamist_conservative"),
      m("nationalist"),
    ]);
    expect(holdsBlindspotRule(d)).toBe(true);
  });

  it("is false for an empty distribution and for an even split", () => {
    expect(holdsBlindspotRule(votingDistribution([]))).toBe(false);
    expect(
      holdsBlindspotRule(
        votingDistribution([...many(3, "pro_government"), ...many(3, "opposition")]),
      ),
    ).toBe(false);
  });

  it("does not count a non-voting member toward the minimum (861b4249 recount)", () => {
    const stored = votingDistribution([...many(4, "center"), m("gov_leaning")]);
    expect(holdsBlindspotRule(stored)).toBe(true); // what the legacy row claimed
    const recount = votingDistribution([...many(4, "center"), m("gov_leaning", "aggregator")]);
    expect(holdsBlindspotRule(recount)).toBe(false);
  });
});
