import { describe, it, expect } from "vitest";

import * as silenceModule from "./silence-digest";
import {
  ZONE_ROW_ORDER,
  buildSilenceDigest,
  capitalizeTr,
  formatSilenceRow,
  silenceFootnote,
  type SilenceRow,
} from "./silence-digest";
import type { BiasCategory, MediaDnaZone } from "@/types";

// Fixtures mimic a real BlindspotBundle: they carry `sources` (which also
// lists non-voting aggregator / niche outlets) so the tests can prove
// buildSilenceDigest ignores it and reads only the voting tally
// (votingZoneCounts) the card's dominantZone / dominantPct come from.

const NOW = Date.parse("2026-10-22T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Bundle = Parameters<typeof buildSilenceDigest>[0][number] & {
  sources: Array<{ id: string; name: string; bias: BiasCategory }>;
};

const BIAS_FOR_ZONE: Record<MediaDnaZone, BiasCategory> = {
  iktidar: "pro_government",
  bagimsiz: "center",
  muhalefet: "opposition",
};

function mkBundle(opts: {
  id: string;
  dominantZone: MediaDnaZone;
  /** The voting tally (BlindspotBundle.votingZoneCounts); missing zones are 0. */
  voting?: Partial<Record<MediaDnaZone, number>>;
  /** Zones of NON-voting sources (aggregator / niche) listed on bundle.sources. */
  nonVotingZones?: MediaDnaZone[];
  updatedAtMs?: number;
  updatedAt?: string;
}): Bundle {
  const updatedAt =
    opts.updatedAt ?? new Date(opts.updatedAtMs ?? NOW - HOUR).toISOString();
  const voting = { iktidar: 0, bagimsiz: 0, muhalefet: 0, ...opts.voting };
  const votingSources = ZONE_ROW_ORDER.flatMap((z) =>
    Array.from({ length: voting[z] }, (_, i) => ({
      id: `${opts.id}-v-${z}-${i}`,
      name: `Kaynak ${opts.id}-${z}-${i}`,
      bias: BIAS_FOR_ZONE[z],
    })),
  );
  const nonVotingSources = (opts.nonVotingZones ?? []).map((z, i) => ({
    id: `${opts.id}-n${i}`,
    name: `Toplayıcı ${opts.id}-${i}`,
    bias: BIAS_FOR_ZONE[z],
  }));
  return {
    cluster: { id: opts.id, updated_at: updatedAt } as Bundle["cluster"],
    sources: [...votingSources, ...nonVotingSources],
    dominantZone: opts.dominantZone,
    votingZoneCounts: voting,
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
  it("keeps the iktidar, bagimsiz, muhalefet row order", () => {
    expect(ZONE_ROW_ORDER).toEqual(["iktidar", "bagimsiz", "muhalefet"]);
  });

  it("no longer exports a 24 hour window constant", () => {
    expect("SILENCE_WINDOW_HOURS" in silenceModule).toBe(false);
  });

  it("is a pure function of the bundles alone (no clock or window argument)", () => {
    expect(buildSilenceDigest.length).toBe(1);
  });
});

describe("buildSilenceDigest — prod case (voting tally, not bundle.sources)", () => {
  // Seen live after #115: one "Sadece İktidar yazdı / %100 tek tarafta" card
  // whose band nevertheless said no zone had skipped a story.
  const prodCase = () =>
    mkBundle({
      id: "prod",
      dominantZone: "iktidar",
      voting: { iktidar: 3 },
      // A non-voting muhalefet aggregator sits in bundle.sources.
      nonVotingZones: ["muhalefet"],
    });

  it("counts muhalefet AND bagimsiz as silent although a non-voting muhalefet aggregator is on the card", () => {
    const d = buildSilenceDigest([prodCase()]);
    expect(d.windowTotal).toBe(1);
    expect(row(d, "iktidar").silentCount).toBe(0);
    expect(row(d, "bagimsiz").silentCount).toBe(1);
    expect(row(d, "muhalefet").silentCount).toBe(1);
    expect(row(d, "muhalefet").byDominant).toEqual([{ zone: "iktidar", count: 1 }]);
    expect(row(d, "bagimsiz").byDominant).toEqual([{ zone: "iktidar", count: 1 }]);
  });

  it("no longer prints the all-clear sentence for the muhalefet row", () => {
    const d = buildSilenceDigest([prodCase()]);
    expect(formatSilenceRow(row(d, "muhalefet"))).toBe(
      "Muhalefete yakın kaynaklar 1 hikâyeye yer vermedi (1 iktidar ağırlıklı)",
    );
  });

  it("a non-voting aggregator in every pole zone never makes a zone un-silent", () => {
    const b = mkBundle({
      id: "agg",
      dominantZone: "iktidar",
      voting: { iktidar: 5 },
      nonVotingZones: ["muhalefet", "bagimsiz", "muhalefet"],
    });
    const d = buildSilenceDigest([b]);
    expect(d.rows.map((r) => r.silentCount)).toEqual([0, 1, 1]);
  });
});

describe("buildSilenceDigest — whole-page window", () => {
  const mk = (id: string, opts: { updatedAtMs?: number; updatedAt?: string }) =>
    mkBundle({
      id,
      dominantZone: "iktidar",
      voting: { iktidar: 5 },
      ...opts,
    });

  it("counts a story last updated 5 days ago", () => {
    const d = buildSilenceDigest([mk("old", { updatedAtMs: NOW - 5 * DAY })]);
    expect(d.windowTotal).toBe(1);
    expect(d.rows.map((r) => r.silentCount)).toEqual([0, 1, 1]);
  });

  it("counts fresh and stale stories together", () => {
    const d = buildSilenceDigest([
      mk("fresh", { updatedAtMs: NOW - HOUR }),
      mk("2d", { updatedAtMs: NOW - 2 * DAY }),
      mk("30d", { updatedAtMs: NOW - 30 * DAY }),
    ]);
    expect(d.windowTotal).toBe(3);
    expect(row(d, "muhalefet").silentCount).toBe(3);
  });

  it("does not look at updated_at at all (unparseable, empty and future values still count)", () => {
    const d = buildSilenceDigest([
      mk("bad", { updatedAt: "not-a-date" }),
      mk("empty", { updatedAt: "" }),
      mk("future", { updatedAtMs: NOW + 10 * DAY }),
    ]);
    expect(d.windowTotal).toBe(3);
  });

  it("returns an empty digest for no bundles", () => {
    const d = buildSilenceDigest([]);
    expect(d.windowTotal).toBe(0);
    expect(d.rows).toHaveLength(3);
    expect(d.rows.map((r) => r.silentCount)).toEqual([0, 0, 0]);
  });
});

describe("buildSilenceDigest — dedupe", () => {
  it("counts a duplicate cluster id once (first occurrence wins)", () => {
    const first = mkBundle({
      id: "dup",
      dominantZone: "iktidar",
      voting: { iktidar: 5 },
    });
    const second = mkBundle({
      id: "dup",
      dominantZone: "muhalefet",
      voting: { muhalefet: 5 },
    });
    const d = buildSilenceDigest([first, second]);
    expect(d.windowTotal).toBe(1);
    // first occurrence is iktidar-dominant, so the dominant bucket is iktidar
    expect(row(d, "muhalefet").byDominant).toEqual([{ zone: "iktidar", count: 1 }]);
    expect(row(d, "bagimsiz").byDominant).toEqual([{ zone: "iktidar", count: 1 }]);
    expect(row(d, "iktidar").silentCount).toBe(0);
  });

  it("dedupes regardless of how far apart the duplicate timestamps are", () => {
    const a = mkBundle({
      id: "x",
      dominantZone: "iktidar",
      voting: { iktidar: 5 },
      updatedAtMs: NOW - HOUR,
    });
    const b = mkBundle({
      id: "x",
      dominantZone: "iktidar",
      voting: { iktidar: 5 },
      updatedAtMs: NOW - 9 * DAY,
    });
    expect(buildSilenceDigest([a, b]).windowTotal).toBe(1);
  });
});

describe("buildSilenceDigest — silence semantics", () => {
  it("counts zones with zero voting sources as silent, never the dominant zone", () => {
    const b = mkBundle({
      id: "a",
      dominantZone: "iktidar",
      voting: { iktidar: 3 },
    });
    const d = buildSilenceDigest([b]);
    expect(row(d, "iktidar").silentCount).toBe(0);
    expect(row(d, "bagimsiz").silentCount).toBe(1);
    expect(row(d, "muhalefet").silentCount).toBe(1);
  });

  it("never counts the dominant zone as silent for any dominant zone, even with an empty tally", () => {
    for (const dominant of ZONE_ROW_ORDER) {
      const b = mkBundle({ id: dominant, dominantZone: dominant });
      const d = buildSilenceDigest([b]);
      expect(row(d, dominant).silentCount).toBe(0);
    }
  });

  it("one VOTING muhalefet source on an iktidar-dominant bundle means muhalefet is not silent on it", () => {
    const b = mkBundle({
      id: "a",
      dominantZone: "iktidar",
      voting: { iktidar: 4, muhalefet: 1 },
    });
    const d = buildSilenceDigest([b]);
    expect(row(d, "muhalefet").silentCount).toBe(0);
    expect(row(d, "muhalefet").byDominant).toEqual([]);
    // bagimsiz had zero voting sources, so it is still silent
    expect(row(d, "bagimsiz").silentCount).toBe(1);
  });

  it("a voting bagimsiz source alone un-silences bagimsiz but not muhalefet", () => {
    const b = mkBundle({
      id: "a",
      dominantZone: "iktidar",
      voting: { iktidar: 4, bagimsiz: 1 },
    });
    const d = buildSilenceDigest([b]);
    expect(d.rows.map((r) => r.silentCount)).toEqual([0, 0, 1]);
  });

  it("a bagimsiz-dominant bundle with zero pole sources counts in both pole rows", () => {
    const b = mkBundle({
      id: "a",
      dominantZone: "bagimsiz",
      voting: { bagimsiz: 2 },
    });
    const d = buildSilenceDigest([b]);
    expect(row(d, "iktidar").silentCount).toBe(1);
    expect(row(d, "muhalefet").silentCount).toBe(1);
    expect(row(d, "bagimsiz").silentCount).toBe(0);
    expect(row(d, "iktidar").byDominant).toEqual([{ zone: "bagimsiz", count: 1 }]);
    expect(row(d, "muhalefet").byDominant).toEqual([{ zone: "bagimsiz", count: 1 }]);
  });

  it("a bundle with an empty voting tally is silent for every non-dominant zone", () => {
    const b = mkBundle({ id: "a", dominantZone: "muhalefet" });
    const d = buildSilenceDigest([b]);
    expect(d.rows.map((r) => r.silentCount)).toEqual([1, 1, 0]);
  });
});

describe("buildSilenceDigest — byDominant", () => {
  it("lists non-zero entries only, in iktidar, bagimsiz, muhalefet order", () => {
    const bundles = [
      // muhalefet-dominant, no voting iktidar source -> iktidar silent, dominant muhalefet
      mkBundle({ id: "m1", dominantZone: "muhalefet", voting: { muhalefet: 5, bagimsiz: 1 } }),
      mkBundle({ id: "m2", dominantZone: "muhalefet", voting: { muhalefet: 5, bagimsiz: 1 } }),
      mkBundle({ id: "m3", dominantZone: "muhalefet", voting: { muhalefet: 5, bagimsiz: 1 } }),
      // bagimsiz-dominant, no voting iktidar source -> iktidar silent, dominant bagimsiz
      mkBundle({ id: "b1", dominantZone: "bagimsiz", voting: { bagimsiz: 5, muhalefet: 1 } }),
    ];
    const d = buildSilenceDigest(bundles);
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
      mkBundle({ id: "1", dominantZone: "iktidar", voting: { iktidar: 5 } }),
      mkBundle({ id: "2", dominantZone: "bagimsiz", voting: { bagimsiz: 5 } }),
      mkBundle({ id: "3", dominantZone: "muhalefet", voting: { muhalefet: 5 } }),
      mkBundle({ id: "4", dominantZone: "muhalefet", voting: { muhalefet: 4, iktidar: 1 } }),
    ];
    const d = buildSilenceDigest(bundles);
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
      [mkBundle({ id: "a", dominantZone: "iktidar", voting: { iktidar: 5 } })],
      [
        mkBundle({ id: "a", dominantZone: "iktidar", voting: { iktidar: 5 } }),
        mkBundle({ id: "b", dominantZone: "muhalefet", voting: { muhalefet: 5 } }),
      ],
    ];
    for (const bundles of cases) {
      const d = buildSilenceDigest(bundles);
      expect(d.rows).toHaveLength(3);
      expect(d.rows.map((r) => r.zone)).toEqual([...ZONE_ROW_ORDER]);
    }
  });

  it("one story can count in two rows", () => {
    const b = mkBundle({ id: "a", dominantZone: "iktidar", voting: { iktidar: 5 } });
    const d = buildSilenceDigest([b]);
    expect(d.windowTotal).toBe(1);
    expect(d.rows.map((r) => r.silentCount)).toEqual([0, 1, 1]);
  });

  it("does not mutate its input", () => {
    const bundles = [
      mkBundle({ id: "a", dominantZone: "iktidar", voting: { iktidar: 5 }, nonVotingZones: ["muhalefet"] }),
    ];
    const snapshot = JSON.stringify(bundles);
    buildSilenceDigest(bundles);
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
      mkBundle({ id: "a", dominantZone: "muhalefet", voting: { muhalefet: 5, bagimsiz: 1 } }),
    ];
    const d = buildSilenceDigest(bundles);
    expect(formatSilenceRow(row(d, "iktidar"))).toBe(
      "İktidara yakın kaynaklar 1 hikâyeye yer vermedi (1 muhalefet ağırlıklı)",
    );
    expect(formatSilenceRow(row(d, "muhalefet"))).toBe(
      "Muhalefete yakın kaynaklar: yer vermedikleri hikâye yok",
    );
  });
});

describe("silenceFootnote", () => {
  it("states the page-wide count, the voting-kind rule and the multi-row caveat", () => {
    expect(silenceFootnote(2)).toBe(
      "Bu sayfadaki 2 kör nokta hikâyesi sayıldı. Bir bölgedeki gazete, TV ve ajanslardan hiçbiri haberi yapmadıysa “yer vermedi” sayılır (toplayıcı ve niş siteler, kör nokta hesabında olduğu gibi, sayılmaz); bir hikâye birden fazla satırda sayılabilir.",
    );
  });

  it("no longer claims a 24 hour window", () => {
    expect(silenceFootnote(1)).not.toContain("24 saat");
    expect(silenceFootnote(1)).not.toContain("güncellenen");
  });
});

describe("copy policy", () => {
  it("no output string contains görmezden, sustu or gizledi", () => {
    const bundles = [
      mkBundle({ id: "a", dominantZone: "iktidar", voting: { iktidar: 5 } }),
      mkBundle({ id: "b", dominantZone: "muhalefet", voting: { muhalefet: 5 } }),
    ];
    const d = buildSilenceDigest(bundles);
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
