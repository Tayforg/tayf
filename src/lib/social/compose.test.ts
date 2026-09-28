import { describe, it, expect } from "vitest";
import {
  composeBlueskyBlindspot,
  composeBlueskyTopStory,
  composeTelegramBlindspot,
  composeTelegramTopStory,
} from "./compose";
import type { BiasCategory } from "@/types";

const SOURCES_MIXED: Array<{ bias: BiasCategory }> = [
  { bias: "pro_government" },
  { bias: "gov_leaning" },
  { bias: "center" },
  { bias: "opposition" },
  { bias: "opposition" },
];

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
