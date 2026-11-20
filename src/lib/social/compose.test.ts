import { describe, it, expect } from "vitest";
import {
  composeBlueskyBlindspot,
  composeBlueskyTopStory,
  composeTelegramBlindspot,
  composeTelegramTopStory,
} from "./compose";
import { wireBadgeLabel } from "@/lib/clusters/wire";
import { sourceCountHead, wireSourceCountHead } from "@/lib/feeds/zone-line";
import type { BiasCategory, SourceKind } from "@/types";

const SOURCES_MIXED: Array<{ bias: BiasCategory }> = [
  { bias: "pro_government" },
  { bias: "gov_leaning" },
  { bias: "center" },
  { bias: "opposition" },
  { bias: "opposition" },
];

// An aggregator is listed on the card (and counted in "N kaynak") but never
// votes, so the zone line and the "N bölge" count must leave it out, and the
// head says so: "4 kaynak (3 sınıflandırılmış)". Its center bias is the only
// Bağımsız entry, which makes a raw recount visible: it would read Bağımsız 1
// and "3 bölge".
const SOURCES_WITH_AGGREGATOR: Array<{
  bias: BiasCategory;
  kind?: SourceKind | null;
}> = [
  { bias: "pro_government", kind: "outlet" },
  { bias: "gov_leaning", kind: "wire" },
  { bias: "opposition", kind: "outlet" },
  { bias: "center", kind: "aggregator" },
];
const VOTING_LINE = "İktidar 2 · Bağımsız 0 · Muhalefet 1";

// 10 members, 2 of them aggregators: the zones add up to 8, not 10.
const TEN_MEMBERS_TWO_AGGREGATORS: Array<{
  bias: BiasCategory;
  kind?: SourceKind | null;
}> = [
  ...Array.from({ length: 8 }, () => ({
    bias: "pro_government" as BiasCategory,
    kind: "outlet" as SourceKind,
  })),
  { bias: "center", kind: "aggregator" },
  { bias: "opposition", kind: "aggregator" },
];
const HEAD_8_OF_10 = "10 kaynak (8 sınıflandırılmış)";
const LINE_8_OF_10 = "İktidar 8 · Bağımsız 0 · Muhalefet 0";

describe("zone line voting basis (aggregators excluded)", () => {
  it("Telegram blindspot: 10 members with 2 aggregators prints the classified count in parentheses", () => {
    const { text } = composeTelegramBlindspot({
      title: "Başlık",
      clusterUrl: "https://tayfhaber.com/cluster/c1",
      dominantZone: "iktidar",
      sources: TEN_MEMBERS_TWO_AGGREGATORS,
    });
    expect(text.split("\n")[2]).toBe(`${HEAD_8_OF_10}: ${LINE_8_OF_10}`);
  });

  it("Telegram top story: the headline uses the same head", () => {
    const { text } = composeTelegramTopStory({
      title: "Başlık",
      clusterUrl: "https://tayfhaber.com/cluster/c2",
      sources: TEN_MEMBERS_TWO_AGGREGATORS,
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe(`Gündem · ${HEAD_8_OF_10}, 1 bölge`);
    expect(lines[2]).toBe(LINE_8_OF_10);
  });

  it("Bluesky blindspot and top story use the same head as Telegram", () => {
    const blindspot = composeBlueskyBlindspot({
      title: "Başlık",
      clusterUrl: "https://tayfhaber.com/cluster/c1",
      dominantZone: "iktidar",
      sources: TEN_MEMBERS_TWO_AGGREGATORS,
    });
    expect(blindspot.text.split("\n")[2]).toBe(`${HEAD_8_OF_10}: ${LINE_8_OF_10}`);
    const top = composeBlueskyTopStory({
      title: "Başlık",
      clusterUrl: "https://tayfhaber.com/cluster/c2",
      sources: TEN_MEMBERS_TWO_AGGREGATORS,
    });
    expect(top.text.split("\n")[0]).toBe(`Gündem · ${HEAD_8_OF_10}, 1 bölge`);
  });

  it("an all-voting cluster keeps the bare count", () => {
    const { text } = composeTelegramBlindspot({
      title: "Başlık",
      clusterUrl: "https://tayfhaber.com/cluster/c1",
      dominantZone: "iktidar",
      sources: [
        { bias: "pro_government", kind: "outlet" },
        { bias: "center", kind: "wire" },
      ],
    });
    expect(text.split("\n")[2]).toBe(
      "2 kaynak: İktidar 1 · Bağımsız 1 · Muhalefet 0",
    );
  });

  it("Telegram blindspot: zone line drops the aggregator, the head names the classified count", () => {
    const { text } = composeTelegramBlindspot({
      title: "Başlık",
      clusterUrl: "https://tayfhaber.com/cluster/c1",
      dominantZone: "iktidar",
      sources: SOURCES_WITH_AGGREGATOR,
    });
    expect(text.split("\n")[2]).toBe(`4 kaynak (3 sınıflandırılmış): ${VOTING_LINE}`);
  });

  it("Telegram top story: zone line and 'N bölge' drop the aggregator, the head names the classified count", () => {
    const { text } = composeTelegramTopStory({
      title: "Başlık",
      clusterUrl: "https://tayfhaber.com/cluster/c2",
      sources: SOURCES_WITH_AGGREGATOR,
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Gündem · 4 kaynak (3 sınıflandırılmış), 2 bölge");
    expect(lines[2]).toBe(VOTING_LINE);
  });

  it("Bluesky blindspot: text line and embed description drop the aggregator", () => {
    const { text, embed } = composeBlueskyBlindspot({
      title: "Başlık",
      clusterUrl: "https://tayfhaber.com/cluster/c1",
      dominantZone: "iktidar",
      sources: SOURCES_WITH_AGGREGATOR,
    });
    expect(text.split("\n")[2]).toBe(`4 kaynak (3 sınıflandırılmış): ${VOTING_LINE}`);
    expect(embed.description).toBe(VOTING_LINE);
  });

  it("Bluesky top story: zone line, embed description and 'N bölge' drop the aggregator", () => {
    const { text, embed } = composeBlueskyTopStory({
      title: "Başlık",
      clusterUrl: "https://tayfhaber.com/cluster/c2",
      sources: SOURCES_WITH_AGGREGATOR,
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Gündem · 4 kaynak (3 sınıflandırılmış), 2 bölge");
    expect(lines[2]).toBe(VOTING_LINE);
    expect(embed.description).toBe(VOTING_LINE);
  });

  it("niche sources are excluded the same way", () => {
    const { text } = composeTelegramTopStory({
      title: "Başlık",
      clusterUrl: "https://tayfhaber.com/cluster/c2",
      sources: [
        { bias: "pro_government", kind: "outlet" },
        { bias: "opposition", kind: "niche" },
      ],
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Gündem · 2 kaynak (1 sınıflandırılmış), 1 bölge");
    expect(lines[2]).toBe("İktidar 1 · Bağımsız 0 · Muhalefet 0");
  });

  it("sources without a kind (or kind null) still vote", () => {
    const { text } = composeTelegramTopStory({
      title: "Başlık",
      clusterUrl: "https://tayfhaber.com/cluster/c2",
      sources: [
        { bias: "center" },
        { bias: "opposition", kind: null },
      ],
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Gündem · 2 kaynak, 2 bölge");
    expect(lines[2]).toBe("İktidar 0 · Bağımsız 1 · Muhalefet 1");
  });
});

describe("composeTelegramBlindspot", () => {
  it("builds the exact 5-line text", () => {
    const { text, url } = composeTelegramBlindspot({
      title: "Asgari ücret zammı açıklandı",
      clusterUrl: "https://tayfhaber.com/cluster/c1",
      dominantZone: "iktidar",
      sources: SOURCES_MIXED,
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Kör nokta · İktidar ağırlıklı haber");
    expect(lines[1]).toBe("Asgari ücret zammı açıklandı");
    expect(lines[2]).toBe("5 kaynak: İktidar 2 · Bağımsız 1 · Muhalefet 2");
    expect(lines[3]).toBe("Diğer bölgelerden bu kümede az ya da hiç haber yok.");
    expect(lines[4]).toBe(url);
    expect(url).toContain("utm_source=telegram");
    expect(url).toContain("utm_medium=social");
    expect(url).toContain("utm_campaign=kor_nokta");
  });

  it('never contains "görmezden"', () => {
    const { text } = composeTelegramBlindspot({
      title: "Test",
      clusterUrl: "https://tayfhaber.com/cluster/c1",
      dominantZone: "muhalefet",
      sources: SOURCES_MIXED,
    });
    expect(text).not.toContain("görmezden");
  });
});

describe("composeTelegramTopStory", () => {
  it("builds the exact 4-line text", () => {
    const { text, url } = composeTelegramTopStory({
      title: "Deprem yönetmeliği değişti",
      clusterUrl: "https://tayfhaber.com/cluster/c2",
      sources: SOURCES_MIXED,
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Gündem · 5 kaynak, 3 bölge");
    expect(lines[1]).toBe("Deprem yönetmeliği değişti");
    expect(lines[2]).toBe("İktidar 2 · Bağımsız 1 · Muhalefet 2");
    expect(lines[3]).toBe(`Kim nasıl yazdı: ${url}`);
    expect(url).toContain("utm_campaign=gundem");
  });
});

describe("composeBlueskyBlindspot", () => {
  it("has no URL line; the link is in the embed with utm_source=bluesky", () => {
    const { text, embed } = composeBlueskyBlindspot({
      title: "Asgari ücret zammı açıklandı",
      clusterUrl: "https://tayfhaber.com/cluster/c1",
      dominantZone: "iktidar",
      sources: SOURCES_MIXED,
    });
    expect(text).not.toContain("https://");
    expect(embed.uri).toContain("utm_source=bluesky");
    expect(embed.description).toBe("İktidar 2 · Bağımsız 1 · Muhalefet 2");
  });

  it("truncates a long Turkish title with emoji to <= 300 graphemes", () => {
    const longTitle =
      "🇹🇷 " + "Çok uzun bir başlık ".repeat(30) + "İstanbul'da büyük gelişme yaşandı";
    const { text } = composeBlueskyBlindspot({
      title: longTitle,
      clusterUrl: "https://tayfhaber.com/cluster/c1",
      dominantZone: "iktidar",
      sources: SOURCES_MIXED,
    });
    const segmenter = new Intl.Segmenter("tr", { granularity: "grapheme" });
    const count = Array.from(segmenter.segment(text)).length;
    expect(count).toBeLessThanOrEqual(300);
    expect(text).toContain("…");
  });

  it('never contains "görmezden"', () => {
    const { text } = composeBlueskyBlindspot({
      title: "Test",
      clusterUrl: "https://tayfhaber.com/cluster/c1",
      dominantZone: "muhalefet",
      sources: SOURCES_MIXED,
    });
    expect(text).not.toContain("görmezden");
  });
});

// h64-ogcards-2. A title that has to be cut to fit the 300-grapheme post was cut
// at a hard grapheme count (mid-word); it is cut at a word now, like the OG card.
// The count is still graphemes: a cut never lands inside a ZWJ emoji or a flag.
describe("Bluesky title cut (h64-ogcards-2)", () => {
  const segmenter = new Intl.Segmenter("tr", { granularity: "grapheme" });
  const graphemes = (s: string): string[] => Array.from(segmenter.segment(s), (x) => x.segment);
  const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";

  it("a long blindspot title is cut at a whole word, never inside one", () => {
    const { text } = composeBlueskyBlindspot({
      title: "kelime ".repeat(80).trimEnd(),
      clusterUrl: "https://tayfhaber.com/cluster/c1",
      dominantZone: "iktidar",
      sources: SOURCES_MIXED,
    });
    const titleLine = text.split("\n")[1] ?? "";
    expect(titleLine).toMatch(/^(?:kelime )*kelime…$/);
    expect(graphemes(text).length).toBeLessThanOrEqual(300);
    // Most of the room is used: the cut did not fall back to a few words.
    expect(titleLine.length).toBeGreaterThan(100);
  });

  it("a long top-story title is cut at a whole word, never inside one", () => {
    const { text } = composeBlueskyTopStory({
      title: "kelime ".repeat(80).trimEnd(),
      clusterUrl: "https://tayfhaber.com/cluster/c2",
      sources: SOURCES_MIXED,
    });
    const titleLine = text.split("\n")[1] ?? "";
    expect(titleLine).toMatch(/^(?:kelime )*kelime…$/);
    expect(graphemes(text).length).toBeLessThanOrEqual(300);
  });

  it("a title that fits is posted whole", () => {
    const title = "Deprem yönetmeliği değişti";
    const { text } = composeBlueskyTopStory({
      title,
      clusterUrl: "https://tayfhaber.com/cluster/c2",
      sources: SOURCES_MIXED,
    });
    expect(text.split("\n")[1]).toBe(title);
  });

  it("never cuts inside a ZWJ emoji or a flag when the title has no blank to cut at", () => {
    for (const unit of [FAMILY, "\u{1F1F9}\u{1F1F7}", "i\u0307"]) {
      const { text } = composeBlueskyBlindspot({
        title: unit.repeat(400),
        clusterUrl: "https://tayfhaber.com/cluster/c1",
        dominantZone: "iktidar",
        sources: SOURCES_MIXED,
      });
      const titleLine = text.split("\n")[1] ?? "";
      expect(titleLine.endsWith("…")).toBe(true);
      const body = graphemes(titleLine.slice(0, -1));
      expect(body.length).toBeGreaterThan(0);
      expect(body.every((g) => g === unit), JSON.stringify(unit)).toBe(true);
      expect(graphemes(text).length).toBeLessThanOrEqual(300);
    }
  });
});

describe("composeBlueskyTopStory", () => {
  it("has no URL line; embed carries the utm url", () => {
    const { text, embed } = composeBlueskyTopStory({
      title: "Deprem yönetmeliği değişti",
      clusterUrl: "https://tayfhaber.com/cluster/c2",
      sources: SOURCES_MIXED,
    });
    expect(text).not.toContain("https://");
    expect(embed.uri).toContain("utm_source=bluesky");
    expect(embed.uri).toContain("utm_campaign=gundem");
  });
});

// h203-wire-callers. A wire redistribution counts its distinct texts, as the cluster
// page, the share surfaces and the feeds do (wireSourceCountHead + wireBadgeLabel),
// so the classified votes can exceed the "N kaynak" the post prints. The copy is
// asserted against the helpers' own output, never a hand-typed twin. The
// 2026-11-16 COP31 cluster: 6 members (two aggregators), 3 distinct texts, 4 voters.
describe("wire redistribution (h203-wire-callers)", () => {
  const WIRE_SOURCES: Array<{ bias: BiasCategory; kind: SourceKind }> = [
    { bias: "pro_government", kind: "outlet" },
    { bias: "center", kind: "aggregator" },
    { bias: "center", kind: "outlet" },
    { bias: "gov_leaning", kind: "aggregator" },
    { bias: "gov_leaning", kind: "outlet" },
    { bias: "gov_leaning", kind: "outlet" },
  ];
  const COUNTS = { iktidar: 3, bagimsiz: 1, muhalefet: 0 };
  const WIRE_LINE = "İktidar 3 · Bağımsız 1 · Muhalefet 0";
  const URL = "https://tayfhaber.com/cluster/c1";
  const WIRE = { isWireRedistribution: true, effectiveArticleCount: 3 } as const;

  const blindspot = (extra: object = WIRE, title = "Başlık") => ({
    title,
    clusterUrl: URL,
    dominantZone: "iktidar" as const,
    sources: WIRE_SOURCES,
    ...extra,
  });
  const topStory = (extra: object = WIRE, title = "Başlık") => ({
    title,
    clusterUrl: URL,
    sources: WIRE_SOURCES,
    ...extra,
  });
  const graphemes = (text: string) =>
    Array.from(new Intl.Segmenter("tr", { granularity: "grapheme" }).segment(text)).length;

  it("Telegram blindspot: the distinct-text head, then the wire cue on its own line", () => {
    const { text, url } = composeTelegramBlindspot(blindspot());
    expect(text.split("\n")).toEqual([
      "Kör nokta · İktidar ağırlıklı haber",
      "Başlık",
      `${wireSourceCountHead(3, COUNTS, true)}: ${WIRE_LINE}`,
      wireBadgeLabel(6, 3),
      "Diğer bölgelerden bu kümede az ya da hiç haber yok.",
      url,
    ]);
    expect(text).toContain("3 kaynak · 4 sınıflandırılmış: İktidar 3");
    expect(text).toContain("Ajans ağırlıklı · 6 haber, 3 farklı metin");
    expect(text).not.toContain("6 kaynak");
  });

  it("Telegram top story: the headline carries the distinct-text head, the cue follows the zone line", () => {
    const { text, url } = composeTelegramTopStory(topStory());
    expect(text.split("\n")).toEqual([
      `Gündem · ${wireSourceCountHead(3, COUNTS, true)}, 2 bölge`,
      "Başlık",
      WIRE_LINE,
      wireBadgeLabel(6, 3),
      `Kim nasıl yazdı: ${url}`,
    ]);
    expect(text.split("\n")[0]).toBe("Gündem · 3 kaynak · 4 sınıflandırılmış, 2 bölge");
  });

  it("Bluesky blindspot and top story: same head and cue, no URL line, the embed description is still the zone line", () => {
    const bs = composeBlueskyBlindspot(blindspot());
    expect(bs.text.split("\n")).toEqual([
      "Kör nokta · İktidar ağırlıklı haber",
      "Başlık",
      `${wireSourceCountHead(3, COUNTS, true)}: ${WIRE_LINE}`,
      wireBadgeLabel(6, 3),
      "Diğer bölgelerden bu kümede az ya da hiç haber yok.",
    ]);
    expect(bs.embed.description).toBe(WIRE_LINE);

    const ts = composeBlueskyTopStory(topStory());
    expect(ts.text.split("\n")).toEqual([
      `Gündem · ${wireSourceCountHead(3, COUNTS, true)}, 2 bölge`,
      "Başlık",
      WIRE_LINE,
      wireBadgeLabel(6, 3),
    ]);
    expect(ts.embed.description).toBe(WIRE_LINE);
  });

  it("one text behind every member: the single-source cue and a '1 kaynak' head", () => {
    const one = { isWireRedistribution: true, effectiveArticleCount: 1 };
    const lines = composeTelegramBlindspot(blindspot(one)).text.split("\n");
    expect(lines[2]).toBe(`${wireSourceCountHead(1, COUNTS, true)}: ${WIRE_LINE}`);
    expect(lines[2]).toBe(`1 kaynak · 4 sınıflandırılmış: ${WIRE_LINE}`);
    expect(lines[3]).toBe("Tek kaynaktan dağıtıldı · 6 kopya");
  });

  it("votes at or below the text count keep sourceCountHead's own wording, with the cue", () => {
    const equal = composeTelegramTopStory(topStory({ isWireRedistribution: true, effectiveArticleCount: 4 }));
    expect(equal.text.split("\n")[0]).toBe("Gündem · 4 kaynak, 2 bölge");
    expect(equal.text.split("\n")[3]).toBe(wireBadgeLabel(6, 4));

    const fewer = composeTelegramTopStory(topStory({ isWireRedistribution: true, effectiveArticleCount: 5 }));
    expect(fewer.text.split("\n")[0]).toBe(`Gündem · ${sourceCountHead(5, COUNTS)}, 2 bölge`);
    expect(fewer.text.split("\n")[0]).toContain("5 kaynak (4 sınıflandırılmış)");
    expect(fewer.text.split("\n")[3]).toBe(wireBadgeLabel(6, 5));
  });

  it("every composer: a cluster that is not a wire redistribution is byte-identical to today", () => {
    const flaggedOff = { isWireRedistribution: false, effectiveArticleCount: 6 };
    const countOnly = { effectiveArticleCount: 3 };
    for (const extra of [flaggedOff, countOnly, { isWireRedistribution: undefined }]) {
      expect(composeTelegramBlindspot(blindspot(extra))).toEqual(composeTelegramBlindspot(blindspot({})));
      expect(composeTelegramTopStory(topStory(extra))).toEqual(composeTelegramTopStory(topStory({})));
      expect(composeBlueskyBlindspot(blindspot(extra))).toEqual(composeBlueskyBlindspot(blindspot({})));
      expect(composeBlueskyTopStory(topStory(extra))).toEqual(composeBlueskyTopStory(topStory({})));
    }
    const plain = composeTelegramBlindspot(blindspot({})).text;
    expect(plain.split("\n")[2]).toBe(`${sourceCountHead(6, COUNTS)}: ${WIRE_LINE}`);
    expect(plain).not.toContain("Ajans ağırlıklı");
    expect(plain).not.toContain("Tek kaynaktan");
  });

  it("a wire flag with no usable text count falls back to today's text", () => {
    for (const effectiveArticleCount of [undefined, 0, -1, Number.NaN]) {
      const extra = { isWireRedistribution: true, effectiveArticleCount };
      expect(composeTelegramBlindspot(blindspot(extra))).toEqual(composeTelegramBlindspot(blindspot({})));
      expect(composeTelegramTopStory(topStory(extra))).toEqual(composeTelegramTopStory(topStory({})));
      expect(composeBlueskyBlindspot(blindspot(extra))).toEqual(composeBlueskyBlindspot(blindspot({})));
      expect(composeBlueskyTopStory(topStory(extra))).toEqual(composeBlueskyTopStory(topStory({})));
    }
  });

  it("Bluesky: a long title is cut to leave room for the cue; the post stays within 300 graphemes and keeps head and cue", () => {
    const longTitle = "🇹🇷 " + "Çok uzun bir başlık ".repeat(30) + "İstanbul'da büyük gelişme yaşandı";
    for (const text of [
      composeBlueskyBlindspot(blindspot(WIRE, longTitle)).text,
      composeBlueskyTopStory(topStory(WIRE, longTitle)).text,
    ]) {
      expect(graphemes(text)).toBeLessThanOrEqual(300);
      expect(text).toContain("…");
      expect(text).toContain("3 kaynak · 4 sınıflandırılmış");
      expect(text).toContain(wireBadgeLabel(6, 3));
      expect(text).toContain(WIRE_LINE);
    }
  });
});
