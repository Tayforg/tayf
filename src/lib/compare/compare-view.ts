// Pure view-model for /karsilastir: turns each side's parsed param plus its
// settled fetch into a SideState the page renders without any branching on
// transport errors, and builds the per-zone source roster.

import type { SourceKunyeSource } from "@/components/story/source-kunye";
import { sourceProfileHref } from "@/components/story/source-profile-link";
import { zoneOf } from "@/lib/bias/config";
import { uniqueSources } from "@/lib/bias/zone-summary";
import type {
  ClusterDetail,
  ClusterDetailMember,
} from "@/lib/clusters/cluster-detail-query";
import { getSourceMetadata } from "@/lib/sources/factuality";
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

/**
 * One outlet in a roster line: the display name plus the slug the page links to
 * `/source/<slug>` with (h138-roadmap2-4). Exactly these two fields, so nothing
 * else of the source row reaches the roster.
 */
export interface RosterSource {
  slug: string;
  name: string;
}

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
  roster: Record<MediaDnaZone, RosterSource[]>;
  nonVoting: RosterSource[];
  /**
   * The rows of the "Kaynak künyesi" strip: this side's rated outlets, one per
   * slug, in member order, exactly what the cluster page passes <SourceKunye>
   * (`kunyeSources`). [] when no member outlet carries factuality / ownership
   * metadata.
   */
  kunyeSources: SourceKunyeSource[];
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

function sortedSources(sources: Iterable<RosterSource>): RosterSource[] {
  return Array.from(sources).sort((x, y) => x.name.localeCompare(y.name, "tr"));
}

/** One {slug, name} per source slug (an outlet can appear as many articles). */
function uniqueRosterSources(
  members: readonly Pick<ClusterDetailMember, "source">[],
): RosterSource[] {
  const bySlug = new Map<string, RosterSource>();
  for (const m of members) {
    if (!bySlug.has(m.source.slug)) {
      bySlug.set(m.source.slug, { slug: m.source.slug, name: m.source.name });
    }
  }
  return sortedSources(bySlug.values());
}

/**
 * Voting sources grouped by Medya DNA zone (via `zoneOf(source.bias)`, not a
 * second bias-to-zone mapping), plus the toplayıcı / niş sources that never
 * vote. Entries are `{slug, name}` (the slug is what the page links with); both
 * lists are deduped by slug and sorted by name with Turkish collation.
 * `nonVotingZones` is the same fact as the cluster page's set: the zones those
 * non-voting members belong to, in ZONES order.
 */
export function rosterByZone(
  members: readonly Pick<ClusterDetailMember, "source">[],
): {
  roster: Record<MediaDnaZone, RosterSource[]>;
  nonVoting: RosterSource[];
  nonVotingZones: MediaDnaZone[];
} {
  const { voting, nonVoting } = partitionByVote(members);

  const byZone: Record<MediaDnaZone, Map<string, RosterSource>> = {
    iktidar: new Map(),
    bagimsiz: new Map(),
    muhalefet: new Map(),
  };
  for (const m of voting) {
    const bucket = byZone[zoneOf(m.source.bias)];
    if (bucket && !bucket.has(m.source.slug)) {
      bucket.set(m.source.slug, { slug: m.source.slug, name: m.source.name });
    }
  }

  const nonVotingZoneSet = new Set<MediaDnaZone>(
    nonVoting.map((m) => zoneOf(m.source.bias)),
  );

  return {
    roster: {
      iktidar: sortedSources(byZone.iktidar.values()),
      bagimsiz: sortedSources(byZone.bagimsiz.values()),
      muhalefet: sortedSources(byZone.muhalefet.values()),
    },
    nonVoting: uniqueRosterSources(nonVoting),
    nonVotingZones: ZONES.filter((zone) => nonVotingZoneSet.has(zone)),
  };
}

/**
 * The outlets the "Kaynak künyesi" strip lists for a cluster: one per slug, in
 * member order, voting or not (factuality and ownership are properties of the
 * outlet, unrelated to whether its kind votes in the spectrum), kept only when
 * the outlet is hand-tagged in `SOURCE_METADATA` (`<SourceChips>` renders nothing
 * for the rest, so an untagged outlet would only add an empty row). The same
 * expression as the cluster page's `uniqueRatedSources`, so a story shows the
 * same künye on /cluster/<id> and here.
 */
export function kunyeSources<S extends { slug: string }>(
  members: readonly { source: S }[],
): S[] {
  return uniqueSources(members).filter((s) => getSourceMetadata(s.slug) !== null);
}

/**
 * Where one roster entry points and which language its name is in. `href` is
 * the same `/source/<slug>` the künye rows use (`sourceProfileHref`: it gates on
 * the slug shape the profile route accepts, which is also why no
 * `encodeURIComponent` is needed, no other page applies one) and is null for a
 * slug the route would reject, so such an entry stays plain text. `lang` is
 * `'en'` for an English-language outlet (WCAG 3.1.2, the cluster page's
 * `sourceLang`: the slug decides, the name is the fallback for a blank slug).
 */
export function rosterLinkTarget(source: RosterSource): {
  href: string | null;
  lang: "en" | undefined;
} {
  return { href: sourceProfileHref(source.slug), lang: sourceLang(source) };
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
      kunyeSources: kunyeSources(members),
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
