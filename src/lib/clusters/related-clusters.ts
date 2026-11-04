import { headlineLang, sourceLang } from "@/lib/sources/source-language";
import {
  isContentlessTitle,
  repairEntityResidue,
} from "../../../supabase/functions/_shared/rss/entities";
import {
  isTopicSlug,
  TOPIC_LABELS_TR,
  type TopicSlug,
} from "./topic-query";

// "İlgili haberler": the block at the end of an indexable cluster page that
// lists other recent multi-article clusters on the same topic. Pure helpers
// only: no I/O and no clock. The page reads an existing cached feed and hands
// the bundles here; nothing in this file fetches.
//
// Imports are constants and types only (topic-query's slug list and labels,
// the entity helpers the page already uses, the language helpers the cards
// use), so the unit tests need no mocks.

/** The most stories the block ever lists. */
export const RELATED_MAX = 5;

/**
 * Which existing feed a cluster's topic reads. A hub slug reads /konu/<slug>
 * page 1 (the same cache entry as the hub page and its RSS); 'politika' has no
 * hub and reads the home feed.
 */
export type RelatedFeed =
  | { kind: "topic"; slug: TopicSlug }
  | { kind: "politika" };

/**
 * The feed for a stored `clusters.topic7`, or null when there is none. Exact
 * match only: 'POLITIKA', '', a number, null and any unknown value give null
 * (no block), so a stale cache entry without the field degrades to nothing.
 */
export function relatedFeedFor(topic7: unknown): RelatedFeed | null {
  if (typeof topic7 !== "string") return null;
  if (topic7 === "politika") return { kind: "politika" };
  if (isTopicSlug(topic7)) return { kind: "topic", slug: topic7 };
  return null;
}

/**
 * The hub link under the list. 'politika' links to '/': /konu/politika 308s
 * there, and the home feed already IS the politics feed.
 */
export function relatedHubLink(feed: RelatedFeed): { href: string; label: string } {
  if (feed.kind === "politika") {
    return { href: "/", label: "Tüm Politika haberleri" };
  }
  return {
    href: `/konu/${feed.slug}`,
    label: `Tüm ${TOPIC_LABELS_TR[feed.slug]} haberleri`,
  };
}

/** The Turkish topic name for the "<Konu> konusunda son haberler" line. */
export function relatedTopicLabel(feed: RelatedFeed): string {
  return feed.kind === "politika" ? "Politika" : TOPIC_LABELS_TR[feed.slug];
}

export interface RelatedCluster {
  id: string;
  title: string;
  sourceCount: number;
  /** 'en' only when the headline is an English outlet's own article title. */
  lang: "en" | undefined;
}

/**
 * What a candidate needs. Structural, so a `ClusterBundle` (the feeds' element
 * type) satisfies it as is; every extra field is optional because the feeds'
 * cluster rows carry neither `topic7`, `is_archived` nor `merged_into`.
 */
export interface RelatedCandidate {
  cluster: {
    id: string;
    title_tr: string;
    article_count: number;
    updated_at: string;
    is_archived?: boolean | null;
    merged_into?: string | null;
    topic7?: string | null;
  };
  effectiveArticleCount?: number;
  articles?: readonly { title: string; source_id: string; source_name?: string }[];
  sources?: readonly { id: string; name: string; slug?: string | null }[];
}

/** Lower-cased (Turkish rules) with whitespace runs collapsed, for comparing titles. */
function foldTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLocaleLowerCase("tr-TR");
}

/**
 * The `lang` of a candidate's headline, by the rule ClusterCard uses: an
 * unneutralised cluster headline IS one member's title, so it is English only
 * when an English outlet's article carries exactly that title and no Turkish
 * outlet does. undefined when the articles or the sources are not available.
 */
function langOfCandidate(title: string, c: RelatedCandidate): "en" | undefined {
  const { articles, sources } = c;
  if (!articles || !sources) return undefined;
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  return headlineLang(
    title,
    articles.map((a) => {
      const src = sourceById.get(a.source_id);
      return {
        title: typeof a.title === "string" ? repairEntityResidue(a.title) : "",
        lang: sourceLang({ slug: src?.slug, name: a.source_name ?? src?.name }),
      };
    }),
  );
}

interface Kept {
  key: string;
  ms: number;
  item: RelatedCluster;
}

/**
 * Up to `max` (never more than RELATED_MAX) other stories from a feed, newest
 * first. Drops, in this order: the page's own cluster, anything under two
 * articles, archived and merged clusters, a different `topic7`, a contentless
 * title, a title equal to the current one (a duplicate-looking story) and a
 * repeated id (the first occurrence wins). Then sorts a COPY by `updated_at`
 * descending (an unparseable date last), equal dates by id descending, the
 * order fetchTopicClusters uses. Never mutates its input.
 */
export function selectRelatedClusters(args: {
  currentId: string;
  currentTitle: string;
  topic: string;
  bundles: readonly RelatedCandidate[];
  max?: number;
}): RelatedCluster[] {
  const requested =
    typeof args.max === "number" && !Number.isNaN(args.max)
      ? Math.trunc(args.max)
      : RELATED_MAX;
  const limit = Math.max(0, Math.min(requested, RELATED_MAX));
  if (limit === 0) return [];

  const currentKey = String(args.currentId).toLowerCase();
  const currentTitle = foldTitle(repairEntityResidue(String(args.currentTitle)));

  const seen = new Set<string>();
  const kept: Kept[] = [];
  for (const c of args.bundles) {
    const cluster = c?.cluster;
    if (!cluster || typeof cluster.id !== "string" || typeof cluster.title_tr !== "string") {
      continue;
    }
    const key = cluster.id.toLowerCase();
    if (key === currentKey) continue;
    // `!(n >= 2)` also drops a missing or NaN count.
    if (!(cluster.article_count >= 2)) continue;
    if (cluster.is_archived === true || cluster.merged_into) continue;
    if (typeof cluster.topic7 === "string" && cluster.topic7 !== args.topic) continue;

    const title = repairEntityResidue(cluster.title_tr).trim();
    if (isContentlessTitle(title)) continue;
    if (foldTitle(title) === currentTitle) continue;

    if (seen.has(key)) continue;
    seen.add(key);

    const effective = c.effectiveArticleCount;
    kept.push({
      key,
      ms: Date.parse(cluster.updated_at),
      item: {
        id: cluster.id,
        title,
        sourceCount:
          typeof effective === "number" && Number.isFinite(effective)
            ? effective
            : cluster.article_count,
        lang: langOfCandidate(title, c),
      },
    });
  }

  kept.sort((a, b) => {
    const aBad = Number.isNaN(a.ms);
    const bBad = Number.isNaN(b.ms);
    if (aBad !== bBad) return aBad ? 1 : -1;
    if (!aBad && a.ms !== b.ms) return b.ms - a.ms;
    if (a.key === b.key) return 0;
    return a.key < b.key ? 1 : -1;
  });

  return kept.slice(0, limit).map((k) => k.item);
}
