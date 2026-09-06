import { groupByOwner } from "@/lib/sources/ownership";
import type { ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";

// Owner-group buckets that are NOT a shared owner — "Bağımsız" and the two
// foreign-broadcaster categories group sources that merely share a
// classification, not a company. Counting them as sahiplik grupları would
// assert shared ownership where there is none (5 independents ≠ 1 owner)
// and "çoğu Bağımsız" reads as a proper-noun owner called Bağımsız.
const CATEGORY_GROUPS = new Set(["independent", "foreign-public", "foreign-state"]);

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
  const dominantShare = dominant ? dominant.sources.length / taggedSourceCount : 0;
  const qualifier = dominantShare === 1 ? "tümü" : "çoğu";

  const parts = [`Künyesi bilinen ${taggedSourceCount} kaynak`];
  if (owners.length > 0) parts.push(`${owners.length} sahiplik grubu`);
  if (independentCount > 0) parts.push(`${independentCount} bağımsız`);
  let text = parts.join(" · ");
  if (dominantIsOwner) text += ` — ${qualifier} ${dominant.label}`;
  else if (dominantIsIndependent) text += " — çoğu bağımsız";

  return (
    <p className="text-[12px] text-muted-foreground" title={title}>
      {text}
    </p>
  );
}
