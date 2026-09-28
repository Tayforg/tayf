import { describe, it, expect, vi, beforeEach } from "vitest";

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
        }),
      ],
    };
    const res = await callRoute("kor-noktalar.xml");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Kör nokta: ağırlıkla İktidar kaynakları (%80).");
    expect(body).toContain("Tayf — Kör noktalar");
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
