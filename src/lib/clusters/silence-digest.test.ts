import { describe, it, expect } from "vitest";

import * as silenceModule from "./silence-digest";
import {
  ZONE_ROW_ORDER,
  blindspotCountLine,
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

// h53-consistency-1: the band used to count only the 30 cards on the page. It
// now counts every public claim of the trailing 7 days, and the footnote says
// how many of those are shown as full cards (the rest are compact rows below).
describe("silenceFootnote with a scope (h53-consistency-1)", () => {
  const RULE =
    "Bir bölgedeki gazete, TV ve ajanslardan hiçbiri haberi yapmadıysa “yer vermedi” sayılır (toplayıcı ve niş siteler, kör nokta hesabında olduğu gibi, sayılmaz); bir hikâye birden fazla satırda sayılabilir.";

  it("names the window, the counted stories and how many are cards", () => {
    expect(silenceFootnote(46, { windowDays: 7, shown: 30 })).toBe(
      `Son 7 günün 46 kör nokta hikâyesi sayıldı; listede 30 tanesi kart olarak gösteriliyor. ${RULE}`,
    );
  });

  it("drops the card clause when every counted story is a card", () => {
    expect(silenceFootnote(12, { windowDays: 7, shown: 12 })).toBe(
      `Son 7 günün 12 kör nokta hikâyesi sayıldı. ${RULE}`,
    );
    expect(silenceFootnote(1, { windowDays: 7, shown: 1 })).not.toContain("kart olarak");
  });

  it("leaves the default wording exactly as it was for any caller without a scope", () => {
    expect(silenceFootnote(2)).toBe(`Bu sayfadaki 2 kör nokta hikâyesi sayıldı. ${RULE}`);
    expect(silenceFootnote(2, undefined)).toBe(silenceFootnote(2));
  });

  it("keeps the voting-kind rule and the multi-row caveat in the scoped wording", () => {
    const text = silenceFootnote(46, { windowDays: 7, shown: 30 });
    expect(text).toContain("toplayıcı ve niş siteler, kör nokta hesabında olduğu gibi, sayılmaz");
    expect(text).toContain("bir hikâye birden fazla satırda sayılabilir");
    expect(text).not.toContain("Bu sayfadaki");
  });

  it("buildSilenceDigest stays a function of the bundles alone", () => {
    expect(buildSilenceDigest.length).toBe(1);
  });
});

describe("buildSilenceDigest over a whole window (h53-consistency-1)", () => {
  it("counts all 46 claims, not a page of 30", () => {
    const claims = [
      ...Array.from({ length: 37 }, (_, i) =>
        mkBundle({ id: `ik-${i}`, dominantZone: "iktidar", voting: { iktidar: 5 } }),
      ),
      ...Array.from({ length: 9 }, (_, i) =>
        mkBundle({ id: `mu-${i}`, dominantZone: "muhalefet", voting: { muhalefet: 5 } }),
      ),
    ];
    const d = buildSilenceDigest(claims);
    expect(d.windowTotal).toBe(46);
    // Muhalefet was silent on all 37 Iktidar claims, Iktidar on all 9 Muhalefet ones.
    expect(row(d, "muhalefet").silentCount).toBe(37);
    expect(row(d, "iktidar").silentCount).toBe(9);
  });
});

describe("blindspotCountLine", () => {
  it("reads 'Son 7 günde N kör nokta · İktidar tarafında a · Muhalefet tarafında b'", () => {
    expect(
      blindspotCountLine(46, { iktidar: 37, bagimsiz: 0, muhalefet: 9 }, 7),
    ).toBe("Son 7 günde 46 kör nokta · İktidar tarafında 37 · Muhalefet tarafında 9");
  });

  it("always names Iktidar and Muhalefet, even at 0 (a zero is a finding)", () => {
    expect(
      blindspotCountLine(3, { iktidar: 3, bagimsiz: 0, muhalefet: 0 }, 7),
    ).toBe("Son 7 günde 3 kör nokta · İktidar tarafında 3 · Muhalefet tarafında 0");
  });

  it("adds Bağımsız only when it is above zero", () => {
    expect(
      blindspotCountLine(6, { iktidar: 3, bagimsiz: 2, muhalefet: 1 }, 7),
    ).toBe(
      "Son 7 günde 6 kör nokta · İktidar tarafında 3 · Muhalefet tarafında 1 · Bağımsız tarafında 2",
    );
  });

  it("is null when there is no claim, so the empty state speaks instead", () => {
    expect(blindspotCountLine(0, { iktidar: 0, bagimsiz: 0, muhalefet: 0 }, 7)).toBeNull();
  });

  it("groups thousands the Turkish way", () => {
    expect(
      blindspotCountLine(1234, { iktidar: 1000, bagimsiz: 0, muhalefet: 234 }, 7),
    ).toBe("Son 7 günde 1.234 kör nokta · İktidar tarafında 1.000 · Muhalefet tarafında 234");
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
      silenceFootnote(46, { windowDays: 7, shown: 30 }),
      silenceFootnote(12, { windowDays: 7, shown: 12 }),
      blindspotCountLine(46, { iktidar: 37, bagimsiz: 2, muhalefet: 7 }, 7) ?? "",
    ];
    for (const s of strings) {
      expect(s).not.toContain("görmezden");
      expect(s).not.toContain("sustu");
      expect(s).not.toContain("gizledi");
    }
  });
});
