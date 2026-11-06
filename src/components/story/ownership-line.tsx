import { groupByOwner } from "@/lib/sources/ownership";
import type { ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";

// Owner-group buckets that are NOT a shared owner — "Bağımsız" and the two
// foreign-broadcaster categories group sources that merely share a
// classification, not a company. Counting them as sahiplik grupları would
// assert shared ownership where there is none (5 independents ≠ 1 owner)
// and "çoğu Bağımsız" reads as a proper-noun owner called Bağımsız.
const CATEGORY_GROUPS = new Set(["independent", "foreign-public", "foreign-state"]);

// The word that sizes the top group's share. groupByOwner calls the top group
// "dominant" from 50% up and breaks a tie by label (alphabetically), which is
// right for the admin report but would make this public line name an arbitrary
// winner, or call a half a "majority". So the line only claims what is true:
//   * every tagged source in the group -> "tümü";
//   * a tie for the top (a runner-up group of the same size) -> no qualifier,
//     because neither group is "most" or "half" more than the other;
//   * a strict majority of the tagged sources -> "çoğu";
//   * exactly half, with a unique top group -> "yarısı".
// Integer arithmetic, so 3 of 6 can never drift across the 50% line.
function shareQualifier(
  topCount: number,
  runnerUpCount: number | null,
  taggedCount: number,
): "tümü" | "çoğu" | "yarısı" | null {
  if (topCount === taggedCount) return "tümü";
  if (runnerUpCount === topCount) return null;
  return topCount * 2 > taggedCount ? "çoğu" : "yarısı";
}

export function OwnershipLine({ members }: { members: ClusterDetailMember[] }) {
  const { groups, taggedSourceCount, taggedShare, dominant } = groupByOwner(
    members.map((m) => m.source),
  );

  if (taggedSourceCount < 3 || taggedShare < 0.6) return null;

  const owners = groups.filter((g) => !CATEGORY_GROUPS.has(g.ownerGroup));
  const independentCount =
    groups.find((g) => g.ownerGroup === "independent")?.sources.length ?? 0;

  const title = groups.map((g) => `${g.label} (${g.sources.length})`).join(", ");

  const dominantIsOwner = dominant && !CATEGORY_GROUPS.has(dominant.ownerGroup);
  const dominantIsIndependent = dominant?.ownerGroup === "independent";
  const runnerUp = groups[1];
  const qualifier = dominant
    ? shareQualifier(
        dominant.sources.length,
        runnerUp ? runnerUp.sources.length : null,
        taggedSourceCount,
      )
    : null;

  const parts = [`Künyesi bilinen ${taggedSourceCount} kaynak`];
  if (owners.length > 0) parts.push(`${owners.length} sahiplik grubu`);
  if (independentCount > 0) parts.push(`${independentCount} bağımsız`);
  let text = parts.join(" · ");
  if (qualifier !== null) {
    if (dominantIsOwner) text += ` — ${qualifier} ${dominant.label}`;
    else if (dominantIsIndependent) text += ` — ${qualifier} bağımsız`;
  }

  return (
    <p className="text-[12px] text-muted-foreground" title={title}>
      {text}
    </p>
  );
}
