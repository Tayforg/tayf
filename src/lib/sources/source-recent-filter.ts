import { isGameEligibleTitle } from "@/lib/game/pii-filter";

// 'Son haberler' on /source/<slug> (h61-journey-3).
//
// The list used to be a source's 20 newest articles with no filter. Unclustered
// crime and accident items that name a private individual (initials, age,
// village) therefore surfaced on an indexable page, although /oyun, the embed,
// the share cards and the social posts all run them through the site's own
// private-individual filter. This is the same predicate, applied here.
//
// A CLUSTERED article is always kept: cluster membership means it passed the
// political gate and it is already public on its cluster page. Only an article
// that is in no cluster is judged, on its title and (when it has one) its
// description.
//
// The pattern list itself is founder-owned (KVKK) and lives in
// src/lib/game/pii-filter.ts; nothing here adds to it or reimplements it.
//
// Pure: no I/O, no clock, so it is safe inside a "use cache" body.

/** How many items 'Son haberler' shows. */
export const SOURCE_RECENT_LIMIT = 20;

interface RecentRow {
  id: string;
  title: string;
  description: string | null;
}

/**
 * The rows 'Son haberler' may show, in input order (newest first), at most
 * `limit` of them. `rows` are expected to be already repaired (entity residue)
 * so the filter sees the text the visitor would read.
 */
export function selectSourceRecentArticles<T extends RecentRow>(
  rows: readonly T[],
  clusteredIds: ReadonlySet<string>,
  limit: number = SOURCE_RECENT_LIMIT,
): T[] {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  const out: T[] = [];
  for (const row of rows) {
    if (out.length >= cap) break;
    if (!clusteredIds.has(row.id) && !isPublishable(row)) continue;
    out.push(row);
  }
  return out;
}

function isPublishable(row: RecentRow): boolean {
  if (!isGameEligibleTitle(row.title)) return false;
  return typeof row.description !== "string" || isGameEligibleTitle(row.description);
}
