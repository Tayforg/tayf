import { describe, it, expect, vi } from "vitest";

import type { ClusterDetail } from "@/lib/clusters/cluster-detail-query";

// Companion to opengraph-image.test.tsx, which mocks `next/og` to inspect
// the element tree. This file keeps ONE real Satori render in the suite so
// a style Satori doesn't support (grid, a pseudo-element, an unsupported
// property) fails here instead of at the first social crawl.

const getClusterDetail = vi.fn();
vi.mock("@/lib/clusters/cluster-detail-query", () => ({
  getClusterDetail: (...args: unknown[]) => getClusterDetail(...args),
}));

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function blindspotDetail(): ClusterDetail {
  return {
    cluster: {
      id: "x",
      title_tr:
        "Cumhurbaşkanı Erdoğan, Şanlıurfa'daki güneş enerjisi santrali açılışında muhalefete yüklendi; İstanbul'da öğretmenler grev kararı aldı",
      title_original: null,
      summary_tr: "Özet",
      article_count: 7,
      bias_distribution: {
        pro_government: 4,
        gov_leaning: 2,
        state_media: 1,
        center: 0,
        opposition_leaning: 0,
        opposition: 0,
        nationalist: 0,
        islamist_conservative: 0,
        pro_kurdish: 0,
        international: 0,
      },
      is_blindspot: true,
      blindspot_side: "pro_government",
      first_published: "2026-07-01T10:00:00Z",
      updated_at: "2026-07-01T12:00:00Z",
    },
    members: [],
    allSources: [],
    wire: { isWireRedistribution: false, effectiveArticleCount: 7, memberCount: 7 },
  };
}

async function pngBytes(res: Response): Promise<Uint8Array> {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  return new Uint8Array(await res.arrayBuffer());
}

describe("cluster opengraph-image (real Satori render)", () => {
  it("renders the blindspot ribbon card to a real PNG", async () => {
    getClusterDetail.mockResolvedValueOnce(blindspotDetail());
    const { default: Image } = await import("./opengraph-image");

    const bytes = await pngBytes(
      await Image({ params: Promise.resolve({ id: "x" }) }),
    );

    expect(Array.from(bytes.slice(0, 8))).toEqual(PNG_SIGNATURE);
    expect(bytes.byteLength).toBeGreaterThan(10_000);
  });

  it("renders the densest layout — blindspot ribbon + wire pill + chips — to a real PNG", async () => {
    getClusterDetail.mockResolvedValueOnce({
      ...blindspotDetail(),
      wire: { isWireRedistribution: true, effectiveArticleCount: 1, memberCount: 7 },
    });
    const { default: Image } = await import("./opengraph-image");

    const bytes = await pngBytes(
      await Image({ params: Promise.resolve({ id: "x" }) }),
    );

    expect(Array.from(bytes.slice(0, 8))).toEqual(PNG_SIGNATURE);
    expect(bytes.byteLength).toBeGreaterThan(10_000);
  });

  it("renders the twitter-image re-export through the same card", async () => {
    getClusterDetail.mockResolvedValueOnce(null);
    const tw = await import("./twitter-image");
    const og = await import("./opengraph-image");

    expect(tw.default).toBe(og.default);
    expect(tw.size).toEqual({ width: 1200, height: 630 });
    expect(tw.contentType).toBe("image/png");

    const bytes = await pngBytes(
      await tw.default({ params: Promise.resolve({ id: "gone" }) }),
    );
    expect(Array.from(bytes.slice(0, 8))).toEqual(PNG_SIGNATURE);
  });
});
