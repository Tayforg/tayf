import { describe, it, expect } from "vitest";

import { selectStoryCard } from "./story-card";
import type { ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";
import type { ZoneFeedHealth, ZoneHealth } from "@/lib/clusters/feed-health";
import type { MediaDnaZone, Source } from "@/types";

// Mirrors the fixture shape cluster-page.test.tsx / cluster-detail-query.test.ts
// already use — trustee_since/trustee_note are required (not optional) on
// `Source` (migration 055), so every literal below sets both to null.
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

// NB: fixture titles must clear `isGameEligibleTitle` (src/lib/game/
// pii-filter.ts). That filter also tests a diacritic-folded copy of its
// patterns, where /adlı/ becomes /adli/ — which matches the English word
// "headline". Turkish fixture headlines below, deliberately.
function mkMember(
  id: string,
  source: Source,
  title: string,
  publishedAt: string,
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

describe("selectStoryCard", () => {
  it("returns null for an empty cluster (no members)", () => {
    expect(selectStoryCard([], null)).toBeNull();
  });

  it("picks one headline per zone, preferring the earliest publication in that zone", () => {
    const members: ClusterDetailMember[] = [
      mkMember(
        "a1",
        mkSource({ id: "gov1", name: "Gov Outlet 1", bias: "pro_government" }),
        "Bütçe teklifi mecliste kabul edildi",
        "2026-09-10T12:00:00Z",
      ),
      mkMember(
        "a2",
        mkSource({ id: "gov2", name: "Gov Outlet 2", bias: "pro_government" }),
        "Meclis bütçe teklifini görüştü",
        "2026-09-10T08:00:00Z",
      ),
      mkMember(
        "a3",
        mkSource({ id: "opp1", name: "Opp Outlet", bias: "opposition" }),
        "Muhalefet bütçeye itiraz etti",
        "2026-09-10T09:00:00Z",
      ),
    ];

    const card = selectStoryCard(members, null);

    expect(card).not.toBeNull();
    expect(card!.headlines.iktidar).toEqual({
      zone: "iktidar",
      outletName: "Gov Outlet 2",
      title: "Meclis bütçe teklifini görüştü",
    });
    expect(card!.headlines.muhalefet).toEqual({
      zone: "muhalefet",
      outletName: "Opp Outlet",
      title: "Muhalefet bütçeye itiraz etti",
    });
    // No bagimsiz coverage at all in this fixture.
    expect(card!.headlines.bagimsiz).toBeNull();
    expect(card!.coverage.bagimsiz.count).toBe(0);
    expect(card!.coverage.iktidar.count).toBe(2);
    expect(card!.coverage.muhalefet.count).toBe(1);
  });

  it("skips a PII-filtered title and falls through to the next-earliest eligible one", () => {
    const members: ClusterDetailMember[] = [
      mkMember(
        "a1",
        mkSource({ id: "c1", name: "Center 1", bias: "center" }),
        "17 yaşındaki çocuk kayboldu",
        "2026-09-10T08:00:00Z",
      ),
      mkMember(
        "a2",
        mkSource({ id: "c2", name: "Center 2", bias: "center" }),
        "Meclis yeni yasayı görüştü",
        "2026-09-10T09:00:00Z",
      ),
    ];

    const card = selectStoryCard(members, null);

    expect(card!.headlines.bagimsiz).toEqual({
      zone: "bagimsiz",
      outletName: "Center 2",
      title: "Meclis yeni yasayı görüştü",
    });
    // The PII-excluded article is still real coverage for the count/bar.
    expect(card!.coverage.bagimsiz.count).toBe(2);
  });

  it("returns a null headline (not a crash) when every title in a zone is PII-filtered", () => {
    const members: ClusterDetailMember[] = [
      mkMember(
        "a1",
        mkSource({ id: "c1", name: "Center 1", bias: "center" }),
        "17 yaşındaki çocuk kayboldu",
        "2026-09-10T08:00:00Z",
      ),
    ];

    const card = selectStoryCard(members, null);

    expect(card!.headlines.bagimsiz).toBeNull();
    expect(card!.coverage.bagimsiz.count).toBe(1);
  });

  it("computes the per-zone denominator from zoneYieldDenominator against the supplied health", () => {
    const members: ClusterDetailMember[] = [
      mkMember(
        "a1",
        mkSource({ id: "gov1", bias: "pro_government" }),
        "Bütçe teklifi mecliste kabul edildi",
        "2026-09-10T08:00:00Z",
      ),
      mkMember(
        "a2",
        mkSource({ id: "opp1", bias: "opposition" }),
        "Muhalefet bütçeye itiraz etti",
        "2026-09-10T08:00:00Z",
      ),
    ];
    const health = mkHealth({
      iktidar: { delivering: 5 },
      muhalefet: { delivering: 3 },
    });

    const card = selectStoryCard(members, health);

    expect(card!.coverage.iktidar.denominator).toBe(5);
    expect(card!.coverage.iktidar.denominatorUnknown).toBe(false);
    expect(card!.coverage.muhalefet.denominator).toBe(3);
    expect(card!.coverage.bagimsiz.denominator).toBe(8); // mkZoneHealth default
  });

  it("flags every zone's denominator unknown when health is null", () => {
    const members: ClusterDetailMember[] = [
      mkMember(
        "a1",
        mkSource({ id: "gov1", bias: "pro_government" }),
        "Bütçe teklifi mecliste kabul edildi",
        "2026-09-10T08:00:00Z",
      ),
    ];

    const card = selectStoryCard(members, null);

    for (const zone of ["iktidar", "bagimsiz", "muhalefet"] as const) {
      expect(card!.coverage[zone].denominator).toBeNull();
      expect(card!.coverage[zone].denominatorUnknown).toBe(true);
      // Fail-open: unknown health must never read as "degraded".
      expect(card!.coverage[zone].degraded).toBe(false);
    }
  });

  it("surfaces the degraded flag per zone from the supplied health", () => {
    const members: ClusterDetailMember[] = [
      mkMember(
        "a1",
        mkSource({ id: "opp1", bias: "opposition" }),
        "Muhalefet bütçeye itiraz etti",
        "2026-09-10T08:00:00Z",
      ),
    ];
    const health = mkHealth({ muhalefet: { degraded: true } });

    const card = selectStoryCard(members, health);

    expect(card!.coverage.muhalefet.degraded).toBe(true);
    expect(card!.coverage.iktidar.degraded).toBe(false);
  });
});
