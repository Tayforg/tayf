import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

import type { ClusterDetail } from "@/lib/clusters/cluster-detail-query";

// Mocked BEFORE importing the module under test so the dynamic
// `getClusterDetailOrThrow` import inside opengraph-image.tsx resolves to this
// mock instead of hitting Supabase.
const VALID_ID = "6ea8b39a-6ca7-4efe-ab30-71fdf1a2187b";
const MISSING_ID = "11111111-2222-4333-8444-555555555555";

const getClusterDetailOrThrow = vi.fn();
vi.mock("@/lib/clusters/cluster-detail-query", () => ({
  getClusterDetailOrThrow: (...args: unknown[]) => getClusterDetailOrThrow(...args),
}));

// Mock next/og so the element tree Image() builds is observable instead
// of being opaquely rendered to PNG bytes by Satori — the ribbon branch
// (ribbonZone → zoneOf / dominantZone / "iktidar" fallback) otherwise has
// no coverage: flipping `is_blindspot` or deleting the ribbon JSX would
// pass the old status-code-only assertions unchanged.
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

function mkDetail(
  overrides: Partial<ClusterDetail["cluster"]>,
  wireOverrides?: Partial<ClusterDetail["wire"]>,
): ClusterDetail {
  const article_count = overrides.article_count ?? 4;
  return {
    cluster: {
      id: VALID_ID,
      title_tr: "Test kümesi başlığı",
      title_original: null,
      title_method: null,
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
      is_archived: false,
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
    blindspotSuppressed: false,
    blindspotRecallVetoed: false,
  };
}

describe("cluster opengraph-image", () => {
  beforeEach(() => {
    captured = null;
    capturedOptions = null;
  });

  it("renders a 200 PNG with the blindspot ribbon", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(mkDetail({}));
    const { default: Image } = await import("./opengraph-image");

    const res = await Image({ params: Promise.resolve({ id: VALID_ID }) });

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBeGreaterThan(0);

    const text = collectText(captured).join("");
    expect(text).toContain("KÖR NOKTA — sadece İktidar yazdı");
  });

  it("omits the ribbon when the cluster is not a blindspot", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail({ is_blindspot: false, blindspot_side: null }),
    );
    const { default: Image } = await import("./opengraph-image");

    await Image({ params: Promise.resolve({ id: VALID_ID }) });

    const text = collectText(captured).join("");
    expect(text).not.toContain("KÖR NOKTA");
  });

  it("falls back to the dominant zone when blindspot_side is null", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(
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

    await Image({ params: Promise.resolve({ id: VALID_ID }) });

    const text = collectText(captured).join("");
    expect(text).toContain("KÖR NOKTA — sadece Muhalefet yazdı");
  });

  it("caps a long blindspot title well below the 4-line overflow point", async () => {
    // Regression for the crushed-ribbon bug: a 120-char Turkish title at
    // the old 125-char cap wrapped to 4 lines and, combined with the
    // ribbon/top-row/chips, overflowed the column enough that yoga
    // shrank the ribbon to an unreadable sliver. The cap is now 95 chars
    // in the ribbon case.
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail({
        title_tr:
          "Ankara ve İstanbul'da yapılan geniş katılımlı toplantıda hükümet ve muhalefet temsilcileri ekonomik istikrar paketi üzerinde uzlaşmaya varamadı ve görüşmeler yarın sabah devam edecek",
      }),
    );
    const { default: Image } = await import("./opengraph-image");

    await Image({ params: Promise.resolve({ id: VALID_ID }) });

    const text = collectText(captured).join("");
    expect(text).toContain("KÖR NOKTA — sadece İktidar yazdı");
    // Title is truncated with an ellipsis to at most 95 chars.
    const titleMatch = text.match(/Ankara ve İstanbul'da[^]*?…/);
    expect(titleMatch).not.toBeNull();
    expect(titleMatch![0].length).toBeLessThanOrEqual(95);
  });

  it("shows the %share form (not 'sadece') when the DB flag fires below 100%", async () => {
    // 4-of-5 = 80% share, the contract's minimum flagging threshold.
    getClusterDetailOrThrow.mockResolvedValueOnce(
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

    await Image({ params: Promise.resolve({ id: VALID_ID }) });

    const text = collectText(captured).join("");
    expect(text).toContain("KÖR NOKTA — %80 İktidar");
    expect(text).not.toContain("sadece İktidar yazdı");
  });

  it("prints the zone tile's largest-remainder percent on the ribbon: 11/1/1 reads %84, never Math.round's %85", async () => {
    // 11/13 = 84.6; the tiles below the title read 84 / 8 / 8.
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail({
        article_count: 13,
        bias_distribution: {
          pro_government: 11,
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
      }),
    );
    const { default: Image } = await import("./opengraph-image");

    await Image({ params: Promise.resolve({ id: VALID_ID }) });

    const text = collectText(captured).join("");
    expect(text).toContain("KÖR NOKTA — %84 İktidar");
    expect(text).toContain("%84 · 11");
    expect(text).not.toContain("%85");
    expect(text).not.toContain("sadece");
  });

  it("does not claim 'sadece' at 250/1/0 although the share rounds to 100", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail({
        article_count: 251,
        bias_distribution: {
          pro_government: 250,
          gov_leaning: 0,
          state_media: 0,
          center: 1,
          opposition_leaning: 0,
          opposition: 0,
          nationalist: 0,
          islamist_conservative: 0,
          pro_kurdish: 0,
          international: 0,
        },
      }),
    );
    const { default: Image } = await import("./opengraph-image");

    await Image({ params: Promise.resolve({ id: VALID_ID }) });

    const text = collectText(captured).join("");
    expect(text).toContain("KÖR NOKTA — %100 İktidar");
    expect(text).not.toContain("sadece");
  });

  it("uses the ribbon zone's own tile percent when blindspot_side differs from the tally's dominant zone", async () => {
    // The reported side is muhalefet but iktidar holds 5 of 6 sources. The
    // ribbon names Muhalefet, so it must carry Muhalefet's tile percent (17),
    // not the iktidar tally's 83.
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail({
        article_count: 6,
        blindspot_side: "opposition",
        bias_distribution: {
          pro_government: 5,
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

    await Image({ params: Promise.resolve({ id: VALID_ID }) });

    const text = collectText(captured).join("");
    expect(text).toContain("KÖR NOKTA — %17 Muhalefet");
    expect(text).toContain("%17 · 1");
    expect(text).not.toContain("%83 Muhalefet");
    expect(text).not.toContain("sadece");
  });

  it("says 'sadece <zone> yazdı' for the ribbon zone only when the other two zones have no sources", async () => {
    // Side muhalefet while the only sources are iktidar: muhalefet is NOT the
    // only zone, so the 'sadece Muhalefet yazdı' claim would be false.
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail({ blindspot_side: "opposition" }),
    );
    const { default: Image } = await import("./opengraph-image");

    await Image({ params: Promise.resolve({ id: VALID_ID }) });

    const text = collectText(captured).join("");
    expect(text).not.toContain("sadece Muhalefet yazdı");
  });

  it("writes the zone tiles in the Turkish prefix form (%80 · 4), never '80% ·'", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(
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

    await Image({ params: Promise.resolve({ id: VALID_ID }) });

    const text = collectText(captured).join("");
    expect(text).toContain("%80 · 4");
    expect(text).toContain("%20 · 1");
    expect(text).toContain("%0 · 0");
    expect(text).not.toMatch(/\d+% ·/);
  });

  it("shows the honest source count and the wire-redistribution pill", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail(
        { article_count: 7, is_blindspot: false, blindspot_side: null },
        { isWireRedistribution: true, effectiveArticleCount: 1, memberCount: 7 },
      ),
    );
    const { default: Image } = await import("./opengraph-image");

    await Image({ params: Promise.resolve({ id: VALID_ID }) });

    const text = collectText(captured).join("");
    expect(text).toContain("1 kaynak");
    expect(text).toContain("7 kopya · tek kaynak");
  });

  it("omits the wire pill when the cluster is not a wire redistribution", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail(
        { article_count: 5, is_blindspot: false, blindspot_side: null },
        { isWireRedistribution: false, effectiveArticleCount: 5, memberCount: 5 },
      ),
    );
    const { default: Image } = await import("./opengraph-image");

    await Image({ params: Promise.resolve({ id: VALID_ID }) });

    const text = collectText(captured).join("");
    expect(text).toContain("5 kaynak");
    expect(text).not.toContain("kopya");
  });

  it("renders both the blindspot ribbon and the wire pill together (densest layout)", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail(
        { article_count: 7 },
        { isWireRedistribution: true, effectiveArticleCount: 1, memberCount: 7 },
      ),
    );
    const { default: Image } = await import("./opengraph-image");

    await Image({ params: Promise.resolve({ id: VALID_ID }) });

    const text = collectText(captured).join("");
    expect(text).toContain("KÖR NOKTA — sadece İktidar yazdı");
    expect(text).toContain("7 kopya · tek kaynak");
  });

  it("shows the muted methodology link in the bottom-right", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(mkDetail({}));
    const { default: Image } = await import("./opengraph-image");

    await Image({ params: Promise.resolve({ id: VALID_ID }) });

    const text = collectText(captured).join("");
    expect(text).toContain("tayfhaber.com/metodoloji");
  });

  it("passes the exact edge cache-control header for the real card, lower-case key only", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(mkDetail({}));
    const { default: Image, OG_CACHE_HEADERS } = await import("./opengraph-image");

    await Image({ params: Promise.resolve({ id: VALID_ID }) });

    expect(OG_CACHE_HEADERS).toEqual({
      "cache-control": "public, s-maxage=600, stale-while-revalidate=86400",
    });
    const headers = capturedOptions?.headers as Record<string, string>;
    expect(headers).toEqual(OG_CACHE_HEADERS);
    expect(headers["Cache-Control"]).toBeUndefined();
  });

  it("falls back to a 200 PNG when the cluster no longer exists", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(null);
    const { default: Image, OG_FALLBACK_CACHE_HEADERS } = await import("./opengraph-image");

    const res = await Image({ params: Promise.resolve({ id: MISSING_ID }) });

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");

    expect(OG_FALLBACK_CACHE_HEADERS).toEqual({ "cache-control": "public, s-maxage=60" });
    const headers = capturedOptions?.headers as Record<string, string>;
    expect(headers).toEqual(OG_FALLBACK_CACHE_HEADERS);
    expect(headers["Cache-Control"]).toBeUndefined();

    const body = await res.arrayBuffer();
    expect(body.byteLength).toBeGreaterThan(0);
  });

  it("404s an empty body for a non-UUID id without touching the database", async () => {
    getClusterDetailOrThrow.mockClear();
    const { default: Image, OG_NOT_FOUND_HEADERS } = await import("./opengraph-image");
    expect(OG_NOT_FOUND_HEADERS).toEqual({ "cache-control": "public, s-maxage=300" });

    for (const id of ["not-a-uuid", "x", "", "6ea8b39a-6ca7-4efe-ab30-71fdf1a2187bZ"]) {
      const res = await Image({ params: Promise.resolve({ id }) });
      expect(res.status, id).toBe(404);
      expect(res.headers.get("cache-control")).toBe(OG_NOT_FOUND_HEADERS["cache-control"]);
      expect((await res.arrayBuffer()).byteLength).toBe(0);
    }
    expect(getClusterDetailOrThrow).not.toHaveBeenCalled();
  });

  it("twitter-image re-export 404s a non-UUID id too", async () => {
    getClusterDetailOrThrow.mockClear();
    const tw = await import("./twitter-image");
    const res = await tw.default({ params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(res.status).toBe(404);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    expect(getClusterDetailOrThrow).not.toHaveBeenCalled();
  });

  it("serves the generic card, uncached, when the reader throws (outage is not 'not found')", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getClusterDetailOrThrow.mockRejectedValueOnce(new Error("db down"));
    const { default: Image, OG_UNAVAILABLE_CACHE_HEADERS } = await import(
      "./opengraph-image"
    );

    try {
      const res = await Image({ params: Promise.resolve({ id: VALID_ID }) });

      // A 200 PNG, so a crawler still unfurls something -- but marked
      // no-store so the generic card is never pinned in a CDN or a crawler's
      // cache past the outage.
      expect(res).toBeInstanceOf(Response);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(OG_UNAVAILABLE_CACHE_HEADERS).toEqual({ "cache-control": "no-store" });
      const headers = capturedOptions?.headers as Record<string, string>;
      expect(headers).toEqual(OG_UNAVAILABLE_CACHE_HEADERS);
      expect(headers["Cache-Control"]).toBeUndefined();
      expect(capturedOptions).toMatchObject({ width: 1200, height: 630 });

      const text = collectText(captured).join(" ");
      expect(text).toContain("Tayf");
      expect(text).toContain("Aynı haber, farklı dünyalar.");
      // It must not claim the cluster is gone: the cluster is fine, the
      // read failed.
      expect(text).not.toContain("bulunamadı");
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
      expect(errSpy).toHaveBeenCalledWith(
        `[cluster-og] ${VALID_ID} failed: db down`,
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it("keeps 'not found' and 'unavailable' distinct: null still says 'Haber kümesi bulunamadı' with the short public TTL", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(null);
    const { default: Image, OG_FALLBACK_CACHE_HEADERS, OG_UNAVAILABLE_CACHE_HEADERS } =
      await import("./opengraph-image");

    const res = await Image({ params: Promise.resolve({ id: MISSING_ID }) });

    expect(res.status).toBe(200);
    expect(collectText(captured).join(" ")).toContain("Haber kümesi bulunamadı");
    const headers = capturedOptions?.headers as Record<string, string>;
    expect(headers).toEqual(OG_FALLBACK_CACHE_HEADERS);
    expect(headers).not.toEqual(OG_UNAVAILABLE_CACHE_HEADERS);
  });

  it("twitter-image re-export also serves the uncached generic card on a read failure", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getClusterDetailOrThrow.mockRejectedValueOnce(new Error("db down"));
    const tw = await import("./twitter-image");

    try {
      const res = await tw.default({ params: Promise.resolve({ id: VALID_ID }) });
      expect(res.status).toBe(200);
      expect((capturedOptions?.headers as Record<string, string>)["cache-control"]).toBe(
        "no-store",
      );
    } finally {
      errSpy.mockRestore();
    }
  });
});
