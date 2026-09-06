import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

import type { ClusterDetail } from "@/lib/clusters/cluster-detail-query";

// Mocked BEFORE importing the module under test so the dynamic
// `getClusterDetail` import inside opengraph-image.tsx resolves to this
// mock instead of hitting Supabase.
const getClusterDetail = vi.fn();
vi.mock("@/lib/clusters/cluster-detail-query", () => ({
  getClusterDetail: (...args: unknown[]) => getClusterDetail(...args),
}));

// Mock next/og so the element tree Image() builds is observable instead
// of being opaquely rendered to PNG bytes by Satori — the ribbon branch
// (ribbonZone → zoneOf / dominantZone / "iktidar" fallback) otherwise has
// no coverage: flipping `is_blindspot` or deleting the ribbon JSX would
// pass the old status-code-only assertions unchanged.
let captured: ReactElement | null = null;
vi.mock("next/og", () => ({
  ImageResponse: class {
    constructor(element: ReactElement) {
      captured = element;
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

function mkDetail(
  overrides: Partial<ClusterDetail["cluster"]>,
  wireOverrides?: Partial<ClusterDetail["wire"]>,
): ClusterDetail {
  const article_count = overrides.article_count ?? 4;
  return {
    cluster: {
      id: "x",
      title_tr: "Test kümesi başlığı",
      title_original: null,
      summary_tr: "Özet",
      article_count,
      bias_distribution: {
        pro_government: 4,
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
      is_blindspot: true,
      blindspot_side: "pro_government",
      first_published: "2026-07-01T10:00:00Z",
      updated_at: "2026-07-01T12:00:00Z",
      ...overrides,
    },
    members: [],
    allSources: [],
    wire: {
      isWireRedistribution: false,
      effectiveArticleCount: article_count,
      memberCount: article_count,
      ...wireOverrides,
    },
  };
}

describe("cluster opengraph-image", () => {
  beforeEach(() => {
    captured = null;
  });

  it("renders a 200 PNG with the blindspot ribbon", async () => {
    getClusterDetail.mockResolvedValueOnce(mkDetail({}));
    const { default: Image } = await import("./opengraph-image");

    const res = await Image({ params: Promise.resolve({ id: "x" }) });

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBeGreaterThan(0);

    const text = collectText(captured).join("");
    expect(text).toContain("KÖR NOKTA — sadece İktidar yazdı");
  });

  it("omits the ribbon when the cluster is not a blindspot", async () => {
    getClusterDetail.mockResolvedValueOnce(
      mkDetail({ is_blindspot: false, blindspot_side: null }),
    );
    const { default: Image } = await import("./opengraph-image");

    await Image({ params: Promise.resolve({ id: "x" }) });

    const text = collectText(captured).join("");
    expect(text).not.toContain("KÖR NOKTA");
  });

  it("falls back to the dominant zone when blindspot_side is null", async () => {
    getClusterDetail.mockResolvedValueOnce(
      mkDetail({
        blindspot_side: null,
        bias_distribution: {
          pro_government: 0,
          gov_leaning: 0,
          state_media: 0,
          center: 0,
          opposition_leaning: 3,
          opposition: 2,
          nationalist: 0,
          islamist_conservative: 0,
          pro_kurdish: 0,
          international: 0,
        },
      }),
    );
    const { default: Image } = await import("./opengraph-image");

    await Image({ params: Promise.resolve({ id: "x" }) });

    const text = collectText(captured).join("");
    expect(text).toContain("KÖR NOKTA — sadece Muhalefet yazdı");
  });

  it("caps a long blindspot title well below the 4-line overflow point", async () => {
    // Regression for the crushed-ribbon bug: a 120-char Turkish title at
    // the old 125-char cap wrapped to 4 lines and, combined with the
    // ribbon/top-row/chips, overflowed the column enough that yoga
    // shrank the ribbon to an unreadable sliver. The cap is now 95 chars
    // in the ribbon case.
    getClusterDetail.mockResolvedValueOnce(
      mkDetail({
        title_tr:
          "Ankara ve İstanbul'da yapılan geniş katılımlı toplantıda hükümet ve muhalefet temsilcileri ekonomik istikrar paketi üzerinde uzlaşmaya varamadı ve görüşmeler yarın sabah devam edecek",
      }),
    );
    const { default: Image } = await import("./opengraph-image");

    await Image({ params: Promise.resolve({ id: "x" }) });

    const text = collectText(captured).join("");
    expect(text).toContain("KÖR NOKTA — sadece İktidar yazdı");
    // Title is truncated with an ellipsis to at most 95 chars.
    const titleMatch = text.match(/Ankara ve İstanbul'da[^]*?…/);
    expect(titleMatch).not.toBeNull();
    expect(titleMatch![0].length).toBeLessThanOrEqual(95);
  });

  it("shows the %share form (not 'sadece') when the DB flag fires below 100%", async () => {
    // 4-of-5 = 80% share, the contract's minimum flagging threshold.
    getClusterDetail.mockResolvedValueOnce(
      mkDetail({
        article_count: 5,
        bias_distribution: {
          pro_government: 4,
          gov_leaning: 0,
          state_media: 0,
          center: 0,
          opposition_leaning: 0,
          opposition: 1,
          nationalist: 0,
          islamist_conservative: 0,
          pro_kurdish: 0,
          international: 0,
        },
      }),
    );
    const { default: Image } = await import("./opengraph-image");

    await Image({ params: Promise.resolve({ id: "x" }) });

    const text = collectText(captured).join("");
    expect(text).toContain("KÖR NOKTA — %80 İktidar");
    expect(text).not.toContain("sadece İktidar yazdı");
  });

  it("shows the honest source count and the wire-redistribution pill", async () => {
    getClusterDetail.mockResolvedValueOnce(
      mkDetail(
        { article_count: 7, is_blindspot: false, blindspot_side: null },
        { isWireRedistribution: true, effectiveArticleCount: 1, memberCount: 7 },
      ),
    );
    const { default: Image } = await import("./opengraph-image");

    await Image({ params: Promise.resolve({ id: "x" }) });

    const text = collectText(captured).join("");
    expect(text).toContain("1 kaynak");
    expect(text).toContain("7 kopya · tek kaynak");
  });

  it("omits the wire pill when the cluster is not a wire redistribution", async () => {
    getClusterDetail.mockResolvedValueOnce(
      mkDetail(
        { article_count: 5, is_blindspot: false, blindspot_side: null },
        { isWireRedistribution: false, effectiveArticleCount: 5, memberCount: 5 },
      ),
    );
    const { default: Image } = await import("./opengraph-image");

    await Image({ params: Promise.resolve({ id: "x" }) });

    const text = collectText(captured).join("");
    expect(text).toContain("5 kaynak");
    expect(text).not.toContain("kopya");
  });

  it("renders both the blindspot ribbon and the wire pill together (densest layout)", async () => {
    getClusterDetail.mockResolvedValueOnce(
      mkDetail(
        { article_count: 7 },
        { isWireRedistribution: true, effectiveArticleCount: 1, memberCount: 7 },
      ),
    );
    const { default: Image } = await import("./opengraph-image");

    await Image({ params: Promise.resolve({ id: "x" }) });

    const text = collectText(captured).join("");
    expect(text).toContain("KÖR NOKTA — sadece İktidar yazdı");
    expect(text).toContain("7 kopya · tek kaynak");
  });

  it("shows the muted methodology link in the bottom-right", async () => {
    getClusterDetail.mockResolvedValueOnce(mkDetail({}));
    const { default: Image } = await import("./opengraph-image");

    await Image({ params: Promise.resolve({ id: "x" }) });

    const text = collectText(captured).join("");
    expect(text).toContain("tayfhaber.com/metodoloji");
  });

  it("falls back to a 200 PNG when the cluster no longer exists", async () => {
    getClusterDetail.mockResolvedValueOnce(null);
    const { default: Image } = await import("./opengraph-image");

    const res = await Image({ params: Promise.resolve({ id: "gone" }) });

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBeGreaterThan(0);
  });
});
