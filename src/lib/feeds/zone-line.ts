import { isVotingKind, zoneOf } from "@/lib/bias/config";
import type { BiasCategory, MediaDnaZone, SourceKind } from "@/types";

// Shared "zone line" formatting for every user-facing source-mix line: the
// per-topic RSS feeds (src/app/rss/[topic]/route.ts), the blindspots RSS
// feed (src/lib/feeds/blindspots-feed.ts, which reads the bundle's own
// votingZoneCounts) and the owned-channels auto-poster
// (src/lib/social/compose.ts). All of them must describe the same cluster's
// source mix identically, so the tally + formatting live here once instead
// of being re-implemented per caller.
//
// The basis is the card's: only VOTING source kinds (outlet, wire) count.
// Aggregators and niche feeds are listed on the card but never vote, so
// `votingZoneCounts` is what every surface that prints a zone line calls.
// `zoneCountsFromSources` stays for raw, kind-blind tallies.
//
// The head in front of the zone line ("N kaynak") counts EVERY member, the
// way the card does, while the zones count voting sources only, so the two
// numbers can differ. `sourceCountHead` prints the full count and, when it
// differs from the zone total, the voting count too: "10 kaynak (8
// sınıflandırılmış) · İktidar 8 · Bağımsız 0 · Muhalefet 0". The zones then
// always add up to the parenthesised number (or to N when there is none),
// the same wording the share text uses (src/lib/clusters/share.ts).

const ZONE_ORDER: readonly MediaDnaZone[] = [
  "iktidar",
  "bagimsiz",
  "muhalefet",
];

const ZONE_LABELS_TR: Record<MediaDnaZone, string> = {
  iktidar: "İktidar",
  bagimsiz: "Bağımsız",
  muhalefet: "Muhalefet",
};

/** The minimum a source needs for the voting tally: its bias plus its kind. */
export interface ZoneLineSource {
  bias: BiasCategory;
  /**
   * Optional/nullable like `Source.kind`: a missing or null kind is a voting
   * one (`isVotingKind`'s default), so legacy rows and fixtures that predate
   * the column keep counting.
   */
  kind?: SourceKind | null;
}

/**
 * Raw tally: every source counts, whatever its kind. `sources` is assumed
 * to already be a distinct-per-source list (e.g. ClusterCardSource[] /
 * BlindspotBundle.sources) — this does not itself dedupe by id, it only
 * maps each entry's `bias` to a zone and counts it.
 *
 * Do NOT use this for a user-facing zone line: it counts aggregators and
 * niche feeds, which the card does not. Use `votingZoneCounts`.
 */
export function zoneCountsFromSources(
  sources: ReadonlyArray<{ bias: BiasCategory }>,
): Record<MediaDnaZone, number> {
  const counts: Record<MediaDnaZone, number> = {
    iktidar: 0,
    bagimsiz: 0,
    muhalefet: 0,
  };
  for (const source of sources) {
    counts[zoneOf(source.bias)] += 1;
  }
  return counts;
}

/**
 * Per-zone tally on the VOTING basis: only outlet and wire sources count,
 * aggregator and niche are dropped, and a missing/null `kind` counts as
 * voting (`isVotingKind`'s default). This is the card's basis (DB
 * `bias_distribution`, `zoneTallyOf`), so a zone line printed from it agrees
 * with the card the reader clicks through to. The line's head ("N kaynak")
 * is the full member count, so print it through `sourceCountHead`, which adds
 * the voting count in parentheses when the two differ.
 */
export function votingZoneCounts(
  sources: ReadonlyArray<ZoneLineSource>,
): Record<MediaDnaZone, number> {
  return zoneCountsFromSources(sources.filter((s) => isVotingKind(s.kind)));
}

/** 'İktidar {a} · Bağımsız {b} · Muhalefet {c}' */
export function formatZoneLine(counts: Record<MediaDnaZone, number>): string {
  return ZONE_ORDER.map((zone) => `${ZONE_LABELS_TR[zone]} ${counts[zone]}`).join(
    " · ",
  );
}

/**
 * The head that goes in front of a zone line: 'N kaynak', or
 * 'N kaynak (M sınıflandırılmış)' when only M of the N members vote, so the
 * zones that follow add up to the number the reader can see. `total` is every
 * member (aggregator and niche included, as on the card); M is the sum of
 * `counts`, the voting tally.
 *
 * When the zones add up to N or more there is nothing to qualify (a stale or
 * synthetic tally can exceed the member list): the bare count is kept.
 */
export function sourceCountHead(
  total: number,
  counts: Record<MediaDnaZone, number>,
): string {
  const voting = ZONE_ORDER.reduce((sum, zone) => sum + counts[zone], 0);
  if (voting >= total) return `${total} kaynak`;
  return `${total} kaynak (${voting} sınıflandırılmış)`;
}
