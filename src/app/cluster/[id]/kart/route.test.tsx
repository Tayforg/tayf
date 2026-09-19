import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

import type {
  ClusterDetail,
  ClusterDetailMember,
} from "@/lib/clusters/cluster-detail-query";
import type { ZoneFeedHealth, ZoneHealth } from "@/lib/clusters/feed-health";
import type { MediaDnaZone, Source } from "@/types";

// Mocked BEFORE the module under test is imported so the route's
// `getClusterDetail` / `getZoneFeedHealth` imports resolve to these stubs
// instead of hitting Supabase (and so `"use cache"` never runs here).
const getClusterDetail = vi.fn();
vi.mock("@/lib/clusters/cluster-detail-query", () => ({
  getClusterDetail: (...args: unknown[]) => getClusterDetail(...args),
}));

const getZoneFeedHealth = vi.fn();
vi.mock("@/lib/clusters/feed-health", async (importOriginal) => {
  // zoneYieldDenominator is a pure helper story-card.ts calls — keep the
  // real one, mock only the network-backed fetcher.
  const actual = await importOriginal<typeof import("@/lib/clusters/feed-health")>();
  return { ...actual, getZoneFeedHealth: () => getZoneFeedHealth() };
});

// Mock next/og so the element tree the handler builds is observable
// instead of being opaquely rendered to PNG bytes by Satori.
let captured: ReactElement | null = null;
let capturedOptions: Record<string, unknown> | null = null;
vi.mock("next/og", () => ({
  ImageResponse: class {
    constructor(element: ReactElement, options: Record<string, unknown>) {
      captured = element;
      capturedOptions = options;
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    }
  },
}));

function collectText(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { props?: { children?: unknown } };
    if (el.props?.children !== undefined) collectText(el.props.children, out);
  }
  return out;
}

const ID = "3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b";

function mkSource(overrides: Partial<Source> & { id: string }): Source {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    slug: overrides.slug ?? overrides.id,
    url: overrides.url ?? `https://example.com/${overrides.id}`,
    rss_url: overrides.rss_url ?? `https://example.com/${overrides.id}/rss`,
    bias: overrides.bias ?? "center",
    logo_url: overrides.logo_url ?? null,
    active: overrides.active ?? true,
    kind: overrides.kind,
    trustee_since: overrides.trustee_since ?? null,
    trustee_note: overrides.trustee_note ?? null,
  };
}

function mkMember(
  id: string,
  source: Source,
  title: string,
  publishedAt = "2026-09-10T08:00:00Z",
): ClusterDetailMember {
  return {
    source,
    article: {
      id,
      title,
      url: `https://example.com/articles/${id}`,
      published_at: publishedAt,
      image_url: null,
      content_hash: `hash-${id}`,
    },
  };
}

function mkZoneHealth(overrides: Partial<ZoneHealth> = {}): ZoneHealth {
  return {
    total: 10,
    fetchOk: 9,
    fetchOkShare: 0.9,
    delivering: 8,
    deliveringShare: 0.8,
    healthy: 8,
    healthyShare: 0.8,
    degraded: false,
    ...overrides,
  };
}

function mkHealth(
  overrides: Partial<Record<MediaDnaZone, Partial<ZoneHealth>>> = {},
): ZoneFeedHealth {
  return {
    iktidar: mkZoneHealth(overrides.iktidar),
    bagimsiz: mkZoneHealth(overrides.bagimsiz),
    muhalefet: mkZoneHealth(overrides.muhalefet),
  };
}

const GOV = mkSource({
  id: "gov1",
  name: "İktidar Gazetesi",
  bias: "pro_government",
});
const CENTER = mkSource({ id: "c1", name: "Bağımsız Ajans", bias: "center" });
const OPP = mkSource({ id: "opp1", name: "Muhalif Gazete", bias: "opposition" });

const GOV_TITLE = "Bütçe teklifi mecliste görüşüldü";
const CENTER_TITLE = "Bütçe görüşmelerinde uzlaşma arayışı";
const OPP_TITLE = "Muhalefet bütçeye itiraz etti";

function mkDetail(
  members: ClusterDetailMember[],
  overrides: Partial<ClusterDetail["cluster"]> = {},
): ClusterDetail {
  return {
    cluster: {
      id: ID,
      title_tr: "Bütçe görüşmeleri başladı",
      title_original: null,
      title_method: null,
      summary_tr: "Özet",
      article_count: members.length,
      bias_distribution: {
        pro_government: 0,
        gov_leaning: 0,
        state_media: 0,
        center: 0,
        opposition_leaning: 0,
        opposition: 0,
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
      ...overrides,
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

async function callGET(id: string): Promise<Response> {
  const { GET } = await import("./route");
  return GET(new Request(`https://tayfhaber.com/cluster/${id}/kart`), {
    params: Promise.resolve({ id }),
  });
}

describe("GET /cluster/[id]/kart", () => {
  beforeEach(() => {
    captured = null;
    capturedOptions = null;
    // The route's rate limiter (G-SEC-1) keeps its token bucket in
    // module scope, and every request here resolves to the same "anon"
    // client key — without a module reset the 11th test in this file
    // would start getting 429s from the previous tests' spend.
    vi.resetModules();
    getClusterDetail.mockReset();
    getZoneFeedHealth.mockReset();
    getZoneFeedHealth.mockResolvedValue(null);
  });

  it("404s on a non-uuid id without touching the database", async () => {
    const res = await callGET("not-a-uuid");

    expect(res.status).toBe(404);
    expect(getClusterDetail).not.toHaveBeenCalled();
  });

  it("404s on an id-shaped path traversal attempt without touching the database", async () => {
    const res = await callGET("../../etc/passwd");

    expect(res.status).toBe(404);
    expect(getClusterDetail).not.toHaveBeenCalled();
  });

  it("404s when the cluster does not exist", async () => {
    getClusterDetail.mockResolvedValueOnce(null);

    const res = await callGET(ID);

    expect(res.status).toBe(404);
    expect(getClusterDetail).toHaveBeenCalledWith(ID);
  });

  it("404s when the cluster has no members at all", async () => {
    getClusterDetail.mockResolvedValueOnce(mkDetail([]));

    const res = await callGET(ID);

    expect(res.status).toBe(404);
  });

  it("renders a PNG carrying the title, one headline per zone and the wordmark", async () => {
    getClusterDetail.mockResolvedValueOnce(
      mkDetail([
        mkMember("a1", GOV, GOV_TITLE),
        mkMember("a2", CENTER, CENTER_TITLE),
        mkMember("a3", OPP, OPP_TITLE),
      ]),
    );

    const res = await callGET(ID);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");

    const text = collectText(captured).join(" ");
    expect(text).toContain("TAYF");
    expect(text).toContain("Aynı haber, farklı dünyalar");
    expect(text).toContain("Bütçe görüşmeleri başladı");
    expect(text).toContain("İktidar Gazetesi");
    expect(text).toContain("Bağımsız Ajans");
    expect(text).toContain("Muhalif Gazete");
    expect(text).toContain(GOV_TITLE);
    expect(text).toContain(CENTER_TITLE);
    expect(text).toContain(OPP_TITLE);
    expect(text).toContain("10.09.2026");
    expect(text).toContain(`tayfhaber.com/cluster/${ID}`);
  });

  it("carries no article excerpt or image — headlines only", async () => {
    getClusterDetail.mockResolvedValueOnce(
      mkDetail([mkMember("a1", GOV, GOV_TITLE)], {
        summary_tr: "GIZLI-OZET-METNI",
      }),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).not.toContain("GIZLI-OZET-METNI");
    expect(JSON.stringify(captured)).not.toContain("img");
  });

  it("falls back to the wording-only counter when feed health is unknown", async () => {
    getZoneFeedHealth.mockResolvedValue(null);
    getClusterDetail.mockResolvedValueOnce(
      mkDetail([mkMember("a1", GOV, GOV_TITLE)]),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).toContain("1 kaynak · payda bilinmiyor");
    expect(text).not.toContain("payda bilinmiyor kaynak");
    expect(text).not.toContain("/ null");
  });

  it("prints the yield denominator per zone when feed health is known", async () => {
    getZoneFeedHealth.mockResolvedValue(
      mkHealth({ iktidar: { delivering: 5 }, muhalefet: { delivering: 3 } }),
    );
    getClusterDetail.mockResolvedValueOnce(
      mkDetail([
        mkMember("a1", GOV, GOV_TITLE),
        mkMember("a2", OPP, OPP_TITLE),
      ]),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).toContain("1 / 5 kaynak");
    expect(text).toContain("1 / 3 kaynak");
    expect(text).toContain("0 / 8 kaynak");
    expect(text).not.toContain("payda bilinmiyor");
  });

  it("renders the silent-zone line for a zone with no members", async () => {
    getClusterDetail.mockResolvedValueOnce(
      mkDetail([mkMember("a1", GOV, GOV_TITLE)]),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).toContain("— bu tarafta haber yok");
    expect(text).toContain("İktidar");
    expect(text).toContain("Bağımsız");
    expect(text).toContain("Muhalefet");
  });

  it("adds the degraded-feed caveat only for a silent zone whose feeds are broken", async () => {
    getZoneFeedHealth.mockResolvedValue(mkHealth({ muhalefet: { degraded: true } }));
    getClusterDetail.mockResolvedValueOnce(
      mkDetail([mkMember("a1", GOV, GOV_TITLE)]),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).toContain("bazı kaynaklara ulaşılamıyor");
    expect(text.match(/bazı kaynaklara ulaşılamıyor/g)).toHaveLength(1);
  });

  it("omits a headline whose title the PII filter excludes, keeping its coverage count", async () => {
    getZoneFeedHealth.mockResolvedValue(null);
    getClusterDetail.mockResolvedValueOnce(
      mkDetail([
        mkMember("a1", GOV, "17 yaşındaki çocuk kayboldu"),
        mkMember("a2", CENTER, "17 yaşındaki çocuk kayboldu"),
        mkMember("a3", OPP, "17 yaşındaki çocuk kayboldu"),
      ]),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).not.toContain("17 yaşındaki çocuk kayboldu");
    expect(text).toContain("1 kaynak · payda bilinmiyor");
    // KART-02: a zone whose members were all PII-filtered is NOT silent —
    // the counter beside it prints their unfiltered count, so claiming
    // "no news on this side" would make the card contradict itself.
    expect(text).not.toContain("— bu tarafta haber yok");
    expect(text).toContain("1 kaynak yazdı · başlık paylaşıma uygun değil");
  });

  it("never prints the degraded-feed caveat for a PII-filtered zone that was in fact covered", async () => {
    getZoneFeedHealth.mockResolvedValue(
      mkHealth({
        iktidar: { degraded: true },
        bagimsiz: { degraded: true },
        muhalefet: { degraded: true },
      }),
    );
    getClusterDetail.mockResolvedValueOnce(
      mkDetail([
        mkMember("a1", GOV, "17 yaşındaki çocuk kayboldu"),
        mkMember("a2", CENTER, "17 yaşındaki çocuk kayboldu"),
        mkMember("a3", OPP, "17 yaşındaki çocuk kayboldu"),
      ]),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).not.toContain("bazı kaynaklara ulaşılamıyor");
    expect(text).not.toContain("— bu tarafta haber yok");
  });

  it("404s without rendering anything when the cluster title itself trips the PII filter", async () => {
    getClusterDetail.mockResolvedValueOnce(
      mkDetail([mkMember("a1", GOV, GOV_TITLE)], {
        title_tr: "17 yaşındaki çocuk gözaltına alındı",
      }),
    );

    const res = await callGET(ID);

    expect(res.status).toBe(404);
    // G-PRIV-1: no ImageResponse was ever constructed, so the excluded
    // wording cannot reach a rasterised, redistributable image.
    expect(captured).toBeNull();
    expect(capturedOptions).toBeNull();
  });

  it("refuses to print an impossible fraction when the count exceeds the yield denominator", async () => {
    getZoneFeedHealth.mockResolvedValue(
      mkHealth({ iktidar: { delivering: 3 }, muhalefet: { delivering: 0 } }),
    );
    getClusterDetail.mockResolvedValueOnce(
      mkDetail([
        mkMember("a1", GOV, GOV_TITLE),
        mkMember("a2", mkSource({ id: "gov2", bias: "pro_government" }), GOV_TITLE),
        mkMember("a3", mkSource({ id: "gov3", bias: "pro_government" }), GOV_TITLE),
        mkMember("a4", mkSource({ id: "gov4", bias: "pro_government" }), GOV_TITLE),
        mkMember("a5", mkSource({ id: "gov5", bias: "pro_government" }), GOV_TITLE),
        mkMember("a6", OPP, OPP_TITLE),
      ]),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    // KART-03: 5 members over the story's lifetime vs 3 feeds that
    // delivered in the yield window are different populations.
    expect(text).not.toContain("5 / 3");
    expect(text).toContain("5 kaynak · payda güvenilir değil (3)");
    expect(text).not.toContain("1 / 0");
    expect(text).toContain("1 kaynak · payda: 0 sağlıklı kaynak");
  });

  it("truncates by code point so a cut never splits a surrogate pair", async () => {
    const longTitle = "😀".repeat(400);
    getClusterDetail.mockResolvedValueOnce(
      mkDetail([mkMember("a1", GOV, GOV_TITLE)], { title_tr: longTitle }),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).toContain(`${"😀".repeat(139)}…`);
    // No lone surrogate survives once well-formed pairs are removed.
    const unpaired = text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "");
    expect(/[\uD800-\uDFFF]/.test(unpaired)).toBe(false);
  });

  it("rate limits the render and stops hitting the database once the bucket is empty", async () => {
    getClusterDetail.mockResolvedValue(
      mkDetail([mkMember("a1", GOV, GOV_TITLE)]),
    );

    // Capacity is 10 tokens; drain them on cheap 404s (the limiter runs
    // before the uuid check, so a malformed-id flood is bounded too).
    for (let i = 0; i < 10; i += 1) {
      expect((await callGET("not-a-uuid")).status).toBe(404);
    }
    getClusterDetail.mockClear();

    const res = await callGET(ID);

    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(getClusterDetail).not.toHaveBeenCalled();
    expect(captured).toBeNull();
  });

  it("truncates an overlong title and headline instead of overflowing the card", async () => {
    const longTitle = "A".repeat(400);
    const longHeadline = "B".repeat(400);
    getClusterDetail.mockResolvedValueOnce(
      mkDetail([mkMember("a1", GOV, longHeadline)], { title_tr: longTitle }),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).toContain(`${"A".repeat(139)}…`);
    expect(text).not.toContain("A".repeat(141));
    expect(text).toContain(`${"B".repeat(109)}…`);
    expect(text).not.toContain("B".repeat(111));
  });

  it("renders at 1080×1920 with a cacheable inline-PNG disposition", async () => {
    getClusterDetail.mockResolvedValueOnce(
      mkDetail([mkMember("a1", GOV, GOV_TITLE)]),
    );

    await callGET(ID);

    expect(capturedOptions).not.toBeNull();
    expect(capturedOptions!.width).toBe(1080);
    expect(capturedOptions!.height).toBe(1920);
    const headers = capturedOptions!.headers as Record<string, string>;
    expect(headers["Cache-Control"]).toContain("s-maxage=300");
    expect(headers["Content-Disposition"]).toContain("inline");
  });

  it("still renders when feed health lookup returns null (never throws)", async () => {
    getZoneFeedHealth.mockResolvedValue(null);
    getClusterDetail.mockResolvedValueOnce(
      mkDetail([mkMember("a1", CENTER, CENTER_TITLE)]),
    );

    const res = await callGET(ID);

    expect(res.status).toBe(200);
  });
});
