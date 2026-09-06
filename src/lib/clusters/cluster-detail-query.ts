import { cacheLife, cacheTag } from "next/cache";

import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import { wireSignalOf, type WireSignal } from "@/lib/clusters/wire";
import { createServerClient } from "@/lib/supabase/server";
import type { BiasCategory, BiasDistribution, Source } from "@/types";

// Cluster detail fetcher used by /clusters/[id].
//
// Perf strategy:
//   The page needs three things: the cluster row, its member articles
//   (with their sources), and the full 144-source directory for the
//   MediaDNA grid. A naive implementation would do 4 sequential round-
//   trips (cluster → cluster_articles → articles → sources). This module
//   collapses that to two parallel round-trips by using a PostgREST
//   embedded select for members (cluster_articles → articles → sources
//   in one shot) and firing the sources directory query alongside it
//   with Promise.all.
//
//   Wrapped in `unstable_cache` with a 30s TTL keyed per cluster id so
//   repeat hits within the TTL skip Supabase entirely.

export interface ClusterDetailMember {
  source: Source;
  article: {
    id: string;
    title: string;
    url: string;
    published_at: string;
    image_url: string | null;
    content_hash: string | null;
  };
}

export interface ClusterDetail {
  cluster: {
    id: string;
    title_tr: string;
    summary_tr: string;
    article_count: number;
    bias_distribution: BiasDistribution;
    is_blindspot: boolean;
    blindspot_side: BiasCategory | null;
    first_published: string;
    updated_at: string;
  };
  members: ClusterDetailMember[];
  allSources: Source[]; // all 144, for MediaDNA rendering
  wire: WireSignal;
}

// Row shape of the cluster query. Matches the columns selected below.
// `bias_distribution` is stored as Postgres jsonb, so we type it as `unknown`
// at the query boundary and narrow via `normalizeDistribution` before
// exposing it to the page renderer.
type ClusterRow = {
  id: string;
  title_tr: string;
  /**
   * H2-WORKER neutral-headline pipeline (migration 019 + headline-worker.mjs):
   * the LLM-rewritten neutral version of `title_tr`. NULL until the rewrite
   * worker has processed the cluster. We coalesce
   * `title_tr_neutral ?? title_tr` at render time so neutralized titles
   * win as soon as they exist without overwriting the original.
   */
  title_tr_neutral: string | null;
  summary_tr: string;
  article_count: number;
  bias_distribution: unknown;
  is_blindspot: boolean;
  blindspot_side: BiasCategory | null;
  first_published: string;
  updated_at: string;
};

/**
 * Narrow the jsonb `bias_distribution` blob into a strongly typed
 * `BiasDistribution`. The cluster pipeline writes the canonical shape but we
 * still validate at the query boundary so a stale row, an admin-side hand
 * edit, or a future schema change can never crash the renderer.
 */
function normalizeDistribution(raw: unknown): BiasDistribution {
  const empty = emptyBiasDistribution();
  if (!raw || typeof raw !== "object") return empty;
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(empty) as BiasCategory[]) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      empty[key] = v;
    }
  }
  return empty;
}

// Shape returned by the embedded PostgREST select for cluster members.
// cluster_articles → articles (one) → sources (one). PostgREST returns
// the nested relations as objects (not arrays) because the FK is
// single-valued (many-to-one).
type EmbeddedSourceRow = {
  id: string;
  name: string;
  slug: string;
  url: string;
  rss_url: string;
  bias: BiasCategory;
  logo_url: string | null;
  active: boolean;
};

type EmbeddedArticleRow = {
  id: string;
  title: string;
  url: string;
  published_at: string;
  image_url: string | null;
  content_hash: string | null;
  source: EmbeddedSourceRow | null;
};

type EmbeddedClusterArticleRow = {
  article: EmbeddedArticleRow | null;
};

// Internal (uncached) implementation. The exported `getClusterDetail`
// wraps this with `unstable_cache` below.
async function fetchClusterDetail(id: string): Promise<ClusterDetail | null> {
  try {
    const supabase = createServerClient();

    // Two parallel round-trips:
    //   (a) cluster row + its members (embedded articles + sources)
    //   (b) full sources directory for MediaDNA
    //
    // (a) is actually two PostgREST calls fired in parallel inside the
    // outer Promise.all — one for the cluster row and one for the
    // embedded cluster_articles tree. We keep them split because a
    // single embed from `clusters` would pull the same cluster columns
    // back in every member row, and because a missing cluster needs to
    // short-circuit with a `null` return before we render.
    const [clusterRes, membersRes, sourcesRes] = await Promise.all([
      supabase
        .from("clusters")
        .select(
          "id, title_tr, title_tr_neutral, summary_tr, article_count, bias_distribution, is_blindspot, blindspot_side, first_published, updated_at"
        )
        .eq("id", id)
        .maybeSingle<ClusterRow>(),
      supabase
        .from("cluster_articles")
        .select(
          `article:articles (
             id, title, url, published_at, image_url, content_hash,
             source:sources ( id, name, slug, url, rss_url, bias, logo_url, active )
           )`
        )
        .eq("cluster_id", id)
        .returns<EmbeddedClusterArticleRow[]>(),
      supabase
        .from("sources")
        .select("id, name, slug, url, rss_url, bias, logo_url, active")
        .eq("active", true)
        .order("name")
        .returns<Source[]>(),
    ]);

    if (clusterRes.error) {
      // Throw — returning null here reads as "no such cluster", the page
      // calls notFound(), and `"use cache"` pins that null for the detail
      // TTL: a real cluster would serve a cached 404 for minutes after a
      // transient failure. A throw keeps the bad result out of the cache.
      throw new Error(
        `[cluster-detail] cluster query error: ${clusterRes.error.message}`
      );
    }
    if (!clusterRes.data) {
      // No such cluster — let the page call `notFound()`.
      return null;
    }

    if (membersRes.error) {
      // Members are the page's content — a memberless detail must not be
      // rendered and cached. Same rationale as the cluster query above.
      throw new Error(
        `[cluster-detail] members query error: ${membersRes.error.message}`
      );
    }
    if (sourcesRes.error) {
      // Supplemental only (MediaDna source-directory dimming) — degrade to
      // an empty list rather than failing the whole page.
      console.warn(
        "[cluster-detail] sources query error:",
        sourcesRes.error.message
      );
    }

    const clusterRow = clusterRes.data;

    // Normalize the embedded shape to the ClusterDetailMember contract.
    // Drop rows where the embedded article or its source is null —
    // those would indicate a dangling FK which shouldn't happen, but
    // we guard defensively rather than crash the page.
    const members: ClusterDetailMember[] = [];
    for (const row of membersRes.data ?? []) {
      const article = row.article;
      if (!article) continue;
      const source = article.source;
      if (!source) continue;
      members.push({
        source: {
          id: source.id,
          name: source.name,
          slug: source.slug,
          url: source.url,
          rss_url: source.rss_url,
          bias: source.bias,
          logo_url: source.logo_url,
          active: source.active,
        },
        article: {
          id: article.id,
          title: article.title,
          url: article.url,
          published_at: article.published_at,
          image_url: article.image_url,
          content_hash: article.content_hash,
        },
      });
    }

    // Sort by published_at ASC FIRST so the dedupe pass below
    // deterministically keeps the EARLIEST article per source.
    const sortedMembers = [...members].sort(
      (a, b) =>
        new Date(a.article.published_at).getTime() -
        new Date(b.article.published_at).getTime()
    );

    // Server-side dedupe (defense in depth):
    // If the cluster has multiple articles from the same source, keep
    // the earliest one. R2's audit found 1.87% of clusters have this —
    // the proper DB fix is D6, this is a guard so the UI never receives
    // the same (cluster_id, source_id) pair twice.
    const seenSources = new Set<string>();
    const dedupedMembers: ClusterDetailMember[] = [];
    for (const m of sortedMembers) {
      if (seenSources.has(m.source.id)) continue;
      seenSources.add(m.source.id);
      dedupedMembers.push(m);
    }
    const droppedDupes = sortedMembers.length - dedupedMembers.length;
    if (droppedDupes > 0) {
      console.log(
        `[cluster-detail-query] dropped ${droppedDupes} duplicate source(s) for cluster ${id}`
      );
    }

    // Re-sort newest-first for display — matches the /clusters list ordering.
    dedupedMembers.sort(
      (a, b) =>
        new Date(b.article.published_at).getTime() -
        new Date(a.article.published_at).getTime()
    );

    return {
      cluster: {
        id: clusterRow.id,
        // H2 neutral-headline coalesce: prefer the LLM-rewritten neutral
        // title once H2-WORKER has produced it. Falls back to the original
        // seed-inherited title for clusters that haven't been rewritten yet.
        // Empty strings are coalesced too — an empty neutral title means
        // the rewriter wrote junk and we'd rather show the original.
        title_tr:
          clusterRow.title_tr_neutral && clusterRow.title_tr_neutral.trim().length > 0
            ? clusterRow.title_tr_neutral
            : clusterRow.title_tr,
        summary_tr: clusterRow.summary_tr,
        // The DB-stored article_count may be stale between the recluster
        // pass and this page render. Reflect the post-dedupe truth.
        article_count: dedupedMembers.length,
        bias_distribution: normalizeDistribution(clusterRow.bias_distribution),
        is_blindspot: clusterRow.is_blindspot,
        blindspot_side: clusterRow.blindspot_side,
        first_published: clusterRow.first_published,
        updated_at: clusterRow.updated_at,
      },
      members: dedupedMembers,
      allSources: sourcesRes.data ?? [],
      wire: wireSignalOf(
        dedupedMembers.map((m) => ({
          id: m.article.id,
          content_hash: m.article.content_hash,
        }))
      ),
    };
  } catch (err) {
    // Rethrow — swallowing to null would cache a 404 for a real cluster.
    console.warn("[cluster-detail] unexpected error:", err);
    throw err;
  }
}

// Public cached entry point. With Cache Components the `id` argument
// is automatically part of the cache key — no per-id wrapper Map needed.
// Callers / workers can invalidate a single cluster with
// `revalidateTag(\`cluster-detail:\${id}\`)`.
export async function getClusterDetail(
  id: string
): Promise<ClusterDetail | null> {
  "use cache";
  cacheLife("cluster-feed");
  cacheTag(`cluster-detail:${id}`, "clusters");
  return fetchClusterDetail(id);
}
