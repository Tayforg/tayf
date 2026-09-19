import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
//
// next/cache: buildYelpazeReport transitively calls getClusterDetail() and
// getZoneFeedHealth(), both wrapped in `"use cache"`. Same no-op mock as
// cluster-detail-query.test.ts / feed-health.test.ts.
//
// @/lib/supabase/server: replaced with the shared chainable fake
// (tests/_helpers/supabase-fake.ts) per D1.md — buildYelpazeReport is
// exercised end-to-end against fixture rows, with feed-health.ts's REAL
// (unmocked) health/suppression logic running on top, so this suite proves
// the whole assembly pipeline, not just yelpaze.ts in isolation.

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const hoisted = vi.hoisted(() => ({ createServerClient: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: hoisted.createServerClient,
}));

import { createSupabaseFake, type SupabaseFakeOptions } from "../../../tests/_helpers/supabase-fake";
import type { ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";

// Import AFTER mocks are declared.
import { buildOwnershipSection, buildYelpazeReport } from "./yelpaze";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function setSupabaseFixtures(options: SupabaseFakeOptions): void {
  const { client } = createSupabaseFake(options);
  hoisted.createServerClient.mockImplementation(() => client);
}

function mkClusterRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cluster-1",
    title_tr: "Başlık",
    title_tr_neutral: null,
    title_neutral_model: null,
    summary_tr: "Özet",
    article_count: 4,
    bias_distribution: {},
    is_blindspot: false,
    blindspot_side: null,
    first_published: "2026-04-17T06:00:00Z",
    updated_at: "2026-04-17T12:00:00Z",
    is_archived: false,
    ...overrides,
  };
}

function mkEmbeddedSource(
  id: string,
  slug: string,
  bias: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    name: `Kaynak ${slug}`,
    slug,
    url: `https://${slug}.example`,
    rss_url: `https://${slug}.example/rss`,
    bias,
    logo_url: null,
    active: true,
    kind: "outlet",
    ...overrides,
  };
}

function mkEmbeddedMember(
  articleId: string,
  source: ReturnType<typeof mkEmbeddedSource>,
  publishedAt: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    article: {
      id: articleId,
      title: `Haber ${articleId}`,
      url: `https://example.com/${articleId}`,
      published_at: publishedAt,
      image_url: null,
      content_hash: `hash-${articleId}`,
      description: null,
      source,
      ...overrides,
    },
  };
}

// Feed-health rows (src/lib/clusters/feed-health.ts): the two-axis
// ZoneHealth shape (pack A merge) — `fetchOk` (status 200/304 within the
// last 2h) and `delivering` (>=1 article in the trailing yield window, via
// the `recent:articles(id)` existence-probe embed) are independent axes;
// `healthy` is their AND. This fixture drives both axes off the same
// `healthy` boolean by default (so every pinned count that predates the
// two-axis split keeps reading the same number post-merge); pass explicit
// `fetch_last_status` / `fetch_last_at` / `recent` overrides to make the
// two axes disagree. Recomputed relative to "now" at call time so the
// fixture never goes stale.
function healthyAt(minutesAgo = 5) {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

function mkFeedHealthRow(
  slug: string,
  bias: string,
  healthy: boolean,
  overrides: Record<string, unknown> = {},
) {
  return {
    slug,
    bias,
    active: true,
    rss_url: `https://${slug}.example/rss`,
    fetch_last_status: healthy ? 200 : 500,
    fetch_last_at: healthy ? healthyAt() : new Date(0).toISOString(),
    recent: healthy ? [{ id: `${slug}-recent` }] : [],
    ...overrides,
  };
}

beforeEach(() => {
  hoisted.createServerClient.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildYelpazeReport — unknown cluster", () => {
  it("returns null when the cluster does not exist", async () => {
    setSupabaseFixtures({
      tables: {
        clusters: [],
        cluster_articles: [],
        sources: [],
      },
    });

    const result = await buildYelpazeReport("does-not-exist");
    expect(result).toBeNull();
  });
});

describe("buildYelpazeReport — coverage, framing, timeline, ownership (known feed health)", () => {
  // iktidar: sabah (turkuvaz, tagged) + hurriyet (demiroren, tagged) — 2 outlets
  // bagimsiz: bianet (independent, tagged) — 1 outlet, exactly one article
  // muhalefet: an untagged outlet — 1 outlet, exactly one article
  const sabah = mkEmbeddedSource("s-sabah", "sabah", "pro_government");
  const hurriyet = mkEmbeddedSource("s-hurriyet", "hurriyet", "gov_leaning");
  const bianet = mkEmbeddedSource("s-bianet", "bianet", "center");
  const untagged = mkEmbeddedSource("s-untagged", "not-a-real-outlet", "opposition");

  function setHappyPathFixtures() {
    setSupabaseFixtures({
      tables: {
        clusters: [mkClusterRow()],
        cluster_articles: [
          mkEmbeddedMember("a-sabah", sabah, "2026-04-17T07:00:00Z"),
          mkEmbeddedMember("a-hurriyet", hurriyet, "2026-04-17T09:00:00Z"),
          mkEmbeddedMember("a-bianet", bianet, "2026-04-17T08:00:00Z"),
          mkEmbeddedMember("a-untagged", untagged, "2026-04-17T10:00:00Z"),
        ],
        // Padded with extra non-covering sources per zone so the
        // denominator differs from the raw outlet count — proves coverage
        // is computed over the yield/status denominator, not the outlet
        // count itself.
        sources: [
          mkFeedHealthRow("sabah", "pro_government", true),
          mkFeedHealthRow("hurriyet", "gov_leaning", true),
          mkFeedHealthRow("iktidar-pad-1", "pro_government", true),
          mkFeedHealthRow("iktidar-pad-2", "pro_government", true),
          mkFeedHealthRow("iktidar-pad-3", "pro_government", true),
          mkFeedHealthRow("bianet", "center", true),
          mkFeedHealthRow("bagimsiz-pad-1", "center", true),
          mkFeedHealthRow("not-a-real-outlet", "opposition", true),
          mkFeedHealthRow("muhalefet-pad-1", "opposition", true),
          mkFeedHealthRow("muhalefet-pad-2", "opposition", false), // unhealthy
        ],
      },
    });
  }

  it("produces three coverage rows with the right outlet counts and denominators", async () => {
    setHappyPathFixtures();
    const report = await buildYelpazeReport("cluster-1");
    expect(report).not.toBeNull();

    const rows = report!.coverage.rows;
    expect(rows).toHaveLength(3);

    const iktidar = rows.find((r) => r.zone === "iktidar")!;
    expect(iktidar.outlets).toBe(2);
    expect(iktidar.denominatorKnown).toBe(true);
    expect(iktidar.denominator).toBe(5); // sabah, hurriyet + 3 healthy pads
    expect(iktidar.share).toBeCloseTo(2 / 5);

    const bagimsiz = rows.find((r) => r.zone === "bagimsiz")!;
    expect(bagimsiz.outlets).toBe(1);
    expect(bagimsiz.denominator).toBe(2); // bianet + 1 healthy pad
    expect(bagimsiz.share).toBeCloseTo(1 / 2);

    const muhalefet = rows.find((r) => r.zone === "muhalefet")!;
    expect(muhalefet.outlets).toBe(1);
    // 2 healthy (untagged outlet + muhalefet-pad-1); muhalefet-pad-2 is
    // unhealthy and must NOT count toward the denominator.
    expect(muhalefet.denominator).toBe(2);
    expect(muhalefet.share).toBeCloseTo(1 / 2);

    expect(report!.coverage.denominatorBasis).toBe("yield");
  });

  it("gives the single-article bagimsiz zone a null `last` framing half, not a fabricated pair", async () => {
    setHappyPathFixtures();
    const report = await buildYelpazeReport("cluster-1");

    const bagimsiz = report!.framing.find((p) => p.zone === "bagimsiz")!;
    expect(bagimsiz).toBeTruthy();
    expect(bagimsiz.first.outlet).toBe("Kaynak bianet");
    expect(bagimsiz.last).toBeNull();

    // iktidar has two articles — first/last must be chronological, not
    // insertion order (sabah 07:00 is first, hurriyet 09:00 is last).
    const iktidar = report!.framing.find((p) => p.zone === "iktidar")!;
    expect(iktidar.first.outlet).toBe("Kaynak sabah");
    expect(iktidar.last).not.toBeNull();
    expect(iktidar.last!.outlet).toBe("Kaynak hurriyet");
  });

  it("computes each zone's timeline lag against the cluster's first_published", async () => {
    setHappyPathFixtures();
    const report = await buildYelpazeReport("cluster-1");

    // cluster.first_published = 06:00; iktidar's first article (sabah) is
    // 07:00 → 1h lag. bagimsiz (bianet) is 08:00 → 2h lag.
    const iktidar = report!.timeline.zones.find((z) => z.zone === "iktidar")!;
    expect(iktidar.firstPublishedAt).toBe("2026-04-17T07:00:00Z");
    expect(iktidar.lagMs).toBe(60 * 60 * 1000);

    const bagimsiz = report!.timeline.zones.find((z) => z.zone === "bagimsiz")!;
    expect(bagimsiz.lagMs).toBe(2 * 60 * 60 * 1000);

    expect(report!.timeline.clusterFirstPublished).toBe("2026-04-17T06:00:00Z");
  });

  it("reports ownership's taggedShare unrounded", async () => {
    setHappyPathFixtures();
    const report = await buildYelpazeReport("cluster-1");

    // 4 covering sources: sabah/hurriyet/bianet tagged, the 4th untagged.
    expect(report!.ownership.totalSourceCount).toBe(4);
    expect(report!.ownership.taggedSourceCount).toBe(3);
    expect(report!.ownership.taggedShare).toBe(3 / 4);
  });
});

describe("buildYelpazeReport — coverage denominator is the yield axis, not fetchOk (pack A merge)", () => {
  it("the denominator equals the zone's `delivering` count even when fetchOk disagrees", async () => {
    setSupabaseFixtures({
      tables: {
        clusters: [mkClusterRow()],
        cluster_articles: [
          mkEmbeddedMember(
            "a1",
            mkEmbeddedSource("s1", "stale-but-delivering", "opposition"),
            "2026-04-17T07:00:00Z",
          ),
        ],
        sources: [
          // fetchOk=false (stale status) but delivering=true — must still
          // count toward the yield denominator: zoneYieldDenominator()
          // reads `delivering` only, never `fetchOk` / the AND'd `healthy`.
          mkFeedHealthRow("stale-but-delivering", "opposition", true, {
            fetch_last_status: 500,
            fetch_last_at: new Date(0).toISOString(),
          }),
          // fetchOk=true (fresh 200) but delivering=false — must NOT count
          // toward the yield denominator despite answering fine.
          mkFeedHealthRow("fresh-but-silent", "opposition", false, {
            fetch_last_status: 200,
            fetch_last_at: healthyAt(),
          }),
        ],
      },
    });

    const report = await buildYelpazeReport("cluster-1");
    expect(report).not.toBeNull();

    const muhalefet = report!.coverage.rows.find((r) => r.zone === "muhalefet")!;
    // Only "stale-but-delivering" delivered — a fetchOk-based denominator
    // would read 0 here (both rows disagree with fetchOk), and a
    // count-every-source denominator would read 2; the yield-only
    // denominator must read exactly 1.
    expect(muhalefet.denominator).toBe(1);
    expect(report!.coverage.denominatorBasis).toBe("yield");
  });
});

describe("buildYelpazeReport — ownership trustee flags (pack G3)", () => {
  it("lists a trusteed source (slug + date) through the full buildYelpazeReport pipeline", async () => {
    // pack G3: cluster-detail-query.ts now selects and threads
    // trustee_since / trustee_note through to ClusterDetailMember.source,
    // so a trusteed source reaches buildOwnershipSection via the real
    // getClusterDetail() → buildYelpazeReport() pipeline — no more
    // hand-built member array / direct buildOwnershipSection workaround.
    setSupabaseFixtures({
      tables: {
        clusters: [mkClusterRow()],
        cluster_articles: [
          mkEmbeddedMember(
            "a1",
            mkEmbeddedSource("s-trustee", "kayyumlu-gazete", "pro_government", {
              trustee_since: "2025-09-11",
              trustee_note: "TMSF kayyum atandı (Can Holding), 11.09.2025",
            }),
            "2026-04-17T07:00:00Z",
          ),
          // A non-trusteed member in the same cluster must not leak a
          // null/blank entry into the trusteed list.
          mkEmbeddedMember(
            "a2",
            mkEmbeddedSource("s-plain", "sade-gazete", "center"),
            "2026-04-17T07:30:00Z",
          ),
        ],
        sources: [],
      },
    });

    const report = await buildYelpazeReport("cluster-1");
    expect(report).not.toBeNull();

    expect(report!.ownership.trusteedSources).toEqual([
      { slug: "kayyumlu-gazete", name: "Kaynak kayyumlu-gazete", since: "2025-09-11" },
    ]);
  });

  it("returns an empty trusteedSources list when no member is trusteed", () => {
    const members = [
      {
        source: {
          ...mkEmbeddedSource("s-plain", "sade-gazete", "center"),
          trustee_since: null,
          trustee_note: null,
        },
        article: {
          id: "a1",
          title: "Haber a1",
          url: "https://example.com/a1",
          published_at: "2026-04-17T07:00:00Z",
          image_url: null,
          content_hash: "hash-a1",
        },
      },
    ] as unknown as ClusterDetailMember[];

    const ownership = buildOwnershipSection(members);

    expect(ownership.trusteedSources).toEqual([]);
  });
});

describe("buildYelpazeReport — feed health unknown", () => {
  it("never computes a share over the nominal denominator when health is unknown", async () => {
    setSupabaseFixtures({
      tables: {
        clusters: [mkClusterRow()],
        cluster_articles: [
          mkEmbeddedMember(
            "a1",
            mkEmbeddedSource("s1", "sabah", "pro_government"),
            "2026-04-17T07:00:00Z",
          ),
        ],
        // A Supabase error on `sources` makes getZoneFeedHealth() (and
        // cluster-detail-query's own supplemental sources query) fail open
        // to "unknown" — the exact path a founder could hit on a real
        // Supabase blip.
        sources: () => ({ data: null, error: { message: "sources boom" } }),
      },
    });

    const report = await buildYelpazeReport("cluster-1");
    expect(report).not.toBeNull();

    for (const row of report!.coverage.rows) {
      expect(row.denominatorKnown).toBe(false);
      expect(row.denominator).toBeNull();
      // The single most important assertion in this pack: no share may be
      // silently computed over a nominal total (e.g. 118) when the real
      // denominator is unknown.
      expect(row.share).toBeNull();
    }
    expect(report!.coverage.denominatorBasis).toBeNull();
  });
});

describe("buildYelpazeReport — coverage numerator/denominator population mismatch (D-SHARE-OVER-100)", () => {
  it("never emits a share when covering outlets exceed the currently-healthy feed count", async () => {
    // 5 distinct outlets covered the cluster (numerator), but only 3 of
    // the zone's sources are currently healthy (denominator) — an outlet
    // that covered the story and then broke stays in the numerator.
    setSupabaseFixtures({
      tables: {
        clusters: [mkClusterRow()],
        cluster_articles: [
          mkEmbeddedMember("a1", mkEmbeddedSource("s1", "muh-1", "opposition"), "2026-04-17T07:00:00Z"),
          mkEmbeddedMember("a2", mkEmbeddedSource("s2", "muh-2", "opposition"), "2026-04-17T07:05:00Z"),
          mkEmbeddedMember("a3", mkEmbeddedSource("s3", "muh-3", "opposition"), "2026-04-17T07:10:00Z"),
          mkEmbeddedMember("a4", mkEmbeddedSource("s4", "muh-4", "opposition"), "2026-04-17T07:15:00Z"),
          mkEmbeddedMember("a5", mkEmbeddedSource("s5", "muh-5", "opposition"), "2026-04-17T07:20:00Z"),
        ],
        sources: [
          mkFeedHealthRow("muh-1", "opposition", true),
          mkFeedHealthRow("muh-2", "opposition", true),
          mkFeedHealthRow("muh-3", "opposition", true),
          mkFeedHealthRow("muh-4", "opposition", false),
          mkFeedHealthRow("muh-5", "opposition", false),
        ],
      },
    });

    const report = await buildYelpazeReport("cluster-1");
    expect(report).not.toBeNull();

    const muhalefet = report!.coverage.rows.find((r) => r.zone === "muhalefet")!;
    expect(muhalefet.outlets).toBe(5);
    expect(muhalefet.denominator).toBe(3);
    expect(muhalefet.denominatorBelowOutlets).toBe(true);
    expect(muhalefet.share).toBeNull();
  });
});

describe("buildYelpazeReport — blindspot suppression", () => {
  it("surfaces blindspotSuppressed into the blindspot section with the withdrawn claim's caveat", async () => {
    setSupabaseFixtures({
      tables: {
        clusters: [
          mkClusterRow({
            is_blindspot: true,
            blindspot_side: "pro_government",
            bias_distribution: { pro_government: 5 },
          }),
        ],
        cluster_articles: [],
        sources: [
          // iktidar (dominant, covering side): healthy.
          mkFeedHealthRow("iktidar-1", "pro_government", true),
          // muhalefet (the silent pole): entirely unhealthy → degraded →
          // shouldSuppressBlindspot(iktidar, health) must return true, via
          // the REAL feed-health.ts running against this fixture.
          mkFeedHealthRow("muhalefet-1", "opposition", false),
          mkFeedHealthRow("muhalefet-2", "opposition", false),
        ],
      },
    });

    const report = await buildYelpazeReport("cluster-1");
    expect(report).not.toBeNull();

    expect(report!.blindspot.blindspotSuppressed).toBe(true);
    expect(report!.blindspot.isBlindspot).toBe(false);
    expect(report!.blindspot.dominantZone).toBe("iktidar");
    expect(report!.blindspot.silentZone).toBe("muhalefet");
    expect(report!.blindspot.healthStatus).toBe("suppressed");
    // The caveat names the silent zone and its stats — never a bare
    // "suppressed" flag with no explanation.
    expect(report!.blindspot.caveat).toContain("muhalefet");
    expect(report!.blindspot.caveat).toContain("0/2");
  });

  it("reports no blindspot claim at all when the cluster was never flagged", async () => {
    setSupabaseFixtures({
      tables: {
        clusters: [mkClusterRow({ is_blindspot: false, blindspot_side: null })],
        cluster_articles: [],
        sources: [],
      },
    });

    const report = await buildYelpazeReport("cluster-1");
    expect(report!.blindspot.healthStatus).toBe("none");
    expect(report!.blindspot.blindspotSuppressed).toBe(false);
    expect(report!.blindspot.caveat).toBe("");
  });
});

describe("buildYelpazeReport — KVKK guard (D-KVKK-SUMMARY)", () => {
  it("never serializes the cluster's raw summary_tr, or a member's description/image_url, onto the report handed to the client component", async () => {
    setSupabaseFixtures({
      tables: {
        clusters: [
          mkClusterRow({
            summary_tr: "GİZLİ-ÖZET-METNİ-KAÇAK",
          }),
        ],
        cluster_articles: [
          mkEmbeddedMember(
            "a1",
            mkEmbeddedSource("s1", "sabah", "pro_government"),
            "2026-04-17T07:00:00Z",
            {
              description: "GİZLİ-ALINTI-METNİ-KAÇAK",
              image_url: "https://cdn.example/gizli-foto-kacak.jpg",
            },
          ),
        ],
        sources: [mkFeedHealthRow("sabah", "pro_government", true)],
      },
    });

    const report = await buildYelpazeReport("cluster-1");
    expect(report).not.toBeNull();

    // ReportHeader must not carry `summary` (or any of the other unused
    // fields) at all — this is what makes the leak structurally
    // impossible, not just untested.
    expect(report!.header).not.toHaveProperty("summary");
    expect(report!.header).not.toHaveProperty("firstPublished");
    expect(report!.header).not.toHaveProperty("updatedAt");
    expect(report!.header).not.toHaveProperty("articleCount");
    expect(report!.header).not.toHaveProperty("isArchived");

    // Defense in depth: even if a field leaked back in, the serialized
    // payload (what actually reaches the RSC flight / client props) must
    // never contain the raw article/cluster text.
    const json = JSON.stringify(report);
    expect(json).not.toContain("GİZLİ-ÖZET-METNİ-KAÇAK");
    expect(json).not.toContain("GİZLİ-ALINTI-METNİ-KAÇAK");
    expect(json).not.toContain("gizli-foto-kacak.jpg");
  });
});
