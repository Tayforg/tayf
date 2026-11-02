// supabase/functions/_shared/cluster/twin-merge.ts
//
// SHADOW decision for twin clusters (h19-recall-3). Two clusters are twins when
// they hold the same story: the consumer opened the second one because the first
// was not in its context, or because the best match was below MATCH_THRESHOLD, and
// from then on both keep absorbing articles. cluster_merge_log has 0 rows ever, so
// nothing repairs them.
//
// The consumer sees the evidence for every article it clusters (each context
// cluster that scores >= TWIN_MERGE_MIN_BRIDGE_SCORE against the article) and used
// to throw it away. It now logs it in public.cluster_twin_bridges (migration 147,
// one row per article x cluster pair). twinMergeDecision() turns the rows of one
// cluster pair into a verdict: "would these two clusters be merged?". It is NEVER
// acted on: merges stay manual (/admin/birlestir) until the 48 h shadow numbers are
// compared with the operator's own decisions (docs/ops-heartbeat.md, "Twin bridges
// (147, shadow)").
//
// A "bridge" is an article of one cluster that scores >= 0.55 against the other
// cluster (the consumer's own ensemble score: seed, latest member and recent
// headlines). The rule, in this order:
//
//   same_cluster      a and b are the same cluster
//   dismissed         a cluster_merge_dismissals row exists for the pair
//   subject_veto      the two seed titles name different actors for one template
//   incident_veto     the two seed titles report incidents in different provinces
//   too_few_articles  < TWIN_MERGE_MIN_ARTICLES distinct articles at >= 0.55
//   too_few_sources   < TWIN_MERGE_MIN_SOURCES distinct non-null sources among them
//   size_cap          a.size + b.size > TWIN_MERGE_MAX_SIZE
//   would_merge       otherwise; target = the larger cluster (tie: the smaller id)
//
// Evidence: on the 24 h replay (2026-11-02) ">= 2 articles from >= 2 sources at
// >= 0.55" fires on 31 of the labelled same-story pairs and 14 of the ambiguous
// ones and on 0 of 20 different-story pairs, while a single bridge at 0.40 would
// have merged the Duzce / Bolu pile-ups.
//
// Pure: no I/O, no clock, no randomness. Imports only the two veto helpers of
// ensemble.ts, which the scoring parity tests already pin.

import { incidentVetoFires, subjectVetoFires } from "./ensemble.ts";

/** An article scores at least this against the other cluster to be evidence. */
export const TWIN_MERGE_MIN_BRIDGE_SCORE = 0.55;
/** At least this many distinct articles must be evidence. */
export const TWIN_MERGE_MIN_ARTICLES = 2;
/** At least this many distinct non-null sources must stand behind them. */
export const TWIN_MERGE_MIN_SOURCES = 2;
/** The merged cluster may not be larger than this many articles. */
export const TWIN_MERGE_MAX_SIZE = 60;

export interface TwinBridge {
  articleId: string;
  /** Opaque source key (uuid or slug); null when unknown, which never counts. */
  sourceId: string | null;
  score: number;
}

export interface TwinSide {
  id: string;
  /** The seed article's title (clusters.title_tr at creation). */
  seedTitle: string;
  /** article_count. */
  size: number;
}

export type TwinMergeReason =
  | "would_merge"
  | "same_cluster"
  | "dismissed"
  | "subject_veto"
  | "incident_veto"
  | "too_few_articles"
  | "too_few_sources"
  | "size_cap";

export interface TwinMergeDecision {
  wouldMerge: boolean;
  reason: TwinMergeReason;
  /** The cluster that would survive; null unless wouldMerge. */
  targetId: string | null;
  /** The cluster that would be merged away; null unless wouldMerge. */
  sourceId: string | null;
  /** Distinct articles at >= TWIN_MERGE_MIN_BRIDGE_SCORE (whatever the reason). */
  articles: number;
  /** Distinct non-null sources among those articles (whatever the reason). */
  sources: number;
}

function blocked(reason: TwinMergeReason, articles: number, sources: number): TwinMergeDecision {
  return { wouldMerge: false, reason, targetId: null, sourceId: null, articles, sources };
}

/**
 * Would the clusters `a` and `b` be merged, judged on `bridges` (the articles of
 * either cluster that score against the other one)? Rows with a missing article id,
 * a non-finite score or a score below TWIN_MERGE_MIN_BRIDGE_SCORE are ignored; an
 * article that appears twice counts once. `opts.dismissed` is true when
 * cluster_merge_dismissals holds the pair. The counts in the result describe the
 * evidence even when another rule decided.
 */
export function twinMergeDecision(
  bridges: readonly TwinBridge[],
  a: TwinSide,
  b: TwinSide,
  opts: { dismissed?: boolean } = {},
): TwinMergeDecision {
  const articleIds = new Set<string>();
  const sourceIds = new Set<string>();
  for (const row of bridges ?? []) {
    if (!row || typeof row.articleId !== "string" || row.articleId === "") continue;
    if (typeof row.score !== "number" || !Number.isFinite(row.score)) continue;
    if (row.score < TWIN_MERGE_MIN_BRIDGE_SCORE) continue;
    articleIds.add(row.articleId);
    if (typeof row.sourceId === "string" && row.sourceId !== "") sourceIds.add(row.sourceId);
  }
  const articles = articleIds.size;
  const sources = sourceIds.size;

  if (a.id === b.id) return blocked("same_cluster", articles, sources);
  if (opts?.dismissed === true) return blocked("dismissed", articles, sources);

  const aTitle = typeof a.seedTitle === "string" ? a.seedTitle : "";
  const bTitle = typeof b.seedTitle === "string" ? b.seedTitle : "";
  if (subjectVetoFires(aTitle, bTitle)) return blocked("subject_veto", articles, sources);
  if (incidentVetoFires(aTitle, bTitle)) return blocked("incident_veto", articles, sources);

  if (articles < TWIN_MERGE_MIN_ARTICLES) return blocked("too_few_articles", articles, sources);
  if (sources < TWIN_MERGE_MIN_SOURCES) return blocked("too_few_sources", articles, sources);
  // Fails closed on a NaN size: the comparison is false, so the cap applies.
  if (!(a.size + b.size <= TWIN_MERGE_MAX_SIZE)) return blocked("size_cap", articles, sources);

  const aIsTarget = a.size > b.size || (a.size === b.size && a.id <= b.id);
  const target = aIsTarget ? a : b;
  const source = aIsTarget ? b : a;
  return { wouldMerge: true, reason: "would_merge", targetId: target.id, sourceId: source.id, articles, sources };
}
