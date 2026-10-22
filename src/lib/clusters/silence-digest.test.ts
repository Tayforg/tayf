import { describe, it, expect } from "vitest";

import {
  SILENCE_WINDOW_HOURS,
  ZONE_ROW_ORDER,
  buildSilenceDigest,
  capitalizeTr,
  formatSilenceRow,
  silenceFootnote,
  type SilenceRow,
} from "./silence-digest";
import type { BiasCategory, MediaDnaZone } from "@/types";

// Fixtures only carry the three BlindspotBundle fields buildSilenceDigest
// reads (cluster.id/updated_at, sources, dominantZone).

const NOW = Date.parse("2026-10-22T12:00:00Z");
const HOUR = 3_600_000;
const MIN = 60_000;

type Bundle = Parameters<typeof buildSilenceDigest>[0][number];

const BIAS_FOR_ZONE: Record<MediaDnaZone, BiasCategory> = {
  iktidar: "pro_government",
  bagimsiz: "center",
  muhalefet: "opposition",
};

function mkBundle(opts: {
  id: string;
  dominantZone: MediaDnaZone;
  /** zone of each source on the bundle (one source per entry) */
  sourceZones: MediaDnaZone[];
  updatedAtMs?: number;
  updatedAt?: string;
}): Bundle {
  const updatedAt =
    opts.updatedAt ?? new Date(opts.updatedAtMs ?? NOW - HOUR).toISOString();
  return {
    cluster: { id: opts.id, updated_at: updatedAt } as Bundle["cluster"],
    sources: opts.sourceZones.map((z, i) => ({
      id: `${opts.id}-s${i}`,
      name: `Kaynak ${opts.id}-${i}`,
      bias: BIAS_FOR_ZONE[z],
    })),
    dominantZone: opts.dominantZone,
  };
}

function row(
  digest: ReturnType<typeof buildSilenceDigest>,
  zone: MediaDnaZone,
): SilenceRow {
  const r = digest.rows.find((x) => x.zone === zone);
  if (!r) throw new Error(`row ${zone} missing`);
  return r;
}

describe("constants", () => {
  it("uses a 24 hour window and the iktidar, bagimsiz, muhalefet row order", () => {
    expect(SILENCE_WINDOW_HOURS).toBe(24);
    expect(ZONE_ROW_ORDER).toEqual(["iktidar", "bagimsiz", "muhalefet"]);
  });
});

describe("buildSilenceDigest — window", () => {
  const mk = (id: string, updatedAtMs: number) =>
    mkBundle({
      id,
      dominantZone: "iktidar",
      sourceZones: ["iktidar"],
      updatedAtMs,
    });

  it("includes a bundle updated 23 h ago", () => {
    expect(buildSilenceDigest([mk("a", NOW - 23 * HOUR)], NOW).windowTotal).toBe(1);
  });

  it("includes a bundle updated exactly 24 h ago (inclusive boundary)", () => {
    expect(buildSilenceDigest([mk("a", NOW - 24 * HOUR)], NOW).windowTotal).toBe(1);
  });

  it("excludes a bundle updated 25 h ago", () => {
    expect(buildSilenceDigest([mk("a", NOW - 25 * HOUR)], NOW).windowTotal).toBe(0);
  });

  it("excludes a bundle with an unparseable updated_at", () => {
    const b = mkBundle({
      id: "bad",
      dominantZone: "iktidar",
      sourceZones: ["iktidar"],
      updatedAt: "not-a-date",
    });
    expect(buildSilenceDigest([b], NOW).windowTotal).toBe(0);
  });

  it("excludes a bundle with an empty updated_at", () => {
    const b = mkBundle({
      id: "empty",
      dominantZone: "iktidar",
      sourceZones: ["iktidar"],
      updatedAt: "",
    });
    expect(buildSilenceDigest([b], NOW).windowTotal).toBe(0);
  });

  it("tolerates +2 min of clock skew (future timestamp included)", () => {
    expect(buildSilenceDigest([mk("a", NOW + 2 * MIN)], NOW).windowTotal).toBe(1);
  });

  it("tolerates exactly +5 min of clock skew", () => {
    expect(buildSilenceDigest([mk("a", NOW + 5 * MIN)], NOW).windowTotal).toBe(1);
  });

  it("excludes a bundle +10 min in the future", () => {
    expect(buildSilenceDigest([mk("a", NOW + 10 * MIN)], NOW).windowTotal).toBe(0);
  });

  it("honours a custom windowHours argument", () => {
    const bundles = [mk("a", NOW - 3 * HOUR), mk("b", NOW - 7 * HOUR)];
    expect(buildSilenceDigest(bundles, NOW, 6).windowTotal).toBe(1);
    expect(buildSilenceDigest(bundles, NOW, 8).windowTotal).toBe(2);
  });

  it("excluded bundles contribute nothing to the silent counts", () => {
    const old = mkBundle({
      id: "old",
      dominantZone: "iktidar",
      sourceZones: ["iktidar"],
      updatedAtMs: NOW - 30 * HOUR,
    });
    const d = buildSilenceDigest([old], NOW);
    expect(d.windowTotal).toBe(0);
    expect(d.rows.map((r) => r.silentCount)).toEqual([0, 0, 0]);
  });

  it("returns an empty digest for no bundles", () => {
    const d = buildSilenceDigest([], NOW);
    expect(d.windowTotal).toBe(0);
    expect(d.rows).toHaveLength(3);
  });
});

describe("buildSilenceDigest — dedupe", () => {
  it("counts a duplicate cluster id once (first occurrence wins)", () => {
    const first = mkBundle({
      id: "dup",
      dominantZone: "iktidar",
      sourceZones: ["iktidar"],
    });
    const second = mkBundle({
      id: "dup",
      dominantZone: "muhalefet",
      sourceZones: ["muhalefet"],
    });
    const d = buildSilenceDigest([first, second], NOW);
    expect(d.windowTotal).toBe(1);
    // first occurrence is iktidar-dominant, so the dominant bucket is iktidar
    expect(row(d, "muhalefet").byDominant).toEqual([{ zone: "iktidar", count: 1 }]);
    expect(row(d, "bagimsiz").byDominant).toEqual([{ zone: "iktidar", count: 1 }]);
  });

  it("drops out-of-window copies before deduping, so an unparseable duplicate does not shadow a valid one", () => {
    const bad = mkBundle({
      id: "x",
      dominantZone: "iktidar",
      sourceZones: ["iktidar"],
      updatedAt: "garbage",
    });
    const good = mkBundle({
      id: "x",
      dominantZone: "iktidar",
      sourceZones: ["iktidar"],
    });
    // The out-of-window copy is dropped before dedupe, so the in-window one counts.
    expect(buildSilenceDigest([bad, good], NOW).windowTotal).toBe(1);
  });
});

describe("buildSilenceDigest — silence semantics", () => {
  it("counts zones with zero sources as silent, never the dominant zone", () => {
    const b = mkBundle({
      id: "a",
      dominantZone: "iktidar",
      sourceZones: ["iktidar", "iktidar", "iktidar"],
    });
    const d = buildSilenceDigest([b], NOW);
    expect(row(d, "iktidar").silentCount).toBe(0);
    expect(row(d, "bagimsiz").silentCount).toBe(1);
    expect(row(d, "muhalefet").silentCount).toBe(1);
  });

  it("never counts the dominant zone as silent for any dominant zone", () => {
    for (const dominant of ZONE_ROW_ORDER) {
      const b = mkBundle({ id: dominant, dominantZone: dominant, sourceZones: [] });
      const d = buildSilenceDigest([b], NOW);
      expect(row(d, dominant).silentCount).toBe(0);
    }
  });

  it("one muhalefet source on an iktidar-dominant bundle means muhalefet is not silent on it", () => {
    const b = mkBundle({
      id: "a",
      dominantZone: "iktidar",
      sourceZones: ["iktidar", "iktidar", "iktidar", "iktidar", "muhalefet"],
    });
    const d = buildSilenceDigest([b], NOW);
    expect(row(d, "muhalefet").silentCount).toBe(0);
    expect(row(d, "muhalefet").byDominant).toEqual([]);
    // bagimsiz had zero sources, so it is still silent
    expect(row(d, "bagimsiz").silentCount).toBe(1);
  });

  it("maps bias to zone through the shared zoneOf mapping (nationalist and pro_kurdish)", () => {
    const b: Bundle = {
      cluster: { id: "z", updated_at: new Date(NOW - HOUR).toISOString() } as Bundle["cluster"],
      sources: [
        { id: "s1", name: "N", bias: "nationalist" },
        { id: "s2", name: "K", bias: "pro_kurdish" },
      ],
      dominantZone: "iktidar",
    };
    const d = buildSilenceDigest([b], NOW);
    // nationalist -> iktidar, pro_kurdish -> bagimsiz: only muhalefet is silent
    expect(row(d, "bagimsiz").silentCount).toBe(0);
    expect(row(d, "muhalefet").silentCount).toBe(1);
  });

  it("a bagimsiz-dominant bundle with zero pole sources counts in both pole rows", () => {
    const b = mkBundle({
      id: "a",
      dominantZone: "bagimsiz",
      sourceZones: ["bagimsiz", "bagimsiz"],
    });
    const d = buildSilenceDigest([b], NOW);
    expect(row(d, "iktidar").silentCount).toBe(1);
    expect(row(d, "muhalefet").silentCount).toBe(1);
    expect(row(d, "bagimsiz").silentCount).toBe(0);
    expect(row(d, "iktidar").byDominant).toEqual([{ zone: "bagimsiz", count: 1 }]);
    expect(row(d, "muhalefet").byDominant).toEqual([{ zone: "bagimsiz", count: 1 }]);
  });

  it("a bundle with no sources at all is silent for every non-dominant zone", () => {
    const b = mkBundle({ id: "a", dominantZone: "muhalefet", sourceZones: [] });
    const d = buildSilenceDigest([b], NOW);
    expect(d.rows.map((r) => r.silentCount)).toEqual([1, 1, 0]);
  });
});

describe("buildSilenceDigest — byDominant", () => {
  it("lists non-zero entries only, in iktidar, bagimsiz, muhalefet order", () => {
    const bundles = [
      // muhalefet-dominant, no iktidar source -> iktidar silent, dominant muhalefet
      mkBundle({ id: "m1", dominantZone: "muhalefet", sourceZones: ["muhalefet", "bagimsiz"] }),
      mkBundle({ id: "m2", dominantZone: "muhalefet", sourceZones: ["muhalefet", "bagimsiz"] }),
      mkBundle({ id: "m3", dominantZone: "muhalefet", sourceZones: ["muhalefet", "bagimsiz"] }),
      // bagimsiz-dominant, no iktidar source -> iktidar silent, dominant bagimsiz
      mkBundle({ id: "b1", dominantZone: "bagimsiz", sourceZones: ["bagimsiz", "muhalefet"] }),
    ];
    const d = buildSilenceDigest(bundles, NOW);
    const ik = row(d, "iktidar");
    expect(ik.silentCount).toBe(4);
    // bagimsiz appears before muhalefet (ZONE_ROW_ORDER), iktidar is omitted (zero)
    expect(ik.byDominant).toEqual([
      { zone: "bagimsiz", count: 1 },
      { zone: "muhalefet", count: 3 },
    ]);
  });

  it("byDominant counts always sum to silentCount", () => {
    const bundles = [
      mkBundle({ id: "1", dominantZone: "iktidar", sourceZones: ["iktidar"] }),
      mkBundle({ id: "2", dominantZone: "bagimsiz", sourceZones: ["bagimsiz"] }),
      mkBundle({ id: "3", dominantZone: "muhalefet", sourceZones: ["muhalefet"] }),
      mkBundle({ id: "4", dominantZone: "muhalefet", sourceZones: ["muhalefet", "iktidar"] }),
    ];
    const d = buildSilenceDigest(bundles, NOW);
    for (const r of d.rows) {
      expect(r.byDominant.reduce((s, e) => s + e.count, 0)).toBe(r.silentCount);
      expect(r.byDominant.every((e) => e.count > 0)).toBe(true);
    }
  });
});

describe("buildSilenceDigest — shape", () => {
  it("always returns exactly 3 rows in ZONE_ROW_ORDER", () => {
    const cases: Bundle[][] = [
      [],
      [mkBundle({ id: "a", dominantZone: "iktidar", sourceZones: ["iktidar"] })],
      [
        mkBundle({ id: "a", dominantZone: "iktidar", sourceZones: ["iktidar"] }),
        mkBundle({ id: "b", dominantZone: "muhalefet", sourceZones: ["muhalefet"] }),
      ],
    ];
    for (const bundles of cases) {
      const d = buildSilenceDigest(bundles, NOW);
      expect(d.rows).toHaveLength(3);
      expect(d.rows.map((r) => r.zone)).toEqual([...ZONE_ROW_ORDER]);
    }
  });

  it("one story can count in two rows", () => {
    const b = mkBundle({ id: "a", dominantZone: "iktidar", sourceZones: ["iktidar"] });
    const d = buildSilenceDigest([b], NOW);
    expect(d.windowTotal).toBe(1);
    expect(d.rows.map((r) => r.silentCount)).toEqual([0, 1, 1]);
  });

  it("does not mutate its input", () => {
    const bundles = [
      mkBundle({ id: "a", dominantZone: "iktidar", sourceZones: ["iktidar"] }),
    ];
    const snapshot = JSON.stringify(bundles);
    buildSilenceDigest(bundles, NOW);
    expect(JSON.stringify(bundles)).toBe(snapshot);
  });
});

describe("capitalizeTr", () => {
  it("upper-cases a leading dotted i with Turkish rules", () => {
    expect(capitalizeTr("iktidara")).toBe("İktidara");
  });

  it("leaves other leading letters intact and handles empty input", () => {
    expect(capitalizeTr("merkez")).toBe("Merkez");
    expect(capitalizeTr("")).toBe("");
  });
});

describe("formatSilenceRow", () => {
  it("formats a non-zero row with the dominant-zone breakdown", () => {
    const r: SilenceRow = {
      zone: "iktidar",
      silentCount: 4,
      byDominant: [
        { zone: "muhalefet", count: 3 },
        { zone: "bagimsiz", count: 1 },
      ],
    };
    expect(formatSilenceRow(r)).toBe(
      "İktidara yakın kaynaklar 4 hikâyeye yer vermedi (3 muhalefet ağırlıklı, 1 bağımsız ağırlıklı)",
    );
  });

  it("formats a zero row", () => {
    const r: SilenceRow = { zone: "bagimsiz", silentCount: 0, byDominant: [] };
    expect(formatSilenceRow(r)).toBe(
      "Merkez ve bağımsız kaynaklar: yer vermedikleri hikâye yok",
    );
  });

  it("uses the muhalefet subject", () => {
    const r: SilenceRow = {
      zone: "muhalefet",
      silentCount: 2,
      byDominant: [{ zone: "iktidar", count: 2 }],
    };
    expect(formatSilenceRow(r)).toBe(
      "Muhalefete yakın kaynaklar 2 hikâyeye yer vermedi (2 iktidar ağırlıklı)",
    );
  });

  it("formats rows produced by buildSilenceDigest end to end", () => {
    const bundles = [
      mkBundle({ id: "a", dominantZone: "muhalefet", sourceZones: ["muhalefet"] }),
    ];
    const d = buildSilenceDigest(bundles, NOW);
    expect(formatSilenceRow(row(d, "iktidar"))).toBe(
      "İktidara yakın kaynaklar 1 hikâyeye yer vermedi (1 muhalefet ağırlıklı)",
    );
    expect(formatSilenceRow(row(d, "muhalefet"))).toBe(
      "Muhalefete yakın kaynaklar: yer vermedikleri hikâye yok",
    );
  });
});

describe("silenceFootnote", () => {
  it("states the window, the total, and the multi-row caveat", () => {
    expect(silenceFootnote(2)).toBe(
      "Bu sayfadaki kör noktalardan son 24 saatte güncellenen 2 hikâye sayıldı. Bir bölgeden izlediğimiz hiçbir kaynak haberi yapmadıysa “yer vermedi” sayılır; bir hikâye birden fazla satırda sayılabilir.",
    );
  });
});

describe("copy policy", () => {
  it("no output string contains görmezden, sustu or gizledi", () => {
    const bundles = [
      mkBundle({ id: "a", dominantZone: "iktidar", sourceZones: ["iktidar"] }),
      mkBundle({ id: "b", dominantZone: "muhalefet", sourceZones: ["muhalefet"] }),
    ];
    const d = buildSilenceDigest(bundles, NOW);
    const strings = [
      ...d.rows.map(formatSilenceRow),
      ...d.rows.map((r) => formatSilenceRow({ ...r, silentCount: 0, byDominant: [] })),
      silenceFootnote(d.windowTotal),
      silenceFootnote(0),
    ];
    for (const s of strings) {
      expect(s).not.toContain("görmezden");
      expect(s).not.toContain("sustu");
      expect(s).not.toContain("gizledi");
    }
  });
});
