import { describe, it, expect, vi } from "vitest";

import type {
  ClusterDetail,
  ClusterDetailMember,
} from "@/lib/clusters/cluster-detail-query";
import type { Source } from "@/types";

// Companion to route.test.tsx, which mocks `next/og` to inspect the
// element tree. This file keeps ONE real Satori render of the 9:16 story
// card in the suite — mirroring opengraph-image.render.test.tsx — so a
// style Satori doesn't support (grid, a pseudo-element, an unsupported
// property) fails here instead of at the first reader who taps "Kartı
// indir". The card uses styles the OG card does not: `fontFamily: "Geist,
// sans-serif"`, `flexGrow: <member count>` bar segments and nested gap
// columns.
//
// `next/og` is deliberately NOT mocked here, and the response headers are
// asserted on the REAL Response so no mock can certify a header the
// framework might drop.

const getClusterDetail = vi.fn();
vi.mock("@/lib/clusters/cluster-detail-query", () => ({
  getClusterDetail: (...args: unknown[]) => getClusterDetail(...args),
}));

const getZoneFeedHealth = vi.fn();
vi.mock("@/lib/clusters/feed-health", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/clusters/feed-health")>();
  return { ...actual, getZoneFeedHealth: () => getZoneFeedHealth() };
});

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const ID = "3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b";

const LONG_TITLE =
  "Cumhurbaşkanı Erdoğan, Şanlıurfa'daki güneş enerjisi santrali açılışında muhalefete yüklendi; İstanbul'da öğretmenler grev kararı aldı";

function mkSource(id: string, name: string, bias: Source["bias"]): Source {
  return {
    id,
    name,
    slug: id,
    url: `https://example.com/${id}`,
    rss_url: `https://example.com/${id}/rss`,
    bias,
    logo_url: null,
    active: true,
    kind: undefined,
    trustee_since: null,
    trustee_note: null,
  };
}

function mkMember(
  id: string,
  source: Source,
  title: string,
): ClusterDetailMember {
  return {
    source,
    article: {
      id,
      title,
      url: `https://example.com/articles/${id}`,
      published_at: "2026-09-10T08:00:00Z",
      image_url: null,
      content_hash: `hash-${id}`,
    },
  };
}

function detailWithLongHeadlines(): ClusterDetail {
  const members = [
    mkMember(
      "a1",
      mkSource("gov1", "İktidar Gazetesi", "pro_government"),
      "Meclis bütçe görüşmelerinde iktidar kanadı, yatırım programının önceliklerini savunarak takvimin değişmeyeceğini açıkladı",
    ),
    mkMember(
      "a2",
      mkSource("c1", "Bağımsız Haber Ajansı", "center"),
      "Bütçe görüşmelerinin ikinci gününde uzlaşma arayışı sürüyor, komisyon kaynakları takvimin sıkıştığını söylüyor",
    ),
    mkMember(
      "a3",
      mkSource("opp1", "Muhalif Gazete", "opposition"),
      "Muhalefet bütçe teklifine itiraz etti: gelir kalemlerinin gerçekçi olmadığını, hesabın tutmadığını savunuyor",
    ),
  ];

  return {
    cluster: {
      id: ID,
      title_tr: LONG_TITLE,
      title_original: null,
      title_method: null,
      summary_tr: "Özet",
      article_count: members.length,
      bias_distribution: {
        pro_government: 1,
        gov_leaning: 0,
        state_media: 0,
        center: 1,
        opposition_leaning: 0,
        opposition: 1,
        nationalist: 0,
        islamist_conservative: 0,
        pro_kurdish: 0,
        international: 0,
      },
      is_blindspot: false,
      blindspot_side: null,
      first_published: "2026-09-10T07:00:00Z",
      updated_at: "2026-09-10T12:00:00Z",
      is_archived: false,
    },
    members,
    allSources: [],
    wire: {
      isWireRedistribution: false,
      effectiveArticleCount: members.length,
      memberCount: members.length,
    },
    blindspotSuppressed: false,
  };
}

describe("GET /cluster/[id]/kart (real Satori render)", () => {
  it("rasterises a 1080×1920 PNG and keeps its real cache headers", async () => {
    getClusterDetail.mockResolvedValueOnce(detailWithLongHeadlines());
    getZoneFeedHealth.mockResolvedValue(null);

    const { GET } = await import("./route");
    const res = await GET(
      new Request(`https://tayfhaber.com/cluster/${ID}/kart`),
      { params: Promise.resolve({ id: ID }) },
    );

    expect(res.status).toBe(200);
    // Asserted on the real Response, not on the options handed to a mock.
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("s-maxage=300");

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(0, 8))).toEqual(PNG_SIGNATURE);

    // IHDR: width at bytes 16-19, height at 20-23, both big-endian.
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(header.getUint32(16)).toBe(1080);
    expect(header.getUint32(20)).toBe(1920);
    expect(bytes.byteLength).toBeGreaterThan(10_000);
  });
});
