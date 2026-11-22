import { isVotingKind, zoneOf } from "@/lib/bias/config";
import type { BiasCategory, MediaDnaZone, SourceKind } from "@/types";

// Shared "zone line" formatting for every user-facing source-mix line: the
// per-topic RSS feeds (src/app/rss/[topic]/route.ts), the blindspots RSS
// feed (src/lib/feeds/blindspots-feed.ts, which reads the bundle's own
// votingZoneCounts), the owned-channels auto-poster
// (src/lib/social/compose.ts) and the /takip follow feed
// (src/app/api/takip/route.ts, which sends the head as `countHead` for
// src/lib/follows/follows.ts to print). All of them must describe the same
// cluster's source mix identically, so the tally + formatting live here once
// instead of being re-implemented per caller.
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
 * synthetic tally can exceed the member list): the bare count is kept. The
 * share surfaces (embed, rozet, OG pill) print a wire redistribution's head
 * through `wireSourceCountHead`, which names the votes in that case; so does the
 * /takip route (h196-counts-2), and so do the RSS topic feed, the blindspots
 * feed, the social composer and the digest template (h203-wire-callers).
 */
export function sourceCountHead(
  total: number,
  counts: Record<MediaDnaZone, number>,
): string {
  const voting = ZONE_ORDER.reduce((sum, zone) => sum + counts[zone], 0);
  if (voting >= total) return `${total} kaynak`;
  return `${total} kaynak (${voting} sınıflandırılmış)`;
}

/**
 * `sourceCountHead` for the share surfaces (embed percent legend, rozet badge,
 * OG pill; the embed's English-only legend keeps `sourceCountHead`) and the
 * /takip route (`countHead`, which also keeps `sourceCountHead` for an
 * all-English cluster, whose zone line carries no tally): a wire
 * redistribution counts its DISTINCT TEXTS (`total` is
 * wire.effectiveArticleCount) while every classified member still votes, so M
 * can exceed N ('3 kaynak' beside %50/%50, from 4 + 4 votes). When `isWire` and
 * the votes exceed a non-zero `total` the head names them in the text-context
 * form 'N kaynak · M sınıflandırılmış'. That form is exactly as long as the
 * parenthesised one ('3 kaynak (2 sınıflandırılmış)'), so the embed's layout
 * budget holds. Every other case is `sourceCountHead`'s, byte for byte: a
 * non-wire cluster keeps its stale-tally rule.
 *
 * The RSS topic feed (src/app/rss/[topic]/route.ts), the blindspots feed
 * (src/lib/feeds/blindspots-feed.ts), the social composer
 * (src/lib/social/compose.ts, `countHeadOf`) and the digest template
 * (src/lib/digest/template.ts, `storyCountLine`) also call it, with
 * `isWire = true`, for a wire redistribution with a positive
 * `effectiveArticleCount`, and follow it with the `wireBadgeLabel` cue. A
 * non-wire cluster in those callers keeps `sourceCountHead`, and so does the
 * cluster card (src/components/story/cluster-card.tsx), which does not use this
 * helper.
 */
export function wireSourceCountHead(
  total: number,
  counts: Record<MediaDnaZone, number>,
  isWire: boolean,
): string {
  const voting = ZONE_ORDER.reduce((sum, zone) => sum + counts[zone], 0);
  if (isWire && total > 0 && voting > total) {
    return `${total} kaynak · ${voting} sınıflandırılmış`;
  }
  return sourceCountHead(total, counts);
}
