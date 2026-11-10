import { describe, it, expect } from "vitest";

import {
  SPECTRUM_ABSENT_QUALIFIED,
  dominantZonePercent,
  isOnlyZone,
  nonVotingOutsideZone,
  onlyZoneClaim,
  uniqueSources,
  zoneCountsOf,
  zonePercents,
} from "./zone-summary";
import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import type { BiasCategory, BiasDistribution, MediaDnaZone, SourceKind } from "@/types";

function dist(partial: Partial<BiasDistribution>): BiasDistribution {
  return { ...emptyBiasDistribution(), ...partial };
}

describe("zoneCountsOf", () => {
  it("sums bias categories into their Medya DNA zones", () => {
    const counts = zoneCountsOf(
      dist({ pro_government: 3, nationalist: 1, center: 2, opposition: 4 }),
    );
    expect(counts).toEqual({ iktidar: 4, bagimsiz: 2, muhalefet: 4 });
  });

  it("returns all zeros for an empty distribution", () => {
    expect(zoneCountsOf(emptyBiasDistribution())).toEqual({
      iktidar: 0,
      bagimsiz: 0,
      muhalefet: 0,
    });
  });
});

describe("zonePercents", () => {
  it("applies largest-remainder rounding on a 1/1/1 split (34/33/33)", () => {
    const percents = zonePercents({ iktidar: 1, bagimsiz: 1, muhalefet: 1 });
    expect(percents).toEqual({ iktidar: 34, bagimsiz: 33, muhalefet: 33 });
  });

  it("gives the leftover point to the zone with the largest remainder", () => {
    expect(zonePercents({ iktidar: 2, bagimsiz: 1, muhalefet: 3 })).toEqual({
      iktidar: 33,
      bagimsiz: 17,
      muhalefet: 50,
    });
  });

  it("breaks a tied remainder in ZONE_ORDER (iktidar, bagimsiz, muhalefet)", () => {
    expect(
      zonePercents({ iktidar: 1, bagimsiz: 1, muhalefet: 4 }),
    ).toEqual({ iktidar: 17, bagimsiz: 17, muhalefet: 66 });
  });

  it("always sums to exactly 100 when total > 0", () => {
    for (const counts of [
      { iktidar: 1, bagimsiz: 1, muhalefet: 1 },
      { iktidar: 7, bagimsiz: 2, muhalefet: 1 },
      { iktidar: 5, bagimsiz: 3, muhalefet: 2 },
      { iktidar: 1, bagimsiz: 0, muhalefet: 0 },
    ]) {
      const percents = zonePercents(counts);
      expect(percents.iktidar + percents.bagimsiz + percents.muhalefet).toBe(
        100,
      );
    }
  });

  it("is deterministic across repeated calls with the same input", () => {
    const counts = { iktidar: 1, bagimsiz: 1, muhalefet: 1 };
    expect(zonePercents(counts)).toEqual(zonePercents(counts));
  });

  it("returns all zeros when the total is 0", () => {
    expect(zonePercents({ iktidar: 0, bagimsiz: 0, muhalefet: 0 })).toEqual({
      iktidar: 0,
      bagimsiz: 0,
      muhalefet: 0,
    });
  });
});

const ZONES: MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

describe("dominantZonePercent", () => {
  it("reads 84 (not Math.round's 85) for 11/1/1: the chip must match the bar", () => {
    // 11/13 = 84.6: Math.round gives 85, largest remainder gives 84/8/8.
    expect(
      dominantZonePercent({ iktidar: 11, bagimsiz: 1, muhalefet: 1 }, "iktidar"),
    ).toBe(84);
  });

  it("equals zonePercents(counts)[zone] for every zone of a table of splits (ties, zeros, all-zero)", () => {
    const table: Array<Record<MediaDnaZone, number>> = [
      { iktidar: 11, bagimsiz: 1, muhalefet: 1 },
      { iktidar: 1, bagimsiz: 1, muhalefet: 1 },
      { iktidar: 1, bagimsiz: 1, muhalefet: 4 },
      { iktidar: 2, bagimsiz: 1, muhalefet: 3 },
      { iktidar: 5, bagimsiz: 0, muhalefet: 0 },
      { iktidar: 250, bagimsiz: 1, muhalefet: 0 },
      { iktidar: 4, bagimsiz: 1, muhalefet: 0 },
      { iktidar: 0, bagimsiz: 0, muhalefet: 0 },
    ];
    for (const counts of table) {
      const percents = zonePercents(counts);
      for (const zone of ZONES) {
        expect(dominantZonePercent(counts, zone)).toBe(percents[zone]);
      }
    }
  });

  it("returns 0 for every zone when nothing voted", () => {
    const counts = { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
    for (const zone of ZONES) {
      expect(dominantZonePercent(counts, zone)).toBe(0);
    }
  });

  it("sums to 100 across the three zones whenever total > 0", () => {
    for (const counts of [
      { iktidar: 11, bagimsiz: 1, muhalefet: 1 },
      { iktidar: 1, bagimsiz: 1, muhalefet: 1 },
      { iktidar: 250, bagimsiz: 1, muhalefet: 0 },
      { iktidar: 0, bagimsiz: 0, muhalefet: 3 },
    ]) {
      const sum = ZONES.reduce(
        (acc, zone) => acc + dominantZonePercent(counts, zone),
        0,
      );
      expect(sum).toBe(100);
    }
  });
});

describe("isOnlyZone", () => {
  it("is true when the zone has sources and the other two have exactly none", () => {
    expect(isOnlyZone({ iktidar: 5, bagimsiz: 0, muhalefet: 0 }, "iktidar")).toBe(true);
    expect(isOnlyZone({ iktidar: 0, bagimsiz: 0, muhalefet: 2 }, "muhalefet")).toBe(true);
    expect(isOnlyZone({ iktidar: 0, bagimsiz: 1, muhalefet: 0 }, "bagimsiz")).toBe(true);
  });

  it("is false at 250/1/0 although the rounded share reads 100", () => {
    const counts = { iktidar: 250, bagimsiz: 1, muhalefet: 0 };
    expect(dominantZonePercent(counts, "iktidar")).toBe(100);
    expect(isOnlyZone(counts, "iktidar")).toBe(false);
  });

  it("is false when nobody voted", () => {
    expect(isOnlyZone({ iktidar: 0, bagimsiz: 0, muhalefet: 0 }, "iktidar")).toBe(false);
  });

  it("is false for a zone with no sources even when the others have", () => {
    expect(isOnlyZone({ iktidar: 5, bagimsiz: 0, muhalefet: 0 }, "muhalefet")).toBe(false);
  });

  it("is false when two other zones are split", () => {
    expect(isOnlyZone({ iktidar: 3, bagimsiz: 0, muhalefet: 2 }, "iktidar")).toBe(false);
  });
});

// h43-blindspots-1: "Sadece İktidar yazdı" is decided on the VOTING tally, so
// it can print over a story that a toplayıcı / niş source from another zone
// also carried (cluster 5692a4a1: İşçi Haber, a niche Muhalefet source). The
// helper counts those outsiders so the chip can qualify its claim.
describe("nonVotingOutsideZone", () => {
  type Src = { kind?: SourceKind | null; bias: BiasCategory };

  // Shaped like cluster 5692a4a1-3c17-429e-87d1-8a5af5741ec6: ten voting
  // İktidar sources (nine outlets and the wire anadolu-ajansi), plus three
  // non-voting ones: haberler-com (aggregator, gov_leaning: İktidar),
  // ajans-haber (aggregator, center: Bağımsız) and isci-haber (niche,
  // opposition: Muhalefet).
  const voting10: Src[] = [
    ...Array.from({ length: 6 }, (): Src => ({ kind: "outlet", bias: "gov_leaning" })),
    ...Array.from({ length: 3 }, (): Src => ({ kind: "outlet", bias: "pro_government" })),
    { kind: "wire", bias: "pro_government" },
  ];
  const cluster5692: Src[] = [
    ...voting10,
    { kind: "aggregator", bias: "gov_leaning" },
    { kind: "aggregator", bias: "center" },
    { kind: "niche", bias: "opposition" },
  ];

  it("counts the 5692a4a1-shaped fixture as 2 outsiders for iktidar", () => {
    expect(nonVotingOutsideZone(cluster5692, "iktidar")).toBe(2);
  });

  it("answers per zone: the non-voting sources NOT in that zone", () => {
    // bagimsiz: haberler-com (İktidar) and isci-haber (Muhalefet) are outside.
    expect(nonVotingOutsideZone(cluster5692, "bagimsiz")).toBe(2);
    // muhalefet: haberler-com (İktidar) and ajans-haber (Bağımsız) are outside.
    expect(nonVotingOutsideZone(cluster5692, "muhalefet")).toBe(2);
  });

  it("does not count a non-voting source inside the zone itself", () => {
    expect(
      nonVotingOutsideZone([{ kind: "aggregator", bias: "gov_leaning" }], "iktidar"),
    ).toBe(0);
    expect(
      nonVotingOutsideZone([{ kind: "niche", bias: "opposition_leaning" }], "muhalefet"),
    ).toBe(0);
    expect(nonVotingOutsideZone([{ kind: "niche", bias: "center" }], "bagimsiz")).toBe(0);
  });

  it("never counts voting kinds (outlet, wire), whatever their zone", () => {
    expect(
      nonVotingOutsideZone(
        [
          { kind: "outlet", bias: "opposition" },
          { kind: "wire", bias: "center" },
        ],
        "iktidar",
      ),
    ).toBe(0);
  });

  it("treats a null or missing kind as voting (isVotingKind's default)", () => {
    expect(
      nonVotingOutsideZone(
        [
          { kind: null, bias: "opposition" },
          { bias: "center" },
          { kind: undefined, bias: "opposition_leaning" },
        ],
        "iktidar",
      ),
    ).toBe(0);
  });

  it("treats an unrecognised kind string as the default (voting), not as non-voting", () => {
    expect(
      nonVotingOutsideZone(
        [{ kind: "podcast" as unknown as SourceKind, bias: "opposition" }],
        "iktidar",
      ),
    ).toBe(0);
  });

  it("maps every one of the ten bias keys through BIAS_TO_ZONE (legacy keys included)", () => {
    const zoneOfKey: Record<BiasCategory, MediaDnaZone> = {
      pro_government: "iktidar",
      gov_leaning: "iktidar",
      state_media: "iktidar",
      islamist_conservative: "iktidar",
      nationalist: "iktidar",
      center: "bagimsiz",
      international: "bagimsiz",
      pro_kurdish: "bagimsiz",
      opposition_leaning: "muhalefet",
      opposition: "muhalefet",
    };
    for (const [bias, zone] of Object.entries(zoneOfKey) as Array<[BiasCategory, MediaDnaZone]>) {
      for (const probe of ZONES) {
        expect(nonVotingOutsideZone([{ kind: "niche", bias }], probe)).toBe(
          zone === probe ? 0 : 1,
        );
      }
    }
  });

  it("counts every kind that is not voting: aggregator and niche", () => {
    expect(
      nonVotingOutsideZone(
        [
          { kind: "aggregator", bias: "opposition" },
          { kind: "niche", bias: "center" },
        ],
        "iktidar",
      ),
    ).toBe(2);
  });

  it("is 0 for an empty list and for an all-voting list", () => {
    expect(nonVotingOutsideZone([], "iktidar")).toBe(0);
    expect(nonVotingOutsideZone(voting10, "iktidar")).toBe(0);
    expect(nonVotingOutsideZone(voting10, "muhalefet")).toBe(0);
  });

  it("does not mutate its input", () => {
    const input = cluster5692.map((s) => ({ ...s }));
    const before = JSON.stringify(input);
    nonVotingOutsideZone(input, "iktidar");
    expect(JSON.stringify(input)).toBe(before);
  });

  it("handles a large list (10k sources)", () => {
    const big: Src[] = Array.from({ length: 10_000 }, (_, i): Src => ({
      kind: i % 2 === 0 ? "niche" : "outlet",
      bias: "opposition",
    }));
    expect(nonVotingOutsideZone(big, "iktidar")).toBe(5_000);
    expect(nonVotingOutsideZone(big, "muhalefet")).toBe(0);
  });
});

// h57-outbound-1: the OG ribbon, the share text, the embed, the Manşet Kartı and
// the digest decided "sadece X yazdı" on the voting counts alone, while
// /blindspots and the cluster timeline already qualified it when a toplayıcı /
// niş source from another zone carried the story. onlyZoneClaim is the one
// decision all of them now read.
describe("onlyZoneClaim (h57-outbound-1)", () => {
  type Src = { kind?: SourceKind | null; bias: BiasCategory };

  // Shaped like cluster 0b127dc3-444a-48fb-a045-6d97086e4074: nine voting
  // İktidar members (outlets and the wire), plus son-dakika (aggregator,
  // center: Bağımsız), isci-haber (niche, opposition: Muhalefet) and
  // haberler-com (aggregator, gov_leaning: İktidar).
  const voting9: Src[] = [
    ...Array.from({ length: 5 }, (): Src => ({ kind: "outlet", bias: "pro_government" })),
    ...Array.from({ length: 3 }, (): Src => ({ kind: "outlet", bias: "gov_leaning" })),
    { kind: "wire", bias: "pro_government" },
  ];
  const cluster0b127: Src[] = [
    ...voting9,
    { kind: "aggregator", bias: "center" },
    { kind: "niche", bias: "opposition" },
    { kind: "aggregator", bias: "gov_leaning" },
  ];
  // The control keeps only haberler-com, which sits inside the İktidar zone.
  const control: Src[] = [...voting9, { kind: "aggregator", bias: "gov_leaning" }];

  const onlyIktidar = { iktidar: 9, bagimsiz: 0, muhalefet: 0 };

  it("the 0b127dc3-shaped fixture has 2 outsiders for iktidar, the control 0", () => {
    expect(nonVotingOutsideZone(cluster0b127, "iktidar")).toBe(2);
    expect(nonVotingOutsideZone(control, "iktidar")).toBe(0);
  });

  it("is 'spectrumOnly' when the zone is the only voting zone and an outsider carried the story", () => {
    const outside = nonVotingOutsideZone(cluster0b127, "iktidar");
    expect(onlyZoneClaim(onlyIktidar, "iktidar", outside)).toBe("spectrumOnly");
    expect(onlyZoneClaim(onlyIktidar, "iktidar", 1)).toBe("spectrumOnly");
  });

  it("is 'only' when the zone is the only voting zone and nobody else carried it (the control)", () => {
    const outside = nonVotingOutsideZone(control, "iktidar");
    expect(onlyZoneClaim(onlyIktidar, "iktidar", outside)).toBe("only");
    expect(onlyZoneClaim(onlyIktidar, "iktidar", 0)).toBe("only");
  });

  it("is 'weighted' whenever isOnlyZone is false, whatever the outsider count", () => {
    for (const outside of [0, 1, 5]) {
      // 250/1/0 rounds to 100 but another zone has a voting source.
      expect(onlyZoneClaim({ iktidar: 250, bagimsiz: 1, muhalefet: 0 }, "iktidar", outside)).toBe("weighted");
      // The zone named has no source while another does.
      expect(onlyZoneClaim(onlyIktidar, "muhalefet", outside)).toBe("weighted");
      // Two other zones split.
      expect(onlyZoneClaim({ iktidar: 3, bagimsiz: 0, muhalefet: 2 }, "iktidar", outside)).toBe("weighted");
      // Nobody voted.
      expect(onlyZoneClaim({ iktidar: 0, bagimsiz: 0, muhalefet: 0 }, "iktidar", outside)).toBe("weighted");
    }
  });

  it("agrees with isOnlyZone on every table row (only/spectrumOnly iff isOnlyZone)", () => {
    const table: Array<Record<MediaDnaZone, number>> = [
      { iktidar: 5, bagimsiz: 0, muhalefet: 0 },
      { iktidar: 0, bagimsiz: 1, muhalefet: 0 },
      { iktidar: 0, bagimsiz: 0, muhalefet: 2 },
      { iktidar: 250, bagimsiz: 1, muhalefet: 0 },
      { iktidar: 3, bagimsiz: 0, muhalefet: 2 },
      { iktidar: 0, bagimsiz: 0, muhalefet: 0 },
    ];
    for (const counts of table) {
      for (const zone of ZONES) {
        for (const outside of [0, 2]) {
          expect(onlyZoneClaim(counts, zone, outside) !== "weighted").toBe(isOnlyZone(counts, zone));
        }
      }
    }
  });

  it("is a pure function of its arguments: it never reads or changes the counts", () => {
    const counts = { ...onlyIktidar };
    onlyZoneClaim(counts, "iktidar", 2);
    expect(counts).toEqual(onlyIktidar);
  });
});

// h108-sharesurfaces-1: /blindspots and the framing comparison already say
// "Kümede sadece X" when Jev matched a silent zone with the same event
// (h106-blindspotbadges-1); the outbound surfaces read onlyZoneClaim, which had
// no recall input. The fourth argument is the number of matched zones.
describe("onlyZoneClaim, recall-matched zones (h108-sharesurfaces-1)", () => {
  const only9 = { iktidar: 9, bagimsiz: 0, muhalefet: 0 };

  it("is 'clusterOnly' for a 9/0/0 count when Jev matched one silent zone", () => {
    expect(onlyZoneClaim(only9, "iktidar", 0, 1)).toBe("clusterOnly");
    expect(onlyZoneClaim(only9, "iktidar", 0, 2)).toBe("clusterOnly");
  });

  it("keeps 'spectrumOnly' ahead of it: a toplayici / nis outsider wins, as on /blindspots", () => {
    expect(onlyZoneClaim(only9, "iktidar", 1, 1)).toBe("spectrumOnly");
    expect(onlyZoneClaim(only9, "iktidar", 3, 2)).toBe("spectrumOnly");
  });

  it("the default argument gives exactly today's results", () => {
    for (const outside of [0, 1, 4]) {
      expect(onlyZoneClaim(only9, "iktidar", outside)).toBe(
        onlyZoneClaim(only9, "iktidar", outside, 0),
      );
    }
    expect(onlyZoneClaim(only9, "iktidar", 0)).toBe("only");
    expect(onlyZoneClaim(only9, "iktidar", 2)).toBe("spectrumOnly");
  });

  it("a zero or negative count is no match: 'only'", () => {
    expect(onlyZoneClaim(only9, "iktidar", 0, 0)).toBe("only");
    expect(onlyZoneClaim(only9, "iktidar", 0, -1)).toBe("only");
  });

  it("stays 'weighted' whenever isOnlyZone is false, whatever the recall count", () => {
    for (const recall of [0, 1, 3]) {
      expect(onlyZoneClaim({ iktidar: 250, bagimsiz: 1, muhalefet: 0 }, "iktidar", 0, recall)).toBe("weighted");
      expect(onlyZoneClaim(only9, "muhalefet", 0, recall)).toBe("weighted");
      expect(onlyZoneClaim({ iktidar: 3, bagimsiz: 0, muhalefet: 2 }, "iktidar", 2, recall)).toBe("weighted");
      expect(onlyZoneClaim({ iktidar: 0, bagimsiz: 0, muhalefet: 0 }, "iktidar", 0, recall)).toBe("weighted");
    }
  });

  it("is never a different 'weighted' / not-weighted answer than isOnlyZone", () => {
    const table: Array<Record<MediaDnaZone, number>> = [
      { iktidar: 5, bagimsiz: 0, muhalefet: 0 },
      { iktidar: 0, bagimsiz: 1, muhalefet: 0 },
      { iktidar: 250, bagimsiz: 1, muhalefet: 0 },
      { iktidar: 3, bagimsiz: 0, muhalefet: 2 },
      { iktidar: 0, bagimsiz: 0, muhalefet: 0 },
    ];
    for (const counts of table) {
      for (const zone of ZONES) {
        for (const outside of [0, 2]) {
          for (const recall of [0, 1]) {
            expect(onlyZoneClaim(counts, zone, outside, recall) !== "weighted").toBe(
              isOnlyZone(counts, zone),
            );
          }
        }
      }
    }
  });

  it("never reads or changes the counts", () => {
    const counts = { ...only9 };
    onlyZoneClaim(counts, "iktidar", 0, 2);
    expect(counts).toEqual(only9);
  });
});

describe("uniqueSources (h57-outbound-1)", () => {
  const mk = (slug: string, bias: BiasCategory = "center") => ({ slug, bias });

  it("keeps one source per slug, first occurrence first", () => {
    const a = mk("a");
    const b = mk("b");
    const out = uniqueSources([{ source: a }, { source: b }, { source: mk("a") }, { source: b }]);
    expect(out).toEqual([a, b]);
    expect(out[0]).toBe(a);
  });

  it("is empty for no members", () => {
    expect(uniqueSources([])).toEqual([]);
  });

  it("does not collapse distinct slugs that merely share a bias", () => {
    expect(uniqueSources([{ source: mk("a") }, { source: mk("b") }])).toHaveLength(2);
  });

  it("does not mutate its input", () => {
    const input = [{ source: mk("a") }, { source: mk("a") }];
    const before = JSON.stringify(input);
    uniqueSources(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("counts one outlet that wrote several articles once, so nonVotingOutsideZone does not double count", () => {
    const sourceOf = (slug: string, kind: SourceKind, bias: BiasCategory) => ({ slug, kind, bias });
    const niche = sourceOf("isci-haber", "niche", "opposition");
    const members = [{ source: niche }, { source: niche }, { source: sourceOf("a", "outlet", "pro_government") }];
    expect(nonVotingOutsideZone(members.map((m) => m.source), "iktidar")).toBe(2);
    expect(nonVotingOutsideZone(uniqueSources(members), "iktidar")).toBe(1);
  });
});

// h58-postship-2: one phrase for "this zone has no source the spectrum counts,
// but a toplayıcı / niş source of it wrote", shared by the Manşet Kartı and the
// cluster page's framing comparison so the two cannot word it differently.
describe("SPECTRUM_ABSENT_QUALIFIED", () => {
  it("is the Kart's qualified wording, verbatim and lower-case, without the dashes", () => {
    expect(SPECTRUM_ABSENT_QUALIFIED).toBe("spektruma sayılan kaynaklardan haber yok");
  });

  it("carries no surrounding dash or space, so each surface frames it itself", () => {
    expect(SPECTRUM_ABSENT_QUALIFIED).toBe(SPECTRUM_ABSENT_QUALIFIED.trim());
    expect(SPECTRUM_ABSENT_QUALIFIED).not.toMatch(/[—–-]/);
  });
});
