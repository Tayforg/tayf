// Pure view-model for /karsilastir: turns each side's parsed param plus its
// settled fetch into a SideState the page renders without any branching on
// transport errors, and builds the per-zone source roster.

import { zoneOf } from "@/lib/bias/config";
import type {
  ClusterDetail,
  ClusterDetailMember,
} from "@/lib/clusters/cluster-detail-query";
import { partitionByVote } from "@/lib/sources/kind";
import {
  clusterTextLang,
  headlineLang as memberHeadlineLang,
  isLanguageIsolatedCluster,
  sourceLang,
} from "@/lib/sources/source-language";
import type { BiasDistribution, MediaDnaZone } from "@/types";
import { isContentlessTitle } from "../../../supabase/functions/_shared/rss/entities";

import { COMPARE_UUID_RE, type ParsedSide } from "./compare-params";

/** The wire facts the cluster page prints as its violet badge. */
export interface SideWire {
  isWire: boolean;
  memberCount: number;
  /** Distinct texts: the cluster's `effectiveArticleCount`. */
  uniqueTexts: number;
}

export interface SideView {
  id: string;
  title: string;
  isBlindspot: boolean;
  distribution: BiasDistribution;
  sourceCount: number;
  firstPublished: string;
  roster: Record<MediaDnaZone, string[]>;
  nonVoting: string[];
  /**
   * Zones a toplayıcı / niş member sits in, deduped, in ZONES order. Words
   * only: an empty roster reads "no source the spectrum counts" for these
   * instead of "no source" (h78-compare-1).
   */
  nonVotingZones: MediaDnaZone[];
  wire: SideWire;
  /**
   * True when EVERY member (voting or not) is an English-language outlet: such
   * a cluster never met the Turkish zones, so an empty zone reads "not compared
   * with Turkish sources", not "no source" (h110-karsilastir-1; the cluster
   * page's `isLanguageIsolatedCluster`).
   */
  languageIsolated: boolean;
  /**
   * Zones Jev's recall stage matched with this story's event, already cut down
   * to the cluster page's empty columns (`ClusterDetail.recallMatchedZones`).
   * [] for a detail cached before the field existed or after a failed lookup.
   * Words only: an empty roster of such a zone reads "benzer haber başka
   * kümede olabilir" instead of "no source".
   */
  recallMatchedZones: MediaDnaZone[];
  /**
   * `'en'` when the headline is English text on a Turkish page (WCAG 3.1.2),
   * otherwise undefined so React omits the attribute. The cluster page's rule
   * for its <h1>: never for the neutral LLM rewrite or a contentless title,
   * else the all-English member rule, else the headline-is-a-member's-title rule.
   */
  headlineLang: "en" | undefined;
}

export type SideState =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "duplicate" }
  | { kind: "not_found" }
  | { kind: "unavailable" }
  | { kind: "merged"; survivorId: string }
  | { kind: "ok"; view: SideView };

const ZONES: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

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
 * `nonVotingZones` is the same fact as the cluster page's set: the zones those
 * non-voting members belong to, in ZONES order.
 */
export function rosterByZone(
  members: readonly Pick<ClusterDetailMember, "source">[],
): {
  roster: Record<MediaDnaZone, string[]>;
  nonVoting: string[];
  nonVotingZones: MediaDnaZone[];
} {
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

  const nonVotingZoneSet = new Set<MediaDnaZone>(
    nonVoting.map((m) => zoneOf(m.source.bias)),
  );

  return {
    roster: {
      iktidar: sortedNames(byZone.iktidar.values()),
      bagimsiz: sortedNames(byZone.bagimsiz.values()),
      muhalefet: sortedNames(byZone.muhalefet.values()),
    },
    nonVoting: uniqueNames(nonVoting),
    nonVotingZones: ZONES.filter((zone) => nonVotingZoneSet.has(zone)),
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

  const { roster, nonVoting, nonVotingZones } = rosterByZone(members);
  const sources = members.map((m) => m.source);
  // Same rule as the cluster page's <h1> (src/app/cluster/[id]/page.tsx): the
  // LLM rewrite and a title with no letter or digit are never English text.
  const headlineLang =
    cluster.title_method === "llm" || isContentlessTitle(cluster.title_tr)
      ? undefined
      : (clusterTextLang(sources) ??
        memberHeadlineLang(
          cluster.title_tr,
          members.map((m) => ({ title: m.article.title, lang: sourceLang(m.source) })),
        ));
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
      nonVotingZones,
      wire: {
        isWire: wire.isWireRedistribution,
        memberCount: wire.memberCount,
        uniqueTexts: wire.effectiveArticleCount,
      },
      languageIsolated: isLanguageIsolatedCluster(sources),
      recallMatchedZones: detail.recallMatchedZones ?? [],
      headlineLang,
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
