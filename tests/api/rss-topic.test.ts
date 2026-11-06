import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  TOPIC_SLUGS,
  topicNounTr,
  topicSubtitleTr,
} from "@/lib/clusters/topic-query";

// ---------------------------------------------------------------------------
// /rss/[topic].xml — per-topic RSS feeds + /rss/kor-noktalar.xml.
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
