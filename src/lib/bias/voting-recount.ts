// Voting recount of a cluster's member list (h63-clusterintegrity-1) -- READ
// PATH ONLY, pure, never writes.
//
// Clusters whose members were last counted before migration 034 store a
// bias_distribution (and an is_blindspot flag derived from it) that include
// aggregator and niche members. The cluster page already tells the reader that
// those kinds "are not counted", so the bar next to that note has to agree.
// This helper re-derives the distribution from the members the detail read
// already loaded.
//
// It mirrors migration 034's `recompute_bias_distribution` exactly:
//   * only members whose source kind votes (outlet, wire; a missing or unknown
//     kind is the column default, 'outlet') are counted, through the shared
//     `votingBiasKeys` of the source-kind contract;
//   * ONE VOTE PER ARTICLE, with no distinct on the source: the SQL joins
//     cluster_articles -> articles -> sources and counts rows, so a source that
//     has two articles in the cluster votes twice. The caller must therefore
//     pass the member list BEFORE any per-source dedupe, or the recount would
//     disagree with the stored value of a modern cluster;
//   * all ten BIAS_KEYS are always present, in contract order, defaulting to 0;
//     a bias value outside the ten keys counts nowhere (jsonb_build_object only
//     names the ten).
//
// The blindspot predicate is the contract's own `detectBlindspot`
// (BLINDSPOT.minSources voting members, top-zone share >=
// BLINDSPOT.dominantShare via BIAS_TO_ZONE, ties broken by ZONE_KEYS order),
// which migration 032's `recompute_blindspot_flags` copies and
// tests/migrations/zone-parity.test.ts keeps in step.

import {
  BIAS_KEYS,
  detectBlindspot,
} from "../../../supabase/functions/_shared/cluster/blindspot";
import { votingBiasKeys } from "../../../supabase/functions/_shared/cluster/source-kind";
import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import type { BiasCategory, BiasDistribution } from "@/types";

/** The slice of a cluster member the recount reads. */
export interface VotingRecountMember {
  source: {
    bias?: string | null;
    kind?: string | null;
  };
}

const KNOWN_BIAS_KEYS: ReadonlySet<string> = new Set<string>(BIAS_KEYS);

/**
 * Per-bias vote counts over the members whose source kind votes, one vote per
 * member article (see the header for why duplicates from one source count
 * each time). Returns a fresh object on every call.
 */
export function votingDistribution(
  members: readonly VotingRecountMember[],
): BiasDistribution {
  const dist = emptyBiasDistribution();
  const votes = votingBiasKeys(
    members.map((member) => ({ bias: member.source.bias, kind: member.source.kind })),
  );
  for (const bias of votes) {
    if (KNOWN_BIAS_KEYS.has(bias)) dist[bias as BiasCategory] += 1;
  }
  return dist;
}

/** True when every one of the ten bias counts is equal. */
export function distributionsEqual(a: BiasDistribution, b: BiasDistribution): boolean {
  return BIAS_KEYS.every((key) => a[key] === b[key]);
}

/**
 * Whether this distribution satisfies the stored blindspot rule (migration
 * 032): at least BLINDSPOT.minSources votes and a top-zone share of at least
 * BLINDSPOT.dominantShare. Used only to WITHDRAW a stored claim; a true here
 * never turns a stored false into a claim.
 */
export function holdsBlindspotRule(dist: BiasDistribution): boolean {
  return detectBlindspot(dist).is_blindspot;
}
