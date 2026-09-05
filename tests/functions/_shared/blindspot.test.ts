import { describe, it, expect } from "vitest";

import {
  detectBlindspot,
  MIN_BLINDSPOT_SOURCES,
  type BiasKey,
} from "../../../supabase/functions/_shared/cluster/blindspot";

// ---------------------------------------------------------------------------
// Zone-based blindspot detection.
//
// The old DB-level rule ("exactly one of the 10 bias categories is non-zero,
// no minimum count") was simultaneously over-sensitive (a 1-article cluster
// got the homepage badge) and under-sensitive (pro_government + gov_leaning
// + state_media — three categories, 100% iktidar zone — was NOT flagged).
// The new rule mirrors the /blindspots page semantics: all participating
// sources fall in a single Medya DNA zone AND there are at least
// MIN_BLINDSPOT_SOURCES distinct sources. The cluster-consumer's
// duplicate-source guard ensures each member has a unique source, so the
// distribution's total count IS the distinct-source count.
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

describe("detectBlindspot (zone-based, min-source floor)", () => {
  it("exports a floor of 5 distinct sources", () => {
    expect(MIN_BLINDSPOT_SOURCES).toBe(5);
  });

  it("does NOT flag a single-article cluster (old rule's worst false positive)", () => {
    const result = detectBlindspot(dist({ pro_government: 1 }));
    expect(result.is_blindspot).toBe(false);
    expect(result.blindspot_side).toBeNull();
  });

  it("does NOT flag a single-category cluster below the source floor", () => {
    const result = detectBlindspot(dist({ opposition: 4 }));
    expect(result.is_blindspot).toBe(false);
  });

  it("flags a multi-category cluster that is 100% one zone at the floor (old rule missed this)", () => {
    // pro_government + gov_leaning + state_media are three different
    // categories but all iktidar zone — the old category-counting rule
    // returned false here.
    const result = detectBlindspot(
      dist({ pro_government: 2, gov_leaning: 2, state_media: 1 }),
    );
    expect(result.is_blindspot).toBe(true);
  });

  it("reports the dominant category of the flagged zone as blindspot_side", () => {
    const result = detectBlindspot(
      dist({ pro_government: 3, gov_leaning: 1, state_media: 1 }),
    );
    expect(result.blindspot_side).toBe("pro_government");
  });

  it("does NOT flag when a second zone has any coverage", () => {
    const result = detectBlindspot(
      dist({ pro_government: 4, opposition: 1 }),
    );
    expect(result.is_blindspot).toBe(false);
    expect(result.blindspot_side).toBeNull();
  });

  it("flags an all-muhalefet cluster across both opposition categories", () => {
    const result = detectBlindspot(
      dist({ opposition: 3, opposition_leaning: 2 }),
    );
    expect(result.is_blindspot).toBe(true);
    expect(result.blindspot_side).toBe("opposition");
  });

  it("treats nationalist as iktidar zone (A6 rezoning), blocking a false blindspot", () => {
    // nationalist + center would be two zones (iktidar + bagimsiz) — no flag —
    // while nationalist + pro_government is single-zone iktidar.
    expect(
      detectBlindspot(dist({ nationalist: 3, center: 2 })).is_blindspot,
    ).toBe(false);
    expect(
      detectBlindspot(dist({ nationalist: 3, pro_government: 2 })).is_blindspot,
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
