import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

import type { ClusterDetail, ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";
import type { BiasCategory, SourceKind } from "@/types";

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
      // Like the real ImageResponse: `options.headers` is applied with
      // Headers.set, so an explicit cache-control reaches the response.
      const headers = new Headers({ "content-type": "image/png" });
      for (const [k, v] of Object.entries(
        (options.headers ?? {}) as Record<string, string>,
      )) {
        headers.set(k, v);
      }
      return new Response(new Uint8Array([1]), { status: 200, headers });
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
  members: ClusterDetailMember[] = [],
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
    members,
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

  // h57-outbound-1: the ribbon claimed "sadece İktidar yazdı" over a story an
  // aggregator (Bağımsız) and a niche source (Muhalefet) also carried;
  // /blindspots and the cluster timeline already qualify it.
  describe("ribbon qualifier for non-voting sources from another zone (h57-outbound-1)", () => {
    const member = (
      slug: string,
      kind: SourceKind | undefined,
      bias: BiasCategory,
      n = 1,
    ): ClusterDetailMember => ({
      source: {
        id: slug,
        name: slug,
        slug,
        url: `https://${slug}.example`,
        rss_url: `https://${slug}.example/rss`,
        bias,
        logo_url: null,
        active: true,
        kind,
        trustee_since: null,
        trustee_note: null,
      },
      article: {
        id: `${slug}-${n}`,
        title: `${slug} başlığı ${n}`,
        url: `https://${slug}.example/haber/${n}`,
        published_at: "2026-07-01T10:00:00Z",
        image_url: null,
        content_hash: `hash-${slug}-${n}`,
      },
    });
    // Shaped like cluster 0b127dc3-444a-48fb-a045-6d97086e4074: nine voting
    // İktidar members, son-dakika (aggregator, center), isci-haber (niche,
    // opposition) and haberler-com (aggregator, gov_leaning).
    const voting9 = [
      ...Array.from({ length: 5 }, (_, i) => member(`outlet-${i}`, "outlet", "pro_government")),
      ...Array.from({ length: 3 }, (_, i) => member(`leaning-${i}`, "outlet", "gov_leaning")),
      member("anadolu-ajansi", "wire", "pro_government"),
    ];
    const SON_DAKIKA = member("son-dakika", "aggregator", "center");
    const ISCI_HABER = member("isci-haber", "niche", "opposition");
    const HABERLER_COM = member("haberler-com", "aggregator", "gov_leaning");
    const NINE: Partial<ClusterDetail["cluster"]> = {
      article_count: 12,
      bias_distribution: {
        pro_government: 6,
        gov_leaning: 3,
        state_media: 0,
        center: 0,
        opposition_leaning: 0,
        opposition: 0,
        nationalist: 0,
        islamist_conservative: 0,
        pro_kurdish: 0,
        international: 0,
      },
    };

    async function ribbonText(detail: ClusterDetail): Promise<string> {
      getClusterDetailOrThrow.mockResolvedValueOnce(detail);
      const { default: Image } = await import("./opengraph-image");
      await Image({ params: Promise.resolve({ id: VALID_ID }) });
      return collectText(captured).join("");
    }

    it("prints 'KÖR NOKTA — spektrumda sadece İktidar' for the 0b127dc3-shaped fixture", async () => {
      const text = await ribbonText(
        mkDetail(NINE, undefined, [...voting9, SON_DAKIKA, ISCI_HABER, HABERLER_COM]),
      );
      expect(text).toContain("KÖR NOKTA — spektrumda sadece İktidar");
      expect(text).not.toContain("yazdı");
    });

    it("keeps 'KÖR NOKTA — sadece İktidar yazdı' for the control (only haberler-com, inside the zone)", async () => {
      const text = await ribbonText(mkDetail(NINE, undefined, [...voting9, HABERLER_COM]));
      expect(text).toContain("KÖR NOKTA — sadece İktidar yazdı");
      expect(text).not.toContain("spektrumda");
    });

    it("keeps the old ribbon when the detail carries no members", async () => {
      const text = await ribbonText(mkDetail(NINE));
      expect(text).toContain("KÖR NOKTA — sadece İktidar yazdı");
    });

    it("one non-voting outsider is enough, counted once however many articles it wrote", async () => {
      const text = await ribbonText(
        mkDetail(NINE, undefined, [...voting9, ISCI_HABER, member("isci-haber", "niche", "opposition", 2)]),
      );
      expect(text).toContain("KÖR NOKTA — spektrumda sadece İktidar");
    });

    it("qualifies the fallback zone (no blindspot_side) with its capitalised label", async () => {
      const text = await ribbonText(
        mkDetail(
          {
            blindspot_side: null,
            article_count: 6,
            bias_distribution: { ...NINE.bias_distribution!, pro_government: 0, gov_leaning: 0, opposition_leaning: 3, opposition: 2 },
          },
          undefined,
          [member("a", "outlet", "opposition"), member("b", "outlet", "opposition_leaning"), member("c", "aggregator", "gov_leaning")],
        ),
      );
      expect(text).toContain("KÖR NOKTA — spektrumda sadece Muhalefet");
    });

    it("voting members of other zones never qualify it", async () => {
      const text = await ribbonText(
        mkDetail(NINE, undefined, [...voting9, member("sozcu", "outlet", "opposition"), member("x", undefined, "center")]),
      );
      expect(text).toContain("KÖR NOKTA — sadece İktidar yazdı");
    });

    it("leaves the %share ribbon alone, outsiders or not", async () => {
      const text = await ribbonText(
        mkDetail(
          {
            article_count: 5,
            bias_distribution: { ...NINE.bias_distribution!, pro_government: 4, gov_leaning: 0, opposition: 1 },
          },
          undefined,
          [ISCI_HABER, SON_DAKIKA],
        ),
      );
      expect(text).toContain("KÖR NOKTA — %80 İktidar");
      expect(text).not.toContain("spektrumda");
    });

    it("does not touch the zone tiles, the count chip or the percents", async () => {
      const qualified = await ribbonText(
        mkDetail(NINE, undefined, [...voting9, SON_DAKIKA, ISCI_HABER, HABERLER_COM]),
      );
      const plain = await ribbonText(mkDetail(NINE));
      const strip = (t: string) =>
        t.replace("KÖR NOKTA — spektrumda sadece İktidar", "").replace("KÖR NOKTA — sadece İktidar yazdı", "");
      expect(strip(qualified)).toBe(strip(plain));
      expect(qualified).toContain("%100 · 9");
      expect(qualified).toContain("12 kaynak (9 sınıflandırılmış)");
    });

    it("prints no ribbon at all for a cluster that is not a blindspot", async () => {
      const text = await ribbonText(
        mkDetail({ ...NINE, is_blindspot: false, blindspot_side: null }, undefined, [...voting9, ISCI_HABER]),
      );
      expect(text).not.toContain("KÖR NOKTA");
    });
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

  it("cuts the 594667c9 ribbon title at a word, never as '...Töreni'ne kat…' (h20-contracts-1)", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail({
        title_tr:
          "İlim Yayma Vakfı Mütevelli Heyeti Başkanı Bilal Erdoğan, HKÜ'de 'Akademik Ödül Töreni'ne katıldı",
      }),
    );
    const { default: Image } = await import("./opengraph-image");

    await Image({ params: Promise.resolve({ id: VALID_ID }) });

    const text = collectText(captured).join("");
    expect(text).toContain("KÖR NOKTA — sadece İktidar yazdı");
    expect(text).not.toContain("kat…");
    expect(text).toContain("Akademik Ödül Töreni'ne…");
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

  it("does not claim a single source when a wire cluster holds several distinct texts (6 members, 3 texts)", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail(
        { article_count: 6, is_blindspot: false, blindspot_side: null },
        { isWireRedistribution: true, effectiveArticleCount: 3, memberCount: 6 },
      ),
    );
    const { default: Image } = await import("./opengraph-image");

    await Image({ params: Promise.resolve({ id: VALID_ID }) });

    const text = collectText(captured).join("");
    expect(text).toContain("3 kaynak");
    expect(text).toContain("6 haber · 3 farklı metin");
    expect(text).not.toContain("tek kaynak");
    expect(text).not.toContain("kopya");
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

  // h44-consistency-1: the zone tiles are computed over the classified
  // (voting) sources only, so a chip that prints every member must say so, in
  // the wording sourceCountHead gives the share text / RSS / Telegram.
  describe("source-count chip basis (h44-consistency-1)", () => {
    const ZERO_DIST = {
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
    };

    it("says '9 kaynak (8 sınıflandırılmış)' for a 9-member cluster with 8 voting sources", async () => {
      getClusterDetailOrThrow.mockResolvedValueOnce(
        mkDetail({
          article_count: 9,
          is_blindspot: false,
          blindspot_side: null,
          bias_distribution: { ...ZERO_DIST, pro_government: 3, center: 3, opposition: 2 },
        }),
      );
      const { default: Image } = await import("./opengraph-image");

      await Image({ params: Promise.resolve({ id: VALID_ID }) });

      const text = collectText(captured).join("");
      expect(text).toContain("9 kaynak (8 sınıflandırılmış)");
    });

    it("stays '9 kaynak' (byte-identical) when every member is classified", async () => {
      getClusterDetailOrThrow.mockResolvedValueOnce(
        mkDetail({
          article_count: 9,
          is_blindspot: false,
          blindspot_side: null,
          bias_distribution: { ...ZERO_DIST, pro_government: 3, center: 3, opposition: 3 },
        }),
      );
      const { default: Image } = await import("./opengraph-image");

      await Image({ params: Promise.resolve({ id: VALID_ID }) });

      const text = collectText(captured).join("");
      expect(text).toContain("9 kaynak");
      expect(text).not.toContain("sınıflandırılmış");
    });

    it("keeps the bare wire-adjusted count when it is below the classified total", async () => {
      // effectiveArticleCount (1) is below the classified total (4): there is
      // nothing to qualify, exactly as sourceCountHead prints it elsewhere.
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
      expect(text).not.toContain("sınıflandırılmış");
    });

    it("uses the shared helper's wording", async () => {
      const { sourceCountHead } = await import("@/lib/feeds/zone-line");
      getClusterDetailOrThrow.mockResolvedValueOnce(
        mkDetail({
          article_count: 12,
          is_blindspot: false,
          blindspot_side: null,
          bias_distribution: { ...ZERO_DIST, pro_government: 4, opposition: 5 },
        }),
      );
      const { default: Image } = await import("./opengraph-image");

      await Image({ params: Promise.resolve({ id: VALID_ID }) });

      const text = collectText(captured).join("");
      expect(text).toContain(sourceCountHead(12, { iktidar: 4, bagimsiz: 0, muhalefet: 5 }));
      expect(text).toContain("12 kaynak (9 sınıflandırılmış)");
    });
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

  it("falls back to a 200 PNG when the cluster no longer exists, CDN-cacheable like the 404 (h30-abuse-2)", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(null);
    const { default: Image, OG_NOT_FOUND_HEADERS } = await import("./opengraph-image");

    const res = await Image({ params: Promise.resolve({ id: MISSING_ID }) });

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");

    // The soft-404 card keeps its 200 body but is sent with the same shared
    // TTL as the malformed-id 404, so repeat fetches of an unknown id are
    // answered by the CDN instead of re-reading the database.
    expect(OG_NOT_FOUND_HEADERS).toEqual({ "cache-control": "public, s-maxage=300" });
    const headers = capturedOptions?.headers as Record<string, string>;
    expect(headers).toEqual(OG_NOT_FOUND_HEADERS);
    expect(headers["Cache-Control"]).toBeUndefined();
    expect(res.headers.get("cache-control")).toBe(OG_NOT_FOUND_HEADERS["cache-control"]);

    const body = await res.arrayBuffer();
    expect(body.byteLength).toBeGreaterThan(0);
  });

  it("the module no longer exports the short-lived OG_FALLBACK_CACHE_HEADERS", async () => {
    const mod = await import("./opengraph-image");
    expect(mod).not.toHaveProperty("OG_FALLBACK_CACHE_HEADERS");
  });

  it("twitter-image re-export sends the unknown-cluster card with the same cache headers", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(null);
    const tw = await import("./twitter-image");
    const { OG_NOT_FOUND_HEADERS } = await import("./opengraph-image");

    const res = await tw.default({ params: Promise.resolve({ id: MISSING_ID }) });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(capturedOptions?.headers).toEqual(OG_NOT_FOUND_HEADERS);
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

  it("keeps 'not found' and 'unavailable' distinct: null still says 'Haber kümesi bulunamadı' with the public TTL", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(null);
    const { default: Image, OG_NOT_FOUND_HEADERS, OG_UNAVAILABLE_CACHE_HEADERS } =
      await import("./opengraph-image");

    const res = await Image({ params: Promise.resolve({ id: MISSING_ID }) });

    expect(res.status).toBe(200);
    expect(collectText(captured).join(" ")).toContain("Haber kümesi bulunamadı");
    const headers = capturedOptions?.headers as Record<string, string>;
    expect(headers).toEqual(OG_NOT_FOUND_HEADERS);
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

  // h64-ogcards-3: a cluster whose sources are all toplayıcı / niş has an
  // all-zero bias_distribution. The card drew an empty bar and three "%0 · 0"
  // tiles for it while the page, the embed, the rozet and the share text say
  // "sınıflandırılmış kaynak yok". It now draws ONE box with that line where the
  // tiles were.
  describe("empty spectrum (h64-ogcards-3)", () => {
    const ZERO_DIST = {
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
    };
    const NON_VOTING_LINE =
      "Bu kümede sınıflandırılan kaynak yok — yalnızca toplayıcı / niş kaynaklar yazdı";
    const UNCLASSIFIED_LINE = "Bu kümede henüz sınıflandırılan kaynak yok";
    const ZONE_BAR_COLORS = ["#ef4444", "#a1a1aa", "#10b981"];

    const member = (
      slug: string,
      kind: SourceKind | undefined,
      bias: BiasCategory,
    ): ClusterDetailMember => ({
      source: {
        id: slug,
        name: slug,
        slug,
        url: `https://${slug}.example`,
        rss_url: `https://${slug}.example/rss`,
        bias,
        logo_url: null,
        active: true,
        kind,
        trustee_since: null,
        trustee_note: null,
      },
      article: {
        id: `${slug}-1`,
        title: `${slug} başlığı`,
        url: `https://${slug}.example/haber/1`,
        published_at: "2026-07-01T10:00:00Z",
        image_url: null,
        content_hash: `hash-${slug}`,
      },
    });
    // Shaped like cluster 4b5cd9f5-b4cc-46a8-9d15-c9cd55aaac39: two members,
    // an aggregator (gov_leaning) and a niche source (center), nobody voting.
    const HABERLER_COM = member("haberler-com", "aggregator", "gov_leaning");
    const EKONOMIM = member("ekonomim", "niche", "center");

    type Styled = { props?: { style?: Record<string, unknown>; children?: unknown } };
    function findElements(node: unknown, pred: (el: Styled) => boolean, out: Styled[] = []): Styled[] {
      if (Array.isArray(node)) {
        for (const child of node) findElements(child, pred, out);
        return out;
      }
      if (node && typeof node === "object") {
        const el = node as Styled;
        if (pred(el)) out.push(el);
        if (el.props?.children !== undefined) findElements(el.props.children, pred, out);
      }
      return out;
    }
    const withBackground = (colors: string[]) => (el: Styled) =>
      typeof el.props?.style?.background === "string" && colors.includes(el.props.style.background);
    const isBar = (el: Styled) => el.props?.style?.height === 18 && el.props?.style?.overflow === "hidden";
    const isTile = (el: Styled) =>
      el.props?.style?.flex === 1 &&
      typeof el.props?.style?.border === "string" &&
      el.props.style.borderRadius === 12;

    async function render(detail: ClusterDetail): Promise<{ text: string; tree: ReactElement | null }> {
      getClusterDetailOrThrow.mockResolvedValueOnce(detail);
      const { default: Image } = await import("./opengraph-image");
      await Image({ params: Promise.resolve({ id: VALID_ID }) });
      return { text: collectText(captured).join(""), tree: captured };
    }
    const zeroCluster: Partial<ClusterDetail["cluster"]> = {
      article_count: 2,
      is_blindspot: false,
      blindspot_side: null,
      bias_distribution: ZERO_DIST,
    };

    it("prints the non-voting line, and no '%0 · 0' tile, for a cluster of two toplayıcı / niş sources", async () => {
      const { text } = await render(mkDetail(zeroCluster, undefined, [HABERLER_COM, EKONOMIM]));

      expect(text).toContain(NON_VOTING_LINE);
      expect(text).not.toContain("%0 · 0");
      expect(text).not.toContain("%0");
      for (const label of ["İktidar", "Bağımsız", "Muhalefet"]) expect(text).not.toContain(label);
      expect(text).not.toContain(UNCLASSIFIED_LINE);
    });

    it("keeps the pill, the title and the methodology row exactly as before", async () => {
      const { text } = await render(
        mkDetail({ ...zeroCluster, title_tr: "Dolar günü yükselişle kapattı" }, undefined, [HABERLER_COM, EKONOMIM]),
      );

      expect(text).toContain("2 kaynak (0 sınıflandırılmış)");
      expect(text).toContain("Dolar günü yükselişle kapattı");
      expect(text).toContain("tayfhaber.com/metodoloji");
      expect(text).not.toContain("KÖR NOKTA");
    });

    it("draws no bar and no zone-coloured element: the stacked bar, its segments and the tile dots are gone", async () => {
      const { tree } = await render(mkDetail(zeroCluster, undefined, [HABERLER_COM, EKONOMIM]));

      expect(findElements(tree, isBar)).toHaveLength(0);
      expect(findElements(tree, withBackground(ZONE_BAR_COLORS))).toHaveLength(0);
      expect(findElements(tree, isTile)).toHaveLength(0);
    });

    it("draws ONE box with the line as its single text node, in the tile's own border and background tokens", async () => {
      const empty = await render(mkDetail(zeroCluster, undefined, [HABERLER_COM, EKONOMIM]));
      const boxes = findElements(empty.tree, (el) => el.props?.children === NON_VOTING_LINE);
      expect(boxes).toHaveLength(1);
      const box = boxes[0]!.props!.style!;
      // One string child (not "{a} {b}" fragments) keeps it one text node for Satori.
      expect(typeof boxes[0]!.props!.children).toBe("string");
      expect(box.display).toBe("flex");

      // The tile of a non-empty card is the reference for the tokens.
      const filled = await render(mkDetail({ ...zeroCluster, article_count: 4, bias_distribution: { ...ZERO_DIST, pro_government: 4 } }));
      const tile = findElements(filled.tree, isTile)[0]!.props!.style!;
      expect(box.background).toBe(tile.background);
      expect(box.border).toBe(tile.border);
      expect(box.borderRadius).toBe(tile.borderRadius);
    });

    it("sets the line at the tile label size (22 px), not the tile value size", async () => {
      const empty = await render(mkDetail(zeroCluster, undefined, [HABERLER_COM, EKONOMIM]));
      const line = findElements(empty.tree, (el) => el.props?.children === NON_VOTING_LINE)[0]!.props!.style!;

      const filled = await render(
        mkDetail({ article_count: 4, bias_distribution: { ...ZERO_DIST, pro_government: 4 } }),
      );
      const label = findElements(filled.tree, (el) => el.props?.children === "İktidar")[0]!.props!.style!;

      expect(line.fontSize).toBe(22);
      expect(line.fontSize).toBe(label.fontSize);
    });

    it("says 'henüz' when nobody is known to have written: no members, all-zero distribution", async () => {
      const { text } = await render(mkDetail(zeroCluster));

      expect(text).toContain(UNCLASSIFIED_LINE);
      expect(text).not.toContain(NON_VOTING_LINE);
      expect(text).not.toContain("%0 · 0");
    });

    it("does not claim 'yalnızca toplayıcı / niş kaynaklar yazdı' when a voting source is among the members", async () => {
      // A voting member with a not-yet-backfilled (zero) distribution: the page's
      // own caption stays silent here (votingMembers.length > 0), and a "yalnızca"
      // line would be false.
      const { text } = await render(
        mkDetail(zeroCluster, undefined, [member("sozcu", "outlet", "opposition"), HABERLER_COM]),
      );

      expect(text).toContain(UNCLASSIFIED_LINE);
      expect(text).not.toContain("yalnızca");
    });

    it("counts a member with no kind as a voting source (kind normalises to outlet), like the page", async () => {
      const { text } = await render(
        mkDetail(zeroCluster, undefined, [member("eski-kaynak", undefined, "center"), HABERLER_COM]),
      );

      expect(text).toContain(UNCLASSIFIED_LINE);
      expect(text).not.toContain("yalnızca");
    });

    it("says the non-voting line for a single non-voting source", async () => {
      const { text } = await render(mkDetail({ ...zeroCluster, article_count: 1 }, undefined, [EKONOMIM]));

      expect(text).toContain(NON_VOTING_LINE);
      expect(text).toContain("1 kaynak");
    });

    it("keeps the bar and the three '%N · n' tiles for every cluster with a classified source", async () => {
      const { text, tree } = await render(
        mkDetail({ article_count: 7, is_blindspot: false, blindspot_side: null, bias_distribution: { ...ZERO_DIST, pro_government: 7 } }),
      );

      expect(text).toContain("%100 · 7");
      expect(text).toContain("%0 · 0");
      for (const label of ["İktidar", "Bağımsız", "Muhalefet"]) expect(text).toContain(label);
      expect(text).not.toContain(NON_VOTING_LINE);
      expect(text).not.toContain(UNCLASSIFIED_LINE);
      expect(findElements(tree, isBar)).toHaveLength(1);
      expect(findElements(tree, isTile)).toHaveLength(3);
    });

    it("keeps the tiles at a total of one source, even when non-voting sources also wrote", async () => {
      const { text, tree } = await render(
        mkDetail(
          { article_count: 3, is_blindspot: false, blindspot_side: null, bias_distribution: { ...ZERO_DIST, center: 1 } },
          undefined,
          [member("bianet", "outlet", "center"), HABERLER_COM, EKONOMIM],
        ),
      );

      expect(text).toContain("%100 · 1");
      expect(text).not.toContain("yalnızca");
      expect(findElements(tree, isTile)).toHaveLength(3);
    });

    it("serves the same empty-state card through the twitter-image re-export", async () => {
      getClusterDetailOrThrow.mockResolvedValueOnce(mkDetail(zeroCluster, undefined, [HABERLER_COM, EKONOMIM]));
      const tw = await import("./twitter-image");

      await tw.default({ params: Promise.resolve({ id: VALID_ID }) });

      const text = collectText(captured).join("");
      expect(text).toContain(NON_VOTING_LINE);
      expect(text).not.toContain("%0 · 0");
    });
  });
});
