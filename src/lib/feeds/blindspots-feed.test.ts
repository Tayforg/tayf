import { describe, it, expect } from "vitest";

import type { BlindspotBundle } from "@/lib/clusters/blindspots-query";
import {
  BLINDSPOTS_FEED_MAX_ITEMS,
  blindspotRssItem,
  buildBlindspotsRssXml,
} from "./blindspots-feed";

const BASE = "https://tayfhaber.com";

function bundle(
  id: string,
  overrides: Partial<BlindspotBundle> = {},
): BlindspotBundle {
  return {
    cluster: {
      id,
      title_tr: `Başlık ${id}`,
      article_count: 5,
      first_published: "2026-09-20T10:00:00.000Z",
      updated_at: "2026-09-20T10:00:00.000Z",
    },
    articles: [],
    // Coherent fixture: s3 is an aggregator, so it is listed (and counted in
    // "N kaynak") but never votes. votingZoneCounts matches the voting
    // sources (s1, s2) only.
    sources: [
      { id: "s1", name: "A", bias: "pro_government", kind: "outlet" },
      { id: "s2", name: "B", bias: "center", kind: "outlet" },
      { id: "s3", name: "C", bias: "center", kind: "aggregator" },
    ],
    dominantZone: "iktidar",
    dominantPct: 0.8,
    votingZoneCounts: { iktidar: 1, bagimsiz: 1, muhalefet: 0 },
    isWireRedistribution: false,
    effectiveArticleCount: 5,
    ...overrides,
  } as unknown as BlindspotBundle;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("BLINDSPOTS_FEED_MAX_ITEMS", () => {
  it("is 30", () => {
    expect(BLINDSPOTS_FEED_MAX_ITEMS).toBe(30);
  });
});

describe("blindspotRssItem", () => {
  it("maps title, utm-tagged link, clean guid and pubDate", () => {
    const item = blindspotRssItem(BASE, bundle("c9"));
    expect(item.title).toBe("Başlık c9");
    expect(item.pubDate).toBe("2026-09-20T10:00:00.000Z");
    expect(item.guid).toBe("https://tayfhaber.com/cluster/c9");
    const url = new URL(item.link);
    expect(url.origin + url.pathname).toBe("https://tayfhaber.com/cluster/c9");
    expect(url.searchParams.get("utm_source")).toBe("rss");
    expect(url.searchParams.get("utm_medium")).toBe("feed");
    expect(url.searchParams.get("utm_campaign")).toBe("kor_nokta");
  });

  it("builds the description from the zone label, rounded percentage, source count and zone line", () => {
    const item = blindspotRssItem(
      BASE,
      bundle("c1", { dominantZone: "muhalefet", dominantPct: 0.666 }),
    );
    // "3 kaynak" is sources.length (the card's count, aggregator included);
    // the zone line is the voting tally, so the aggregator's Bağımsız vote
    // is not there (a raw recount would read Bağımsız 2).
    expect(item.description).toBe(
      "Kör nokta: ağırlıkla Muhalefet kaynakları (%67). 3 kaynak · İktidar 1 · Bağımsız 1 · Muhalefet 0",
    );
  });

  it("takes the zone line from bundle.votingZoneCounts, not from a recount of bundle.sources", () => {
    const item = blindspotRssItem(
      BASE,
      bundle("c2", {
        votingZoneCounts: { iktidar: 7, bagimsiz: 0, muhalefet: 2 },
      }),
    );
    expect(item.description).toContain("İktidar 7 · Bağımsız 0 · Muhalefet 2");
    expect(item.description).toContain("3 kaynak");
  });
});

describe("buildBlindspotsRssXml", () => {
  it("composes the self URL from base and selfPath", () => {
    const a = buildBlindspotsRssXml(BASE, [], "/blindspots/rss.xml");
    expect(a).toContain(
      '<atom:link href="https://tayfhaber.com/blindspots/rss.xml"',
    );
    const b = buildBlindspotsRssXml(BASE, [], "/rss/kor-noktalar.xml");
    expect(b).toContain(
      '<atom:link href="https://tayfhaber.com/rss/kor-noktalar.xml"',
    );
  });

  it("gives both URLs identical content apart from the self link", () => {
    const bundles = [bundle("c1"), bundle("c2")];
    const a = buildBlindspotsRssXml(BASE, bundles, "/blindspots/rss.xml");
    const b = buildBlindspotsRssXml(BASE, bundles, "/rss/kor-noktalar.xml");
    expect(a.replace("/blindspots/rss.xml", "/rss/kor-noktalar.xml")).toBe(b);
  });

  it("sets the channel title, link and description", () => {
    const xml = buildBlindspotsRssXml(BASE, [], "/blindspots/rss.xml");
    expect(xml).toContain("<title>Tayf — Kör noktalar</title>");
    expect(xml).toContain("<link>https://tayfhaber.com/blindspots</link>");
    expect(xml).toContain(
      "Bir tarafın haberi verdiği, diğerlerinin görmezden geldiği hikâyeler.",
    );
  });

  it("caps the item count at BLINDSPOTS_FEED_MAX_ITEMS and keeps the first ones", () => {
    const bundles = Array.from({ length: 40 }, (_, i) => bundle(`c${i}`));
    const xml = buildBlindspotsRssXml(BASE, bundles, "/blindspots/rss.xml");
    expect(count(xml, "<item>")).toBe(BLINDSPOTS_FEED_MAX_ITEMS);
    expect(xml).toContain("/cluster/c29");
    expect(xml).not.toContain("/cluster/c30");
  });

  it("emits no items and no lastBuildDate for an empty list", () => {
    const xml = buildBlindspotsRssXml(BASE, [], "/blindspots/rss.xml");
    expect(count(xml, "<item>")).toBe(0);
    expect(xml).not.toContain("<lastBuildDate>");
  });

  it("does not mutate the input array", () => {
    const bundles = Array.from({ length: 40 }, (_, i) => bundle(`c${i}`));
    buildBlindspotsRssXml(BASE, bundles, "/blindspots/rss.xml");
    expect(bundles).toHaveLength(40);
  });
});
