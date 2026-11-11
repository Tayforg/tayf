import { describe, it, expect } from "vitest";

import {
  buildChannelShareHref,
  buildShareText,
  buildShareUrl,
  SHARE_LINK_CHANNELS,
} from "./share";
import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import type { BiasCategory, BiasDistribution, SourceKind } from "@/types";

function dist(partial: Partial<BiasDistribution>): BiasDistribution {
  return { ...emptyBiasDistribution(), ...partial };
}

describe("buildShareText", () => {
  it("formats article count and zone percents, sign-first", () => {
    // Fixture fix (hunt-20 numbers-3): this used articleCount 12 over a
    // distribution of 10 votes, which is now (correctly) a "10 sınıflandırılmış"
    // head. Equal totals keep the plain format, so the count is 10.
    const text = buildShareText({
      articleCount: 10,
      distribution: dist({ pro_government: 7, center: 2, opposition: 1 }),
      isBlindspot: false,
      blindspotSide: null,
    });
    expect(text).toBe(
      "10 kaynak · %70 iktidar · %20 bağımsız · %10 muhalefet",
    );
  });

  it("appends the blindspot line using blindspot_side's zone", () => {
    const text = buildShareText({
      articleCount: 4,
      distribution: dist({ pro_government: 4 }),
      isBlindspot: true,
      blindspotSide: "pro_government",
    });
    expect(text).toBe(
      "4 kaynak · %100 iktidar · %0 bağımsız · %0 muhalefet · Kör nokta: sadece iktidar yazdı",
    );
  });

  it("falls back to the dominant zone when blindspot_side is null", () => {
    const text = buildShareText({
      articleCount: 5,
      distribution: dist({ opposition: 5 }),
      isBlindspot: true,
      blindspotSide: null,
    });
    expect(text).toContain("Kör nokta: sadece muhalefet yazdı");
  });

  it("uses the %share form (not 'sadece') when the DB flag fires below 100%", () => {
    // 4-of-5 = 80% share, the contract's minimum flagging threshold.
    const text = buildShareText({
      articleCount: 5,
      distribution: dist({ pro_government: 4, opposition: 1 }),
      isBlindspot: true,
      blindspotSide: "pro_government",
    });
    expect(text).toBe(
      "5 kaynak · %80 iktidar · %0 bağımsız · %20 muhalefet · Kör nokta: iktidar ağırlıklı",
    );
  });

  it("says 'ağırlıklı', not 'sadece', at 250/1/0 although the share rounds to 100", () => {
    const text = buildShareText({
      articleCount: 251,
      distribution: dist({ pro_government: 250, center: 1 }),
      isBlindspot: true,
      blindspotSide: "pro_government",
    });
    expect(text).toContain("Kör nokta: iktidar ağırlıklı");
    expect(text).not.toContain("sadece");
  });

  it("says 'sadece <zone> yazdı' when the zone is the only one with sources (several categories, one zone)", () => {
    const text = buildShareText({
      articleCount: 5,
      distribution: dist({ pro_government: 3, state_media: 2 }),
      isBlindspot: true,
      blindspotSide: "state_media",
    });
    expect(text).toContain("Kör nokta: sadece iktidar yazdı");
  });

  it("does not say 'sadece' when blindspot_side's zone is not the only zone with sources", () => {
    const text = buildShareText({
      articleCount: 5,
      distribution: dist({ pro_government: 5 }),
      isBlindspot: true,
      blindspotSide: "opposition",
    });
    expect(text).toContain("Kör nokta: muhalefet ağırlıklı");
    expect(text).not.toContain("sadece");
  });

  it("appends the wire-redistribution suffix when wire.isWireRedistribution is true", () => {
    const text = buildShareText({
      articleCount: 2,
      distribution: dist({ pro_government: 2 }),
      isBlindspot: false,
      blindspotSide: null,
      wire: { isWireRedistribution: true, memberCount: 7 },
    });
    // articleCount is the honest source count (the page passes
    // wire.effectiveArticleCount): 2 distinct texts behind 7 members.
    expect(text).toBe(
      "2 kaynak · %100 iktidar · %0 bağımsız · %0 muhalefet · 7 haber · 2 farklı metin",
    );
    expect(text).not.toContain("tek kaynak");
  });

  it("keeps the single-source wording only when one text is behind every member (articleCount 1)", () => {
    const text = buildShareText({
      articleCount: 1,
      distribution: dist({ pro_government: 1 }),
      isBlindspot: false,
      blindspotSide: null,
      wire: { isWireRedistribution: true, memberCount: 7 },
    });
    expect(text).toBe(
      "1 kaynak · %100 iktidar · %0 bağımsız · %0 muhalefet · 7 kopya · tek kaynak",
    );
  });

  it("omits the wire suffix when wire.isWireRedistribution is false", () => {
    const text = buildShareText({
      articleCount: 2,
      distribution: dist({ pro_government: 2 }),
      isBlindspot: false,
      blindspotSide: null,
      wire: { isWireRedistribution: false, memberCount: 2 },
    });
    expect(text).not.toContain("kopya");
  });

  // INTENDED FLIP (hunt-20 numbers-3): with nobody classified there is nothing to
  // take a percent of, so the text says so instead of printing three "%0"s.
  it("handles a zero distribution without throwing", () => {
    const text = buildShareText({
      articleCount: 0,
      distribution: emptyBiasDistribution(),
      isBlindspot: false,
      blindspotSide: null,
    });
    expect(text).toBe("0 kaynak · sınıflandırılmış kaynak yok");
  });

  describe("classified total vs member count (hunt-20 numbers-3)", () => {
    it("names the classified total when it is smaller than articleCount", () => {
      // 14 sources, 3 of them aggregator / niche: the percents are 6/11, 1/11, 4/11.
      const text = buildShareText({
        articleCount: 14,
        distribution: dist({ pro_government: 6, center: 1, opposition: 4 }),
        isBlindspot: false,
        blindspotSide: null,
      });
      expect(text).toBe(
        "14 kaynak · 11 sınıflandırılmış: %55 iktidar · %9 bağımsız · %36 muhalefet",
      );
    });

    it("says there are no classified sources when the distribution is empty", () => {
      const text = buildShareText({
        articleCount: 2,
        distribution: emptyBiasDistribution(),
        isBlindspot: false,
        blindspotSide: null,
      });
      expect(text).toBe("2 kaynak · sınıflandırılmış kaynak yok");
      expect(text).not.toContain("%");
    });

    it("leaves the text unchanged when the classified total equals articleCount", () => {
      const text = buildShareText({
        articleCount: 20,
        distribution: dist({ pro_government: 12, center: 5, opposition: 3 }),
        isBlindspot: false,
        blindspotSide: null,
      });
      expect(text).toBe("20 kaynak · %60 iktidar · %25 bağımsız · %15 muhalefet");
      expect(text).not.toContain("sınıflandırılmış");
    });

    it("sums several categories of one zone into the classified total", () => {
      // 3 + 2 iktidar categories + 1 opposition = 6 classified of 9.
      const text = buildShareText({
        articleCount: 9,
        distribution: dist({ pro_government: 3, state_media: 2, opposition: 1 }),
        isBlindspot: false,
        blindspotSide: null,
      });
      expect(text).toBe(
        "9 kaynak · 6 sınıflandırılmış: %83 iktidar · %0 bağımsız · %17 muhalefet",
      );
    });

    it("appends the blindspot suffix after the new head", () => {
      const text = buildShareText({
        articleCount: 5,
        distribution: dist({ pro_government: 4 }),
        isBlindspot: true,
        blindspotSide: "pro_government",
      });
      expect(text).toBe(
        "5 kaynak · 4 sınıflandırılmış: %100 iktidar · %0 bağımsız · %0 muhalefet · Kör nokta: sadece iktidar yazdı",
      );
    });

    it("appends the wire suffix after the new head", () => {
      const text = buildShareText({
        articleCount: 4,
        distribution: dist({ pro_government: 2, opposition: 1 }),
        isBlindspot: false,
        blindspotSide: null,
        wire: { isWireRedistribution: true, memberCount: 9 },
      });
      expect(text).toBe(
        "4 kaynak · 3 sınıflandırılmış: %67 iktidar · %0 bağımsız · %33 muhalefet · 9 haber · 4 farklı metin",
      );
    });

    it("appends the wire suffix after the no-classified-sources head", () => {
      const text = buildShareText({
        articleCount: 2,
        distribution: emptyBiasDistribution(),
        isBlindspot: false,
        blindspotSide: null,
        wire: { isWireRedistribution: true, memberCount: 7 },
      });
      expect(text).toBe(
        "2 kaynak · sınıflandırılmış kaynak yok · 7 haber · 2 farklı metin",
      );
    });

    // Wire clusters: the page passes the distinct-text count as `articleCount`,
    // so the votes (one per classified member) can outnumber it. The head must
    // then name the voting total, or %80/%20 would sit next to "2 kaynak".
    it("names the voting total when classified exceeds articleCount (wire case)", () => {
      const text = buildShareText({
        articleCount: 2,
        distribution: dist({ pro_government: 4, opposition: 1 }),
        isBlindspot: false,
        blindspotSide: null,
        wire: { isWireRedistribution: true, memberCount: 7 },
      });
      expect(text).toBe(
        "2 kaynak · 5 sınıflandırılmış haber: %80 iktidar · %0 bağımsız · %20 muhalefet · 7 haber · 2 farklı metin",
      );
    });

    it("names the voting total for a single-text wire with mixed outlets", () => {
      const text = buildShareText({
        articleCount: 1,
        distribution: dist({ pro_government: 4, opposition: 4 }),
        isBlindspot: false,
        blindspotSide: null,
        wire: { isWireRedistribution: true, memberCount: 8 },
      });
      expect(text).toBe(
        "1 kaynak · 8 sınıflandırılmış haber: %50 iktidar · %0 bağımsız · %50 muhalefet · 8 kopya · tek kaynak",
      );
    });

    it("keeps the plain head when a wire cluster's votes equal articleCount", () => {
      const text = buildShareText({
        articleCount: 5,
        distribution: dist({ pro_government: 4, opposition: 1 }),
        isBlindspot: false,
        blindspotSide: null,
        wire: { isWireRedistribution: true, memberCount: 9 },
      });
      expect(text).toBe(
        "5 kaynak · %80 iktidar · %0 bağımsız · %20 muhalefet · 9 haber · 5 farklı metin",
      );
    });
  });
});

// h57-outbound-1: "sadece iktidar yazdı" is decided on the voting tally, so it
// printed over a story an aggregator (son-dakika, Bağımsız) and a niche source
// (isci-haber, Muhalefet) from another zone also carried. /blindspots and the
// cluster timeline already say so; the share text now does too.
describe("buildShareText qualifies 'sadece' for non-voting sources (h57-outbound-1)", () => {
  type Src = { kind?: SourceKind | null; bias: BiasCategory };

  // Shaped like cluster 0b127dc3-444a-48fb-a045-6d97086e4074: nine voting
  // İktidar members plus three non-voting ones (12 kaynak, 9 sınıflandırılmış).
  const voting9: Src[] = [
    ...Array.from({ length: 5 }, (): Src => ({ kind: "outlet", bias: "pro_government" })),
    ...Array.from({ length: 3 }, (): Src => ({ kind: "outlet", bias: "gov_leaning" })),
    { kind: "wire", bias: "pro_government" },
  ];
  const SON_DAKIKA: Src = { kind: "aggregator", bias: "center" };
  const ISCI_HABER: Src = { kind: "niche", bias: "opposition" };
  const HABERLER_COM: Src = { kind: "aggregator", bias: "gov_leaning" };
  const fixture: Src[] = [...voting9, SON_DAKIKA, ISCI_HABER, HABERLER_COM];
  const control: Src[] = [...voting9, HABERLER_COM];

  const distribution = dist({ pro_government: 6, gov_leaning: 3 });
  const HEAD = "12 kaynak · 9 sınıflandırılmış: %100 iktidar · %0 bağımsız · %0 muhalefet";
  const base = {
    articleCount: 12,
    distribution,
    isBlindspot: true,
    blindspotSide: "pro_government" as BiasCategory,
  };

  it("ends in ' · Kör nokta: spektrumda sadece iktidar' for the 0b127dc3-shaped fixture", () => {
    expect(buildShareText({ ...base, sources: fixture })).toBe(
      `${HEAD} · Kör nokta: spektrumda sadece iktidar`,
    );
  });

  it("is byte-identical to the old text for the control (only haberler-com, inside the zone)", () => {
    expect(buildShareText({ ...base, sources: control })).toBe(
      `${HEAD} · Kör nokta: sadece iktidar yazdı`,
    );
  });

  it("is byte-identical to the old text when no sources are passed", () => {
    expect(buildShareText(base)).toBe(`${HEAD} · Kör nokta: sadece iktidar yazdı`);
    expect(buildShareText({ ...base, sources: [] })).toBe(`${HEAD} · Kör nokta: sadece iktidar yazdı`);
    expect(buildShareText({ ...base, sources: undefined })).toBe(
      `${HEAD} · Kör nokta: sadece iktidar yazdı`,
    );
  });

  it("one non-voting outsider is enough", () => {
    expect(buildShareText({ ...base, sources: [...voting9, ISCI_HABER] })).toContain(
      "Kör nokta: spektrumda sadece iktidar",
    );
  });

  it("voting sources from other zones never qualify it (they are in the tally already)", () => {
    const text = buildShareText({
      ...base,
      sources: [...voting9, { kind: "outlet", bias: "opposition" }, { kind: null, bias: "center" }, { bias: "center" }],
    });
    expect(text).toBe(`${HEAD} · Kör nokta: sadece iktidar yazdı`);
  });

  it("leaves the 'ağırlıklı' branch unchanged whatever the sources are", () => {
    const text = buildShareText({
      articleCount: 5,
      distribution: dist({ pro_government: 4, opposition: 1 }),
      isBlindspot: true,
      blindspotSide: "pro_government",
      sources: [{ kind: "niche", bias: "center" }],
    });
    expect(text).toBe(
      "5 kaynak · %80 iktidar · %0 bağımsız · %20 muhalefet · Kör nokta: iktidar ağırlıklı",
    );
  });

  it("leaves 250/1/0 on 'ağırlıklı' even with an outsider", () => {
    const text = buildShareText({
      articleCount: 251,
      distribution: dist({ pro_government: 250, center: 1 }),
      isBlindspot: true,
      blindspotSide: "pro_government",
      sources: [{ kind: "niche", bias: "opposition" }],
    });
    expect(text).toContain("Kör nokta: iktidar ağırlıklı");
    expect(text).not.toContain("sadece");
  });

  it("uses the same fallback zone as before when blindspot_side is null", () => {
    const text = buildShareText({
      articleCount: 6,
      distribution: dist({ opposition: 5 }),
      isBlindspot: true,
      blindspotSide: null,
      sources: [{ kind: "outlet", bias: "opposition" }, { kind: "aggregator", bias: "gov_leaning" }],
    });
    expect(text).toContain("Kör nokta: spektrumda sadece muhalefet");
    expect(text).not.toContain("yazdı");
  });

  it("qualifies against the NAMED zone: a non-voting source inside it does not count", () => {
    const text = buildShareText({
      articleCount: 6,
      distribution: dist({ opposition: 5 }),
      isBlindspot: true,
      blindspotSide: "opposition",
      sources: [{ kind: "niche", bias: "opposition_leaning" }],
    });
    expect(text).toContain("Kör nokta: sadece muhalefet yazdı");
  });

  it("adds nothing when the cluster is not a blindspot, however many outsiders", () => {
    const text = buildShareText({ ...base, isBlindspot: false, sources: fixture });
    expect(text).toBe(HEAD);
    expect(text).not.toContain("spektrumda");
  });

  it("keeps the wire suffix after the qualified blindspot suffix", () => {
    const text = buildShareText({
      ...base,
      sources: fixture,
      wire: { isWireRedistribution: true, memberCount: 14 },
    });
    expect(text).toBe(
      `${HEAD} · Kör nokta: spektrumda sadece iktidar · 14 haber · 12 farklı metin`,
    );
  });

  it("changes nothing but the blindspot suffix (counts, percents and the head)", () => {
    const qualified = buildShareText({ ...base, sources: fixture });
    const plain = buildShareText(base);
    expect(qualified.replace(" · Kör nokta: spektrumda sadece iktidar", "")).toBe(
      plain.replace(" · Kör nokta: sadece iktidar yazdı", ""),
    );
  });

  it("does not mutate the sources it is given", () => {
    const input = fixture.map((s) => ({ ...s }));
    const before = JSON.stringify(input);
    buildShareText({ ...base, sources: input });
    expect(JSON.stringify(input)).toBe(before);
  });

  it("reaches all four channel links (WhatsApp, Telegram, X, Bluesky) as the new wording", () => {
    const body = buildShareText({ ...base, sources: fixture });
    const url = buildShareUrl("https://tayf.test", "0b127dc3-444a-48fb-a045-6d97086e4074", "whatsapp");
    const decoded = SHARE_LINK_CHANNELS.map(
      (channel) => new URL(buildChannelShareHref(channel, url, body)).searchParams.get("text") ?? "",
    );
    expect(decoded).toHaveLength(4);
    for (const text of decoded) {
      expect(text).toContain("· Kör nokta: spektrumda sadece iktidar");
      expect(text).not.toContain("yazdı");
    }
  });
});

// h108-sharesurfaces-1: cluster 0746c9d2 (9 İktidar, Jev matched Yeniçağ and Elips
// Haber, both Muhalefet, with the same event in another cluster) said "Kör nokta:
// sadece iktidar yazdı" in the share sheet and every chip, while /blindspots said
// "Kümede sadece İktidar". The page now hands buildShareText the zones Jev matched.
describe("buildShareText, zones Jev matched (h108-sharesurfaces-1)", () => {
  const HEAD = "9 kaynak · %100 iktidar · %0 bağımsız · %0 muhalefet";
  const base = {
    articleCount: 9,
    distribution: dist({ pro_government: 6, gov_leaning: 3 }),
    isBlindspot: true,
    blindspotSide: "pro_government" as BiasCategory,
  };
  const OLD = `${HEAD} · Kör nokta: sadece iktidar yazdı`;
  const NEW = `${HEAD} · Kör nokta: kümede sadece iktidar`;

  it("a 0746c9d2-shaped cluster ends in ' · Kör nokta: kümede sadece iktidar'", () => {
    const text = buildShareText({ ...base, recallMatchedZones: ["muhalefet"] });
    expect(text).toBe(NEW);
    expect(text).not.toContain("sadece iktidar yazdı");
    expect(text).not.toContain("yazdı");
  });

  it("one match is enough, and so are two", () => {
    expect(buildShareText({ ...base, recallMatchedZones: ["bagimsiz"] })).toBe(NEW);
    expect(buildShareText({ ...base, recallMatchedZones: ["bagimsiz", "muhalefet"] })).toBe(NEW);
  });

  it("is byte-identical to today's text with [] (a failed lookup) and with the field undefined (an old cache entry)", () => {
    expect(buildShareText({ ...base, recallMatchedZones: [] })).toBe(OLD);
    expect(buildShareText({ ...base, recallMatchedZones: undefined })).toBe(OLD);
    expect(buildShareText(base)).toBe(OLD);
  });

  it("names the NAMED zone in lower case, also when blindspot_side is null (tally fallback)", () => {
    const text = buildShareText({
      articleCount: 6,
      distribution: dist({ opposition: 5, opposition_leaning: 1 }),
      isBlindspot: true,
      blindspotSide: null,
      recallMatchedZones: ["iktidar"],
    });
    expect(text).toContain("Kör nokta: kümede sadece muhalefet");
    expect(text).not.toContain("yazdı");
  });

  it("keeps the toplayıcı / niş qualifier ahead of it (precedence, as on /blindspots)", () => {
    const text = buildShareText({
      ...base,
      sources: [
        ...Array.from({ length: 9 }, (): { kind: SourceKind; bias: BiasCategory } => ({
          kind: "outlet",
          bias: "pro_government",
        })),
        { kind: "niche", bias: "opposition" },
      ],
      recallMatchedZones: ["bagimsiz"],
    });
    expect(text).toBe(`${HEAD} · Kör nokta: spektrumda sadece iktidar`);
  });

  it("a source list with no outsider does not hide the recall wording", () => {
    const text = buildShareText({
      ...base,
      sources: Array.from({ length: 9 }, (): { kind: SourceKind; bias: BiasCategory } => ({
        kind: "outlet",
        bias: "pro_government",
      })),
      recallMatchedZones: ["muhalefet"],
    });
    expect(text).toBe(NEW);
  });

  it("leaves 'ağırlıklı' alone: another zone has a voting source", () => {
    const text = buildShareText({
      articleCount: 5,
      distribution: dist({ pro_government: 4, opposition: 1 }),
      isBlindspot: true,
      blindspotSide: "pro_government",
      recallMatchedZones: ["bagimsiz"],
    });
    expect(text).toBe(
      "5 kaynak · %80 iktidar · %0 bağımsız · %20 muhalefet · Kör nokta: iktidar ağırlıklı",
    );
  });

  it("adds nothing when the cluster is not a blindspot", () => {
    const text = buildShareText({ ...base, isBlindspot: false, recallMatchedZones: ["muhalefet"] });
    expect(text).toBe(HEAD);
  });

  it("changes nothing but the blindspot suffix (counts, percents and the head)", () => {
    const matched = buildShareText({ ...base, recallMatchedZones: ["muhalefet"] });
    const plain = buildShareText(base);
    expect(matched.replace(" · Kör nokta: kümede sadece iktidar", "")).toBe(
      plain.replace(" · Kör nokta: sadece iktidar yazdı", ""),
    );
  });

  it("keeps the wire suffix after the recall suffix", () => {
    const text = buildShareText({
      ...base,
      recallMatchedZones: ["muhalefet"],
      wire: { isWireRedistribution: true, memberCount: 14 },
    });
    expect(text).toBe(`${NEW} · 14 haber · 9 farklı metin`);
  });

  it("does not mutate the zones it is given", () => {
    const zones: Array<"bagimsiz" | "muhalefet"> = ["muhalefet", "bagimsiz"];
    buildShareText({ ...base, recallMatchedZones: zones });
    expect(zones).toEqual(["muhalefet", "bagimsiz"]);
  });

  it("reaches all four channel links (WhatsApp, Telegram, X, Bluesky) as the new wording", () => {
    const body = buildShareText({ ...base, recallMatchedZones: ["muhalefet"] });
    const url = buildShareUrl("https://tayf.test", "0746c9d2-8f33-4bad-b2da-64b3a600e5f9", "whatsapp");
    const decoded = SHARE_LINK_CHANNELS.map(
      (channel) => new URL(buildChannelShareHref(channel, url, body)).searchParams.get("text") ?? "",
    );
    expect(decoded).toHaveLength(4);
    for (const text of decoded) {
      expect(text).toContain("· Kör nokta: kümede sadece iktidar");
      expect(text).not.toContain("yazdı");
    }
  });
});

// h118-shares-1: an all-English cluster (92742df8: daily-sabah, hurriyet-daily-news,
// trt-world, 3 sources, pro_government 2 / gov_leaning 1) shared "3 kaynak · %100
// iktidar · %0 bağımsız · %0 muhalefet", the zone-absence claim its own page does
// not make. With languageIsolated the text carries the page's qualifier instead.
describe("buildShareText for a language-isolated (all-English) cluster (h118-shares-1)", () => {
  const CLAUSE = "yalnızca İngilizce kaynaklar, Türkçe haberlerle karşılaştırılmadı";

  it("92742df8: names the count and the qualifier, with no percent", () => {
    const text = buildShareText({
      articleCount: 3,
      distribution: dist({ pro_government: 2, gov_leaning: 1 }),
      isBlindspot: false,
      blindspotSide: null,
      languageIsolated: true,
    });
    expect(text).toBe(`3 kaynak · ${CLAUSE}`);
    expect(text).not.toContain("%");
    expect(text).not.toContain("bağımsız");
    expect(text).not.toContain("muhalefet");
  });

  it("2dab7e87: two sources, a-news + trt-world", () => {
    const text = buildShareText({
      articleCount: 2,
      distribution: dist({ pro_government: 2 }),
      isBlindspot: false,
      blindspotSide: null,
      languageIsolated: true,
    });
    expect(text).toBe(`2 kaynak · ${CLAUSE}`);
  });

  it("replaces every head variant: votes below, above and equal to the member count", () => {
    const base = { isBlindspot: false, blindspotSide: null, languageIsolated: true } as const;
    // Fewer votes than members (a non-voting niche outlet such as mfa-turkey).
    expect(buildShareText({ ...base, articleCount: 3, distribution: dist({ pro_government: 2 }) })).toBe(
      `3 kaynak · ${CLAUSE}`,
    );
    // More votes than the distinct-text count (a wire cluster).
    expect(buildShareText({ ...base, articleCount: 2, distribution: dist({ pro_government: 5 }) })).toBe(
      `2 kaynak · ${CLAUSE}`,
    );
  });

  it("leaves 'sınıflandırılmış kaynak yok' alone when nothing voted", () => {
    expect(
      buildShareText({
        articleCount: 2,
        distribution: dist({}),
        isBlindspot: false,
        blindspotSide: null,
        languageIsolated: true,
      }),
    ).toBe("2 kaynak · sınıflandırılmış kaynak yok");
  });

  it("is today's text when the flag is omitted or false", () => {
    const input = {
      articleCount: 3,
      distribution: dist({ pro_government: 2, gov_leaning: 1 }),
      isBlindspot: false,
      blindspotSide: null,
    } as const;
    const today = "3 kaynak · %100 iktidar · %0 bağımsız · %0 muhalefet";
    expect(buildShareText(input)).toBe(today);
    expect(buildShareText({ ...input, languageIsolated: false })).toBe(today);
  });

  it("every existing head is untouched without the flag (qualified, wire and plain)", () => {
    expect(
      buildShareText({
        articleCount: 14,
        distribution: dist({ pro_government: 6, center: 1, opposition: 4 }),
        isBlindspot: false,
        blindspotSide: null,
        languageIsolated: false,
      }),
    ).toBe("14 kaynak · 11 sınıflandırılmış: %55 iktidar · %9 bağımsız · %36 muhalefet");
    expect(
      buildShareText({
        articleCount: 2,
        distribution: dist({ pro_government: 4, opposition: 1 }),
        isBlindspot: false,
        blindspotSide: null,
        languageIsolated: false,
      }),
    ).toBe("2 kaynak · 5 sınıflandırılmış haber: %80 iktidar · %0 bağımsız · %20 muhalefet");
  });

  it("a flagged isolated cluster reads 'kümede sadece X', never 'sadece X yazdı'", () => {
    const text = buildShareText({
      articleCount: 3,
      distribution: dist({ pro_government: 3 }),
      isBlindspot: true,
      blindspotSide: "pro_government",
      languageIsolated: true,
    });
    expect(text).toBe(`3 kaynak · ${CLAUSE} · Kör nokta: kümede sadece iktidar`);
    expect(text).not.toContain("yazdı");
  });

  it("keeps 'spektrumda sadece' over 'kümede sadece' when a toplayıcı / niş source sits in another zone", () => {
    const text = buildShareText({
      articleCount: 3,
      distribution: dist({ pro_government: 2 }),
      isBlindspot: true,
      blindspotSide: "pro_government",
      sources: [
        { kind: "outlet", bias: "pro_government" },
        { kind: "niche", bias: "opposition" },
      ],
      languageIsolated: true,
    });
    expect(text).toContain("Kör nokta: spektrumda sadece iktidar");
    expect(text).not.toContain("kümede sadece");
  });

  it("a weighted flag stays 'ağırlıklı' (the +1 only matters for an only-zone claim)", () => {
    const text = buildShareText({
      articleCount: 5,
      distribution: dist({ pro_government: 4, opposition: 1 }),
      isBlindspot: true,
      blindspotSide: "pro_government",
      languageIsolated: true,
    });
    expect(text).toBe(`5 kaynak · ${CLAUSE} · Kör nokta: iktidar ağırlıklı`);
  });

  it("the blindspot suffix of a non-isolated cluster is unchanged (recall 'kümede sadece' included)", () => {
    const input = {
      articleCount: 4,
      distribution: dist({ pro_government: 4 }),
      isBlindspot: true,
      blindspotSide: "pro_government",
    } as const;
    expect(buildShareText({ ...input, languageIsolated: false })).toBe(
      "4 kaynak · %100 iktidar · %0 bağımsız · %0 muhalefet · Kör nokta: sadece iktidar yazdı",
    );
    expect(buildShareText({ ...input, recallMatchedZones: ["muhalefet"] })).toBe(
      "4 kaynak · %100 iktidar · %0 bağımsız · %0 muhalefet · Kör nokta: kümede sadece iktidar",
    );
  });

  it("leaves the wire suffix as it was", () => {
    const text = buildShareText({
      articleCount: 2,
      distribution: dist({ pro_government: 2 }),
      isBlindspot: false,
      blindspotSide: null,
      wire: { isWireRedistribution: true, memberCount: 5 },
      languageIsolated: true,
    });
    const plain = buildShareText({
      articleCount: 2,
      distribution: dist({ pro_government: 2 }),
      isBlindspot: false,
      blindspotSide: null,
      wire: { isWireRedistribution: true, memberCount: 5 },
    });
    const suffix = plain.slice(plain.indexOf(" · ", plain.indexOf("%0 muhalefet")));
    expect(text).toBe(`2 kaynak · ${CLAUSE}${suffix}`);
    expect(suffix).not.toBe("");
  });
});

describe("buildShareUrl", () => {
  it("builds the exact UTM-tagged cluster URL", () => {
    expect(buildShareUrl("https://tayf.test", "c1", "whatsapp")).toBe(
      "https://tayf.test/cluster/c1?utm_source=whatsapp&utm_medium=share&utm_campaign=cluster",
    );
  });

  it("strips a trailing slash from origin", () => {
    expect(buildShareUrl("https://tayf.test/", "c1", "x")).toBe(
      "https://tayf.test/cluster/c1?utm_source=x&utm_medium=share&utm_campaign=cluster",
    );
  });

  it("encodes the cluster id", () => {
    expect(buildShareUrl("https://tayf.test", "a b/c", "telegram")).toBe(
      "https://tayf.test/cluster/a%20b%2Fc?utm_source=telegram&utm_medium=share&utm_campaign=cluster",
    );
  });

  it("uses a distinct utm_source per channel", () => {
    for (const ch of SHARE_LINK_CHANNELS) {
      expect(buildShareUrl("https://tayf.test", "c1", ch)).toContain(`utm_source=${ch}`);
    }
  });
});

describe("buildChannelShareHref", () => {
  const url = "https://tayf.test/cluster/c1?utm_source=whatsapp&utm_medium=share&utm_campaign=cluster";
  const body = "12 kaynak · %70 iktidar · %20 bağımsız · %10 muhalefet";

  it("whatsapp: decodes back to body + newline + url", () => {
    const href = buildChannelShareHref("whatsapp", url, body);
    expect(href.startsWith("https://wa.me/?text=")).toBe(true);
    const text = decodeURIComponent(href.split("text=")[1]!);
    expect(text).toBe(`${body}\n${url}`);
  });

  it("telegram: decodes url and text params back to the originals", () => {
    const href = buildChannelShareHref("telegram", url, body);
    const parsed = new URL(href);
    expect(parsed.origin + parsed.pathname).toBe("https://t.me/share/url");
    expect(parsed.searchParams.get("url")).toBe(url);
    expect(parsed.searchParams.get("text")).toBe(body);
  });

  it("x: decodes to the body and url params, truncating text at 240 chars", () => {
    const href = buildChannelShareHref("x", url, body);
    const parsed = new URL(href);
    expect(parsed.origin + parsed.pathname).toBe("https://twitter.com/intent/tweet");
    expect(parsed.searchParams.get("text")).toBe(body);
    expect(parsed.searchParams.get("url")).toBe(url);
  });

  it("bluesky: decodes to '<truncated body> <url>'", () => {
    const href = buildChannelShareHref("bluesky", url, body);
    const parsed = new URL(href);
    expect(parsed.origin + parsed.pathname).toBe("https://bsky.app/intent/compose");
    expect(parsed.searchParams.get("text")).toBe(`${body} ${url}`);
  });

  // h64: the cut is cutAtWord() (src/lib/seo/og-title.ts), so the text is at most
  // 240 code points INCLUDING the "…", it ends at a word, and a surrogate pair is
  // never split (a lone surrogate made encodeURIComponent throw URIError).
  const hasLoneSurrogate = (s: string): boolean =>
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
  const textParam = (href: string): string => new URL(href).searchParams.get("text")!;

  it("truncates x/bluesky text to 240 code points (including the ellipsis)", () => {
    const longBody = "a".repeat(300);
    const xText = textParam(buildChannelShareHref("x", url, longBody));
    expect(xText).toBe(`${"a".repeat(239)}…`);
    expect(Array.from(xText).length).toBe(240);

    const bskyText = textParam(buildChannelShareHref("bluesky", url, longBody));
    expect(bskyText).toBe(`${"a".repeat(239)}… ${url}`);
  });

  it("leaves an x/bluesky body of exactly 240 code points whole", () => {
    const exact = "a".repeat(240);
    expect(textParam(buildChannelShareHref("x", url, exact))).toBe(exact);
    expect(textParam(buildChannelShareHref("bluesky", url, exact))).toBe(`${exact} ${url}`);
  });

  it("cuts a long x/bluesky body at a blank: ends with the ellipsis, no partial word", () => {
    const wordy = "kelime ".repeat(50).trim(); // 349 code points
    for (const channel of ["x", "bluesky"] as const) {
      const text = textParam(buildChannelShareHref(channel, url, wordy));
      const body = channel === "bluesky" ? text.slice(0, -(url.length + 1)) : text;
      expect(body.endsWith("kelime…"), channel).toBe(true);
      expect(Array.from(body).length, channel).toBeLessThanOrEqual(240);
      const words = body.slice(0, -1).split(" ");
      expect(new Set(words), channel).toEqual(new Set(["kelime"]));
      if (channel === "bluesky") expect(text.endsWith(` ${url}`)).toBe(true);
    }
  });

  it("does not throw on an emoji that straddles the 240 cut, and leaves no lone surrogate", () => {
    // "a" x 239, then an astral character (two UTF-16 units: 239 and 240), then
    // more text: the old slice(0, 240) kept the high surrogate alone.
    const straddle = `${"a".repeat(239)}\u{1F600}${"b".repeat(20)}`;
    for (const channel of ["x", "bluesky"] as const) {
      let href = "";
      expect(() => {
        href = buildChannelShareHref(channel, url, straddle);
      }, channel).not.toThrow();
      const text = textParam(href);
      expect(hasLoneSurrogate(text), channel).toBe(false);
      expect(text.includes("…"), channel).toBe(true);
    }
    expect(textParam(buildChannelShareHref("x", url, straddle))).toBe(`${"a".repeat(239)}…`);
  });

  it("does not truncate whatsapp/telegram bodies", () => {
    const longBody = "a".repeat(300);
    const waHref = buildChannelShareHref("whatsapp", url, longBody);
    expect(decodeURIComponent(waHref.split("text=")[1]!)).toBe(`${longBody}\n${url}`);
  });
});
