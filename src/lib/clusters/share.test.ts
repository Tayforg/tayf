import { describe, it, expect } from "vitest";

import {
  buildChannelShareHref,
  buildShareText,
  buildShareUrl,
  SHARE_LINK_CHANNELS,
} from "./share";
import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import type { BiasDistribution } from "@/types";

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

  it("truncates x/bluesky text at 240 characters and appends an ellipsis", () => {
    const longBody = "a".repeat(300);
    const xHref = buildChannelShareHref("x", url, longBody);
    const xText = new URL(xHref).searchParams.get("text")!;
    expect(xText).toBe(`${"a".repeat(240)}…`);
    expect(xText.length).toBe(241);

    const bskyHref = buildChannelShareHref("bluesky", url, longBody);
    const bskyText = new URL(bskyHref).searchParams.get("text")!;
    expect(bskyText).toBe(`${"a".repeat(240)}… ${url}`);
  });

  it("does not truncate whatsapp/telegram bodies", () => {
    const longBody = "a".repeat(300);
    const waHref = buildChannelShareHref("whatsapp", url, longBody);
    expect(decodeURIComponent(waHref.split("text=")[1]!)).toBe(`${longBody}\n${url}`);
  });
});
