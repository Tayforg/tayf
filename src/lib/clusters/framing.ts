import { zoneOf } from "@/lib/bias/config";
import type { ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";
import type { MediaDnaZone } from "@/types";

// Grouping logic for the "Aynı Haber, Farklı Dünyalar" framing comparison
// (src/components/story/framing-comparison.tsx): bucket a cluster's member
// articles into the three Medya DNA zones and sort each bucket
// newest-first so the freshest headline of each world leads its column.

export type MembersByZone = Record<MediaDnaZone, ClusterDetailMember[]>;

export function groupMembersByZone(
  members: ClusterDetailMember[],
): MembersByZone {
  const byZone: MembersByZone = {
    iktidar: [],
    bagimsiz: [],
    muhalefet: [],
  };
  for (const member of members) {
    byZone[zoneOf(member.source.bias)].push(member);
  }

  for (const zone of Object.keys(byZone) as MediaDnaZone[]) {
    byZone[zone].sort((a, b) => {
      // Unparseable timestamps sort last (NaN → -Infinity) instead of
      // shuffling nondeterministically through the comparator.
      const ta = new Date(a.article.published_at).getTime();
      const tb = new Date(b.article.published_at).getTime();
      return (
        (Number.isNaN(tb) ? -Infinity : tb) -
        (Number.isNaN(ta) ? -Infinity : ta)
      );
    });
  }
  return byZone;
}
