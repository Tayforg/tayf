import { isSeoExplainerTitle } from "@/lib/clusters/blindspot-feed";
import { groupMembersByZone } from "@/lib/clusters/framing";
import { isExplainerTitle } from "@/lib/clusters/summary-agreement";
import type { ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";
import type { MediaDnaZone } from "@/types";

interface OtherSidePick {
  zone: "iktidar" | "muhalefet";
  member: ClusterDetailMember | null;
  counts: Record<MediaDnaZone, number>;
}

/**
 * True for an explainer or SEO biography title ("Ali Koç kimdir?", "... kaç
 * yaşında, nereli?", "... biyografisi", "Asgari ücret nedir?", "... canlı
 * izle"). Either of the two house predicates is enough: `isSeoExplainerTitle`
 * (blindspot-feed.ts) and `isExplainerTitle` (summary-agreement.ts) cover
 * overlapping but not identical stems. A missing or non-string title is not an
 * explainer, so the member stays pickable.
 */
function isReadAcrossExplainer(title: string | null | undefined): boolean {
  return typeof title === "string" && (isSeoExplainerTitle(title) || isExplainerTitle(title));
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
 * `member` is the newest NON-explainer article in the chosen pole
 * (`groupMembersByZone` already sorts each zone newest-first), so the CTA does
 * not send the reader to an SEO biography ("... kimdir, kaç yaşında, nereli?")
 * instead of that side's coverage. When every member of the pole is an
 * explainer it is the newest member, as before. It is null when the pole has
 * zero coverage — the "kör nokta" case the CTA needs to render as disabled.
 * The pole choice and `counts` never depend on titles.
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

  const pole = byZone[zone];
  const member = pole.find((m) => !isReadAcrossExplainer(m.article.title)) ?? pole[0] ?? null;
  return { zone, member, counts };
}
