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
    const text = buildShareText({
      articleCount: 12,
      distribution: dist({ pro_government: 7, center: 2, opposition: 1 }),
      isBlindspot: false,
      blindspotSide: null,
    });
    expect(text).toBe(
      "12 kaynak · %70 iktidar · %20 bağımsız · %10 muhalefet",
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

  it("appends the wire-redistribution suffix when wire.isWireRedistribution is true", () => {
    const text = buildShareText({
      articleCount: 2,
      distribution: dist({ pro_government: 2 }),
      isBlindspot: false,
      blindspotSide: null,
      wire: { isWireRedistribution: true, memberCount: 7 },
    });
    expect(text).toBe(
      "2 kaynak · %100 iktidar · %0 bağımsız · %0 muhalefet · tek kaynaktan 7 kopya",
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

  it("handles a zero distribution without throwing", () => {
    const text = buildShareText({
      articleCount: 0,
      distribution: emptyBiasDistribution(),
      isBlindspot: false,
      blindspotSide: null,
    });
    expect(text).toBe("0 kaynak · %0 iktidar · %0 bağımsız · %0 muhalefet");
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
