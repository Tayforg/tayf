import { describe, it, expect } from "vitest";
import * as mjs from "./blindspot.mjs";
import * as ts from "../../../supabase/functions/_shared/cluster/blindspot";

// Fixtures reused across the parity checks below. Not the zone-parity.test.ts
// fixtures (those are SQL-text regexes, not runtime distributions) — these
// are hand-built bias_distribution shapes covering the cases that matter:
// a clean iktidar blindspot, a mixed/no-blindspot cluster, a too-small
// cluster, and an empty/legacy distribution.
const DISTRIBUTIONS = [
  {}, // empty
  { pro_government: 5 }, // single-zone, exactly at minSources, 100% share
  { pro_government: 4, opposition: 1 }, // 5 sources, 80% share — right at the line
  { pro_government: 3, opposition: 2 }, // 5 sources, 60% share — below the line
  { pro_government: 2, gov_leaning: 2, nationalist: 1 }, // all-iktidar, mixed categories
  { center: 6, opposition: 1 }, // bagimsiz-dominant
  { opposition: 3 }, // below minSources
  { pro_government: 10, opposition_leaning: 1, pro_kurdish: 1 }, // 12 total, 83% share
  { independent: 5 }, // legacy key not in BIAS_KEYS — must count as empty
];

describe("blindspot.mjs mirrors supabase/functions/_shared/cluster/blindspot.ts", () => {
  it("BIAS_TO_ZONE deep-equals the .ts contract", () => {
    expect(mjs.BIAS_TO_ZONE).toEqual(ts.BIAS_TO_ZONE);
  });

  it("BIAS_KEYS / ZONE_KEYS deep-equal the .ts contract, in order", () => {
    expect(mjs.BIAS_KEYS).toEqual([...ts.BIAS_KEYS]);
    expect(mjs.ZONE_KEYS).toEqual([...ts.ZONE_KEYS]);
  });

  it("BLINDSPOT / SURPRISE thresholds equal the .ts contract", () => {
    expect(mjs.BLINDSPOT).toEqual(ts.BLINDSPOT);
    expect(mjs.SURPRISE).toEqual(ts.SURPRISE);
    expect(mjs.MIN_BLINDSPOT_SOURCES).toBe(ts.MIN_BLINDSPOT_SOURCES);
  });

  it("tallyZones() agrees with the .ts contract on every fixture", () => {
    for (const dist of DISTRIBUTIONS) {
      expect(mjs.tallyZones(dist)).toEqual(ts.tallyZones(dist));
    }
  });

  it("detectBlindspot() agrees with the .ts contract on every fixture", () => {
    for (const dist of DISTRIBUTIONS) {
      expect(mjs.detectBlindspot(dist)).toEqual(ts.detectBlindspot(dist));
    }
  });
});

describe("tallyZones", () => {
  it("returns zero counts and no dominant zone for an empty distribution", () => {
    const t = mjs.tallyZones({});
    expect(t).toEqual({
      counts: { iktidar: 0, bagimsiz: 0, muhalefet: 0 },
      total: 0,
      dominantZone: null,
      dominantShare: 0,
      dominantCategory: null,
    });
  });

  it("ignores keys outside BIAS_KEYS (legacy 'independent')", () => {
    expect(mjs.tallyZones({ independent: 7 }).total).toBe(0);
  });

  it("ignores zero/negative counts", () => {
    const t = mjs.tallyZones({ pro_government: 0, opposition: -1, center: 3 });
    expect(t.total).toBe(3);
    expect(t.dominantZone).toBe("bagimsiz");
  });

  it("rolls nationalist into iktidar (A6 finding)", () => {
    expect(mjs.zoneOfKey("nationalist")).toBe("iktidar");
  });

  it("breaks dominant-category ties by BIAS_KEYS order", () => {
    // pro_government (index 0) and gov_leaning (index 1) tie at 2 each,
    // both iktidar — pro_government must win as the earlier BIAS_KEYS entry.
    const t = mjs.tallyZones({ pro_government: 2, gov_leaning: 2 });
    expect(t.dominantCategory).toBe("pro_government");
  });
});

describe("detectBlindspot", () => {
  it("flags a single-zone cluster at exactly minSources and 100% share", () => {
    expect(mjs.detectBlindspot({ pro_government: 5 })).toEqual({
      is_blindspot: true,
      blindspot_side: "pro_government",
    });
  });

  it("flags right at the 80% dominantShare line", () => {
    expect(mjs.detectBlindspot({ pro_government: 4, opposition: 1 }).is_blindspot).toBe(true);
  });

  it("does not flag just below the 80% dominantShare line", () => {
    expect(mjs.detectBlindspot({ pro_government: 3, opposition: 2 }).is_blindspot).toBe(false);
  });

  it("does not flag below minSources even at 100% share", () => {
    expect(mjs.detectBlindspot({ opposition: 3 })).toEqual({
      is_blindspot: false,
      blindspot_side: null,
    });
  });

  it("does not flag an empty or legacy-only distribution", () => {
    expect(mjs.detectBlindspot({}).is_blindspot).toBe(false);
    expect(mjs.detectBlindspot({ independent: 9 }).is_blindspot).toBe(false);
  });

  it("sums mixed categories within the dominant zone before checking share", () => {
    // pro_government(2) + gov_leaning(2) + nationalist(1) = 5, all iktidar
    // → 100% share, dominant category is pro_government (tie-break).
    expect(
      mjs.detectBlindspot({ pro_government: 2, gov_leaning: 2, nationalist: 1 }),
    ).toEqual({ is_blindspot: true, blindspot_side: "pro_government" });
  });
});
