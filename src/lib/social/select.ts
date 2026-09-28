import { zoneOf } from "@/lib/bias/config";
import { shouldSuppressBlindspot, type ZoneFeedHealth } from "@/lib/clusters/feed-health";
import { isGameEligibleTitle } from "@/lib/game/pii-filter";
import type { BiasCategory, MediaDnaZone } from "@/types";

// Pure selection rules for the owned-channels auto-poster
// (src/app/api/cron/social/route.ts). Every gate here is fail-CLOSED —
// unlike the site's read paths, which fail open on unknown health so a
// transient Supabase blip never empties /blindspots. Posting publicly is a
// one-way action a silent "unknown" must never wave through.

export const SOCIAL_KINDS = ["blindspot", "top_story"] as const;
export type SocialKind = (typeof SOCIAL_KINDS)[number];

export const SOCIAL_BLINDSPOT_MAX_AGE_H = 72;
export const SOCIAL_BLINDSPOTS_PER_TICK = 2;
export const SOCIAL_TOP_MIN_SOURCES = 10;
export const SOCIAL_TOP_MAX_AGE_H = 6;
export const SOCIAL_TOP_SPACING_H = 3;
export const SOCIAL_DAILY_CAP = 8;

const HOUR_MS = 60 * 60 * 1000;

/** The minimal cluster-bundle shape both selectors need. Deliberately a
 * subset of ClusterBundle / BlindspotBundle so this module stays free of
 * a hard dependency on either query module's full row shape. */
export interface SocialCandidateBundle {
  cluster: {
    id: string;
    title_tr: string;
    first_published: string;
  };
  sources: ReadonlyArray<{ id: string; bias: BiasCategory }>;
  dominantZone?: MediaDnaZone;
  dominantPct?: number;
  effectiveArticleCount?: number;
  isWireRedistribution?: boolean;
}

/** The live-re-read `clusters` row, keyed by id, checked immediately
 * before a claim so a 5-minute-cached bundle can never be trusted alone
 * for a public blindspot claim (see the pack's "Pitfalls" note). */
export interface FreshClusterRow {
  id: string;
  is_blindspot: boolean;
  blindspot_recall_veto: boolean;
  blindspot_recall_suspect: boolean;
  blindspot_recall_checked_at: string | null;
  is_archived: boolean;
}

function hoursSince(iso: string, nowMs: number): number {
  return (nowMs - new Date(iso).getTime()) / HOUR_MS;
}

/** Distinct Medya DNA zones represented among a bundle's (already
 * distinct-per-source) sources. */
function zonesCoveredOf(sources: ReadonlyArray<{ bias: BiasCategory }>): number {
  const zones = new Set<MediaDnaZone>();
  for (const source of sources) zones.add(zoneOf(source.bias));
  return zones.size;
}

export interface SelectBlindspotsArgs {
  bundles: ReadonlyArray<
    SocialCandidateBundle & { dominantZone: MediaDnaZone; dominantPct: number }
  >;
  fresh: ReadonlyMap<string, FreshClusterRow>;
  health: ZoneFeedHealth | null;
  nowMs: number;
  postedIds: ReadonlySet<string>;
}

/**
 * At most SOCIAL_BLINDSPOTS_PER_TICK blindspot bundles eligible to post,
 * ordered by dominantPct desc then article_count desc. Every gate below is
 * required; failing ANY one drops the candidate.
 */
export function selectBlindspotsToPost(
  args: SelectBlindspotsArgs,
): SocialCandidateBundle[] {
  const { bundles, fresh, health, nowMs, postedIds } = args;

  // Fail-closed: unlike the site's read paths, unknown health means NO
  // blindspot posts this tick, not "assume healthy".
  if (health === null) return [];

  const eligible = bundles.filter((bundle) => {
    if (postedIds.has(bundle.cluster.id)) return false;
    if (shouldSuppressBlindspot(bundle.dominantZone, health)) return false;

    const row = fresh.get(bundle.cluster.id);
    if (!row) return false;
    if (!row.is_blindspot) return false;
    if (row.blindspot_recall_veto) return false;
    if (row.blindspot_recall_suspect) return false;
    if (!row.blindspot_recall_checked_at) return false;
    if (row.is_archived) return false;

    if (hoursSince(bundle.cluster.first_published, nowMs) > SOCIAL_BLINDSPOT_MAX_AGE_H) {
      return false;
    }

    const effectiveCount = bundle.effectiveArticleCount ?? bundle.sources.length;
    if (effectiveCount < 5) return false;
    if (bundle.isWireRedistribution) return false;

    if (!isGameEligibleTitle(bundle.cluster.title_tr)) return false;

    return true;
  });

  eligible.sort((a, b) => {
    if (b.dominantPct !== a.dominantPct) return b.dominantPct - a.dominantPct;
    const aCount = a.effectiveArticleCount ?? a.sources.length;
    const bCount = b.effectiveArticleCount ?? b.sources.length;
    return bCount - aCount;
  });

  return eligible.slice(0, SOCIAL_BLINDSPOTS_PER_TICK);
}

export interface SelectTopStoryArgs {
  bundles: ReadonlyArray<SocialCandidateBundle & { isBlindspot?: boolean }>;
  nowMs: number;
  postedIds: ReadonlySet<string>;
  lastTopStoryAtMs: number | null;
}

/**
 * The first eligible top-story bundle in ranking order, or null. `bundles`
 * must already be in the getPoliticsClusters ranking order — this
 * function does not re-sort, it only filters and takes the first match.
 */
export function selectTopStory(args: SelectTopStoryArgs): SocialCandidateBundle | null {
  const { bundles, nowMs, postedIds, lastTopStoryAtMs } = args;

  if (
    lastTopStoryAtMs !== null &&
    (nowMs - lastTopStoryAtMs) / HOUR_MS < SOCIAL_TOP_SPACING_H
  ) {
    return null;
  }

  for (const bundle of bundles) {
    if (bundle.isBlindspot) continue;
    if (bundle.sources.length < SOCIAL_TOP_MIN_SOURCES) continue;
    const effectiveCount = bundle.effectiveArticleCount ?? bundle.sources.length;
    if (effectiveCount < SOCIAL_TOP_MIN_SOURCES) continue;
    if (zonesCoveredOf(bundle.sources) < 2) continue;
    if (hoursSince(bundle.cluster.first_published, nowMs) > SOCIAL_TOP_MAX_AGE_H) {
      continue;
    }
    if (!isGameEligibleTitle(bundle.cluster.title_tr)) continue;
    if (postedIds.has(bundle.cluster.id)) continue;
    return bundle;
  }

  return null;
}
