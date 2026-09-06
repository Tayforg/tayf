import { groupMembersByZone } from "@/lib/clusters/framing";
import type { ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";
import type { MediaDnaZone } from "@/types";

interface OtherSidePick {
  zone: "iktidar" | "muhalefet";
  member: ClusterDetailMember | null;
  counts: Record<MediaDnaZone, number>;
}

/**
 * Picks which pole (İktidar or Muhalefet) the "Karşı tarafı oku" CTA
 * should send a landing visitor to.
 *
 * Rule: prefer the pole with FEWER members — that's the side a reader
 * arriving from a shared link is least likely to have already seen. On
 * an exact tie between the two poles, ties always go to Muhalefet:
 * Turkish media ownership skews pro-government, so the median reader
 * has more likely already seen the İktidar framing even when the
 * cluster's coverage is numerically even.
 *
 * `member` is the newest article in the chosen pole (`groupMembersByZone`
 * already sorts each zone newest-first) or null when that pole has zero
 * coverage — the "kör nokta" case the CTA needs to render as disabled.
 */
export function pickOtherSide(members: ClusterDetailMember[]): OtherSidePick {
  const byZone = groupMembersByZone(members);
  const counts: Record<MediaDnaZone, number> = {
    iktidar: byZone.iktidar.length,
    bagimsiz: byZone.bagimsiz.length,
    muhalefet: byZone.muhalefet.length,
  };

  // On a tie, send the reader to muhalefet (see rationale above).
  const zone: "iktidar" | "muhalefet" =
    counts.iktidar < counts.muhalefet ? "iktidar" : "muhalefet";

  const member = byZone[zone][0] ?? null;
  return { zone, member, counts };
}
