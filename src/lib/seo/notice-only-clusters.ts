import { isLegalNotice } from "../../../supabase/functions/_shared/rss/legal-notice";

// Does a cluster hold legal notices only?
//
// The cluster page answers `noindex` when EVERY member is a legal notice (a court or tender notice: isLegalNotice on the
// member's title, url and description; h168-notices-1: two municipalities' EKAP tenders became the 2-source story "Ümraniye
// belediye başkanlığı"). The page has its members, so it applies this predicate directly.
//
// The sitemaps and the IndexNow ping do NOT apply it: their list readers carry no members, and a member read per rebuild is far
// too heavy for the few legacy notice-only clusters (new notices are dropped at ingest by isLegalNotice's description rules). A
// legacy notice-only cluster can therefore still be listed while its page says noindex; see isIndexableCluster in
// src/app/cluster/[id]/page.tsx.
//
// An empty member list is not "every member": a read that returned no members says nothing about the cluster.

/** What isLegalNotice reads of a member. */
export interface NoticeMember {
  title: string;
  url: string;
  description?: string | null;
}

/** True when the cluster has members and every one is a legal notice. The predicate behind the cluster page's robots decision. */
export function isNoticeOnlyCluster(members: ReadonlyArray<NoticeMember>): boolean {
  return members.length > 0 && members.every((m) => isLegalNotice(m.title, m.url, m.description));
}
