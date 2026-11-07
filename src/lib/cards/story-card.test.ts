import { describe, it, expect } from "vitest";

import {
  hasStoryCardCoverage,
  isStoryCardTitleEligible,
  selectStoryCard,
  storyCardHref,
} from "./story-card";
import { zoneOf } from "@/lib/bias/config";
import type { ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";
import type { ZoneFeedHealth, ZoneHealth } from "@/lib/clusters/feed-health";
import { partitionByVote } from "@/lib/sources/kind";
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
    // delivering (all kinds) deliberately differs from votingDelivering so a
    // test that reads the wrong one cannot pass by coincidence.
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

describe("selectStoryCard", () => {
  it("returns null for an empty cluster (no members)", () => {
    expect(selectStoryCard([], null)).toBeNull();
  });

  it("returns null when every member is non-voting", () => {
    // covered again in detail below; kept here to mirror the spec's
    // "all-non-voting members make selectStoryCard return null" wording.
    const members: ClusterDetailMember[] = [
      mkMember(
        "n1",
        mkSource({ id: "niche1", bias: "center", kind: "niche" }),
        "Niş kaynak başlığı",
        "2026-09-10T08:00:00Z",
      ),
    ];
    expect(selectStoryCard(members, null)).toBeNull();
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

  it("computes the per-zone denominator from zoneVotingYieldDenominator against the supplied health", () => {
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
      iktidar: { votingDelivering: 5 },
      muhalefet: { votingDelivering: 3 },
    });

    const card = selectStoryCard(members, health);

    expect(card!.coverage.iktidar.denominator).toBe(5);
    expect(card!.coverage.iktidar.denominatorUnknown).toBe(false);
    expect(card!.coverage.muhalefet.denominator).toBe(3);
    expect(card!.coverage.bagimsiz.denominator).toBe(8); // mkZoneHealth default
  });

  // h53-consistency-2: the numerator counts VOTING members only, so the
  // denominator must be the VOTING delivering count too. Before the fix the
  // card printed "2 / 37" for Bağımsız where the voting basis was 24.
  it("h53-consistency-2: the denominator is votingDelivering, never the all-kinds delivering count", () => {
    const members: ClusterDetailMember[] = [
      mkMember("a1", mkSource({ id: "c1", bias: "center" }), "Bütçe teklifi mecliste kabul edildi", "2026-09-10T08:00:00Z"),
      mkMember("a2", mkSource({ id: "c2", bias: "international" }), "Bütçe görüşmelerinde uzlaşma arayışı", "2026-09-10T09:00:00Z"),
      mkMember("a3", mkSource({ id: "n1", bias: "center", kind: "niche" }), "Niş kaynak başlığı", "2026-09-10T10:00:00Z"),
    ];
    const health = mkHealth({});
    health.bagimsiz = { ...health.bagimsiz, delivering: 37, votingDelivering: 24 };

    const card = selectStoryCard(members, health);

    expect(card!.coverage.bagimsiz.count).toBe(2);
    expect(card!.coverage.bagimsiz.denominator).toBe(24);
    expect(card!.coverage.bagimsiz.denominator).toBe(health.bagimsiz.votingDelivering);
    expect(card!.coverage.bagimsiz.denominator).not.toBe(health.bagimsiz.delivering);
    // The niche member stays out of the count and is reported separately.
    expect(card!.nonVotingCount).toBe(1);
  });

  it("every zone's denominator equals that zone's votingDelivering", () => {
    const members: ClusterDetailMember[] = [
      mkMember("a1", mkSource({ id: "gov1", bias: "pro_government" }), "Bütçe teklifi mecliste kabul edildi", "2026-09-10T08:00:00Z"),
    ];
    const health = mkHealth({
      iktidar: { delivering: 31, votingDelivering: 28 },
      bagimsiz: { delivering: 37, votingDelivering: 24 },
      muhalefet: { delivering: 19, votingDelivering: 18 },
    });

    const card = selectStoryCard(members, health);

    expect(
      (["iktidar", "bagimsiz", "muhalefet"] as const).map((z) => card!.coverage[z].denominator),
    ).toEqual([28, 24, 18]);
  });

  it("a zone with no delivering voting source has denominator 0 (a real zero), not null", () => {
    const members: ClusterDetailMember[] = [
      mkMember("a1", mkSource({ id: "gov1", bias: "pro_government" }), "Bütçe teklifi mecliste kabul edildi", "2026-09-10T08:00:00Z"),
    ];
    const health = mkHealth({ muhalefet: { delivering: 2, votingDelivering: 0 } });

    const card = selectStoryCard(members, health);

    expect(card!.coverage.muhalefet.denominator).toBe(0);
    expect(card!.coverage.muhalefet.denominatorUnknown).toBe(false);
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

  // KART-VOTE: mirrors cluster 6ea8b39a — 8 members total: one 'niche'
  // (bias 'center', would-be bagimsiz), plus 1 iktidar, 2 bagimsiz and 4
  // muhalefet VOTING members. The niche member must never reach coverage
  // or a headline; only the voting partition counts.
  it("counts only voting-kind members toward zone coverage (cluster 6ea8b39a shape)", () => {
    const members: ClusterDetailMember[] = [
      mkMember(
        "n1",
        mkSource({ id: "niche1", name: "Niche Co", bias: "center", kind: "niche" }),
        "Niş kaynak başlığı",
        "2026-09-10T07:00:00Z",
      ),
      mkMember(
        "g1",
        mkSource({ id: "gov1", bias: "pro_government" }),
        "İktidar haberi bir",
        "2026-09-10T08:00:00Z",
      ),
      mkMember(
        "b1",
        mkSource({ id: "b1", bias: "center" }),
        "Bağımsız haberi bir",
        "2026-09-10T08:00:00Z",
      ),
      mkMember(
        "b2",
        mkSource({ id: "b2", bias: "international" }),
        "Bağımsız haberi iki",
        "2026-09-10T09:00:00Z",
      ),
      mkMember(
        "m1",
        mkSource({ id: "m1", bias: "opposition" }),
        "Muhalefet haberi bir",
        "2026-09-10T08:00:00Z",
      ),
      mkMember(
        "m2",
        mkSource({ id: "m2", bias: "opposition" }),
        "Muhalefet haberi iki",
        "2026-09-10T09:00:00Z",
      ),
      mkMember(
        "m3",
        mkSource({ id: "m3", bias: "opposition_leaning" }),
        "Muhalefet haberi üç",
        "2026-09-10T10:00:00Z",
      ),
      mkMember(
        "m4",
        mkSource({ id: "m4", bias: "opposition_leaning" }),
        "Muhalefet haberi dört",
        "2026-09-10T11:00:00Z",
      ),
    ];

    const card = selectStoryCard(members, null);

    expect(card).not.toBeNull();
    expect(card!.coverage.iktidar.count).toBe(1);
    expect(card!.coverage.bagimsiz.count).toBe(2);
    expect(card!.coverage.muhalefet.count).toBe(4);
    expect(card!.nonVotingCount).toBe(1);
    // The niche member's title never becomes a zone headline.
    for (const zone of ["iktidar", "bagimsiz", "muhalefet"] as const) {
      expect(card!.headlines[zone]?.title).not.toBe("Niş kaynak başlığı");
    }
  });

  it("returns null when every member is non-voting (aggregator/niche only)", () => {
    const members: ClusterDetailMember[] = [
      mkMember(
        "n1",
        mkSource({ id: "niche1", bias: "center", kind: "niche" }),
        "Niş kaynak başlığı",
        "2026-09-10T08:00:00Z",
      ),
      mkMember(
        "n2",
        mkSource({ id: "agg1", bias: "opposition", kind: "aggregator" }),
        "Toplayıcı başlığı",
        "2026-09-10T09:00:00Z",
      ),
    ];

    expect(selectStoryCard(members, null)).toBeNull();
  });

  it("a 'kind'-less member still votes (isVotingKind's default)", () => {
    const members: ClusterDetailMember[] = [
      mkMember(
        "a1",
        mkSource({ id: "gov1", bias: "pro_government", kind: undefined }),
        "Bütçe teklifi mecliste kabul edildi",
        "2026-09-10T08:00:00Z",
      ),
    ];

    const card = selectStoryCard(members, null);

    expect(card).not.toBeNull();
    expect(card!.coverage.iktidar.count).toBe(1);
    expect(card!.nonVotingCount).toBe(0);
  });

  // Parity: for a fixture with a post-034 voting-only bias_distribution,
  // the sum of coverage[zone].count per zone equals the unique voting
  // sources per zone (i.e. selectStoryCard's per-zone member count is a
  // straight count of voting members, matching a bias_distribution built
  // from the same voting partition).
  it("keeps coverage counts in parity with a voting-only partition", () => {
    const members: ClusterDetailMember[] = [
      mkMember("a1", mkSource({ id: "gov1", bias: "pro_government" }), "Haber bir", "2026-09-10T08:00:00Z"),
      mkMember("a2", mkSource({ id: "gov2", bias: "pro_government" }), "Haber iki", "2026-09-10T09:00:00Z"),
      mkMember("a3", mkSource({ id: "opp1", bias: "opposition" }), "Haber üç", "2026-09-10T08:00:00Z"),
      mkMember(
        "a4",
        mkSource({ id: "niche1", bias: "opposition", kind: "niche" }),
        "Haber dört",
        "2026-09-10T08:00:00Z",
      ),
    ];

    const card = selectStoryCard(members, null);
    const { voting } = partitionByVote(members);

    const zoneCounts: Record<MediaDnaZone, number> = {
      iktidar: 0,
      bagimsiz: 0,
      muhalefet: 0,
    };
    for (const member of voting) {
      zoneCounts[zoneOf(member.source.bias)] += 1;
    }

    for (const zone of ["iktidar", "bagimsiz", "muhalefet"] as const) {
      expect(card!.coverage[zone].count).toBe(zoneCounts[zone]);
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

// h57-outbound-1: the card printed "Bağımsız — bu tarafta haber yok" over a
// story an aggregator (son-dakika, Bağımsız) also carried, and "Muhalefet — bu
// tarafta haber yok" next to its own footer naming a niche Muhalefet source.
// Each zone now carries the number of distinct non-voting sources whose own zone
// it is, so the route can word the silence for what it is.
describe("selectStoryCard per-zone nonVotingCount (h57-outbound-1)", () => {
  const T = "2026-09-10T08:00:00Z";
  const nineVoting = (): ClusterDetailMember[] =>
    Array.from({ length: 9 }, (_, i) =>
      mkMember(
        `v${i}`,
        mkSource({ id: `gov${i}`, name: `Gov ${i}`, bias: i < 5 ? "pro_government" : "gov_leaning" }),
        `Bütçe haberi ${i}`,
        `2026-09-10T0${i}:30:00Z`,
      ),
    );
  // Shaped like cluster 0b127dc3: son-dakika (aggregator, center), isci-haber
  // (niche, opposition) and haberler-com (aggregator, gov_leaning).
  const SON_DAKIKA = mkSource({ id: "son-dakika", bias: "center", kind: "aggregator" });
  const ISCI_HABER = mkSource({ id: "isci-haber", bias: "opposition", kind: "niche" });
  const HABERLER_COM = mkSource({ id: "haberler-com", bias: "gov_leaning", kind: "aggregator" });
  const fixture = (): ClusterDetailMember[] => [
    ...nineVoting(),
    mkMember("n1", SON_DAKIKA, "Son dakika haberi", T),
    mkMember("n2", ISCI_HABER, "İşçi haber başlığı", T),
    mkMember("n3", HABERLER_COM, "Haberler toplayıcı başlığı", T),
  ];

  it("counts bagimsiz 1, muhalefet 1, iktidar 1 for the 0b127dc3-shaped fixture", () => {
    const card = selectStoryCard(fixture(), null)!;
    expect(card.coverage.bagimsiz.nonVotingCount).toBe(1);
    expect(card.coverage.muhalefet.nonVotingCount).toBe(1);
    expect(card.coverage.iktidar.nonVotingCount).toBe(1);
  });

  it("leaves the voting counts, the headlines and the top-level nonVotingCount as they were", () => {
    const card = selectStoryCard(fixture(), null)!;
    expect(card.coverage.iktidar.count).toBe(9);
    expect(card.coverage.bagimsiz.count).toBe(0);
    expect(card.coverage.muhalefet.count).toBe(0);
    expect(card.nonVotingCount).toBe(3);
    expect(card.headlines.bagimsiz).toBeNull();
    expect(card.headlines.muhalefet).toBeNull();
    // A non-voting title never becomes a zone headline.
    for (const zone of ["iktidar", "bagimsiz", "muhalefet"] as const) {
      expect(card.headlines[zone]?.title ?? "").not.toMatch(/Son dakika|İşçi|toplayıcı/);
    }
  });

  it("counts a non-voting source once per slug however many articles it wrote", () => {
    const members = [
      ...nineVoting(),
      mkMember("n1", ISCI_HABER, "İşçi haber bir", T),
      mkMember("n2", ISCI_HABER, "İşçi haber iki", "2026-09-10T09:00:00Z"),
      mkMember("n3", mkSource({ id: "isci-haber", bias: "opposition", kind: "niche" }), "İşçi haber üç", T),
    ];
    const card = selectStoryCard(members, null)!;
    expect(card.coverage.muhalefet.nonVotingCount).toBe(1);
    expect(card.nonVotingCount).toBe(1);
  });

  it("is 0 in every zone when no member is non-voting", () => {
    const card = selectStoryCard(nineVoting(), null)!;
    for (const zone of ["iktidar", "bagimsiz", "muhalefet"] as const) {
      expect(card.coverage[zone].nonVotingCount).toBe(0);
    }
  });

  it("maps every one of the ten bias keys through the zone table (international and pro_kurdish are Bağımsız)", () => {
    const zoneOfKey: Record<string, MediaDnaZone> = {
      pro_government: "iktidar",
      gov_leaning: "iktidar",
      state_media: "iktidar",
      islamist_conservative: "iktidar",
      nationalist: "iktidar",
      center: "bagimsiz",
      international: "bagimsiz",
      pro_kurdish: "bagimsiz",
      opposition_leaning: "muhalefet",
      opposition: "muhalefet",
    };
    for (const [bias, zone] of Object.entries(zoneOfKey)) {
      const members = [
        ...nineVoting(),
        mkMember("n1", mkSource({ id: `niche-${bias}`, bias: bias as never, kind: "niche" }), "Niş başlık", T),
      ];
      const card = selectStoryCard(members, null)!;
      for (const z of ["iktidar", "bagimsiz", "muhalefet"] as const) {
        expect(card.coverage[z].nonVotingCount, `${bias} in ${z}`).toBe(z === zone ? 1 : 0);
      }
    }
  });

  it("counts both non-voting kinds (aggregator and niche) in the same zone", () => {
    const members = [
      ...nineVoting(),
      mkMember("n1", mkSource({ id: "agg", bias: "opposition", kind: "aggregator" }), "Toplayıcı başlığı", T),
      mkMember("n2", mkSource({ id: "nic", bias: "opposition_leaning", kind: "niche" }), "Niş başlığı", T),
    ];
    expect(selectStoryCard(members, null)!.coverage.muhalefet.nonVotingCount).toBe(2);
  });

  it("never counts a voting member, a kind-less member included", () => {
    const members = [
      mkMember("a1", mkSource({ id: "gov1", bias: "pro_government" }), "Haber bir", T),
      mkMember("a2", mkSource({ id: "opp1", bias: "opposition", kind: "outlet" }), "Haber iki", T),
      mkMember("a3", mkSource({ id: "wire1", bias: "center", kind: "wire" }), "Haber üç", T),
    ];
    const card = selectStoryCard(members, null)!;
    for (const zone of ["iktidar", "bagimsiz", "muhalefet"] as const) {
      expect(card.coverage[zone].nonVotingCount).toBe(0);
    }
    expect(card.nonVotingCount).toBe(0);
  });

  it("the per-zone counts add up to the top-level distinct count when every non-voting slug is distinct", () => {
    const card = selectStoryCard(fixture(), null)!;
    const sum = (["iktidar", "bagimsiz", "muhalefet"] as const).reduce(
      (acc, zone) => acc + card.coverage[zone].nonVotingCount,
      0,
    );
    expect(sum).toBe(card.nonVotingCount);
  });
});

// h57-outbound-2: the card took the earliest eligible member per zone, so a
// Hürriyet columnist's piece (/yazarlar/...) became the İktidar headline over
// Takvim and A Haber news (442e0395). #217's column rule (isOpinionUrl) now
// applies here: a zone with news prints news; a column is the headline only when
// the zone has nothing else eligible, and is then marked.
describe("selectStoryCard opinion columns (h57-outbound-2)", () => {
  const withUrl = (m: ClusterDetailMember, url: string | undefined): ClusterDetailMember => ({
    ...m,
    article: { ...m.article, url: url as string },
  });
  const HURRIYET = mkSource({ id: "hurriyet", name: "Hürriyet", bias: "pro_government" });
  const TAKVIM = mkSource({ id: "takvim", name: "Takvim", bias: "pro_government" });
  const A_HABER = mkSource({ id: "ahaber", name: "A Haber", bias: "pro_government" });
  const YENI_AKIT = mkSource({ id: "yeni-akit", name: "Yeni Akit", bias: "islamist_conservative" });
  const SOZCU = mkSource({ id: "sozcu", name: "Sözcü", bias: "opposition" });

  // Shaped like cluster 442e0395-00d9-4164-9b5b-457b5e67b035 (2026-11-07).
  const HURRIYET_TITLE =
    "Emir Sarıgül’den Özgür Özel’i yalanlayan etkin pişmanlık ifadesi: 100 bin dolar rüşvet verilen kutu içindeki …";
  const TAKVIM_TITLE = "Emir Sarıgül 3'üncü kez ifade verdi! …";
  const hurriyetColumn = () =>
    withUrl(
      mkMember("h1", HURRIYET, HURRIYET_TITLE, "2026-11-07T03:04:00Z"),
      "https://www.hurriyet.com.tr/yazarlar/nedim-sener/emir-sarigul-ozgur-ozeli-yalanlayan-etkin-pismanlik-ifadesi-43000001",
    );
  const takvimNews = () =>
    withUrl(
      mkMember("t1", TAKVIM, TAKVIM_TITLE, "2026-11-07T04:00:00Z"),
      "https://www.takvim.com.tr/guncel/2026/11/07/emir-sarigul-3uncu-kez-ifade-verdi",
    );
  const aHaberNews = () =>
    withUrl(
      mkMember("a1", A_HABER, "Sarıgül hakkında yeni gelişme", "2026-11-07T04:46:00Z"),
      "https://www.ahaber.com.tr/gundem/2026/11/07/sarigul-hakkinda-yeni-gelisme",
    );

  it("(1) 442e0395: the İktidar headline is Takvim's news, not Hürriyet's earlier column; count stays 3", () => {
    const card = selectStoryCard([hurriyetColumn(), takvimNews(), aHaberNews()], null)!;
    expect(card.headlines.iktidar).toEqual({
      zone: "iktidar",
      outletName: "Takvim",
      title: TAKVIM_TITLE,
    });
    expect(card.headlines.iktidar).not.toHaveProperty("opinion");
    expect(card.coverage.iktidar.count).toBe(3);
  });

  it("(2) ab8cf589: Yeni Akit /haber/ is picked over the earlier Hürriyet /yazarlar/ column", () => {
    const column = withUrl(
      mkMember("h2", HURRIYET, "Selvi'den yeni yazı: bütçe ve siyaset", "2026-11-07T03:03:00Z"),
      "https://www.hurriyet.com.tr/yazarlar/abdulkadir-selvi/butce-ve-siyaset-43000002",
    );
    const news = withUrl(
      mkMember("y1", YENI_AKIT, "Bütçe teklifi mecliste kabul edildi", "2026-11-07T07:40:00Z"),
      "https://www.yeniakit.com.tr/haber/butce-teklifi-mecliste-kabul-edildi-1",
    );
    const card = selectStoryCard([column, news], null)!;
    expect(card.headlines.iktidar?.outletName).toBe("Yeni Akit");
    expect(card.headlines.iktidar?.title).toBe("Bütçe teklifi mecliste kabul edildi");
    expect(card.headlines.iktidar).not.toHaveProperty("opinion");
    expect(card.coverage.iktidar.count).toBe(2);
  });

  it("(3) a zone whose only member is a column gives that headline with opinion: true", () => {
    const card = selectStoryCard([hurriyetColumn(), withUrl(mkMember("o1", SOZCU, "Muhalefet bütçeye itiraz etti", "2026-11-07T05:00:00Z"), "https://www.sozcu.com.tr/2026/gundem/butce-p1")], null)!;
    expect(card.headlines.iktidar).toEqual({
      zone: "iktidar",
      outletName: "Hürriyet",
      title: HURRIYET_TITLE,
      opinion: true,
    });
    expect(card.coverage.iktidar.count).toBe(1);
    // The news zone is untouched and carries no marker.
    expect(card.headlines.muhalefet).not.toHaveProperty("opinion");
  });

  it("(4) a member without a url is treated as news, like isOpinionUrl(undefined) === false", () => {
    const noUrl = withUrl(mkMember("n1", TAKVIM, TAKVIM_TITLE, "2026-11-07T03:00:00Z"), undefined);
    const card = selectStoryCard([noUrl, hurriyetColumn()], null)!;
    // The url-less member is the earlier news member and wins; no marker.
    expect(card.headlines.iktidar).toEqual({ zone: "iktidar", outletName: "Takvim", title: TAKVIM_TITLE });
    const onlyNoUrl = selectStoryCard([noUrl], null)!;
    expect(onlyNoUrl.headlines.iktidar).not.toHaveProperty("opinion");
    for (const url of [null, "", "not a url", "/yazarlar/x/"]) {
      const m = withUrl(mkMember("n2", TAKVIM, TAKVIM_TITLE, "2026-11-07T03:00:00Z"), url as string);
      expect(selectStoryCard([m], null)!.headlines.iktidar).not.toHaveProperty("opinion");
    }
  });

  it("among several news members the earliest still wins (the column rule only filters)", () => {
    const early = withUrl(mkMember("e1", TAKVIM, "Erken haber", "2026-11-07T02:00:00Z"), "https://www.takvim.com.tr/guncel/erken");
    const card = selectStoryCard([aHaberNews(), hurriyetColumn(), early, takvimNews()], null)!;
    expect(card.headlines.iktidar?.title).toBe("Erken haber");
    expect(card.headlines.iktidar).not.toHaveProperty("opinion");
  });

  it("falls back to the EARLIEST eligible column when a zone holds only columns", () => {
    const late = withUrl(
      mkMember("h3", mkSource({ id: "sabah", name: "Sabah", bias: "pro_government" }), "Sabah köşesi başlığı", "2026-11-07T09:00:00Z"),
      "https://www.sabah.com.tr/yazarlar/ali-veli/sabah-kosesi-1",
    );
    const card = selectStoryCard([late, hurriyetColumn()], null)!;
    expect(card.headlines.iktidar?.outletName).toBe("Hürriyet");
    expect(card.headlines.iktidar?.opinion).toBe(true);
    expect(card.coverage.iktidar.count).toBe(2);
  });

  it("falls back to a column when every news title in the zone is PII-filtered", () => {
    const filteredNews = withUrl(
      mkMember("p1", TAKVIM, "17 yaşındaki çocuk kayboldu", "2026-11-07T03:00:00Z"),
      "https://www.takvim.com.tr/guncel/kayip",
    );
    const card = selectStoryCard([filteredNews, hurriyetColumn()], null)!;
    expect(card.headlines.iktidar?.outletName).toBe("Hürriyet");
    expect(card.headlines.iktidar?.opinion).toBe(true);
    expect(card.coverage.iktidar.count).toBe(2);
  });

  it("never picks a PII-filtered column, even as the opinion fallback", () => {
    const filteredColumn = withUrl(
      mkMember("p2", HURRIYET, "17 yaşındaki çocuk kayboldu", "2026-11-07T03:00:00Z"),
      "https://www.hurriyet.com.tr/yazarlar/x/kayip-1",
    );
    expect(selectStoryCard([filteredColumn], null)!.headlines.iktidar).toBeNull();
    // With eligible news next to it, the news wins and nothing is marked.
    const card = selectStoryCard([filteredColumn, takvimNews()], null)!;
    expect(card.headlines.iktidar?.outletName).toBe("Takvim");
    expect(card.headlines.iktidar).not.toHaveProperty("opinion");
  });

  it("is decided per zone: a column in one zone does not affect another zone's pick", () => {
    const oppColumn = withUrl(
      mkMember("s1", SOZCU, "Sözcü köşe başlığı", "2026-11-07T01:00:00Z"),
      "https://www.sozcu.com.tr/kose-yazilari/ali/yazi-1",
    );
    const oppNews = withUrl(
      mkMember("s2", mkSource({ id: "cumhuriyet", name: "Cumhuriyet", bias: "opposition" }), "Cumhuriyet haber başlığı", "2026-11-07T06:00:00Z"),
      "https://www.cumhuriyet.com.tr/haber/yazi-2",
    );
    const card = selectStoryCard([oppColumn, oppNews, hurriyetColumn(), takvimNews()], null)!;
    expect(card.headlines.muhalefet?.outletName).toBe("Cumhuriyet");
    expect(card.headlines.muhalefet).not.toHaveProperty("opinion");
    expect(card.headlines.iktidar?.outletName).toBe("Takvim");
  });

  it("recognises the other outlets' column paths (kose-yazilari, opinion, column, gorus)", () => {
    const paths = [
      "https://www.sozcu.com.tr/kose-yazilari/ali/yazi-1",
      "https://www.hurriyetdailynews.com/opinion/columns/x-1",
      "https://example.com/column/x-1",
      "https://example.com/gorus/x-1",
    ];
    for (const url of paths) {
      const col = withUrl(mkMember("c1", TAKVIM, "Köşe başlığı", "2026-11-07T02:00:00Z"), url);
      const card = selectStoryCard([col, aHaberNews()], null)!;
      expect(card.headlines.iktidar?.outletName, url).toBe("A Haber");
    }
  });

  it("does not mistake a query string or a longer segment for a column", () => {
    for (const url of [
      "https://www.takvim.com.tr/guncel/haber-1?ref=yazarlar",
      "https://www.takvim.com.tr/haber/yazarlarin-tepkisi-1",
      "https://www.takvim.com.tr/yazarlar-kurulu/karar-1",
    ]) {
      const m = withUrl(mkMember("q1", TAKVIM, TAKVIM_TITLE, "2026-11-07T02:00:00Z"), url);
      expect(selectStoryCard([m], null)!.headlines.iktidar).toEqual({
        zone: "iktidar",
        outletName: "Takvim",
        title: TAKVIM_TITLE,
      });
    }
  });

  it("leaves coverage counts, denominators, degraded flags and nonVotingCount exactly as they were", () => {
    const members = [
      hurriyetColumn(),
      takvimNews(),
      aHaberNews(),
      mkMember("n1", mkSource({ id: "isci-haber", bias: "opposition", kind: "niche" }), "İşçi haber başlığı", "2026-11-07T05:00:00Z"),
    ];
    const health = mkHealth({ iktidar: { votingDelivering: 5, degraded: true } });
    const card = selectStoryCard(members, health)!;
    expect(card.coverage.iktidar).toEqual({
      count: 3,
      denominator: 5,
      denominatorUnknown: false,
      degraded: true,
      nonVotingCount: 0,
    });
    expect(card.coverage.muhalefet.nonVotingCount).toBe(1);
    expect(card.nonVotingCount).toBe(1);
  });

  it("a non-voting column never becomes a headline (non-voting members are never headlines)", () => {
    const nicheColumn = withUrl(
      mkMember("n3", mkSource({ id: "isci-haber", bias: "pro_government", kind: "niche" }), "Niş köşe başlığı", "2026-11-07T01:00:00Z"),
      "https://example.com/yazarlar/x/y-1",
    );
    const card = selectStoryCard([nicheColumn, takvimNews()], null)!;
    expect(card.headlines.iktidar?.title).toBe(TAKVIM_TITLE);
  });

  it("an opinion headline carries exactly the marker on top of the old shape; a news headline keeps the old keys only", () => {
    const col = selectStoryCard([hurriyetColumn()], null)!.headlines.iktidar!;
    expect(Object.keys(col).sort()).toEqual(["opinion", "outletName", "title", "zone"]);
    const news = selectStoryCard([takvimNews()], null)!.headlines.iktidar!;
    expect(Object.keys(news).sort()).toEqual(["outletName", "title", "zone"]);
  });

  it("does not depend on the input order", () => {
    const a = selectStoryCard([hurriyetColumn(), takvimNews(), aHaberNews()], null)!;
    const b = selectStoryCard([aHaberNews(), takvimNews(), hurriyetColumn()], null)!;
    expect(a.headlines).toEqual(b.headlines);
  });
});

// h21-journeys-1: the cluster page offers "Kartı indir" only when the card
// route would answer 200. The route's two 404 reasons (no voting member, a
// title the KVKK filter rejects) are the two pure predicates below; the page
// and the route both call them, so they cannot drift.
describe("hasStoryCardCoverage", () => {
  const OUTLET = mkSource({ id: "gov1", bias: "pro_government" });
  const WIRE = mkSource({ id: "wire1", bias: "center", kind: "wire" });
  const AGGREGATOR = mkSource({ id: "agg1", bias: "center", kind: "aggregator" });
  const NICHE = mkSource({ id: "niche1", bias: "opposition", kind: "niche" });

  it("is false for an empty member list", () => {
    expect(hasStoryCardCoverage([])).toBe(false);
  });

  it("is false when every member is an aggregator or niche source", () => {
    const members = [
      mkMember("n1", AGGREGATOR, "Toplayıcı başlığı", "2026-09-10T08:00:00Z"),
      mkMember("n2", NICHE, "Niş kaynak başlığı", "2026-09-10T09:00:00Z"),
    ];
    expect(hasStoryCardCoverage(members)).toBe(false);
  });

  it("is true for a single outlet member, and for a single wire member", () => {
    expect(
      hasStoryCardCoverage([mkMember("a1", OUTLET, "Haber bir", "2026-09-10T08:00:00Z")]),
    ).toBe(true);
    expect(
      hasStoryCardCoverage([mkMember("w1", WIRE, "Ajans haberi", "2026-09-10T08:00:00Z")]),
    ).toBe(true);
  });

  it("is true when one voting member sits among non-voting ones", () => {
    const members = [
      mkMember("n1", AGGREGATOR, "Toplayıcı başlığı", "2026-09-10T08:00:00Z"),
      mkMember("a1", OUTLET, "Haber bir", "2026-09-10T09:00:00Z"),
    ];
    expect(hasStoryCardCoverage(members)).toBe(true);
  });

  it("agrees with selectStoryCard(m, null) !== null for every fixture", () => {
    const fixtures: ClusterDetailMember[][] = [
      [],
      [mkMember("n1", AGGREGATOR, "Toplayıcı başlığı", "2026-09-10T08:00:00Z")],
      [mkMember("n1", NICHE, "Niş kaynak başlığı", "2026-09-10T08:00:00Z")],
      [
        mkMember("n1", AGGREGATOR, "Toplayıcı başlığı", "2026-09-10T08:00:00Z"),
        mkMember("n2", NICHE, "Niş kaynak başlığı", "2026-09-10T09:00:00Z"),
      ],
      [mkMember("a1", OUTLET, "Haber bir", "2026-09-10T08:00:00Z")],
      [mkMember("w1", WIRE, "Ajans haberi", "2026-09-10T08:00:00Z")],
      [
        mkMember("n1", AGGREGATOR, "Toplayıcı başlığı", "2026-09-10T08:00:00Z"),
        mkMember("a1", OUTLET, "Haber bir", "2026-09-10T09:00:00Z"),
      ],
      // A voting member whose own headline is PII-filtered still has coverage:
      // the card renders, just without that zone's headline.
      [mkMember("a1", OUTLET, "17 yaşındaki çocuk gözaltına alındı", "2026-09-10T08:00:00Z")],
      // A kind-less member votes (isVotingKind's default).
      [mkMember("k1", mkSource({ id: "k1", bias: "opposition" }), "Haber iki", "2026-09-10T08:00:00Z")],
    ];
    expect(fixtures.length).toBeGreaterThan(5);
    for (const members of fixtures) {
      expect(hasStoryCardCoverage(members)).toBe(selectStoryCard(members, null) !== null);
    }
  });
});

describe("isStoryCardTitleEligible", () => {
  it("is false for null, undefined and non-string input", () => {
    expect(isStoryCardTitleEligible(null)).toBe(false);
    expect(isStoryCardTitleEligible(undefined)).toBe(false);
    expect(isStoryCardTitleEligible(42 as unknown as string)).toBe(false);
  });

  it("is false for titles the KVKK private-individual filter rejects", () => {
    expect(isStoryCardTitleEligible("32 ilde FETÖ operasyonu: 41 şüpheli tutuklandı")).toBe(false);
    expect(isStoryCardTitleEligible("22 supheli gozaltina alindi")).toBe(false);
  });

  it("is true for a neutral title", () => {
    expect(isStoryCardTitleEligible("Cumhurbaşkanı Erdoğan, Güney Kore'ye geldi")).toBe(true);
  });
});

describe("storyCardHref", () => {
  const ID = "3f1e4b2a-7c8d-4e5f-9a0b-1c2d3e4f5a6b";

  it.each([
    "32 ilde FETÖ operasyonu: 41 şüpheli tutuklandı",
    "İçişleri Bakanı 22 şüphelinin gözaltına alındığını açıkladı",
    "22 supheli gozaltina alindi",
  ])("is null for the KVKK-ineligible title %j even when the card has coverage", (title) => {
    expect(storyCardHref(ID, title, true)).toBeNull();
  });

  it("is null for a null or undefined title", () => {
    expect(storyCardHref(ID, null, true)).toBeNull();
    expect(storyCardHref(ID, undefined, true)).toBeNull();
  });

  it("is null when the card has no coverage, even for a neutral title", () => {
    expect(storyCardHref(ID, "Cumhurbaşkanı Erdoğan, Güney Kore'ye geldi", false)).toBeNull();
  });

  it("is the card route for a neutral title with coverage", () => {
    expect(storyCardHref(ID, "Cumhurbaşkanı Erdoğan, Güney Kore'ye geldi", true)).toBe(
      `/cluster/${ID}/kart`,
    );
  });
});
