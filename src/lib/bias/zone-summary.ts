import { isVotingKind, zoneOf } from "@/lib/bias/config";
import { roundPercents } from "@/lib/bias/round-percents";
import type { BiasCategory, BiasDistribution, MediaDnaZone, SourceKind } from "@/types";

// Pure helpers for collapsing a cluster's 10-category `BiasDistribution`
// into the 3 Medya DNA zone counts, percentages, and dominant-zone calls.
// Extracted from `opengraph-image.tsx` (which needs it for the ribbon +
// chip math) and shared with `buildShareText` (src/lib/clusters/share.ts)
// so both consumers agree on the same rounding and tie-break rules.

const ZONE_ORDER: MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

/**
 * What an empty zone says when it has no source the spectrum counts but a
 * toplayıcı / niş source of that zone wrote about the story: the absence is
 * scoped to the counted sources instead of claiming nobody wrote there
 * (h57-outbound-1, h58-postship-2). The Manşet Kartı prints it as
 * "— <this>" and the cluster page's framing comparison as "— <this> —"; both
 * read this one constant so the wording cannot drift between them. Bare: each
 * surface adds its own dashes. A zone nobody wrote in keeps its plain line
 * ("bu tarafta haber yok" / "bu tarafta sessizlik").
 */
export const SPECTRUM_ABSENT_QUALIFIED = "spektruma sayılan kaynaklardan haber yok";

export function zoneCountsOf(
  distribution: BiasDistribution,
): Record<MediaDnaZone, number> {
  const counts: Record<MediaDnaZone, number> = {
    iktidar: 0,
    bagimsiz: 0,
    muhalefet: 0,
  };
  for (const [bias, count] of Object.entries(distribution)) {
    counts[zoneOf(bias as keyof BiasDistribution)] += count;
  }
  return counts;
}

/**
 * Integer percents that sum to exactly 100 when total > 0, via
 * largest-remainder rounding (Hamilton's method) -- see `roundPercents`.
 * Ties in the remainder are broken by `ZONE_ORDER`
 * (iktidar, bagimsiz, muhalefet), so the result is deterministic across
 * calls. All zeros when the total is 0.
 */
export function zonePercents(
  counts: Record<MediaDnaZone, number>,
): Record<MediaDnaZone, number> {
  const [iktidar = 0, bagimsiz = 0, muhalefet = 0] = roundPercents(
    ZONE_ORDER.map((zone) => counts[zone]),
  );
  return { iktidar, bagimsiz, muhalefet };
}

/**
 * The zone's share of the voting sources as a whole percent, from the SAME
 * largest-remainder rounding as the bars and tiles (`zonePercents`): 11 of 13
 * reads 84 here and in the bar, where `Math.round(11 / 13 * 100)` read 85.
 * Every chip, ribbon, RSS line and digest line that names a zone's share must
 * come through here (tests/guards/zone-percent-rounding.test.ts) so the number
 * next to a bar can never disagree with the bar. 0 when nobody voted.
 */
export function dominantZonePercent(
  counts: Record<MediaDnaZone, number>,
  zone: MediaDnaZone,
): number {
  return zonePercents(counts)[zone];
}

/**
 * True when `zone` has at least one source and the other two zones have
 * exactly none: the only honest basis for a "sadece X yazdı" (only X wrote)
 * claim. It is decided on the COUNTS, never on a rounded percent: 250/1/0
 * rounds to 100 for the big zone while another zone still has a source.
 */
export function isOnlyZone(
  counts: Record<MediaDnaZone, number>,
  zone: MediaDnaZone,
): boolean {
  return ZONE_ORDER.every((other) =>
    other === zone ? counts[other] > 0 : counts[other] === 0,
  );
}

/**
 * How many toplayıcı / niş (non-voting) sources sit OUTSIDE `zone`.
 *
 * "Sadece X yazdı" is decided on the voting tally only (`isOnlyZone`), so it
 * can be printed over a story an aggregator or niche source from another zone
 * also carried (cluster 5692a4a1: İşçi Haber, a niche Muhalefet source). The
 * flag rule is right by design; only the wording claims who wrote, so a
 * non-zero count lets the chip qualify itself ("Spektrumda sadece X"). Never a
 * vote: nothing here changes a count, a share or a blindspot flag.
 *
 * A source is non-voting by `isVotingKind` (null / missing kind votes, like
 * everywhere else). One without a recognised bias has no zone, so it is not
 * "inside" `zone` and is counted: the error that adds a qualifier is the
 * honest one. `sources` must already be de-duplicated per source (a
 * `BlindspotBundle.sources` is).
 */
export function nonVotingOutsideZone(
  sources: readonly { kind?: SourceKind | null; bias: BiasCategory }[],
  zone: MediaDnaZone,
): number {
  let outside = 0;
  for (const source of sources) {
    if (isVotingKind(source.kind)) continue;
    if (zoneOf(source.bias) !== zone) outside += 1;
  }
  return outside;
}

/**
 * What a "Kör nokta" line may say about the zone that wrote the story.
 *   "only"         the zone is the only one with a voting source and nobody
 *                  outside it carried the story: "sadece X yazdı".
 *   "spectrumOnly" the zone is the only one with a voting source, but a
 *                  toplayıcı / niş source from another zone carried it too:
 *                  "spektrumda sadece X" (what the counted sources show), never
 *                  "yazdı".
 *   "weighted"     another zone has a voting source: "X ağırlıklı" / "%N X".
 *
 * The one decision every outbound surface reads (the OG ribbon, the share text,
 * the embed, the digest; /blindspots and the Manşet Kartı decide the same way
 * from `nonVotingOutsideZone`), so none of them can word it differently.
 * Nothing here is a vote: the counts, the shares and the flag are untouched.
 */
export type OnlyZoneClaim = "only" | "spectrumOnly" | "weighted";

/**
 * `isOnlyZone` plus the non-voting qualifier. `nonVotingOutside` is
 * `nonVotingOutsideZone(sources, zone)`; a caller that has no source list passes
 * 0 and gets the unqualified wording it always had.
 */
export function onlyZoneClaim(
  counts: Record<MediaDnaZone, number>,
  zone: MediaDnaZone,
  nonVotingOutside: number,
): OnlyZoneClaim {
  if (!isOnlyZone(counts, zone)) return "weighted";
  return nonVotingOutside > 0 ? "spectrumOnly" : "only";
}

/**
 * One source per slug, in first-seen order: a single outlet can appear as
 * several members (one per article), and `nonVotingOutsideZone` counts what it
 * is given. Works on `ClusterDetailMember[]` and on anything shaped like
 * `{ source: { slug } }`.
 */
export function uniqueSources<S extends { slug: string }>(
  members: readonly { source: S }[],
): S[] {
  const bySlug = new Map<string, S>();
  for (const { source } of members) {
    if (!bySlug.has(source.slug)) bySlug.set(source.slug, source);
  }
  return Array.from(bySlug.values());
}
