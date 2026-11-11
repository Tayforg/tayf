import { describe, it, expect, vi, beforeEach } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  TOPIC_SLUGS,
  topicNounTr,
  topicSubtitleTr,
} from "@/lib/clusters/topic-query";
import {
  ENTITY_HUB_LIMIT,
  entityByKey,
  hubMatchNote,
} from "@/lib/entities/entity-hub";
import { RISING_ENTITIES } from "@/lib/trends/rising-entities";

// ---------------------------------------------------------------------------
// /rss/[topic].xml — per-topic RSS feeds + /rss/kor-noktalar.xml, and (h136-roadmap-3)
// /rss/gundem-<key>.xml, one feed per entity hub.
// ---------------------------------------------------------------------------

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: async () => {} };
});

vi.mock("@/lib/site-url", () => ({
  siteUrl: () => "https://tayfhaber.com",
}));

const mocks = vi.hoisted(() => ({
  topicClusters: null as unknown,
  blindspots: null as unknown,
  blindspotsThrows: false,
  hub: null as unknown,
  hubCalls: [] as unknown[][],
}));

// The entity feed reads page 1 of the hub through the same cached getter the
// /gundem/[key] page uses; the feed has no query of its own.
vi.mock("@/lib/entities/entity-hub-query", () => ({
  getEntityHub: vi.fn(async (...args: unknown[]) => {
    mocks.hubCalls.push(args);
    return mocks.hub;
  }),
}));

vi.mock("@/lib/clusters/topic-query", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/clusters/topic-query")>();
  return {
    ...actual,
    getTopicClusters: vi.fn(async () => mocks.topicClusters),
  };
});

vi.mock("@/lib/clusters/blindspots-query", () => ({
  getBlindspots: vi.fn(async () => {
    if (mocks.blindspotsThrows) throw new Error("boom");
    return mocks.blindspots;
  }),
}));

function bundle(overrides: Record<string, unknown> = {}) {
  return {
    cluster: {
      id: "c1",
      title_tr: "Test başlık",
      article_count: 5,
      first_published: "2026-09-20T10:00:00.000Z",
      updated_at: "2026-09-20T10:00:00.000Z",
    },
    articles: [],
    sources: [
      { id: "s1", name: "A", bias: "pro_government" },
      { id: "s2", name: "B", bias: "center" },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  mocks.topicClusters = { bundles: [bundle()], hasMore: false, page: 1 };
  mocks.blindspots = { bundles: [] };
  mocks.blindspotsThrows = false;
  mocks.hub = { bundles: [bundle()], total: 1, asOfMs: 0 };
  mocks.hubCalls = [];
});

async function callRoute(topic: string) {
  const { GET } = await import("@/app/rss/[topic]/route");
  return GET(new Request("https://tayfhaber.com/rss/" + topic), {
    params: Promise.resolve({ topic }),
  });
}

describe("GET /rss/[topic].xml", () => {
  it("returns 200 RSS with the topic's items", async () => {
    const res = await callRoute("dunya.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/rss+xml");
    const body = await res.text();
    expect(body).toContain("<rss");
    expect(body).toContain("Test başlık");
    expect(body).toContain("Tayf — Dünya haberleri");
  });

  // h46-copy-1: the channel title and description come from the shared topic
  // helpers, so 'genel' (an adjective) is never "Genel haberleri" and a label
  // in the middle of a sentence is lower-case.
  it("the genel channel title is 'Tayf — Genel haberler', never 'Genel haberleri'", async () => {
    const body = await (await callRoute("genel.xml")).text();
    expect(body).toContain("<title>Tayf — Genel haberler</title>");
    expect(body).not.toContain("Genel haberleri");
  });

  it("the channel description is topicSubtitleTr: lower-case label, 'genel gündemde' for genel", async () => {
    const dunya = await (await callRoute("dunya.xml")).text();
    expect(dunya).toContain(
      "<description>Son 7 günde dünya konusunda kümelenen haberler.</description>",
    );
    expect(dunya).toContain("Tayf — Dünya haberleri");
    expect(dunya).not.toContain("Son 7 günde Dünya konusunda");

    const genel = await (await callRoute("genel.xml")).text();
    expect(genel).toContain(
      "<description>Son 7 günde genel gündemde kümelenen haberler.</description>",
    );
    expect(genel).not.toContain("Genel konusunda");
  });

  it.each(TOPIC_SLUGS)("%s: the channel title and description are the helpers' output", async (slug) => {
    const body = await (await callRoute(`${slug}.xml`)).text();
    expect(body).toContain(`<title>Tayf — ${topicNounTr(slug)}</title>`);
    expect(body).toContain(`<description>${topicSubtitleTr(slug)}</description>`);
  });

  it("sets Cache-Control public max-age=300 s-maxage=300", async () => {
    const res = await callRoute("dunya.xml");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=300, s-maxage=300",
    );
  });

  it("does not leak summary_tr into the feed", async () => {
    mocks.topicClusters = {
      bundles: [bundle({ cluster: { ...bundle().cluster, summary_tr: "OUTLET WORDS" } })],
      hasMore: false,
      page: 1,
    };
    const res = await callRoute("dunya.xml");
    const body = await res.text();
    expect(body).not.toContain("OUTLET WORDS");
  });

  it("builds the zone line on the voting basis: an aggregator is counted in 'N kaynak' but not in the zones", async () => {
    mocks.topicClusters = {
      bundles: [
        bundle({
          sources: [
            { id: "s1", name: "A", bias: "pro_government", kind: "outlet" },
            { id: "s2", name: "B", bias: "center", kind: "wire" },
            { id: "s3", name: "C", bias: "opposition", kind: "aggregator" },
            { id: "s4", name: "D", bias: "opposition", kind: "niche" },
            { id: "s5", name: "E", bias: "gov_leaning", kind: null },
          ],
        }),
      ],
      hasMore: false,
      page: 1,
    };
    const res = await callRoute("dunya.xml");
    const body = await res.text();
    // 5 listed sources, 3 voting (outlet, wire, kind-null default): the head
    // names both numbers so the zones (2 + 1 + 0) add up to the parenthesis.
    expect(body).toContain(
      "5 kaynak (3 sınıflandırılmış) · İktidar 2 · Bağımsız 1 · Muhalefet 0",
    );
    expect(body).not.toContain("Muhalefet 1");
  });

  it("prints '10 kaynak (8 sınıflandırılmış)' for 10 members with 2 aggregators, still 4 parts on ' · '", async () => {
    mocks.topicClusters = {
      bundles: [
        bundle({
          sources: [
            ...Array.from({ length: 8 }, (_, i) => ({
              id: `v${i}`,
              name: `V${i}`,
              bias: "pro_government",
              kind: "outlet",
            })),
            { id: "a1", name: "Agg1", bias: "center", kind: "aggregator" },
            { id: "a2", name: "Agg2", bias: "opposition", kind: "aggregator" },
          ],
        }),
      ],
      hasMore: false,
      page: 1,
    };
    const body = await (await callRoute("dunya.xml")).text();
    const description = /<description>(\d+ kaynak[^<]*)<\/description>/.exec(body)?.[1];
    expect(description).toBe(
      "10 kaynak (8 sınıflandırılmış) · İktidar 8 · Bağımsız 0 · Muhalefet 0",
    );
    expect(description!.split(" · ")).toHaveLength(4);
  });

  it("keeps the bare count when every member votes, still 4 parts on ' · '", async () => {
    mocks.topicClusters = {
      bundles: [
        bundle({
          sources: [
            { id: "s1", name: "A", bias: "pro_government", kind: "outlet" },
            { id: "s2", name: "B", bias: "pro_government", kind: "outlet" },
            { id: "s3", name: "C", bias: "state_media", kind: "wire" },
            { id: "s4", name: "D", bias: "gov_leaning", kind: "outlet" },
            { id: "s5", name: "E", bias: "center", kind: "outlet" },
            { id: "s6", name: "F", bias: "center", kind: "outlet" },
            { id: "s7", name: "G", bias: "opposition", kind: "outlet" },
          ],
        }),
      ],
      hasMore: false,
      page: 1,
    };
    const body = await (await callRoute("dunya.xml")).text();
    const description = /<description>(\d+ kaynak[^<]*)<\/description>/.exec(body)?.[1];
    expect(description).toBe(
      "7 kaynak · İktidar 4 · Bağımsız 2 · Muhalefet 1",
    );
    expect(description!.split(" · ")).toHaveLength(4);
  });

  it("404s an unknown slug like politika.xml", async () => {
    const res = await callRoute("politika.xml");
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
  });

  it("404s a slug missing the .xml suffix", async () => {
    const res = await callRoute("dunya");
    expect(res.status).toBe(404);
  });

  it("404s a path-traversal attempt", async () => {
    const res = await callRoute("../x.xml");
    expect(res.status).toBe(404);
  });

  it("returns 503 with no-store when the topic data is null", async () => {
    mocks.topicClusters = null;
    const res = await callRoute("dunya.xml");
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Retry-After")).toBe("300");
  });

  it("returns 503 when getBlindspots throws", async () => {
    mocks.blindspotsThrows = true;
    const res = await callRoute("kor-noktalar.xml");
    expect(res.status).toBe(503);
  });

  it("serves /rss/kor-noktalar.xml with a blindspot prefix and zone line", async () => {
    mocks.blindspots = {
      bundles: [
        bundle({
          dominantZone: "iktidar",
          dominantPct: 0.8,
          // The blindspot feed reads the voting tally the card is built on.
          votingZoneCounts: { iktidar: 4, bagimsiz: 1, muhalefet: 0 },
        }),
      ],
    };
    const res = await callRoute("kor-noktalar.xml");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Kör nokta: ağırlıkla İktidar kaynakları (%80).");
    expect(body).toContain("2 kaynak · İktidar 4 · Bağımsız 1 · Muhalefet 0");
    expect(body).toContain("Tayf — Kör noktalar");
  });

  it("serves /rss/kor-noktalar.xml with the parenthesised voting count when aggregators are members", async () => {
    mocks.blindspots = {
      bundles: [
        bundle({
          dominantZone: "iktidar",
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
        }),
      ],
    };
    const body = await (await callRoute("kor-noktalar.xml")).text();
    const description = /<description>(Kör nokta[^<]*)<\/description>/.exec(body)?.[1];
    expect(description).toBe(
      "Kör nokta: ağırlıkla İktidar kaynakları (%100). 10 kaynak (8 sınıflandırılmış) · İktidar 8 · Bağımsız 0 · Muhalefet 0",
    );
    expect(description!.split(" · ")).toHaveLength(4);
  });

  it("caps items at 30 per feed", async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      bundle({ cluster: { ...bundle().cluster, id: `c${i}` } }),
    );
    mocks.topicClusters = { bundles: many, hasMore: true, page: 1 };
    const res = await callRoute("dunya.xml");
    const body = await res.text();
    const itemCount = (body.match(/<item>/g) ?? []).length;
    expect(itemCount).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// h136-roadmap-3: /rss/gundem-<key>.xml, one RSS feed per entity hub. Page 1 of
// getEntityHub (the read /gundem/<key> renders), the topic feeds' item builder,
// headers and 503, a 'gundem-' prefix that cannot collide with a topic slug.
// ---------------------------------------------------------------------------

function hubBundle(i: number, overrides: Record<string, unknown> = {}) {
  return bundle({
    cluster: {
      ...bundle().cluster,
      id: `c${i}`,
      title_tr: `Hub başlığı ${i}`,
      first_published: new Date(Date.UTC(2026, 10, 10, 12, 0) - i * 3_600_000).toISOString(),
    },
    ...overrides,
  });
}

function itemLinks(body: string): string[] {
  return [...body.matchAll(/<link>([^<]*)<\/link>/g)].map((m) => m[1] as string).slice(1);
}

describe("GET /rss/gundem-<key>.xml", () => {
  it("returns 200 application/rss+xml with the hub's items, and reads only page 1 of the hub", async () => {
    mocks.hub = { bundles: [hubBundle(1), hubBundle(2)], total: 152, asOfMs: 0 };
    const res = await callRoute("gundem-chp.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/rss+xml; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("<rss");
    expect(body).toContain("Hub başlığı 1");
    expect(body).toContain("Hub başlığı 2");
    // the same cached read the page uses: key only, so page 1, no query of its own
    expect(mocks.hubCalls).toEqual([["chp"]]);
  });

  it("carries at most ENTITY_HUB_LIMIT (20) items even when the read hands back more", async () => {
    mocks.hub = {
      bundles: Array.from({ length: 25 }, (_, i) => hubBundle(i)),
      total: 400,
      asOfMs: 0,
    };
    const body = await (await callRoute("gundem-chp.xml")).text();
    expect(ENTITY_HUB_LIMIT).toBe(20);
    expect((body.match(/<item>/g) ?? []).length).toBe(20);
    expect(body).not.toContain("Hub başlığı 20<");
  });

  it("keeps the hub's order (first_published desc) and prints the cluster ids in it", async () => {
    mocks.hub = { bundles: [hubBundle(3), hubBundle(1), hubBundle(2)], total: 3, asOfMs: 0 };
    const body = await (await callRoute("gundem-chp.xml")).text();
    const ids = itemLinks(body).map((l) => /\/cluster\/(c\d+)/.exec(l)?.[1]);
    expect(ids).toEqual(["c3", "c1", "c2"]);
  });

  it("links carry utm_campaign=gundem_<key>; the guid is the canonical cluster URL with no utm_", async () => {
    mocks.hub = { bundles: [hubBundle(1)], total: 1, asOfMs: 0 };
    const body = await (await callRoute("gundem-chp.xml")).text();
    expect(body).toContain(
      "<link>https://tayfhaber.com/cluster/c1?utm_source=rss&amp;utm_medium=feed&amp;utm_campaign=gundem_chp</link>",
    );
    expect(body).toContain(
      '<guid isPermaLink="true">https://tayfhaber.com/cluster/c1</guid>',
    );
    const guids = [...body.matchAll(/<guid[^>]*>([^<]*)<\/guid>/g)].map((m) => m[1] as string);
    expect(guids).toHaveLength(1);
    expect(guids[0]).not.toContain("utm_");
  });

  it("uses the campaign of the requested hub, with a hyphenated key intact", async () => {
    mocks.hub = { bundles: [hubBundle(1)], total: 1, asOfMs: 0 };
    const body = await (await callRoute("gundem-ozgur-ozel.xml")).text();
    expect(body).toContain("utm_campaign=gundem_ozgur-ozel");
    expect(mocks.hubCalls).toEqual([["ozgur-ozel"]]);
  });

  it("builds the item description with the topic feeds' source-count head and zone line", async () => {
    mocks.hub = {
      bundles: [
        hubBundle(1, {
          sources: [
            { id: "s1", name: "A", bias: "pro_government", kind: "outlet" },
            { id: "s2", name: "B", bias: "center", kind: "wire" },
            { id: "s3", name: "C", bias: "opposition", kind: "aggregator" },
          ],
        }),
      ],
      total: 1,
      asOfMs: 0,
    };
    const body = await (await callRoute("gundem-chp.xml")).text();
    expect(body).toContain(
      "<description>3 kaynak (2 sınıflandırılmış) · İktidar 1 · Bağımsız 1 · Muhalefet 0</description>",
    );
  });

  it("never prints old_title, only the current headline, and no summary text", async () => {
    mocks.hub = {
      bundles: [
        hubBundle(1, {
          cluster: {
            ...hubBundle(1).cluster,
            old_title: "ESKİ BAŞLIK",
            summary_tr: "ÖZET METNİ",
          },
        }),
      ],
      total: 1,
      asOfMs: 0,
    };
    const body = await (await callRoute("gundem-chp.xml")).text();
    expect(body).not.toContain("ESKİ BAŞLIK");
    expect(body).not.toContain("ÖZET METNİ");
    expect(body).toContain("Hub başlığı 1");
    const src = readFileSync(resolve(__dirname, "..", "..", "src", "app", "rss", "[topic]", "route.ts"), "utf8");
    expect(src).not.toContain("old_title");
  });

  it("channel: title 'Tayf — Gündem: {label}', link to the hub, atom self, description from hubMatchNote", async () => {
    mocks.hub = { bundles: [hubBundle(1)], total: 1, asOfMs: 0 };
    const body = await (await callRoute("gundem-chp.xml")).text();
    expect(body).toContain("<title>Tayf — Gündem: CHP</title>");
    expect(body).toContain("<link>https://tayfhaber.com/gundem/chp</link>");
    expect(body).toContain(
      '<atom:link href="https://tayfhaber.com/rss/gundem-chp.xml" rel="self" type="application/rss+xml" />',
    );
    const channelDescription = /<atom:link[^>]*\/>\s*<description>([^<]*)<\/description>/.exec(body)?.[1];
    expect(channelDescription).toBe(
      `${hubMatchNote(entityByKey("chp")!)} (son 14 gün, en yeni 20)`,
    );
    expect(channelDescription!.endsWith("(son 14 gün, en yeni 20)")).toBe(true);
  });

  it("akp (headline-only) says the match is on the headline only, never the lead", async () => {
    mocks.hub = { bundles: [hubBundle(1)], total: 1, asOfMs: 0 };
    const body = await (await callRoute("gundem-akp.xml")).text();
    expect(body).toContain("<title>Tayf — Gündem: AK Parti</title>");
    const channelDescription = /<atom:link[^>]*\/>\s*<description>([^<]*)<\/description>/.exec(body)?.[1];
    expect(channelDescription).toContain("küme başlığında geçen ada göre");
    expect(channelDescription).not.toContain("özetin ilk paragrafında");
    expect(channelDescription!.endsWith("(son 14 gün, en yeni 20)")).toBe(true);
  });

  it("sets exactly the topic feeds' Cache-Control", async () => {
    const entity = await callRoute("gundem-chp.xml");
    const topic = await callRoute("dunya.xml");
    expect(entity.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=300");
    expect(entity.headers.get("Cache-Control")).toBe(topic.headers.get("Cache-Control"));
  });

  it("a hub with no cluster in the window is a normal 200 feed with no items, not a 503", async () => {
    mocks.hub = { bundles: [], total: 0, asOfMs: 0 };
    const res = await callRoute("gundem-chp.xml");
    expect(res.status).toBe(200);
    expect(((await res.text()).match(/<item>/g) ?? []).length).toBe(0);
  });

  it("a null read is a 503 with Retry-After 300 and no-store, exactly as the topic feeds answer", async () => {
    mocks.hub = null;
    const res = await callRoute("gundem-chp.xml");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("300");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    mocks.topicClusters = null;
    const topic = await callRoute("dunya.xml");
    expect(Object.fromEntries(res.headers)).toEqual(Object.fromEntries(topic.headers));
  });

  it.each([
    ["gundem-.xml", "an empty key"],
    ["gundem-unknown.xml", "an unknown key"],
    ["gundem-chp-x.xml", "a key plus a suffix"],
    ["gundem-chp-.xml", "a trailing hyphen"],
    ["gundem--chp.xml", "a leading hyphen"],
    ["gundem-CHP.xml", "an upper-case key"],
    ["gundem-chp", "no .xml suffix"],
    ["gundem-chp.xml.xml", "a doubled suffix"],
    ["gundem-__proto__.xml", "a prototype name"],
    ["gundem-constructor.xml", "a prototype name"],
    ["chp.xml", "the bare key without the prefix"],
    ["gundem.xml", "the prefix word alone"],
    ["gundem-dunya.xml", "a topic slug after the prefix"],
    ["gundem-kor-noktalar.xml", "the blindspot slug after the prefix"],
  ])("404s %s (%s) without reading the hub", async (name) => {
    const res = await callRoute(name);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(mocks.hubCalls).toEqual([]);
  });

  it("every curated entity key has a feed: the key fits the slug pattern and cannot collide with a topic slug", async () => {
    expect(RISING_ENTITIES.length).toBeGreaterThan(50);
    for (const e of RISING_ENTITIES) {
      expect(e.key, e.key).toMatch(/^[a-z-]+$/);
      expect((TOPIC_SLUGS as readonly string[]).includes(`gundem-${e.key}`), e.key).toBe(false);
      const res = await callRoute(`gundem-${e.key}.xml`);
      expect(res.status, e.key).toBe(200);
    }
  });

  it("leaves the topic and kor-noktalar feeds byte-identical (golden XML of the unchanged route)", async () => {
    mocks.topicClusters = {
      bundles: [
        {
          cluster: {
            id: "c1",
            title_tr: "Birinci & başlık",
            first_published: "2026-09-20T10:00:00.000Z",
            updated_at: "2026-09-20T10:00:00.000Z",
          },
          articles: [],
          sources: [
            { id: "s1", name: "A", bias: "pro_government" },
            { id: "s2", name: "B", bias: "center" },
          ],
        },
        {
          cluster: {
            id: "c2",
            title_tr: "İkinci başlık",
            first_published: "2026-09-19T08:30:00.000Z",
            updated_at: "2026-09-20T10:00:00.000Z",
          },
          articles: [],
          sources: [{ id: "s3", name: "C", bias: "opposition", kind: "outlet" }],
        },
      ],
      hasMore: false,
      page: 1,
    };
    const body = await (await callRoute("dunya.xml")).text();
    expect(body).toBe(GOLDEN_DUNYA);
    expect(mocks.hubCalls).toEqual([]);
  });
});

const GOLDEN_DUNYA = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Tayf — Dünya haberleri</title>
    <link>https://tayfhaber.com/konu/dunya</link>
    <atom:link href="https://tayfhaber.com/rss/dunya.xml" rel="self" type="application/rss+xml" />
    <description>Son 7 günde dünya konusunda kümelenen haberler.</description>
    <language>tr-TR</language>
    <lastBuildDate>Sun, 20 Sep 2026 10:00:00 GMT</lastBuildDate>
        <item>
      <title>Birinci &amp; başlık</title>
      <link>https://tayfhaber.com/cluster/c1?utm_source=rss&amp;utm_medium=feed&amp;utm_campaign=konu_dunya</link>
      <guid isPermaLink="true">https://tayfhaber.com/cluster/c1</guid>
      <pubDate>Sun, 20 Sep 2026 10:00:00 GMT</pubDate>
      <description>2 kaynak · İktidar 1 · Bağımsız 1 · Muhalefet 0</description>
    </item>
    <item>
      <title>İkinci başlık</title>
      <link>https://tayfhaber.com/cluster/c2?utm_source=rss&amp;utm_medium=feed&amp;utm_campaign=konu_dunya</link>
      <guid isPermaLink="true">https://tayfhaber.com/cluster/c2</guid>
      <pubDate>Sat, 19 Sep 2026 08:30:00 GMT</pubDate>
      <description>1 kaynak · İktidar 0 · Bağımsız 0 · Muhalefet 1</description>
    </item>
  </channel>
</rss>`;
