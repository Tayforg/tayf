import { describe, it, expect } from "vitest";

import {
  BLINDSPOT,
  detectBlindspot,
  MIN_BLINDSPOT_SOURCES,
  tallyZones,
  type BiasKey,
} from "../../../supabase/functions/_shared/cluster/blindspot";

// ---------------------------------------------------------------------------
// Zone-based blindspot detection, contract rule (BLINDSPOT in
// supabase/functions/_shared/cluster/blindspot.ts): a single zone must own
// >= BLINDSPOT.dominantShare (80%) of at least BLINDSPOT.minSources (5)
// distinct sources. Measured on production (540 clusters / 14 days): a
// strict single-zone rule flagged 2 clusters in 14 days; >= 80% flagged 22.
// The cluster-consumer's duplicate-source guard ensures each member has a
// unique source, so the distribution's total count IS the distinct-source
// count.
// ---------------------------------------------------------------------------

function dist(partial: Partial<Record<BiasKey, number>>): Record<BiasKey, number> {
  return {
    pro_government: 0,
    gov_leaning: 0,
    state_media: 0,
    center: 0,
    opposition_leaning: 0,
    opposition: 0,
    nationalist: 0,
    islamist_conservative: 0,
    pro_kurdish: 0,
    international: 0,
    ...partial,
  };
}

describe("detectBlindspot (zone-based, >=80% share, min-source floor)", () => {
  it("exports a floor of 5 distinct sources, taken from BLINDSPOT.minSources", () => {
    expect(MIN_BLINDSPOT_SOURCES).toBe(5);
    expect(MIN_BLINDSPOT_SOURCES).toBe(BLINDSPOT.minSources);
  });

  it("does NOT flag a single-article cluster (below the source floor)", () => {
    const result = detectBlindspot(dist({ pro_government: 1 }));
    expect(result.is_blindspot).toBe(false);
    expect(result.blindspot_side).toBeNull();
  });

  it("does NOT flag a single-category cluster below the source floor", () => {
    const result = detectBlindspot(dist({ opposition: 4 }));
    expect(result.is_blindspot).toBe(false);
  });

  it("flags at >=5 sources with a >=80% share (4-of-5 = 80%)", () => {
    const result = detectBlindspot(
      dist({ pro_government: 4, opposition: 1 }),
    );
    expect(result.is_blindspot).toBe(true);
    expect(result.blindspot_side).toBe("pro_government");
  });

  it("does NOT flag 3-of-5 (60% share)", () => {
    const result = detectBlindspot(
      dist({ pro_government: 3, opposition: 2 }),
    );
    expect(result.is_blindspot).toBe(false);
    expect(result.blindspot_side).toBeNull();
  });

  it("flags a multi-category cluster at 100% one zone (five sources)", () => {
    // pro_government + gov_leaning + state_media are three different
    // categories but all iktidar zone.
    const result = detectBlindspot(
      dist({ pro_government: 2, gov_leaning: 2, state_media: 1 }),
    );
    expect(result.is_blindspot).toBe(true);
  });

  it("blindspot_side is the largest category INSIDE the dominant zone, ties by BIAS_KEYS order", () => {
    // pro_government 2 + gov_leaning 2 + opposition 1 → dominant zone
    // iktidar at 80%; pro_government and gov_leaning tie at 2 each inside
    // it, so BIAS_KEYS order (pro_government before gov_leaning) decides.
    const result = detectBlindspot(
      dist({ pro_government: 2, gov_leaning: 2, opposition: 1 }),
    );
    expect(result.is_blindspot).toBe(true);
    expect(result.blindspot_side).toBe("pro_government");
  });

  it("does NOT flag when the dominant zone is below 80% even with >=5 sources", () => {
    const result = detectBlindspot(
      dist({ pro_government: 4, opposition: 1, opposition_leaning: 1 }),
    );
    expect(result.is_blindspot).toBe(false);
    expect(result.blindspot_side).toBeNull();
  });

  it("flags an all-muhalefet cluster across both opposition categories", () => {
    const result = detectBlindspot(
      dist({ opposition: 4, opposition_leaning: 1 }),
    );
    expect(result.is_blindspot).toBe(true);
    expect(result.blindspot_side).toBe("opposition");
  });

  it("treats nationalist as iktidar zone (A6 rezoning), blocking a false blindspot", () => {
    // nationalist + center would be two zones (iktidar + bagimsiz) — no
    // flag — while nationalist + pro_government is single-zone iktidar.
    expect(
      detectBlindspot(dist({ nationalist: 3, center: 2 })).is_blindspot,
    ).toBe(false);
    expect(
      detectBlindspot(dist({ nationalist: 4, pro_government: 1 })).is_blindspot,
    ).toBe(true);
  });

  it("flags a pure-bagimsiz cluster too (center/international/pro_kurdish)", () => {
    const result = detectBlindspot(
      dist({ center: 2, international: 2, pro_kurdish: 1 }),
    );
    expect(result.is_blindspot).toBe(true);
    expect(result.blindspot_side).toBe("center");
  });

  it("returns not-blindspot for an empty distribution", () => {
    const result = detectBlindspot(dist({}));
    expect(result.is_blindspot).toBe(false);
    expect(result.blindspot_side).toBeNull();
  });
});

describe("tallyZones", () => {
  it("counts sources per zone and totals them", () => {
    const tally = tallyZones(
      dist({ pro_government: 2, gov_leaning: 2, opposition: 1 }),
    );
    expect(tally.counts).toEqual({ iktidar: 4, bagimsiz: 0, muhalefet: 1 });
    expect(tally.total).toBe(5);
  });

  it("computes dominantShare as dominant zone count / total", () => {
    const tally = tallyZones(dist({ pro_government: 4, opposition: 1 }));
    expect(tally.dominantZone).toBe("iktidar");
    expect(tally.dominantShare).toBeCloseTo(0.8, 5);
  });

  it("computes dominantCategory as the largest category inside the dominant zone", () => {
    const tally = tallyZones(
      dist({ pro_government: 2, gov_leaning: 2, opposition: 1 }),
    );
    expect(tally.dominantZone).toBe("iktidar");
    expect(tally.dominantCategory).toBe("pro_government");
  });

  it("returns a null dominantZone and 0 dominantShare for an empty distribution", () => {
    const tally = tallyZones(dist({}));
    expect(tally.dominantZone).toBeNull();
    expect(tally.dominantShare).toBe(0);
    expect(tally.dominantCategory).toBeNull();
    expect(tally.total).toBe(0);
  });
});
