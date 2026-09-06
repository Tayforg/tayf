import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// GET /rss.xml — asserts the AI-disclosure sentence is appended to the
// channel description exactly once (methodology/trust feature).
// ---------------------------------------------------------------------------

vi.mock("@/lib/clusters/politics-query", () => ({
  getPoliticsClusters: vi.fn(async () => ({
    bundles: [
      {
        cluster: {
          id: "cluster-1",
          title_tr: "Örnek başlık",
          summary_tr: "Örnek özet",
          article_count: 3,
          first_published: "2026-04-17T08:00:00Z",
        },
        articles: [],
        sources: [],
      },
    ],
  })),
}));

describe("GET /rss.xml", () => {
  it("appends the AI-disclosure sentence to the channel description exactly once", async () => {
    const { GET } = await import("@/app/rss.xml/route");
    const res = await GET();
    const xml = await res.text();

    const sentence =
      "Başlıklar yapay zekâ ile tarafsızlaştırılmıştır (tayfhaber.com/metodoloji).";

    const occurrences = xml.split(sentence).length - 1;
    expect(occurrences).toBe(1);

    // Must live inside the channel-level <description>, not an <item>.
    const channelDescMatch = xml.match(
      /<channel>[\s\S]*?<description>([\s\S]*?)<\/description>/,
    );
    expect(channelDescMatch).not.toBeNull();
    expect(channelDescMatch![1]).toContain(sentence);
  });
});
