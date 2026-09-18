import { cacheLife, cacheTag } from "next/cache";

import { zoneOf } from "@/lib/bias/config";
import { sourceKindOf } from "@/lib/sources/kind";
import { createServerClient } from "@/lib/supabase/server";
import type { BiasCategory, MediaDnaZone, SourceKind } from "@/types";
import { isGameEligibleTitle } from "./pii-filter";

// /oyun's headline pool — the pick. Mirrors the embedded-select shape
// blindspots-query.ts / politics-query.ts already use (clusters →
// cluster_articles → articles → sources in one round-trip) rather than
// inventing a different query shape for this one surface.
//
// All FIVE filter rules (48h window, article_count >= 3, one headline per
// outlet, wire-source exclusion, PII filter) live in the pure
// `selectGameHeadlines` below — same "fetch broad, filter in JS" split
// blindspots-query.ts uses, so this is unit-testable without Supabase and
// the async wrapper stays a thin fetch + delegate.

export interface GameHeadline {
  articleId: string;
  sourceId: string;
  title: string;
  sourceName: string;
  sourceSlug: string;
  bias: BiasCategory;
  zone: MediaDnaZone;
}

export interface GameSourceRow {
  id: string;
  name: string;
  slug: string;
  bias: BiasCategory;
  kind?: SourceKind | null;
  active: boolean;
}

export interface GameArticleRow {
  id: string;
  title: string;
  published_at: string;
  source_id: string;
  sources: GameSourceRow | null;
}

export interface GameClusterArticleRow {
  articles: GameArticleRow | null;
}

export interface GameClusterRow {
  article_count: number;
  cluster_articles: GameClusterArticleRow[] | null;
}

const WINDOW_HOURS = 48;
const DEFAULT_LIMIT = 10;
// Broad DB-side candidate window — same order of magnitude as
// blindspots-query.ts's CANDIDATE_LIMIT — so a cheap `article_count >= 3`
// prefilter doesn't drag in the entire clusters table.
const CANDIDATE_LIMIT = 200;

/**
 * PURE. Applies every /oyun eligibility rule — 48h window, article_count >=
 * 3, source.active, wire-kind exclusion, one headline per outlet, and the
 * PII filter (per pii-filter.ts's "before sampling" ordering rule) — and
 * returns the FULL eligible candidate list, unshuffled and uncapped. No
 * Supabase dependency, so it's unit-testable with plain fixtures.
 *
 * Deliberately does NOT shuffle or cap: this runs inside the cached
 * `getGameHeadlines` call graph (5-minute `cacheLife`), so randomising here
 * would freeze the same draw for every visitor for the whole cache window.
 * Use `sampleHeadlines` per-request instead — see that function's doc
 * comment.
 */
export function selectGameHeadlines(
  rows: readonly GameClusterRow[],
): GameHeadline[] {
  const cutoffMs = Date.now() - WINDOW_HOURS * 3_600_000;
  const seenSourceIds = new Set<string>();
  const candidates: GameHeadline[] = [];

  for (const cluster of rows) {
    if (cluster.article_count < 3) continue;

    for (const clusterArticle of cluster.cluster_articles ?? []) {
      const article = clusterArticle.articles;
      if (!article) continue;

      const source = article.sources;
      if (!source) continue;
      if (!source.active) continue;
      // Uses the shared normalization helper (never a raw `=== "wire"` on
      // the un-normalized column) so legacy/null `kind` values fall back
      // to "outlet" the same way every other reader consistently does.
      if (sourceKindOf({ kind: source.kind ?? undefined }) === "wire") continue;

      const publishedMs = new Date(article.published_at).getTime();
      if (!Number.isFinite(publishedMs) || publishedMs < cutoffMs) continue;

      if (seenSourceIds.has(source.id)) continue;

      // PII filter runs before this headline ever enters the candidate
      // pool that gets sampled from — never after.
      if (!isGameEligibleTitle(article.title)) continue;

      seenSourceIds.add(source.id);
      candidates.push({
        articleId: article.id,
        sourceId: source.id,
        title: article.title,
        sourceName: source.name,
        sourceSlug: source.slug,
        bias: source.bias,
        zone: zoneOf(source.bias),
      });
    }
  }

  return candidates;
}

/**
 * PURE. Shuffles the full eligible candidate list (Fisher-Yates) and caps
 * it at `limit`. Call this OUTSIDE the cached call graph — per request, not
 * per cache window — so every visitor (and every replay within a 5-minute
 * cache window) gets their own draw instead of the whole window sharing one
 * `Math.random()` call. No cryptographic requirement.
 */
export function sampleHeadlines(
  candidates: readonly GameHeadline[],
  limit: number = DEFAULT_LIMIT,
): GameHeadline[] {
  const copy = [...candidates];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as GameHeadline, copy[i] as GameHeadline];
  }
  return copy.slice(0, limit);
}

async function fetchGameHeadlinePool(): Promise<GameHeadline[]> {
  try {
    const supabase = createServerClient();

    const { data, error } = await supabase
      .from("clusters")
      .select(
        `article_count,
         cluster_articles (
           articles (
             id, title, published_at, source_id,
             sources ( id, name, slug, bias, kind, active )
           )
         )`,
      )
      .eq("is_archived", false)
      .gte("article_count", 3)
      .order("updated_at", { ascending: false })
      .limit(CANDIDATE_LIMIT)
      .returns<GameClusterRow[]>();

    if (error) {
      // Fail-open: unlike blindspots-query.ts (where a cached empty result
      // would poison the feed for the cache window), an empty /oyun pool
      // just shows an honest "şu an oynanacak başlık yok" state. Never
      // throw inside `"use cache"`.
      console.error("[oyun] headline pool select error", error.message);
      return [];
    }

    return selectGameHeadlines(data ?? []);
  } catch (err) {
    console.error("[oyun] unexpected headline pool error", err);
    return [];
  }
}

// Public cached entry point. Caches the ELIGIBLE POOL (every candidate that
// passes `selectGameHeadlines`'s five rules), not the game's final 10 —
// reuses the existing "cluster-feed" profile (5-minute revalidate) rather
// than adding a new next.config.ts cacheLife entry for one surface. The
// per-request sample (which 10, in which order) is drawn by the caller via
// `sampleHeadlines`, so it rotates on every request even while this pool
// stays cached.
export async function getGameHeadlines(): Promise<GameHeadline[]> {
  "use cache";
  cacheLife("cluster-feed");
  cacheTag("articles");
  return fetchGameHeadlinePool();
}
