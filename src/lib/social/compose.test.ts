import { describe, it, expect } from "vitest";
import {
  composeBlueskyBlindspot,
  composeBlueskyTopStory,
  composeTelegramBlindspot,
  composeTelegramTopStory,
} from "./compose";
import type { BiasCategory, SourceKind } from "@/types";

const SOURCES_MIXED: Array<{ bias: BiasCategory }> = [
  { bias: "pro_government" },
  { bias: "gov_leaning" },
  { bias: "center" },
  { bias: "opposition" },
  { bias: "opposition" },
];

// An aggregator is listed on the card (and counted in "N kaynak") but never
// votes, so the zone line and the "N bölge" count must leave it out. Its
// center bias is the only Bağımsız entry, which makes a raw recount visible:
// it would read Bağımsız 1 and "3 bölge".
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

describe("zone line voting basis (aggregators excluded)", () => {
  it("Telegram blindspot: zone line drops the aggregator, 'N kaynak' keeps it", () => {
    const { text } = composeTelegramBlindspot({
      title: "Başlık",
      clusterUrl: "https://tayfhaber.com/cluster/c1",
      dominantZone: "iktidar",
      sources: SOURCES_WITH_AGGREGATOR,
    });
    expect(text.split("\n")[2]).toBe(`4 kaynak: ${VOTING_LINE}`);
  });

  it("Telegram top story: zone line and 'N bölge' drop the aggregator, 'N kaynak' keeps it", () => {
    const { text } = composeTelegramTopStory({
      title: "Başlık",
      clusterUrl: "https://tayfhaber.com/cluster/c2",
      sources: SOURCES_WITH_AGGREGATOR,
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Gündem · 4 kaynak, 2 bölge");
    expect(lines[2]).toBe(VOTING_LINE);
  });

  it("Bluesky blindspot: text line and embed description drop the aggregator", () => {
    const { text, embed } = composeBlueskyBlindspot({
      title: "Başlık",
      clusterUrl: "https://tayfhaber.com/cluster/c1",
      dominantZone: "iktidar",
      sources: SOURCES_WITH_AGGREGATOR,
    });
    expect(text.split("\n")[2]).toBe(`4 kaynak: ${VOTING_LINE}`);
    expect(embed.description).toBe(VOTING_LINE);
  });

  it("Bluesky top story: zone line, embed description and 'N bölge' drop the aggregator", () => {
    const { text, embed } = composeBlueskyTopStory({
      title: "Başlık",
      clusterUrl: "https://tayfhaber.com/cluster/c2",
      sources: SOURCES_WITH_AGGREGATOR,
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("Gündem · 4 kaynak, 2 bölge");
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
    expect(lines[0]).toBe("Gündem · 2 kaynak, 1 bölge");
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
