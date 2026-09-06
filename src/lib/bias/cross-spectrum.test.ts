import { describe, it, expect } from "vitest";
import { detectCrossSpectrum, summarizeSurprises } from "./cross-spectrum";
import { BLINDSPOT, SURPRISE } from "./config";
import type { Source, BiasCategory } from "@/types";

function mkSource(id: string, name: string, bias: BiasCategory): Source {
  return {
    id,
    name,
    slug: id,
    url: "",
    rss_url: "",
    bias,
    logo_url: null,
    active: true,
  };
}

describe("detectCrossSpectrum", () => {
  it("returns null dominant when balanced (no surprises)", () => {
    const sources = [
      mkSource("s1", "A", "pro_government"),
      mkSource("s2", "B", "opposition"),
      mkSource("s3", "C", "center"),
    ];
    const result = detectCrossSpectrum(sources);
    expect(result.dominantZone).toBeNull();
    expect(result.dominantPct).toBe(0);
    expect(result.surpriseOutlets).toHaveLength(0);
    expect(result.blindspotCandidate).toBe(false);
  });

  it("flags muhalefet outlet in iktidar-dominant cluster", () => {
    const sources = [
      mkSource("s1", "Sabah", "pro_government"),
      mkSource("s2", "A Haber", "pro_government"),
      mkSource("s3", "TRT", "state_media"),
      mkSource("s4", "Milliyet", "gov_leaning"),
      mkSource("s5", "Sözcü", "opposition"),
    ];
    const result = detectCrossSpectrum(sources);
    expect(result.dominantZone).toBe("iktidar");
    expect(result.dominantPct).toBeGreaterThanOrEqual(0.75);
    expect(result.surpriseOutlets.map((s) => s.name)).toContain("Sözcü");
    expect(result.surpriseOutlets).toHaveLength(1);
  });

  it("flags iktidar outlet in muhalefet-dominant cluster", () => {
    // A6 moved `nationalist` out of muhalefet (MHP is a Cumhur İttifakı ally),
    // so this fixture uses four muhalefet-mapped outlets + one iktidar outlet.
    const sources = [
      mkSource("s1", "Sözcü", "opposition"),
      mkSource("s2", "Cumhuriyet", "opposition"),
      mkSource("s3", "Halk TV", "opposition_leaning"),
      mkSource("s4", "BirGün", "opposition"),
      mkSource("s5", "Sabah", "pro_government"),
    ];
    const result = detectCrossSpectrum(sources);
    expect(result.dominantZone).toBe("muhalefet");
    expect(result.dominantPct).toBeGreaterThanOrEqual(0.75);
    expect(result.surpriseOutlets.map((s) => s.name)).toContain("Sabah");
    expect(result.surpriseOutlets).toHaveLength(1);
  });

  it("does not flag surprises when dominant is bagimsiz", () => {
    const sources = [
      mkSource("s1", "T24", "center"),
      mkSource("s2", "Gazete Duvar", "center"),
      mkSource("s3", "BBC Türkçe", "international"),
      mkSource("s4", "DW Türkçe", "international"),
      mkSource("s5", "Sabah", "pro_government"),
    ];
    const result = detectCrossSpectrum(sources);
    expect(result.dominantZone).toBe("bagimsiz");
    expect(result.surpriseOutlets).toHaveLength(0);
  });

  it("returns empty result when fewer than 2 members", () => {
    const result = detectCrossSpectrum([
      mkSource("s1", "One", "opposition"),
    ]);
    expect(result.dominantZone).toBeNull();
    expect(result.dominantPct).toBe(0);
    expect(result.surpriseOutlets).toHaveLength(0);
    expect(result.blindspotCandidate).toBe(false);

    const empty = detectCrossSpectrum([]);
    expect(empty.dominantZone).toBeNull();
    expect(empty.surpriseOutlets).toHaveLength(0);
  });

  it("uses the SURPRISE.dominantShare threshold from the contract (no dominant below it)", () => {
    // 3×pro_government + center + international: no muhalefet source at
    // all, so the minMargin guard never rejects this fixture and the
    // threshold check is what actually discriminates the two runs. At
    // 60% iktidar: passes at 0.55, fails at 0.65/default.
    const sources = [
      mkSource("s1", "A", "pro_government"),
      mkSource("s2", "B", "pro_government"),
      mkSource("s3", "C", "pro_government"),
      mkSource("s4", "D", "center"),
      mkSource("s5", "E", "international"),
    ];
    expect(0.55).toBeLessThan(SURPRISE.dominantShare);

    const atLowThreshold = detectCrossSpectrum(sources, 0.55);
    expect(atLowThreshold.dominantZone).toBe("iktidar");

    const atContractThreshold = detectCrossSpectrum(sources, SURPRISE.dominantShare);
    expect(atContractThreshold.dominantZone).toBeNull();
    expect(atContractThreshold.surpriseOutlets).toHaveLength(0);
  });

  it("takes its default threshold from SURPRISE, not a hardcoded literal", () => {
    // Same margin-guard-proof fixture as above. If the default ever
    // reverted to 0.55 (the exact regression this contract removes), this
    // test would fail because withDefault would then diverge from
    // withExplicit(SURPRISE.dominantShare).
    const sources = [
      mkSource("s1", "A", "pro_government"),
      mkSource("s2", "B", "pro_government"),
      mkSource("s3", "C", "pro_government"),
      mkSource("s4", "D", "center"),
      mkSource("s5", "E", "international"),
    ];
    const withDefault = detectCrossSpectrum(sources);
    const withExplicit = detectCrossSpectrum(sources, SURPRISE.dominantShare);
    expect(withDefault).toEqual(withExplicit);
    expect(withDefault.dominantZone).toBeNull();
  });

  it("sets blindspotCandidate when dominantPct >= BLINDSPOT.dominantShare", () => {
    // 9 iktidar + 1 muhalefet → 90% iktidar dominance
    const sources = [
      mkSource("s1", "Sabah", "pro_government"),
      mkSource("s2", "A Haber", "pro_government"),
      mkSource("s3", "TRT", "state_media"),
      mkSource("s4", "Milliyet", "gov_leaning"),
      mkSource("s5", "Yeni Şafak", "islamist_conservative"),
      mkSource("s6", "Star", "pro_government"),
      mkSource("s7", "Akşam", "gov_leaning"),
      mkSource("s8", "Türkiye", "pro_government"),
      mkSource("s9", "AA", "state_media"),
      mkSource("s10", "Sözcü", "opposition"),
    ];
    const result = detectCrossSpectrum(sources);
    expect(result.dominantZone).toBe("iktidar");
    expect(result.dominantPct).toBeGreaterThanOrEqual(BLINDSPOT.dominantShare);
    expect(result.blindspotCandidate).toBe(true);
    expect(result.surpriseOutlets.map((s) => s.name)).toContain("Sözcü");
  });

  it("does NOT set blindspotCandidate below BLINDSPOT.dominantShare", () => {
    // 8 sources at 75% iktidar — clears the SURPRISE threshold and the size
    // + margin guards, but stays under the BLINDSPOT.dominantShare line.
    const sources = [
      mkSource("s1", "Sabah", "pro_government"),
      mkSource("s2", "A Haber", "pro_government"),
      mkSource("s3", "TRT", "state_media"),
      mkSource("s4", "Milliyet", "gov_leaning"),
      mkSource("s5", "Yeni Şafak", "islamist_conservative"),
      mkSource("s6", "Star", "pro_government"),
      mkSource("s7", "Sözcü", "opposition"),
      mkSource("s8", "Cumhuriyet", "opposition"),
    ];
    const result = detectCrossSpectrum(sources);
    expect(result.dominantZone).toBe("iktidar");
    expect(result.dominantPct).toBeCloseTo(0.75, 5);
    expect(0.75).toBeLessThan(BLINDSPOT.dominantShare);
    expect(result.blindspotCandidate).toBe(false);
  });
});

describe("summarizeSurprises", () => {
  it("returns Turkish strings using the post-A6 template", () => {
    const sources = [
      mkSource("s1", "Sabah", "pro_government"),
      mkSource("s2", "A Haber", "pro_government"),
      mkSource("s3", "TRT", "state_media"),
      mkSource("s4", "Milliyet", "gov_leaning"),
      mkSource("s5", "Sözcü", "opposition"),
    ];
    const result = detectCrossSpectrum(sources);
    const lines = summarizeSurprises(result, "Sample story", 2);
    expect(lines.length).toBeGreaterThan(0);
    // post-A6 template:
    //   "⚡ Name (muhalefet) bu iktidara yakın habere yer verdi: "title""
    expect(lines[0]).toMatch(/Sözcü/);
    expect(lines[0]).toMatch(/\(muhalefet\)/);
    expect(lines[0]).toMatch(/iktidara yakın/);
    expect(lines[0]).toMatch(/habere yer verdi/);
    expect(lines[0]).toMatch(/Sample story/);
  });

  it("renders the inverse template for muhalefet-dominant clusters", () => {
    const sources = [
      mkSource("s1", "Sözcü", "opposition"),
      mkSource("s2", "Cumhuriyet", "opposition"),
      mkSource("s3", "Halk TV", "opposition_leaning"),
      mkSource("s4", "BirGün", "opposition"),
      mkSource("s5", "Sabah", "pro_government"),
    ];
    const result = detectCrossSpectrum(sources);
    const lines = summarizeSurprises(result, "Karşı manşet", 2);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toMatch(/Sabah/);
    expect(lines[0]).toMatch(/\(iktidar\)/);
    expect(lines[0]).toMatch(/muhalefet yanlısı/);
    expect(lines[0]).toMatch(/Karşı manşet/);
  });

  it("returns [] when there are no surprises or no dominant", () => {
    const balanced = detectCrossSpectrum([
      mkSource("s1", "A", "pro_government"),
      mkSource("s2", "B", "opposition"),
      mkSource("s3", "C", "center"),
    ]);
    expect(summarizeSurprises(balanced, "anything")).toEqual([]);
  });

  it("respects the max cap on rendered lines", () => {
    // 10 sources at 70% iktidar — clears the 0.65 threshold and the
    // margin-of-3 guard, and leaves 3 muhalefet surprises to cap at 2.
    const sources = [
      mkSource("s1", "Sabah", "pro_government"),
      mkSource("s2", "A Haber", "pro_government"),
      mkSource("s3", "TRT", "state_media"),
      mkSource("s4", "Milliyet", "gov_leaning"),
      mkSource("s5", "Yeni Şafak", "islamist_conservative"),
      mkSource("s6", "Star", "pro_government"),
      mkSource("s7", "Akşam", "gov_leaning"),
      mkSource("s8", "Sözcü", "opposition"),
      mkSource("s9", "Cumhuriyet", "opposition"),
      mkSource("s10", "Halk TV", "opposition_leaning"),
    ];
    const result = detectCrossSpectrum(sources);
    expect(result.surpriseOutlets.length).toBeGreaterThanOrEqual(3);
    const lines = summarizeSurprises(result, "Story", 2);
    expect(lines).toHaveLength(2);
  });
});
