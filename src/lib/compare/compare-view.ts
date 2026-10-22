// Pure view-model for /karsilastir: turns each side's parsed param plus its
// settled fetch into a SideState the page renders without any branching on
// transport errors, and builds the per-zone source roster.

import { zoneOf } from "@/lib/bias/config";
import type {
  ClusterDetail,
  ClusterDetailMember,
} from "@/lib/clusters/cluster-detail-query";
import { partitionByVote } from "@/lib/sources/kind";
import type { BiasDistribution, MediaDnaZone } from "@/types";

import { COMPARE_UUID_RE, type ParsedSide } from "./compare-params";

export interface SideView {
  id: string;
  title: string;
  isBlindspot: boolean;
  distribution: BiasDistribution;
  sourceCount: number;
  firstPublished: string;
  roster: Record<MediaDnaZone, string[]>;
  nonVoting: string[];
}

export type SideState =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "duplicate" }
  | { kind: "not_found" }
  | { kind: "unavailable" }
  | { kind: "merged"; survivorId: string }
  | { kind: "ok"; view: SideView };

function sortedNames(names: Iterable<string>): string[] {
  return Array.from(names).sort((x, y) => x.localeCompare(y, "tr"));
}

/** One display name per source slug (an outlet can appear as many articles). */
function uniqueNames(
  members: readonly Pick<ClusterDetailMember, "source">[],
): string[] {
  const bySlug = new Map<string, string>();
  for (const m of members) {
    if (!bySlug.has(m.source.slug)) bySlug.set(m.source.slug, m.source.name);
  }
  return sortedNames(bySlug.values());
}

/**
 * Voting sources grouped by Medya DNA zone (via `zoneOf(source.bias)`, not a
 * second bias-to-zone mapping), plus the toplayıcı / niş names that never
 * vote. Both lists are deduped by slug and sorted with Turkish collation.
 */
export function rosterByZone(
  members: readonly Pick<ClusterDetailMember, "source">[],
): { roster: Record<MediaDnaZone, string[]>; nonVoting: string[] } {
  const { voting, nonVoting } = partitionByVote(members);

  const byZone: Record<MediaDnaZone, Map<string, string>> = {
    iktidar: new Map(),
    bagimsiz: new Map(),
    muhalefet: new Map(),
  };
  for (const m of voting) {
    const bucket = byZone[zoneOf(m.source.bias)];
    if (bucket && !bucket.has(m.source.slug)) {
      bucket.set(m.source.slug, m.source.name);
    }
  }

  return {
    roster: {
      iktidar: sortedNames(byZone.iktidar.values()),
      bagimsiz: sortedNames(byZone.bagimsiz.values()),
      muhalefet: sortedNames(byZone.muhalefet.values()),
    },
    nonVoting: uniqueNames(nonVoting),
  };
}

export function toSideState(
  parsed: ParsedSide,
  settled?: PromiseSettledResult<ClusterDetail | null>,
): SideState {
  if (parsed.kind !== "id") return { kind: parsed.kind };
  // A rejected read (cold DB, timeout) is "try again", never "no such story".
  if (!settled || settled.status === "rejected") return { kind: "unavailable" };

  const detail = settled.value;
  if (!detail) return { kind: "not_found" };

  const { cluster, members, wire } = detail;
  if (cluster.merged_into) {
    const survivorId = cluster.merged_into.trim().toLowerCase();
    // Only a well-formed id that is not this cluster itself may reach an href.
    return COMPARE_UUID_RE.test(survivorId) && survivorId !== parsed.id
      ? { kind: "merged", survivorId }
      : { kind: "not_found" };
  }

  const { roster, nonVoting } = rosterByZone(members);
  return {
    kind: "ok",
    view: {
      id: parsed.id,
      title: cluster.title_tr,
      isBlindspot: cluster.is_blindspot,
      distribution: cluster.bias_distribution,
      sourceCount: wire.effectiveArticleCount,
      firstPublished: cluster.first_published,
      roster,
      nonVoting,
    },
  };
}

const ISTANBUL_DATE_TIME = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Europe/Istanbul",
});

/** "22 Ekim 2026 14:05" in Istanbul time; '' for anything unparseable. */
export function formatIstanbulDateTime(iso: string): string {
  if (typeof iso !== "string" || iso.length === 0) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return ISTANBUL_DATE_TIME.format(date);
}
