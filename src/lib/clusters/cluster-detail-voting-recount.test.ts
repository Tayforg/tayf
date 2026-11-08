import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// h63-clusterintegrity-1: read-path recount of the voting distribution.
//
// Clusters last touched before migration 034 store a bias_distribution (and an
// is_blindspot flag) that count aggregator and niche members. The detail read
// recounts the members it already loaded, over voting kinds only, and shows
// that instead of the stored value. It may withdraw a stored blindspot claim
// the recount no longer supports; it never creates one.
//
// Harness: the shared chainable fake (tests/_helpers/supabase-fake.ts) behind a
// mocked createReaderClient. The sibling suite cluster-detail-query.test.ts
// keeps its own table-keyed fake for the query-shape assertions.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  cluster: null as Record<string, unknown> | null,
  members: [] as unknown[],
  membersError: null as { message: string } | null,
  sources: [] as unknown[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: () => ({ data: fixture.cluster ? [fixture.cluster] : [], error: null }),
      cluster_articles: () =>
        fixture.membersError
          ? { data: null, error: fixture.membersError }
          : { data: fixture.members, error: null },
      sources: () => ({ data: fixture.sources, error: null }),
    },
  });
});

vi.mock("@/lib/supabase/server", () => ({
  createReaderClient: () => supabaseFake.client,
  createServerClient: () => {
    throw new Error("cluster-detail-query must use the capped createReaderClient()");
  },
}));

const feedHealthMock = vi.hoisted(() => ({
  getZoneFeedHealth: vi.fn(),
  shouldSuppressBlindspot: vi.fn(),
}));

vi.mock("@/lib/clusters/feed-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clusters/feed-health")>();
  return {
    ...actual,
    getZoneFeedHealth: feedHealthMock.getZoneFeedHealth,
    shouldSuppressBlindspot: feedHealthMock.shouldSuppressBlindspot,
  };
});

import { __resetCacheResilienceForTests } from "@/lib/cache-resilience";
import { POSTGREST_MAX_ROWS } from "@/lib/db/paging";
import { getClusterDetail, getClusterDetailOrThrow } from "./cluster-detail-query";

const ID = "861b4249-f553-41b7-be98-45544008b1bc";

function clusterRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    title_tr: "Başlık",
    title_tr_neutral: null,
    title_neutral_model: null,
    summary_tr: "Özet",
    article_count: 5,
    bias_distribution: { center: 4, gov_leaning: 1 },
    is_blindspot: true,
    blindspot_side: "center",
    blindspot_recall_veto: null,
    // Old enough that the feed-delay wait is long over.
    first_published: "2026-08-02T08:00:00Z",
    updated_at: "2026-08-02T12:00:00Z",
    is_archived: false,
    ...overrides,
  };
}

let seq = 0;
function member(
  sourceSlug: string,
  bias: string,
  kind: string,
  overrides: { sourceId?: string; publishedAt?: string } = {},
) {
  seq += 1;
  const sourceId = overrides.sourceId ?? `src-${sourceSlug}`;
  return {
    article: {
      id: `art-${seq}`,
      title: `Haber ${seq}`,
      url: `https://${sourceSlug}.example/${seq}`,
      published_at: overrides.publishedAt ?? "2026-08-02T09:00:00Z",
      image_url: null,
      content_hash: null,
      description: null,
      source: {
        id: sourceId,
        name: sourceSlug,
        slug: sourceSlug,
        url: `https://${sourceSlug}.example`,
        rss_url: `https://${sourceSlug}.example/rss`,
        bias,
        logo_url: null,
        active: true,
        kind,
      },
    },
  };
}

/** The 861b4249 shape: one aggregator in gov_leaning + four centre outlets. */
function legacyMembers() {
  return [
    member("haberler-com", "gov_leaning", "aggregator"),
    member("dokuz8-haber", "center", "outlet"),
    member("isin-detayi", "center", "outlet"),
    member("dw-turkce", "center", "outlet"),
    member("gazete-pencere", "center", "outlet"),
  ];
}

function reset() {
  seq = 0;
  fixture.cluster = clusterRow();
  fixture.members = legacyMembers();
  fixture.membersError = null;
  fixture.sources = [];
}

let infoSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetCacheResilienceForTests();
  reset();
  feedHealthMock.getZoneFeedHealth.mockReset();
  feedHealthMock.shouldSuppressBlindspot.mockReset();
  feedHealthMock.getZoneFeedHealth.mockResolvedValue(null);
  feedHealthMock.shouldSuppressBlindspot.mockReturnValue(false);
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  infoSpy.mockRestore();
  logSpy.mockRestore();
});

/** Every console.info / console.log line that carries the recount tag. */
function recountLogs(): string[] {
  return [...infoSpy.mock.calls, ...logSpy.mock.calls]
    .map((c) => String(c[0]))
    .filter((line) => line.includes("voting-recount"));
}

describe("legacy cluster (stored all-member distribution, one aggregator member)", () => {
  it("shows the voting recount instead of the stored distribution", async () => {
    const detail = await getClusterDetail(ID);
    expect(detail).not.toBeNull();
    expect(detail!.cluster.bias_distribution.center).toBe(4);
    expect(detail!.cluster.bias_distribution.gov_leaning).toBe(0);
    const total = Object.values(detail!.cluster.bias_distribution).reduce((a, b) => a + b, 0);
    expect(total).toBe(4);
  });

  it("withdraws the blindspot claim the recount no longer supports, and skips feed health", async () => {
    const detail = await getClusterDetail(ID);
    expect(detail!.cluster.is_blindspot).toBe(false);
    expect(detail!.cluster.blindspot_side).toBeNull();
    // A recount failure is not a feed outage and not a recall veto.
    expect(detail!.blindspotSuppressed).toBe(false);
    expect(detail!.blindspotRecallVetoed).toBe(false);
    expect(feedHealthMock.getZoneFeedHealth).not.toHaveBeenCalled();
  });

  it("logs once, with the cluster id and no distribution values", async () => {
    await getClusterDetail(ID);
    const lines = recountLogs();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(ID);
    // Nothing but the id: no counts, no member or source names.
    expect(lines[0]).not.toMatch(/gov_leaning|center|haberler/);
  });

  it("serves the same recount on the throwing variant (page, share card, embed, oEmbed, OG image)", async () => {
    const detail = await getClusterDetailOrThrow(ID);
    expect(detail!.cluster.bias_distribution.center).toBe(4);
    expect(detail!.cluster.bias_distribution.gov_leaning).toBe(0);
    expect(detail!.cluster.is_blindspot).toBe(false);
  });
});

describe("modern cluster (stored equals the recount)", () => {
  function modern() {
    fixture.cluster = clusterRow({
      article_count: 6,
      bias_distribution: { center: 5, pro_kurdish: 1 },
      is_blindspot: true,
      blindspot_side: "center",
    });
    fixture.members = [
      member("a", "center", "outlet"),
      member("b", "center", "outlet"),
      member("c", "center", "wire"),
      member("d", "center", "outlet"),
      member("e", "center", "outlet"),
      member("f", "pro_kurdish", "outlet"),
      // Non-voting member: listed on the page, never in the stored value.
      member("haberler-com", "gov_leaning", "aggregator"),
    ];
  }

  it("is unchanged: same distribution, claim kept, no log", async () => {
    modern();
    const detail = await getClusterDetail(ID);
    expect(detail!.cluster.bias_distribution.center).toBe(5);
    expect(detail!.cluster.bias_distribution.pro_kurdish).toBe(1);
    expect(detail!.cluster.bias_distribution.gov_leaning).toBe(0);
    expect(detail!.cluster.is_blindspot).toBe(true);
    expect(detail!.cluster.blindspot_side).toBe("center");
    expect(recountLogs()).toHaveLength(0);
  });

  it("still runs the feed-health gate for a claim that stands", async () => {
    modern();
    await getClusterDetail(ID);
    expect(feedHealthMock.getZoneFeedHealth).toHaveBeenCalledTimes(1);
  });

  it("lets feed health withdraw the claim after the recount kept it", async () => {
    modern();
    feedHealthMock.shouldSuppressBlindspot.mockReturnValue(true);
    const detail = await getClusterDetail(ID);
    expect(detail!.cluster.is_blindspot).toBe(false);
    expect(detail!.cluster.blindspot_side).toBeNull();
    expect(detail!.blindspotSuppressed).toBe(true);
  });

  it("counts a repeated source once per article, as migration 034 does", async () => {
    fixture.cluster = clusterRow({
      bias_distribution: { center: 3 },
      is_blindspot: false,
      blindspot_side: null,
    });
    fixture.members = [
      member("a", "center", "outlet", { publishedAt: "2026-08-02T09:00:00Z" }),
      member("a", "center", "outlet", { publishedAt: "2026-08-02T10:00:00Z" }),
      member("b", "center", "outlet"),
    ];
    const detail = await getClusterDetail(ID);
    // The page dedupes the member LIST per source, but the vote tally is per
    // article, so it still agrees with the stored 3 and nothing is logged.
    expect(detail!.members).toHaveLength(2);
    expect(detail!.cluster.bias_distribution.center).toBe(3);
    expect(recountLogs()).toHaveLength(0);
  });
});

describe("the recount never creates a claim", () => {
  it("keeps is_blindspot false when the stored flag is false even though the recount would pass", async () => {
    fixture.cluster = clusterRow({
      bias_distribution: { center: 1 },
      is_blindspot: false,
      blindspot_side: null,
    });
    fixture.members = [
      member("a", "center", "outlet"),
      member("b", "center", "outlet"),
      member("c", "center", "outlet"),
      member("d", "center", "outlet"),
      member("e", "center", "wire"),
    ];
    const detail = await getClusterDetail(ID);
    expect(detail!.cluster.bias_distribution.center).toBe(5);
    expect(detail!.cluster.is_blindspot).toBe(false);
    expect(detail!.cluster.blindspot_side).toBeNull();
    expect(feedHealthMock.getZoneFeedHealth).not.toHaveBeenCalled();
  });
});

describe("withdrawal edge cases", () => {
  it("withdraws a claim whose recount has enough voters but too little zone share", async () => {
    fixture.cluster = clusterRow({
      bias_distribution: { center: 5, pro_kurdish: 1 },
      is_blindspot: true,
      blindspot_side: "center",
    });
    fixture.members = [
      member("a", "center", "outlet"),
      member("b", "center", "outlet"),
      member("c", "center", "outlet"),
      member("d", "opposition", "outlet"),
      member("e", "pro_government", "outlet"),
      member("f", "pro_government", "outlet"),
    ];
    const detail = await getClusterDetail(ID);
    expect(detail!.cluster.is_blindspot).toBe(false);
    expect(detail!.cluster.blindspot_side).toBeNull();
    expect(feedHealthMock.getZoneFeedHealth).not.toHaveBeenCalled();
  });

  it("keeps the recall veto first: a vetoed claim stays vetoed and is logged as a veto", async () => {
    fixture.cluster = clusterRow({ blindspot_recall_veto: true });
    const detail = await getClusterDetail(ID);
    expect(detail!.blindspotRecallVetoed).toBe(true);
    expect(detail!.cluster.is_blindspot).toBe(false);
    expect(infoSpy.mock.calls.some((c) => String(c[0]).includes("[recall-veto]"))).toBe(true);
    expect(feedHealthMock.getZoneFeedHealth).not.toHaveBeenCalled();
  });

  it("does not ask feed health about a claim still inside the feed delay when the recount fails it", async () => {
    // The stored flag is true and unvetoed, so the claim is `pending`; a failed
    // recount turns it into no claim at all, and nothing is withheld or suppressed.
    fixture.cluster = clusterRow({ first_published: new Date().toISOString() });
    const detail = await getClusterDetail(ID);
    expect(detail!.cluster.is_blindspot).toBe(false);
    expect(detail!.cluster.blindspot_side).toBeNull();
    expect(detail!.blindspotSuppressed).toBe(false);
    expect(feedHealthMock.getZoneFeedHealth).not.toHaveBeenCalled();
  });

  it("still asks feed health about a pending claim the recount supports", async () => {
    fixture.cluster = clusterRow({
      first_published: new Date().toISOString(),
      bias_distribution: { center: 5 },
    });
    fixture.members = [
      member("a", "center", "outlet"),
      member("b", "center", "outlet"),
      member("c", "center", "outlet"),
      member("d", "center", "outlet"),
      member("e", "center", "outlet"),
    ];
    feedHealthMock.shouldSuppressBlindspot.mockReturnValue(true);
    const detail = await getClusterDetail(ID);
    expect(feedHealthMock.getZoneFeedHealth).toHaveBeenCalledTimes(1);
    expect(detail!.blindspotSuppressed).toBe(true);
    expect(detail!.cluster.is_blindspot).toBe(false);
  });
});

describe("incomplete member lists fall back to the stored values", () => {
  it("falls back when the member list hit PostgREST's row cap (truncated)", async () => {
    fixture.cluster = clusterRow({
      bias_distribution: { center: 1500, gov_leaning: 1 },
      is_blindspot: true,
      blindspot_side: "center",
    });
    fixture.members = Array.from({ length: POSTGREST_MAX_ROWS }, (_, i) =>
      member(`s${i}`, "center", "outlet"),
    );
    const detail = await getClusterDetail(ID);
    expect(detail!.cluster.bias_distribution.center).toBe(1500);
    expect(detail!.cluster.bias_distribution.gov_leaning).toBe(1);
    expect(detail!.cluster.is_blindspot).toBe(true);
    expect(detail!.cluster.blindspot_side).toBe("center");
    expect(recountLogs()).toHaveLength(0);
  });

  it("recounts a list one row under the cap", async () => {
    fixture.cluster = clusterRow({
      bias_distribution: { center: 1500 },
      is_blindspot: false,
      blindspot_side: null,
    });
    fixture.members = Array.from({ length: POSTGREST_MAX_ROWS - 1 }, (_, i) =>
      member(`s${i}`, "center", "outlet"),
    );
    const detail = await getClusterDetail(ID);
    expect(detail!.cluster.bias_distribution.center).toBe(POSTGREST_MAX_ROWS - 1);
  });

  it("falls back when the cluster has no member rows at all", async () => {
    fixture.members = [];
    const detail = await getClusterDetail(ID);
    expect(detail!.cluster.bias_distribution.center).toBe(4);
    expect(detail!.cluster.bias_distribution.gov_leaning).toBe(1);
    expect(detail!.cluster.is_blindspot).toBe(true);
    expect(recountLogs()).toHaveLength(0);
  });

  it("still rejects on a members error instead of serving stored or recounted numbers", async () => {
    fixture.membersError = { message: "boom" };
    await expect(getClusterDetailOrThrow(ID)).rejects.toThrow();
  });
});

describe("stored value shapes", () => {
  it("recounts over a null or malformed stored distribution without throwing, and logs the mismatch", async () => {
    fixture.cluster = clusterRow({
      bias_distribution: null,
      is_blindspot: false,
      blindspot_side: null,
    });
    const detail = await getClusterDetail(ID);
    expect(detail!.cluster.bias_distribution.center).toBe(4);
    expect(recountLogs()).toHaveLength(1);
  });

  it("ignores legacy keys in the stored jsonb when comparing", async () => {
    fixture.cluster = clusterRow({
      bias_distribution: { center: 4, independent: 7 },
      is_blindspot: false,
      blindspot_side: null,
    });
    const detail = await getClusterDetail(ID);
    expect(detail!.cluster.bias_distribution.center).toBe(4);
    expect(recountLogs()).toHaveLength(0);
  });
});
