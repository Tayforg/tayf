import { describe, it, expect, vi, beforeEach } from "vitest";

import type {
  BlindspotBundle,
  BlindspotMoreRow,
} from "@/lib/clusters/blindspots-query";
import {
  BLINDSPOTS_FEED_MAX_ITEMS,
  blindspotMoreRssItem,
  blindspotRssItem,
  blindspotsFeedResponse,
  buildBlindspotsRssXml,
} from "./blindspots-feed";

// blindspotsFeedResponse reads the query through getBlindspots(); the pure
// builders below never touch it.
const mocks = vi.hoisted(() => ({ result: null as unknown, throws: false }));
vi.mock("@/lib/clusters/blindspots-query", () => ({
  getBlindspots: vi.fn(async () => {
    if (mocks.throws) throw new Error("boom");
    return mocks.result;
  }),
}));
vi.mock("@/lib/site-url", () => ({ siteUrl: () => "https://tayfhaber.com" }));

beforeEach(() => {
  mocks.result = null;
  mocks.throws = false;
});

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
    // Coherent fixture: s5 is an outlet, s6 an aggregator, so s6 is listed
    // (and counted in "N kaynak") but never votes. votingZoneCounts matches
    // the voting sources (s1-s5) only: 4 iktidar + 1 bağımsız, which is the
    // 80% dominantPct below.
    sources: [
      { id: "s1", name: "A", bias: "pro_government", kind: "outlet" },
      { id: "s2", name: "B", bias: "pro_government", kind: "outlet" },
      { id: "s3", name: "C", bias: "state_media", kind: "outlet" },
      { id: "s4", name: "D", bias: "gov_leaning", kind: "outlet" },
      { id: "s5", name: "E", bias: "center", kind: "outlet" },
      { id: "s6", name: "F", bias: "center", kind: "aggregator" },
    ],
    dominantZone: "iktidar",
    dominantPct: 0.8,
    votingZoneCounts: { iktidar: 4, bagimsiz: 1, muhalefet: 0 },
    isWireRedistribution: false,
    effectiveArticleCount: 5,
    ...overrides,
  } as unknown as BlindspotBundle;
}

/** A compact row as the query returns it: 11 of 13 voters in the dominant zone. */
function moreRow(
  id: string,
  overrides: Partial<BlindspotMoreRow> = {},
): BlindspotMoreRow {
  return {
    id,
    title: `Kompakt ${id}`,
    dominantZone: "iktidar",
    dominantPct: 11 / 13,
    sourceCount: 13,
    firstPublished: "2026-09-19T08:00:00.000Z",
    votingZoneCounts: { iktidar: 11, bagimsiz: 1, muhalefet: 1 },
    ...overrides,
  };
}

function guids(xml: string): string[] {
  return [...xml.matchAll(/<guid[^>]*>([^<]*)<\/guid>/g)].map((m) => m[1]!);
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("BLINDSPOTS_FEED_MAX_ITEMS", () => {
  it("is 60: the 30 cards plus up to 30 compact rows (h53-consistency-1)", () => {
    expect(BLINDSPOTS_FEED_MAX_ITEMS).toBe(60);
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

  it("builds the description from the zone label, largest-remainder percentage, source count and zone line", () => {
    const item = blindspotRssItem(
      BASE,
      bundle("c1", {
        dominantZone: "muhalefet",
        dominantPct: 2 / 3,
        // 3 voters (1 iktidar, 2 muhalefet) plus 3 non-voting members.
        sources: [
          { id: "s1", name: "A", bias: "pro_government", kind: "outlet" },
          { id: "s2", name: "B", bias: "opposition", kind: "outlet" },
          { id: "s3", name: "C", bias: "opposition", kind: "wire" },
          { id: "s4", name: "D", bias: "center", kind: "aggregator" },
          { id: "s5", name: "E", bias: "center", kind: "aggregator" },
          { id: "s6", name: "F", bias: "center", kind: "niche" },
        ],
        votingZoneCounts: { iktidar: 1, bagimsiz: 0, muhalefet: 2 },
      } as unknown as Partial<BlindspotBundle>),
    );
    // "6 kaynak" is every listed member (the card's count); the parenthesised
    // 3 is the voting count the zones add up to. The non-voting members'
    // Bağımsız bias is not in the zones (a raw recount would read Bağımsız 3).
    expect(item.description).toBe(
      "Kör nokta: ağırlıkla Muhalefet kaynakları (%67). 6 kaynak (3 sınıflandırılmış) · İktidar 1 · Bağımsız 0 · Muhalefet 2",
    );
  });

  it("marks the voting count when 2 of 10 members are aggregators, so the zones add up", () => {
    const item = blindspotRssItem(
      BASE,
      bundle("c5", {
        dominantPct: 1,
        sources: [
          ...Array.from({ length: 8 }, (_, i) => ({
            id: `v${i}`,
            name: `V${i}`,
            bias: "pro_government",
            kind: "outlet",
          })),
          { id: "a1", name: "Agg1", bias: "center", kind: "aggregator" },
          { id: "a2", name: "Agg2", bias: "center", kind: "aggregator" },
        ],
        votingZoneCounts: { iktidar: 8, bagimsiz: 0, muhalefet: 0 },
      } as unknown as Partial<BlindspotBundle>),
    );
    expect(item.description).toBe(
      "Kör nokta: ağırlıkla İktidar kaynakları (%100). 10 kaynak (8 sınıflandırılmış) · İktidar 8 · Bağımsız 0 · Muhalefet 0",
    );
    expect(item.description.split(" · ")).toHaveLength(4);
  });

  it("keeps the bare count when every member votes", () => {
    const item = blindspotRssItem(
      BASE,
      bundle("c6", {
        dominantPct: 4 / 7,
        sources: [
          { id: "s1", name: "A", bias: "pro_government", kind: "outlet" },
          { id: "s2", name: "B", bias: "pro_government", kind: "outlet" },
          { id: "s3", name: "C", bias: "state_media", kind: "wire" },
          { id: "s4", name: "D", bias: "gov_leaning", kind: "outlet" },
          { id: "s5", name: "E", bias: "center", kind: "outlet" },
          { id: "s6", name: "F", bias: "center", kind: "outlet" },
          { id: "s7", name: "G", bias: "opposition", kind: "outlet" },
        ],
        votingZoneCounts: { iktidar: 4, bagimsiz: 2, muhalefet: 1 },
      } as unknown as Partial<BlindspotBundle>),
    );
    expect(item.description).toBe(
      "Kör nokta: ağırlıkla İktidar kaynakları (%57). 7 kaynak · İktidar 4 · Bağımsız 2 · Muhalefet 1",
    );
    expect(item.description.split(" · ")).toHaveLength(4);
  });

  it("prints %84 (the bar's largest-remainder figure), not Math.round's %85, for an 11/1/1 tally", () => {
    const item = blindspotRssItem(
      BASE,
      bundle("c3", {
        dominantPct: 11 / 13,
        votingZoneCounts: { iktidar: 11, bagimsiz: 1, muhalefet: 1 },
      }),
    );
    expect(item.description).toContain("(%84).");
    expect(item.description).not.toContain("%85");
    expect(item.description).toContain("İktidar 11 · Bağımsız 1 · Muhalefet 1");
  });

  it("derives the percent from votingZoneCounts, never from dominantPct", () => {
    // dominantPct is only the sort key; a stale value must not reach the copy.
    const item = blindspotRssItem(
      BASE,
      bundle("c4", {
        dominantPct: 0.5,
        votingZoneCounts: { iktidar: 4, bagimsiz: 1, muhalefet: 0 },
      }),
    );
    expect(item.description).toContain("(%80).");
  });

  it("takes the zone line from bundle.votingZoneCounts, not from a recount of bundle.sources", () => {
    const item = blindspotRssItem(
      BASE,
      bundle("c2", {
        votingZoneCounts: { iktidar: 7, bagimsiz: 0, muhalefet: 2 },
      }),
    );
    expect(item.description).toContain("İktidar 7 · Bağımsız 0 · Muhalefet 2");
    expect(item.description).toContain("6 kaynak");
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
  });

  // h53-consistency-5: the channel description said the other sides "ignored"
  // the story. It states the coverage and nothing about intent.
  it("describes the coverage, never motive, on both feed paths", () => {
    for (const path of ["/rss/kor-noktalar.xml", "/blindspots/rss.xml"]) {
      const xml = buildBlindspotsRssXml(BASE, [], path);
      expect(xml).toContain(
        "<description>Bir tarafın haberi verdiği, diğer taraflardan az ya da hiç haber çıkmayan hikâyeler.</description>",
      );
      expect(xml).not.toMatch(/görmezden|susuyor/i);
    }
  });

  it("caps the item count at BLINDSPOTS_FEED_MAX_ITEMS and keeps the first ones", () => {
    const bundles = Array.from({ length: 70 }, (_, i) => bundle(`c${i}`));
    const xml = buildBlindspotsRssXml(BASE, bundles, "/blindspots/rss.xml");
    expect(count(xml, "<item>")).toBe(BLINDSPOTS_FEED_MAX_ITEMS);
    expect(xml).toContain("/cluster/c59");
    expect(xml).not.toContain("/cluster/c60");
  });

  // h53-consistency-1: the feed reaches every claim of the window, in the
  // page's order: the cards first, then the compact rows.
  it("lists the bundles first, then the compact rows, in the page's order", () => {
    const bundles = [bundle("b1"), bundle("b2")];
    const more = [moreRow("m1"), moreRow("m2"), moreRow("m3")];
    const xml = buildBlindspotsRssXml(BASE, bundles, "/blindspots/rss.xml", more);
    expect(guids(xml)).toEqual(
      ["b1", "b2", "m1", "m2", "m3"].map((id) => `${BASE}/cluster/${id}`),
    );
  });

  it("caps bundles + rows at 60 and keeps the bundles whole when the rows overflow", () => {
    const bundles = Array.from({ length: 30 }, (_, i) => bundle(`b${i}`));
    const more = Array.from({ length: 50 }, (_, i) => moreRow(`m${i}`));
    const xml = buildBlindspotsRssXml(BASE, bundles, "/blindspots/rss.xml", more);
    expect(count(xml, "<item>")).toBe(60);
    expect(xml).toContain("/cluster/b29");
    expect(xml).toContain("/cluster/m29");
    expect(xml).not.toContain("/cluster/m30");
  });

  it("every <link> is unique, even when a claim is in both lists", () => {
    const bundles = [bundle("dup"), bundle("b2")];
    const more = [moreRow("dup"), moreRow("m1"), moreRow("m1")];
    const xml = buildBlindspotsRssXml(BASE, bundles, "/blindspots/rss.xml", more);
    const links = [...xml.matchAll(/<link>(https:\/\/tayfhaber\.com\/cluster\/[^<]*)<\/link>/g)].map(
      (m) => m[1]!,
    );
    expect(links).toHaveLength(3);
    expect(new Set(links).size).toBe(3);
    expect(guids(xml)).toEqual(["dup", "b2", "m1"].map((id) => `${BASE}/cluster/${id}`));
  });

  it("without compact rows it is the feed it always was", () => {
    const bundles = [bundle("c1"), bundle("c2")];
    expect(buildBlindspotsRssXml(BASE, bundles, "/blindspots/rss.xml", [])).toBe(
      buildBlindspotsRssXml(BASE, bundles, "/blindspots/rss.xml"),
    );
  });

  it("emits no items and no lastBuildDate for an empty list", () => {
    const xml = buildBlindspotsRssXml(BASE, [], "/blindspots/rss.xml");
    expect(count(xml, "<item>")).toBe(0);
    expect(xml).not.toContain("<lastBuildDate>");
  });

  it("does not mutate the input array", () => {
    const bundles = Array.from({ length: 70 }, (_, i) => bundle(`c${i}`));
    const more = Array.from({ length: 5 }, (_, i) => moreRow(`m${i}`));
    buildBlindspotsRssXml(BASE, bundles, "/blindspots/rss.xml", more);
    expect(bundles).toHaveLength(70);
    expect(more).toHaveLength(5);
  });
});

describe("blindspotMoreRssItem (h53-consistency-1)", () => {
  it("maps title, utm-tagged link, clean guid and the claim's first-published time", () => {
    const item = blindspotMoreRssItem(BASE, moreRow("m9"));
    expect(item.title).toBe("Kompakt m9");
    expect(item.guid).toBe("https://tayfhaber.com/cluster/m9");
    expect(item.pubDate).toBe("2026-09-19T08:00:00.000Z");
    const url = new URL(item.link);
    expect(url.origin + url.pathname).toBe("https://tayfhaber.com/cluster/m9");
    expect(url.searchParams.get("utm_source")).toBe("rss");
    expect(url.searchParams.get("utm_medium")).toBe("feed");
    expect(url.searchParams.get("utm_campaign")).toBe("kor_nokta");
  });

  it("dates the item by the claim's first publication, never by a later update (review fix correctness-rss-more-pubdate)", () => {
    // A claim's updated_at moves with every new member; first_published does not. A card
    // is dated by first_published, so a compact row dated by updated_at would sort above
    // every card in a date-sorted reader and jump back when it is promoted to a card.
    const row = {
      ...moreRow("m3", { firstPublished: "2026-09-18T06:00:00.000Z" }),
      updatedAt: "2026-09-21T12:00:00.000Z",
    } as BlindspotMoreRow;
    expect(blindspotMoreRssItem(BASE, row).pubDate).toBe("2026-09-18T06:00:00.000Z");
  });

  it("dates a compact row exactly like the card of a claim published at the same time", () => {
    const published = "2026-09-17T09:30:00.000Z";
    const card = bundle("same", {
      cluster: {
        id: "same",
        title_tr: "Başlık same",
        article_count: 5,
        first_published: published,
        updated_at: "2026-09-22T09:30:00.000Z",
      },
    } as unknown as Partial<BlindspotBundle>);
    expect(blindspotMoreRssItem(BASE, moreRow("same", { firstPublished: published })).pubDate).toBe(
      blindspotRssItem(BASE, card).pubDate,
    );
  });

  it("describes the row exactly as a card item: zone, largest-remainder percent (%84, not %85), count, zone line", () => {
    expect(blindspotMoreRssItem(BASE, moreRow("m1")).description).toBe(
      "Kör nokta: ağırlıkla İktidar kaynakları (%84). 13 kaynak · İktidar 11 · Bağımsız 1 · Muhalefet 1",
    );
  });

  it("marks the voting count when aggregators are among the members", () => {
    const item = blindspotMoreRssItem(
      BASE,
      moreRow("m2", {
        dominantZone: "muhalefet",
        sourceCount: 10,
        votingZoneCounts: { iktidar: 0, bagimsiz: 0, muhalefet: 8 },
      }),
    );
    expect(item.description).toBe(
      "Kör nokta: ağırlıkla Muhalefet kaynakları (%100). 10 kaynak (8 sınıflandırılmış) · İktidar 0 · Bağımsız 0 · Muhalefet 8",
    );
  });

  it("gives the same description as the card item for the same claim", () => {
    const card = bundle("same", {
      dominantZone: "iktidar",
      votingZoneCounts: { iktidar: 11, bagimsiz: 1, muhalefet: 1 },
      sources: Array.from({ length: 13 }, (_, i) => ({
        id: `s${i}`,
        name: `S${i}`,
        bias: "pro_government",
        kind: "outlet",
      })),
    } as unknown as Partial<BlindspotBundle>);
    expect(blindspotMoreRssItem(BASE, moreRow("same")).description).toBe(
      blindspotRssItem(BASE, card).description,
    );
  });
});

describe("blindspotsFeedResponse (h53-consistency-1)", () => {
  it("serves the cards followed by the compact rows", async () => {
    mocks.result = {
      bundles: [bundle("b1")],
      more: [moreRow("m1"), moreRow("m2")],
    };
    const res = await blindspotsFeedResponse("/rss/kor-noktalar.xml");
    expect(res.status).toBe(200);
    expect(guids(await res.text())).toEqual(
      ["b1", "m1", "m2"].map((id) => `${BASE}/cluster/${id}`),
    );
  });

  it("still serves a result that has no compact rows at all", async () => {
    mocks.result = { bundles: [bundle("b1")] };
    const res = await blindspotsFeedResponse("/blindspots/rss.xml");
    expect(res.status).toBe(200);
    expect(guids(await res.text())).toEqual([`${BASE}/cluster/b1`]);
  });

  it("answers 503 when the read fails, never an empty feed", async () => {
    mocks.throws = true;
    const res = await blindspotsFeedResponse("/rss/kor-noktalar.xml");
    expect(res.status).toBe(503);
  });
});
