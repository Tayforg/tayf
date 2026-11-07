import { isOpinionUrl } from "@/lib/articles/opinion-url";
import { zoneOf } from "@/lib/bias/config";
import type { ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";
import {
  zoneVotingYieldDenominator,
  type ZoneFeedHealth,
} from "@/lib/clusters/feed-health";
import { isGameEligibleTitle } from "@/lib/game/pii-filter";
import { partitionByVote } from "@/lib/sources/kind";
import type { MediaDnaZone } from "@/types";

// Pure data selection for the U-02 "Manşet Kartı" share card
// (/cluster/[id]/kart). Deliberately has no Supabase/next/cache
// dependency of its own — the route handler fetches `ClusterDetail` (via
// `getClusterDetail`) and `ZoneFeedHealth` (via `getZoneFeedHealth`) and
// passes both in here, so this module stays trivially unit-testable and
// the two data-fetch concerns (member selection vs. feed health) stay
// decoupled.

const ZONES: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

export interface StoryCardHeadline {
  zone: MediaDnaZone;
  outletName: string;
  title: string;
  /** True when the headline is an opinion column (`isOpinionUrl` on the
   *  article URL), picked only because the zone has no eligible news member.
   *  Absent otherwise (never `false`), so a news headline keeps the exact
   *  shape it always had. The card prints "<Outlet> · köşe yazısı"
   *  (h57-outbound-2). */
  opinion?: true;
}

export interface StoryCardZoneCoverage {
  /** Total members in this zone, PII-filtered or not — real coverage for
   *  the share bar and the "N / M kaynak" count even when no single
   *  headline from the zone was eligible to display. */
  count: number;
  /** `zoneVotingYieldDenominator(health, zone)` — the zone's delivering
   *  VOTING sources (outlet / wire), the same basis as `count`, which also
   *  leaves aggregator and niche members out. Null when health is unknown. */
  denominator: number | null;
  /** True when `health` was null, i.e. the denominator above is not a
   *  real number — callers must render the wording-without-numbers
   *  fallback rather than treat `denominator` as 0. */
  denominatorUnknown: boolean;
  /** `health[zone].degraded` — always false (fail-open) when health is
   *  unknown; missing data must never read as a degraded feed. */
  degraded: boolean;
  /** Distinct non-voting sources (aggregator, niche; by slug) whose own zone
   *  (`zoneOf(source.bias)`) is this one. Never part of `count`, a share or a
   *  denominator: it only lets the card word an empty zone for what it is
   *  ("spektruma sayılan kaynaklardan haber yok" instead of "bu tarafta haber
   *  yok") when a toplayıcı / niş source of that zone carried the story
   *  (h57-outbound-1). */
  nonVotingCount: number;
}

export interface StoryCard {
  /** One headline per zone — the earliest-published member in that zone
   *  whose title clears the PII filter (`isGameEligibleTitle`) and whose
   *  article is not an opinion column; a column (marked `opinion: true`) only
   *  when the zone has no such news member. `null` when the zone has no
   *  members, or every member's title was filtered. */
  headlines: Record<MediaDnaZone, StoryCardHeadline | null>;
  coverage: Record<MediaDnaZone, StoryCardZoneCoverage>;
  /** Unique source slugs among members whose kind does not vote in
   *  bias_distribution / blindspot / trends (aggregator, niche — see
   *  `src/lib/sources/kind.ts`). Excluded entirely from `headlines` and
   *  `coverage`, but counted here so the card can say so instead of
   *  silently under-counting real coverage. */
  nonVotingCount: number;
}

function emptyCoverage(): StoryCardZoneCoverage {
  return {
    count: 0,
    denominator: null,
    denominatorUnknown: true,
    degraded: false,
    nonVotingCount: 0,
  };
}

/**
 * True when the cluster has at least one VOTING member (outlet / wire), i.e.
 * when `selectStoryCard` can build a card at all. The cluster page and the
 * /kart route both decide on this one rule, so the page never offers a card
 * the route would answer with a 404.
 */
export function hasStoryCardCoverage(members: ClusterDetailMember[]): boolean {
  return partitionByVote(members).voting.length > 0;
}

/**
 * True when the cluster TITLE may be rasterised into the card's largest text.
 * The title is the neutral `title_tr`, which can pass a member headline through
 * verbatim, so it gets the same KVKK private-individual filter (G-PRIV-1) the
 * per-zone headlines get. A missing title is not eligible.
 */
export function isStoryCardTitleEligible(title: string | null | undefined): boolean {
  return typeof title === "string" && isGameEligibleTitle(title);
}

/**
 * The "Kartı indir" href for a cluster, or `null` when the /kart route would
 * 404 for it (no voting coverage, or an ineligible title). Pure: the cluster
 * page computes it and hands ShareButton (a 'use client' component) the plain
 * string, so that component never imports this module.
 */
export function storyCardHref(
  clusterId: string,
  title: string | null | undefined,
  hasCard: boolean,
): string | null {
  if (!hasCard || !isStoryCardTitleEligible(title)) return null;
  return `/cluster/${clusterId}/kart`;
}

/**
 * Select the per-zone headline + coverage data the share card renders.
 *
 * Only voting-kind members ("outlet" / "wire" — see `partitionByVote` in
 * `@/lib/sources/kind`) are bucketed into zones: this mirrors the cluster
 * page and OG image, which both derive their spectrum from voting members
 * / `bias_distribution`. Non-voting members (aggregator, niche) never
 * become a zone headline and are never counted toward `coverage`; they
 * are surfaced only via `nonVotingCount`.
 *
 * `null` when there are no VOTING members at all — the route handler
 * must treat that the same as "unknown id" (404): three empty zones would
 * misrepresent a cluster that in fact has no spectrum-eligible coverage.
 */
export function selectStoryCard(
  members: ClusterDetailMember[],
  health: ZoneFeedHealth | null,
): StoryCard | null {
  if (!hasStoryCardCoverage(members)) return null;
  const { voting, nonVoting } = partitionByVote(members);

  const nonVotingCount = new Set(nonVoting.map((m) => m.source.slug)).size;
  // The same distinct sources, bucketed by their own zone (h57-outbound-1).
  const nonVotingSlugsByZone: Record<MediaDnaZone, Set<string>> = {
    iktidar: new Set(),
    bagimsiz: new Set(),
    muhalefet: new Set(),
  };
  for (const member of nonVoting) {
    nonVotingSlugsByZone[zoneOf(member.source.bias)].add(member.source.slug);
  }

  const byZone: Record<MediaDnaZone, ClusterDetailMember[]> = {
    iktidar: [],
    bagimsiz: [],
    muhalefet: [],
  };
  for (const member of voting) {
    byZone[zoneOf(member.source.bias)].push(member);
  }

  const headlines: Record<MediaDnaZone, StoryCardHeadline | null> = {
    iktidar: null,
    bagimsiz: null,
    muhalefet: null,
  };
  const coverage: Record<MediaDnaZone, StoryCardZoneCoverage> = {
    iktidar: emptyCoverage(),
    bagimsiz: emptyCoverage(),
    muhalefet: emptyCoverage(),
  };

  for (const zone of ZONES) {
    const zoneMembers = [...byZone[zone]].sort(
      (a, b) =>
        new Date(a.article.published_at).getTime() -
        new Date(b.article.published_at).getTime(),
    );

    const zoneCoverage = coverage[zone];
    zoneCoverage.count = zoneMembers.length;
    // Voting basis on both sides of the fraction: `count` above is voting
    // members only, so the denominator must not include delivering
    // aggregator / niche feeds (h53-consistency-2: "2 / 37" for a zone whose
    // voting basis was 24).
    zoneCoverage.denominator = zoneVotingYieldDenominator(health, zone);
    zoneCoverage.denominatorUnknown = health === null;
    zoneCoverage.degraded = health ? health[zone].degraded : false;
    zoneCoverage.nonVotingCount = nonVotingSlugsByZone[zone].size;

    // Earliest-first eligible headline — mirrors the "prefer the outlet
    // with the earliest publication in that zone" instruction, skipping
    // any title the PII filter would exclude (KVKK: false negatives here
    // are acceptable, missing a real private-individual name is not).
    // h57-outbound-2: an opinion column is not news (#217), so the earliest
    // eligible NEWS member wins even over an earlier column (442e0395: a
    // Hürriyet columnist's piece at 03:04 over Takvim's news at 04:00). The
    // earliest eligible column is the headline only when the zone has no news
    // member to show, and is then marked so the card can say so.
    let news: ClusterDetailMember | undefined;
    let column: ClusterDetailMember | undefined;
    for (const member of zoneMembers) {
      if (!isGameEligibleTitle(member.article.title)) continue;
      if (isOpinionUrl(member.article.url)) {
        column ??= member;
        continue;
      }
      news = member;
      break;
    }
    const picked = news ?? column;
    if (picked) {
      headlines[zone] = {
        zone,
        outletName: picked.source.name,
        title: picked.article.title,
        ...(news ? {} : { opinion: true as const }),
      };
    }
  }

  return { headlines, coverage, nonVotingCount };
}
