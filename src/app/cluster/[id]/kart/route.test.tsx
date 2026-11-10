import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactElement } from "react";

import { storyCardHref } from "@/lib/cards/story-card";

import type {
  ClusterDetail,
  ClusterDetailMember,
} from "@/lib/clusters/cluster-detail-query";
import type { ZoneFeedHealth, ZoneHealth } from "@/lib/clusters/feed-health";
import type { MediaDnaZone, Source } from "@/types";

// Mocked BEFORE the module under test is imported so the route's
// `getClusterDetailOrThrow` / `getZoneFeedHealth` imports resolve to these stubs
// instead of hitting Supabase (and so `"use cache"` never runs here).
const getClusterDetailOrThrow = vi.fn();
vi.mock("@/lib/clusters/cluster-detail-query", () => ({
  getClusterDetailOrThrow: (...args: unknown[]) => getClusterDetailOrThrow(...args),
}));

const getZoneFeedHealth = vi.fn();
vi.mock("@/lib/clusters/feed-health", async (importOriginal) => {
  // zoneVotingYieldDenominator is a pure helper story-card.ts calls — keep
  // the real one, mock only the network-backed fetcher.
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
    // delivering (all kinds) deliberately differs from votingDelivering: the
    // card's denominator must come from the voting count.
    delivering: 10,
    votingDelivering: 8,
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
    blindspotRecallVetoed: false,
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
    getClusterDetailOrThrow.mockReset();
    getZoneFeedHealth.mockReset();
    getZoneFeedHealth.mockResolvedValue(null);
  });

  it("404s on a non-uuid id without touching the database", async () => {
    const res = await callGET("not-a-uuid");

    expect(res.status).toBe(404);
    expect(getClusterDetailOrThrow).not.toHaveBeenCalled();
  });

  it("404s on an id-shaped path traversal attempt without touching the database", async () => {
    const res = await callGET("../../etc/passwd");

    expect(res.status).toBe(404);
    expect(getClusterDetailOrThrow).not.toHaveBeenCalled();
  });

  it("404s when the cluster does not exist", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(null);

    const res = await callGET(ID);

    expect(res.status).toBe(404);
    expect(getClusterDetailOrThrow).toHaveBeenCalledWith(ID);
  });

  it("503s no-store with Retry-After 60 when the reader throws, instead of a cacheable 404", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getClusterDetailOrThrow.mockRejectedValueOnce(new Error("db down"));

    try {
      const res = await callGET(ID);

      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("retry-after")).toBe("60");
      expect(errSpy).toHaveBeenCalledWith(`[kart] ${ID} failed: db down`);
      // The failure ends the request: no feed-health read, no card.
      expect(getZoneFeedHealth).not.toHaveBeenCalled();
      expect(captured).toBeNull();
    } finally {
      errSpy.mockRestore();
    }
  });

  it("keeps a genuinely unknown cluster a plain 404 (not the 503 path)", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(null);

    const res = await callGET(ID);

    expect(res.status).toBe(404);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(res.headers.get("cache-control")).not.toBe("no-store");
  });

  it("404s when the cluster has no members at all", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(mkDetail([]));

    const res = await callGET(ID);

    expect(res.status).toBe(404);
  });

  it("renders a PNG carrying the title, one headline per zone and the wordmark", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(
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
    getClusterDetailOrThrow.mockResolvedValueOnce(
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
    getClusterDetailOrThrow.mockResolvedValueOnce(
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
      mkHealth({
        iktidar: { votingDelivering: 5 },
        muhalefet: { votingDelivering: 3 },
      }),
    );
    getClusterDetailOrThrow.mockResolvedValueOnce(
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
    // The all-kinds delivering figure (10 in every zone) is never printed.
    expect(text).not.toContain("/ 10 kaynak");
  });

  // h53-consistency-2: a Bağımsız zone where 24 voting + 13 non-voting feeds
  // delivered printed "2 / 37 kaynak" on the shareable image although the
  // voting basis was 24. Numerator and denominator now share one basis.
  it("h53-consistency-2: renders '2 / 24 kaynak' for a Bağımsız zone with 24 voting and 13 non-voting delivering feeds", async () => {
    getZoneFeedHealth.mockResolvedValue(
      mkHealth({ bagimsiz: { delivering: 37, votingDelivering: 24 } }),
    );
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail([
        mkMember("a1", CENTER, CENTER_TITLE),
        mkMember("a2", mkSource({ id: "c2", name: "Bağımsız Gazete", bias: "center" }), CENTER_TITLE),
        mkMember(
          "a3",
          mkSource({ id: "niche1", name: "Niş Kaynak", bias: "center", kind: "niche" }),
          "Niş kaynak başlığı",
        ),
      ]),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).toContain("2 / 24 kaynak");
    expect(text).not.toContain("2 / 37");
    expect(text).not.toContain("37 kaynak");
    // The non-voting disclosure line is unchanged.
    expect(text).toContain("+1 toplayıcı / niş kaynak spektruma sayılmaz");
    expect(text).not.toContain("Niş kaynak başlığı");
  });

  it("h53-consistency-2: all three zones print their voting denominator (28 / 24 / 18 replay)", async () => {
    getZoneFeedHealth.mockResolvedValue(
      mkHealth({
        iktidar: { delivering: 31, votingDelivering: 28 },
        bagimsiz: { delivering: 37, votingDelivering: 24 },
        muhalefet: { delivering: 19, votingDelivering: 18 },
      }),
    );
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail([
        mkMember("a1", GOV, GOV_TITLE),
        mkMember("a2", CENTER, CENTER_TITLE),
        mkMember("a3", OPP, OPP_TITLE),
      ]),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).toContain("1 / 28 kaynak");
    expect(text).toContain("1 / 24 kaynak");
    expect(text).toContain("1 / 18 kaynak");
    for (const allKinds of ["/ 31", "/ 37", "/ 19"]) {
      expect(text).not.toContain(allKinds);
    }
  });

  it("renders the silent-zone line for a zone with no members", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(
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
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail([mkMember("a1", GOV, GOV_TITLE)]),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).toContain("bazı kaynaklara ulaşılamıyor");
    expect(text.match(/bazı kaynaklara ulaşılamıyor/g)).toHaveLength(1);
  });

  it("omits a headline whose title the PII filter excludes, keeping its coverage count", async () => {
    getZoneFeedHealth.mockResolvedValue(null);
    getClusterDetailOrThrow.mockResolvedValueOnce(
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
    getClusterDetailOrThrow.mockResolvedValueOnce(
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
    getClusterDetailOrThrow.mockResolvedValueOnce(
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

  // h21-journeys-1: the cluster page hides "Kartı indir" through
  // storyCardHref(); the route must answer 404 for exactly the titles that
  // helper rejects, so a link is never offered that cannot work.
  it.each([
    ["a crime-operation title", "32 ilde FETÖ operasyonu: 41 şüpheli tutuklandı"],
    ["a minister announcing detentions", "İçişleri Bakanı 22 şüphelinin gözaltına alındığını açıkladı"],
    ["a diacritic-folded detention title", "22 supheli gozaltina alindi"],
    ["a neutral title", "Cumhurbaşkanı Erdoğan, Güney Kore'ye geldi"],
  ])("agrees with storyCardHref on %s", async (_label, title) => {
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail([mkMember("a1", GOV, GOV_TITLE)], { title_tr: title }),
    );

    const res = await callGET(ID);

    const offered = storyCardHref(ID, title, true) !== null;
    expect(res.status).toBe(offered ? 200 : 404);
    expect(storyCardHref(ID, title, true)).toBe(offered ? `/cluster/${ID}/kart` : null);
    // The ineligible titles are the 404s, the neutral one the 200.
    expect(offered).toBe(title === "Cumhurbaşkanı Erdoğan, Güney Kore'ye geldi");
  });

  it("answers 404 (not a throw) when the cluster title is missing", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail([mkMember("a1", GOV, GOV_TITLE)], {
        title_tr: null as unknown as string,
      }),
    );

    const res = await callGET(ID);

    expect(res.status).toBe(404);
    expect(captured).toBeNull();
  });

  // The route and the cluster page must call the same helpers instead of each
  // carrying a copy of the rule, so they cannot drift apart again.
  it("shares one eligibility predicate with the cluster page", () => {
    const root = process.cwd();
    const routeSrc = readFileSync(resolve(root, "src/app/cluster/[id]/kart/route.tsx"), "utf8");
    const pageSrc = readFileSync(resolve(root, "src/app/cluster/[id]/page.tsx"), "utf8");

    expect(routeSrc).toContain("isStoryCardTitleEligible(title)");
    expect(routeSrc).not.toContain("pii-filter");
    expect(routeSrc).not.toContain("isGameEligibleTitle(");

    expect(pageSrc).toContain(
      "cardHref={storyCardHref(id, cluster.title_tr, hasStoryCardCoverage(members))}",
    );
  });

  it("refuses to print an impossible fraction when the count exceeds the yield denominator", async () => {
    getZoneFeedHealth.mockResolvedValue(
      mkHealth({
        iktidar: { votingDelivering: 3 },
        muhalefet: { votingDelivering: 0 },
      }),
    );
    getClusterDetailOrThrow.mockResolvedValueOnce(
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
    getClusterDetailOrThrow.mockResolvedValueOnce(
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
    getClusterDetailOrThrow.mockResolvedValue(
      mkDetail([mkMember("a1", GOV, GOV_TITLE)]),
    );

    // Capacity is 10 tokens; drain them on cheap 404s (the limiter runs
    // before the uuid check, so a malformed-id flood is bounded too).
    for (let i = 0; i < 10; i += 1) {
      expect((await callGET("not-a-uuid")).status).toBe(404);
    }
    getClusterDetailOrThrow.mockClear();

    const res = await callGET(ID);

    expect(res.status).toBe(429);
    // apiTooManyRequests: whole seconds, at least 1, and never cached by a
    // shared cache (a cached 429 would keep throttling other readers).
    const retryAfter = Number(res.headers.get("retry-after"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      error: string;
      details: { retryAfterMs: number };
    };
    expect(typeof body.error).toBe("string");
    expect(body.details.retryAfterMs).toBeGreaterThan(0);
    expect(retryAfter).toBe(Math.max(1, Math.ceil(body.details.retryAfterMs / 1000)));
    expect(getClusterDetailOrThrow).not.toHaveBeenCalled();
    expect(captured).toBeNull();
  });

  it("truncates an overlong title and headline instead of overflowing the card", async () => {
    const longTitle = "A".repeat(400);
    const longHeadline = "B".repeat(400);
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail([mkMember("a1", GOV, longHeadline)], { title_tr: longTitle }),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).toContain(`${"A".repeat(139)}…`);
    expect(text).not.toContain("A".repeat(141));
    expect(text).toContain(`${"B".repeat(109)}…`);
    expect(text).not.toContain("B".repeat(111));
  });

  // h64-ogcards-2. The İktidar line of cluster 790d2354-48f1-434b-815d-0ba8f4f84e74
  // read '...32 binden fazla bu…' (a hard cut inside 'buluntu'), and the d26a31d4
  // title '...hesaba çekilme…' (a noun, for the stored 'çekilmeli'). Both lines
  // are cut at a word now. Titles pinned as stored on 2026-11-08.
  it("cuts a long headline at a word, never inside one: '…32 binden fazla…'", async () => {
    const headline =
      "Bakan Ersoy, Kültür ve Turizm Bakanlığı'nın 2027 yılı bütçesini sundu | Geleceğe miras ile 32 binden fazla buluntu gün yüzüne çıkarıldı";
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail([mkMember("a1", GOV, headline)]),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).toContain("32 binden fazla…");
    expect(text).not.toContain("bu…");
    expect(text).not.toContain("buluntu");
  });

  it("cuts a long title at a word, never inside one: '…de hesaba…'", async () => {
    const title =
      "AKP’li isim Fatma Betül’ün sevk yazısındaki gerekçeye dikkat çekti: ‘Biliniyordu… İhmali veya kastı olan kamu görevlileri de hesaba çekilmeli’";
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail([mkMember("a1", GOV, GOV_TITLE)], { title_tr: title }),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).toContain("kamu görevlileri de hesaba…");
    expect(text).not.toContain("çekilme");
  });

  it("trims a padded headline before it is cut", async () => {
    const padded = `   ${"kelime ".repeat(40)}   `;
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail([mkMember("a1", GOV, padded)]),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    // HEADLINE_MAX is 110: 15 whole words (104 characters) fit before '…'.
    expect(text).toContain(`${"kelime ".repeat(14)}kelime…`);
    expect(text).not.toContain("kelime  ");
  });

  it("renders at 1080×1920 with a cacheable inline-PNG disposition", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(
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

  it("renders the non-voting-source line only when a niche/aggregator member is excluded", async () => {
    getZoneFeedHealth.mockResolvedValue(null);
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail([
        mkMember("a1", GOV, GOV_TITLE),
        mkMember(
          "a2",
          mkSource({ id: "niche1", name: "Niş Kaynak", bias: "center", kind: "niche" }),
          "Niş kaynak başlığı",
        ),
      ]),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).toContain("+1 toplayıcı / niş kaynak spektruma sayılmaz");
    expect(text).not.toContain("Niş kaynak başlığı");
  });

  it("omits the non-voting-source line entirely when every member votes", async () => {
    getZoneFeedHealth.mockResolvedValue(null);
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail([mkMember("a1", GOV, GOV_TITLE)]),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).not.toContain("toplayıcı / niş kaynak");
  });

  it("404s when every member is a non-voting kind (no spectrum coverage at all)", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail([
        mkMember(
          "a1",
          mkSource({ id: "niche1", bias: "center", kind: "niche" }),
          "Niş kaynak başlığı",
        ),
      ]),
    );

    const res = await callGET(ID);

    expect(res.status).toBe(404);
    expect(captured).toBeNull();
  });

  it("still renders when feed health lookup returns null (never throws)", async () => {
    getZoneFeedHealth.mockResolvedValue(null);
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail([mkMember("a1", CENTER, CENTER_TITLE)]),
    );

    const res = await callGET(ID);

    expect(res.status).toBe(200);
  });
});

// h57-outbound-1: "Bağımsız — bu tarafta haber yok" was printed over a story an
// aggregator (son-dakika, Bağımsız) carried, and "Muhalefet — bu tarafta haber
// yok" sat above the card's own footer naming a niche Muhalefet source. A zone
// with no voting member but a non-voting one of that zone says what is true.
describe("GET /cluster/[id]/kart non-voting sources in a silent zone (h57-outbound-1)", () => {
  const QUALIFIED_SILENCE = "— spektruma sayılan kaynaklardan haber yok";
  const PLAIN_SILENCE = "— bu tarafta haber yok";

  const SON_DAKIKA = mkSource({ id: "son-dakika", name: "Son Dakika", bias: "center", kind: "aggregator" });
  const ISCI_HABER = mkSource({ id: "isci-haber", name: "İşçi Haber", bias: "opposition", kind: "niche" });
  const HABERLER_COM = mkSource({ id: "haberler-com", name: "Haberler.com", bias: "gov_leaning", kind: "aggregator" });

  const countOf = (text: string, needle: string) => text.split(needle).length - 1;

  beforeEach(() => {
    captured = null;
    capturedOptions = null;
    vi.resetModules();
    getClusterDetailOrThrow.mockReset();
    getZoneFeedHealth.mockReset();
    getZoneFeedHealth.mockResolvedValue(null);
  });

  it("prints the qualified line for both zones the 0b127dc3-shaped fixture leaves to non-voting sources", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail([
        mkMember("a1", GOV, GOV_TITLE),
        mkMember("n1", SON_DAKIKA, "Son dakika başlığı"),
        mkMember("n2", ISCI_HABER, "İşçi haber başlığı"),
        mkMember("n3", HABERLER_COM, "Haberler toplayıcı başlığı"),
      ]),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(countOf(text, QUALIFIED_SILENCE)).toBe(2);
    expect(text).not.toContain(PLAIN_SILENCE);
    // The footer and every non-voting title are as before.
    expect(text).toContain("+3 toplayıcı / niş kaynak spektruma sayılmaz");
    for (const title of ["Son dakika başlığı", "İşçi haber başlığı", "Haberler toplayıcı başlığı"]) {
      expect(text).not.toContain(title);
    }
  });

  it("keeps '— bu tarafta haber yok' for a zone with no member of any kind", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail([mkMember("a1", GOV, GOV_TITLE), mkMember("n2", ISCI_HABER, "İşçi haber başlığı")]),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    // Muhalefet has the niche source, Bağımsız has nobody at all.
    expect(countOf(text, QUALIFIED_SILENCE)).toBe(1);
    expect(countOf(text, PLAIN_SILENCE)).toBe(1);
    const bagimsizAt = text.indexOf("Bağımsız");
    const muhalefetAt = text.indexOf("Muhalefet");
    expect(text.indexOf(PLAIN_SILENCE)).toBeGreaterThan(bagimsizAt);
    expect(text.indexOf(PLAIN_SILENCE)).toBeLessThan(muhalefetAt);
    expect(text.indexOf(QUALIFIED_SILENCE)).toBeGreaterThan(muhalefetAt);
  });

  it("changes nothing for a cluster without non-voting sources (byte-identical silent line)", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(mkDetail([mkMember("a1", GOV, GOV_TITLE)]));

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(countOf(text, PLAIN_SILENCE)).toBe(2);
    expect(text).not.toContain("spektruma sayılan kaynaklardan haber yok");
    expect(text).not.toContain("toplayıcı / niş kaynak");
  });

  it("does not use the qualified line for a non-voting source in a zone that has a voting member", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail([
        mkMember("a1", GOV, GOV_TITLE),
        mkMember("a2", CENTER, CENTER_TITLE),
        mkMember("n1", SON_DAKIKA, "Son dakika başlığı"),
      ]),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).toContain(CENTER_TITLE);
    // Only Muhalefet is silent, and nobody of any kind wrote there.
    expect(countOf(text, PLAIN_SILENCE)).toBe(1);
    expect(text).not.toContain(QUALIFIED_SILENCE);
  });

  it("keeps the degraded-feed caveat under the qualified line", async () => {
    getZoneFeedHealth.mockResolvedValue(mkHealth({ muhalefet: { degraded: true } }));
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail([mkMember("a1", GOV, GOV_TITLE), mkMember("n2", ISCI_HABER, "İşçi haber başlığı")]),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).toContain(QUALIFIED_SILENCE);
    expect(countOf(text, "bazı kaynaklara ulaşılamıyor")).toBe(1);
  });

  it("keeps the PII line for a zone whose voting members were all filtered (not silent at all)", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail([
        mkMember("a1", GOV, GOV_TITLE),
        mkMember("a2", CENTER, "17 yaşındaki çocuk kayboldu"),
        mkMember("n1", SON_DAKIKA, "Son dakika başlığı"),
      ]),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).toContain("1 kaynak yazdı · başlık paylaşıma uygun değil");
    expect(text).not.toContain(QUALIFIED_SILENCE);
  });

  it("does not change the counters, the share bar or the denominator", async () => {
    getZoneFeedHealth.mockResolvedValue(mkHealth({ iktidar: { votingDelivering: 5 } }));
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail([mkMember("a1", GOV, GOV_TITLE), mkMember("n2", ISCI_HABER, "İşçi haber başlığı")]),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).toContain("1 / 5 kaynak");
    expect(text).toContain("0 / 8 kaynak");
    expect(text).not.toContain("1 / 8");
  });
});

// h108-sharesurfaces-1: cluster 0746c9d2 (nine İktidar outlets; Jev matched Yeniçağ
// and Elips Haber, Muhalefet, with the same event in another cluster) printed
// "Muhalefet — bu tarafta haber yok" on the card readers save and post, while the
// cluster page's framing comparison said "bu kümede yok · benzer haber başka
// kümede olabilir". ClusterDetail.recallMatchedZones is already on the detail.
describe("GET /cluster/[id]/kart zones Jev matched (h108-sharesurfaces-1)", () => {
  const MATCHED_SILENCE = "— bu kümede yok · benzer haber başka kümede olabilir";
  const QUALIFIED_SILENCE = "— spektruma sayılan kaynaklardan haber yok";
  const PLAIN_SILENCE = "— bu tarafta haber yok";
  const ISOLATED_LINE = "— karşılaştırma yok (yalnızca İngilizce kaynaklar)";

  const ISCI_HABER = mkSource({ id: "isci-haber", name: "İşçi Haber", bias: "opposition", kind: "niche" });
  const SABAH_EN = mkSource({ id: "ds", slug: "daily-sabah", name: "Daily Sabah", bias: "pro_government", kind: "outlet" });
  const HDN = mkSource({ id: "hdn", slug: "hurriyet-daily-news", name: "Hürriyet Daily News", bias: "gov_leaning", kind: "outlet" });
  const A_NEWS = mkSource({ id: "an", slug: "a-news", name: "A News", bias: "pro_government", kind: "outlet" });

  const countOf = (text: string, needle: string) => text.split(needle).length - 1;

  /** Nine voting İktidar outlets, like 0746c9d2. */
  const nineGov = () =>
    Array.from({ length: 9 }, (_, i) =>
      mkMember(`g${i}`, mkSource({ id: `gov-${i}`, name: `Gazete ${i}`, bias: "pro_government", kind: "outlet" }), `Gazete ${i} haberi`),
    );

  const withRecall = (detail: ClusterDetail, zones: MediaDnaZone[] | undefined): ClusterDetail =>
    zones === undefined ? detail : { ...detail, recallMatchedZones: zones };

  async function textFor(detail: ClusterDetail): Promise<string> {
    getClusterDetailOrThrow.mockResolvedValueOnce(detail);
    const res = await callGET(ID);
    expect(res.status).toBe(200);
    return collectText(captured).join(" ");
  }

  beforeEach(() => {
    captured = null;
    capturedOptions = null;
    vi.resetModules();
    getClusterDetailOrThrow.mockReset();
    getZoneFeedHealth.mockReset();
    getZoneFeedHealth.mockResolvedValue(null);
  });

  it("0746c9d2-shaped: the Muhalefet column carries the qualifier and Bağımsız keeps the plain line", async () => {
    const text = await textFor(withRecall(mkDetail(nineGov()), ["muhalefet"]));

    expect(countOf(text, MATCHED_SILENCE)).toBe(1);
    expect(countOf(text, PLAIN_SILENCE)).toBe(1);
    const bagimsizAt = text.indexOf("Bağımsız");
    const muhalefetAt = text.indexOf("Muhalefet");
    expect(text.indexOf(PLAIN_SILENCE)).toBeGreaterThan(bagimsizAt);
    expect(text.indexOf(PLAIN_SILENCE)).toBeLessThan(muhalefetAt);
    expect(text.indexOf(MATCHED_SILENCE)).toBeGreaterThan(muhalefetAt);
  });

  it("both empty zones matched: both columns carry the qualifier", async () => {
    const text = await textFor(withRecall(mkDetail(nineGov()), ["bagimsiz", "muhalefet"]));

    expect(countOf(text, MATCHED_SILENCE)).toBe(2);
    expect(text).not.toContain(PLAIN_SILENCE);
  });

  it("reads the very constant the framing comparison prints", async () => {
    const { RECALL_MATCH_EMPTY_COLUMN } = await import("@/lib/clusters/recall-matched-zones");
    expect(MATCHED_SILENCE).toBe(`— ${RECALL_MATCH_EMPTY_COLUMN}`);
  });

  it("is byte-identical to today's card with [] (a failed lookup) and with the field undefined (an old cache entry)", async () => {
    const plain = await textFor(mkDetail(nineGov()));
    const empty = await textFor(withRecall(mkDetail(nineGov()), []));

    expect(empty).toBe(plain);
    expect(countOf(plain, PLAIN_SILENCE)).toBe(2);
    expect(plain).not.toContain("benzer haber");
  });

  it("weighted claims too: iktidar 7, bağımsız 1, muhalefet 0, matched muhalefet prints the line for Muhalefet only", async () => {
    const members = [
      ...nineGov().slice(0, 7),
      mkMember("c1", CENTER, CENTER_TITLE),
    ];
    const text = await textFor(withRecall(mkDetail(members), ["muhalefet"]));

    expect(countOf(text, MATCHED_SILENCE)).toBe(1);
    // The zones with headlines are untouched, and nothing else is silent.
    expect(text).toContain(CENTER_TITLE);
    expect(text).not.toContain(PLAIN_SILENCE);
    expect(text.indexOf(MATCHED_SILENCE)).toBeGreaterThan(text.indexOf("Muhalefet"));
  });

  it("precedence: a toplayıcı / niş source in the zone keeps the spectrum wording over the matched one", async () => {
    const text = await textFor(
      withRecall(
        mkDetail([...nineGov(), mkMember("n2", ISCI_HABER, "İşçi haber başlığı")]),
        ["bagimsiz", "muhalefet"],
      ),
    );

    // Muhalefet has the niche source: qualified. Bağımsız has nobody: matched.
    expect(countOf(text, QUALIFIED_SILENCE)).toBe(1);
    expect(countOf(text, MATCHED_SILENCE)).toBe(1);
    expect(text).not.toContain(PLAIN_SILENCE);
    expect(text.indexOf(MATCHED_SILENCE)).toBeLessThan(text.indexOf(QUALIFIED_SILENCE));
  });

  it("precedence: an all-English cluster keeps the no-comparison line over the matched one", async () => {
    const members = [
      mkMember("a1", HDN, "Erdoğan visits Seoul with $15 billion trade goal"),
      mkMember("a2", A_NEWS, "Erdoğan visits Seoul"),
      mkMember("a3", SABAH_EN, "Erdoğan in Seoul"),
    ];
    const text = await textFor(withRecall(mkDetail(members), ["bagimsiz", "muhalefet"]));

    expect(countOf(text, ISOLATED_LINE)).toBe(2);
    expect(text).not.toContain("benzer haber");
    expect(text).not.toContain(MATCHED_SILENCE);
  });

  it("a matched zone that has a headline shows the headline, not the line", async () => {
    const text = await textFor(
      withRecall(mkDetail([...nineGov().slice(0, 2), mkMember("c1", CENTER, CENTER_TITLE)]), ["bagimsiz"]),
    );

    expect(text).toContain(CENTER_TITLE);
    expect(text).not.toContain(MATCHED_SILENCE);
  });

  it("keeps the PII line for a matched zone whose voting members were all filtered (not silent at all)", async () => {
    const text = await textFor(
      withRecall(
        mkDetail([...nineGov().slice(0, 2), mkMember("c1", CENTER, "17 yaşındaki çocuk kayboldu")]),
        ["bagimsiz"],
      ),
    );

    expect(text).toContain("1 kaynak yazdı · başlık paylaşıma uygun değil");
    expect(text).not.toContain(MATCHED_SILENCE);
  });

  it("keeps the degraded-feed caveat under the matched line", async () => {
    getZoneFeedHealth.mockResolvedValue(mkHealth({ muhalefet: { degraded: true } }));
    const text = await textFor(withRecall(mkDetail(nineGov()), ["muhalefet"]));

    expect(text).toContain(MATCHED_SILENCE);
    expect(countOf(text, "bazı kaynaklara ulaşılamıyor")).toBe(1);
  });

  it("does not change the counters, the share bar or the denominator", async () => {
    getZoneFeedHealth.mockResolvedValue(mkHealth({ iktidar: { votingDelivering: 12 } }));
    const matched = await textFor(withRecall(mkDetail(nineGov()), ["muhalefet"]));
    const plain = await textFor(mkDetail(nineGov()));

    expect(matched).toContain("9 / 12 kaynak");
    expect(matched).toContain("0 / 8 kaynak");
    expect(matched.replace(MATCHED_SILENCE, PLAIN_SILENCE)).toBe(plain);
  });
});

// h57-outbound-2: the card is the image readers download and post, so a column
// that is the only thing a zone has is labelled the way the cluster page's
// summary already labels it ('<Outlet> · köşe yazısı'); a zone with news never
// shows the column at all.
describe("GET /cluster/[id]/kart opinion columns (h57-outbound-2)", () => {
  const HURRIYET = mkSource({ id: "hurriyet", name: "Hürriyet", bias: "pro_government" });
  const TAKVIM = mkSource({ id: "takvim", name: "Takvim", bias: "pro_government" });
  const COLUMN_TITLE = "Emir Sarıgül’den Özgür Özel’i yalanlayan etkin pişmanlık ifadesi";
  const NEWS_TITLE = "Emir Sarıgül 3'üncü kez ifade verdi!";

  const column = (): ClusterDetailMember => ({
    ...mkMember("h1", HURRIYET, COLUMN_TITLE, "2026-11-07T03:04:00Z"),
    article: {
      ...mkMember("h1", HURRIYET, COLUMN_TITLE, "2026-11-07T03:04:00Z").article,
      url: "https://www.hurriyet.com.tr/yazarlar/nedim-sener/emir-sarigul-43000001",
    },
  });
  const news = (): ClusterDetailMember => ({
    ...mkMember("t1", TAKVIM, NEWS_TITLE, "2026-11-07T04:00:00Z"),
    article: {
      ...mkMember("t1", TAKVIM, NEWS_TITLE, "2026-11-07T04:00:00Z").article,
      url: "https://www.takvim.com.tr/guncel/2026/11/07/emir-sarigul-ifade-verdi",
    },
  });

  beforeEach(() => {
    captured = null;
    capturedOptions = null;
    vi.resetModules();
    getClusterDetailOrThrow.mockReset();
    getZoneFeedHealth.mockReset();
    getZoneFeedHealth.mockResolvedValue(null);
  });

  it("renders 'Hürriyet · köşe yazısı' for a zone whose only member is a column", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(mkDetail([column()]));

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).toContain("Hürriyet · köşe yazısı");
    expect(text).toContain(COLUMN_TITLE);
    // The outlet line is ONE text node (Satori renders fragments as separate runs).
    expect(collectText(captured)).toContain("Hürriyet · köşe yazısı");
  });

  it("renders the plain outlet name for a news headline, never the column cue", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(mkDetail([news()]));

    await callGET(ID);

    const texts = collectText(captured);
    expect(texts).toContain("Takvim");
    expect(texts.join(" ")).not.toContain("köşe yazısı");
    expect(texts.join(" ")).toContain(NEWS_TITLE);
  });

  it("prints Takvim's news and no column cue when the zone has both (442e0395)", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(mkDetail([column(), news()]));

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).toContain("Takvim");
    expect(text).toContain(NEWS_TITLE);
    expect(text).not.toContain(COLUMN_TITLE);
    expect(text).not.toContain("Hürriyet");
    expect(text).not.toContain("köşe yazısı");
    // The count still includes the column.
    expect(text).toContain("2 kaynak");
  });

  it("marks only the zone that fell back to a column", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail([column(), mkMember("o1", OPP, OPP_TITLE)]),
    );

    await callGET(ID);

    const texts = collectText(captured);
    expect(texts.filter((t) => t.includes("köşe yazısı"))).toEqual(["Hürriyet · köşe yazısı"]);
    expect(texts).toContain("Muhalif Gazete");
  });

  it("keeps the PII gate: a PII-filtered column is never printed, with or without the cue", async () => {
    const filtered: ClusterDetailMember = {
      ...column(),
      article: { ...column().article, title: "17 yaşındaki çocuk kayboldu" },
    };
    getClusterDetailOrThrow.mockResolvedValueOnce(mkDetail([filtered]));

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(text).not.toContain("17 yaşındaki çocuk kayboldu");
    expect(text).not.toContain("köşe yazısı");
    expect(text).toContain("1 kaynak yazdı · başlık paylaşıma uygun değil");
  });
});

// h59-english-1: fbb078b4 and 26e8abf9 were written only by English-language
// outlets. "— bu tarafta haber yok" on their Bağımsız and Muhalefet rows claims
// nobody on those sides covered the event, which the Turkish clusters on the same
// event contradict. An isolated cluster's empty zone says no comparison exists.
describe("GET /cluster/[id]/kart all-English cluster (h59-english-1)", () => {
  const ISOLATED_LINE = "— karşılaştırma yok (yalnızca İngilizce kaynaklar)";
  const PLAIN_SILENCE = "— bu tarafta haber yok";

  const HDN = mkSource({ id: "hdn", slug: "hurriyet-daily-news", name: "Hürriyet Daily News", bias: "gov_leaning", kind: "outlet" });
  const A_NEWS = mkSource({ id: "an", slug: "a-news", name: "A News", bias: "pro_government", kind: "outlet" });
  const SABAH_EN = mkSource({ id: "ds", slug: "daily-sabah", name: "Daily Sabah", bias: "pro_government", kind: "outlet" });
  const TRT = mkSource({ id: "trt", slug: "trt-world", name: "TRT World", bias: "state_media", kind: "outlet" });
  const A_HABER = mkSource({ id: "ah", slug: "a-haber", name: "A Haber", bias: "pro_government", kind: "outlet" });
  const YENI_SAFAK = mkSource({ id: "ys", slug: "yeni-safak", name: "Yeni Şafak", bias: "pro_government", kind: "outlet" });

  const countOf = (text: string, needle: string) => text.split(needle).length - 1;

  const fixtureA = () => [
    mkMember("a1", HDN, "Erdoğan visits Seoul with $15 billion trade goal", "2026-11-02T06:18:00Z"),
    mkMember("a2", A_NEWS, "Erdoğan visits Seoul", "2026-11-02T06:53:00Z"),
    mkMember("a3", SABAH_EN, "Erdoğan in Seoul", "2026-11-02T06:56:00Z"),
    mkMember("a4", TRT, "Erdoğan lands in Seoul", "2026-11-02T08:25:00Z"),
  ];

  beforeEach(() => {
    captured = null;
    capturedOptions = null;
    vi.resetModules();
    getClusterDetailOrThrow.mockReset();
    getZoneFeedHealth.mockReset();
    getZoneFeedHealth.mockResolvedValue(null);
  });

  it("fixture A: both empty zones print the no-comparison line and never the plain silence", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(mkDetail(fixtureA()));

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(countOf(text, ISOLATED_LINE)).toBe(2);
    expect(text).not.toContain(PLAIN_SILENCE);
    expect(text).not.toContain("spektruma sayılan kaynaklardan haber yok");
    // The İktidar row still shows an outlet's own headline, and the counters stay.
    expect(text).toContain("4 kaynak");
    expect(text.toLowerCase()).toContain("seoul");
  });

  it("fixture B (three English outlets): both empty zones print the no-comparison line", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail([
        mkMember("b1", SABAH_EN, "Turkey signs deal", "2026-11-03T05:00:00Z"),
        mkMember("b2", HDN, "Turkey signs a deal", "2026-11-03T05:20:00Z"),
        mkMember("b3", A_NEWS, "Turkey agrees deal", "2026-11-03T06:10:00Z"),
      ]),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(countOf(text, ISOLATED_LINE)).toBe(2);
    expect(text).not.toContain(PLAIN_SILENCE);
  });

  it("does not attach the degraded-feed caveat to a comparison that was never claimed", async () => {
    getZoneFeedHealth.mockResolvedValue(mkHealth({ muhalefet: { degraded: true }, bagimsiz: { degraded: true } }));
    getClusterDetailOrThrow.mockResolvedValueOnce(mkDetail(fixtureA()));

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(countOf(text, ISOLATED_LINE)).toBe(2);
    expect(text).not.toContain("bazı kaynaklara ulaşılamıyor");
  });

  it("controls: a mixed cluster (a-haber + daily-sabah) keeps '— bu tarafta haber yok' on both empty zones", async () => {
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail([mkMember("m1", A_HABER, GOV_TITLE), mkMember("m2", SABAH_EN, "Budget talks begin")]),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(countOf(text, PLAIN_SILENCE)).toBe(2);
    expect(text).not.toContain("karşılaştırma yok");
  });

  it("controls: a Turkish 2-outlet pro-government cluster keeps '— bu tarafta haber yok' and the degraded caveat", async () => {
    getZoneFeedHealth.mockResolvedValue(mkHealth({ muhalefet: { degraded: true } }));
    getClusterDetailOrThrow.mockResolvedValueOnce(
      mkDetail([mkMember("t1", A_HABER, GOV_TITLE), mkMember("t2", YENI_SAFAK, "Bütçe teklifi kabul edildi")]),
    );

    await callGET(ID);

    const text = collectText(captured).join(" ");
    expect(countOf(text, PLAIN_SILENCE)).toBe(2);
    expect(countOf(text, "bazı kaynaklara ulaşılamıyor")).toBe(1);
    expect(text).not.toContain("karşılaştırma yok");
  });
});
