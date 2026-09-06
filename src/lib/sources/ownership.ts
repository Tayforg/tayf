// Ownership-group rollup for the "honest source count" feature: folds the
// hand-tagged `ownerGroup` slugs in `factuality.ts` into Turkish labels and
// groups a cluster's sources by owner so the UI can say "9 outlets, 3
// owners" instead of implying 9 independent newsrooms.

import { getSourceMetadata } from "@/lib/sources/factuality";
import type { Source } from "@/types";

export const OWNER_GROUPS: Record<string, string> = {
  turkuvaz: "Turkuvaz Medya",
  demiroren: "Demirören Medya",
  ihlas: "İhlas Holding",
  albayrak: "Albayrak Grubu",
  ciner: "Ciner Medya",
  dogus: "Doğuş Grubu",
  "state-tr": "Devlet medyası (TRT/AA)",
  "foreign-public": "Yabancı kamu yayıncısı",
  "foreign-state": "Yabancı devlet medyası",
  "foreign-private": "Yabancı özel medya",
  srmg: "SRMG",
  independent: "Bağımsız",
};

export interface OwnerGroupBucket {
  ownerGroup: string;
  label: string;
  sources: Source[];
}

export interface OwnerGroupSummary {
  groups: OwnerGroupBucket[];
  taggedSourceCount: number;
  totalSourceCount: number;
  taggedShare: number;
  dominant: OwnerGroupBucket | null;
}

/**
 * Groups sources by their `ownerGroup` (from `SOURCE_METADATA`), deduping
 * by slug first. Untagged sources (no `getSourceMetadata` entry, or a
 * `null` ownerGroup) count toward `totalSourceCount` but never appear in
 * `groups` and never contribute to `taggedShare`.
 */
export function groupByOwner(sources: Source[]): OwnerGroupSummary {
  const bySlug = new Map<string, Source>();
  for (const source of sources) {
    if (!bySlug.has(source.slug)) bySlug.set(source.slug, source);
  }
  const uniqueSources = [...bySlug.values()];

  const buckets = new Map<string, Source[]>();
  let taggedSourceCount = 0;
  for (const source of uniqueSources) {
    const ownerGroup = getSourceMetadata(source.slug)?.ownerGroup ?? null;
    if (!ownerGroup) continue;
    taggedSourceCount += 1;
    const bucket = buckets.get(ownerGroup);
    if (bucket) {
      bucket.push(source);
    } else {
      buckets.set(ownerGroup, [source]);
    }
  }

  const groups: OwnerGroupBucket[] = [...buckets.entries()]
    .map(([ownerGroup, groupSources]) => ({
      ownerGroup,
      label: OWNER_GROUPS[ownerGroup] ?? ownerGroup,
      sources: groupSources,
    }))
    .sort((a, b) => {
      const bySize = b.sources.length - a.sources.length;
      if (bySize !== 0) return bySize;
      return a.label.localeCompare(b.label, "tr");
    });

  const totalSourceCount = uniqueSources.length;
  const taggedShare = totalSourceCount > 0 ? taggedSourceCount / totalSourceCount : 0;
  const topGroup = groups[0] ?? null;
  const dominant =
    topGroup && taggedSourceCount > 0 && topGroup.sources.length / taggedSourceCount >= 0.5
      ? topGroup
      : null;

  return { groups, taggedSourceCount, totalSourceCount, taggedShare, dominant };
}
