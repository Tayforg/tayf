import { cacheLife, cacheTag } from "next/cache";

import type {
  ClusterCardArticle,
  ClusterCardCluster,
  ClusterCardSource,
} from "@/components/story/cluster-card";
import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import { BLINDSPOT } from "@/lib/bias/config";
import {
  dedupeBySource,
  passesFeedFilters,
  zoneTallyOf,
  type EmbeddedArticle,
} from "@/lib/clusters/blindspot-feed";
import { wireSignalOf } from "@/lib/clusters/wire";
import { createServerClient } from "@/lib/supabase/server";
import type { BiasCategory, BiasDistribution, MediaDnaZone } from "@/types";

// Fetcher for /blindspots — extracted out of the page component so the
// cluster-page.test.ts-style unit tests can exercise it without rendering
// JSX, and so other surfaces (e.g. the weekly digest cron) can reuse the
// same "most lopsided" query. Behaviour is unchanged from the inline
// version this replaced.
//
// A "kör nokta" is a cluster where the contract's BLINDSPOT rule fires:
// ≥minSources distinct outlets, one Medya DNA zone holding ≥dominantShare
// of them (see supabase/functions/_shared/cluster/blindspot.ts). The DB's
// `is_blindspot` flag implements the same rule and is used as a cheap
// pre-filter; we still recompute the live tally after dedupe so a story
// that has since balanced out can never surface here. On top of the
// contract we keep this feed's own quality filters (SEO explainers, wire
// redistribution, dunya/politics category share) and a 24h delay so the
// absent side has time to catch up before we call something a blindspot.
const PREFILTER_MIN_ARTICLE_COUNT = 3;
const CANDIDATE_LIMIT = 200;
const DISPLAY_LIMIT = 30;

type EmbeddedClusterArticle = {
  articles: EmbeddedArticle | null;
};

type EmbeddedClusterRow = {
  id: string;
  title_tr: string;
  title_tr_neutral: string | null;
  summary_tr: string;
  bias_distribution: unknown;
  is_blindspot: boolean;
  blindspot_side: BiasCategory | null;
  article_count: number;
  first_published: string;
  updated_at: string;
  cluster_articles: EmbeddedClusterArticle[] | null;
};

export interface BlindspotBundle {
  cluster: ClusterCardCluster;
  articles: ClusterCardArticle[];
  sources: ClusterCardSource[];
  dominantZone: MediaDnaZone;
  dominantPct: number;
  isWireRedistribution: boolean;
  effectiveArticleCount: number;
}

// Internal (uncached) implementation. The exported `getBlindspots` wraps
// this with `"use cache"` below.
async function fetchBlindspots(): Promise<{ bundles: BlindspotBundle[] }> {
  try {
    const supabase = createServerClient();

    // B-FIX (A5 fix #1): only consider clusters whose first article is at
    // least 24h old. Computed as an ISO string and passed straight to the
    // PostgREST `.lt('first_published', …)` filter so the work is done in
    // the database, not after the round-trip.
    const blindspotCutoffIso = new Date(
      Date.now() - BLINDSPOT.feedDelayHours * 3600 * 1000
    ).toISOString();

    const { data, error } = await supabase
      .from("clusters")
      .select(
        `id, title_tr, title_tr_neutral, summary_tr, bias_distribution, is_blindspot, blindspot_side, article_count, first_published, updated_at,
         cluster_articles (
           articles (
             id, title, url, image_url, published_at, source_id, category, content_hash,
             sources ( id, name, bias, kind )
           )
         )`
      )
      // Cheap DB-side floor before the in-JS dedupe pass; the real
      // BLINDSPOT.minSources gate runs on the deduped, live-tallied set.
      .gte("article_count", PREFILTER_MIN_ARTICLE_COUNT)
      // The DB flag implements the same core rule as a pre-filter — the
      // live tally below still re-checks it after dedupe.
      .eq("is_blindspot", true)
      // 24-hour delay: time-lag artifacts get time to be caught up by the
      // absent side before we call them blindspots.
      .lt("first_published", blindspotCutoffIso)
      .order("updated_at", { ascending: false })
      .limit(CANDIDATE_LIMIT)
      .returns<EmbeddedClusterRow[]>();

    if (error) {
      // Throw — this fetcher is wrapped in `"use cache"`; returning an
      // empty list on a transient failure would cache "no blindspots" for
      // the full revalidate window. Same rule as politics-query.
      throw new Error(`[blindspots] embedded select error: ${error.message}`);
    }

    const clusterRows = data ?? [];
    if (clusterRows.length === 0) return { bundles: [] };

    const bundles: BlindspotBundle[] = [];

    for (const c of clusterRows) {
      const members: EmbeddedArticle[] = [];
      for (const ca of c.cluster_articles ?? []) {
        if (ca.articles) members.push(ca.articles);
      }
      if (members.length === 0) continue;

      // Same dedupe-by-source rule the politics page uses, so the zone
      // distribution is computed against unique outlets — otherwise a
      // single outlet that happens to publish twice would inflate its
      // own zone's share.
      const deduped = dedupeBySource(members);

      if (!passesFeedFilters({ title_tr: c.title_tr }, deduped).ok) continue;

      // Live tally over unique outlets — re-checked against the contract
      // so a cluster whose `is_blindspot` flag has gone stale (the story
      // balanced out since it was flagged) can never surface here.
      const tally = zoneTallyOf(deduped);
      if (
        !tally.dominantZone ||
        tally.total < BLINDSPOT.minSources ||
        tally.dominantShare < BLINDSPOT.dominantShare
      ) {
        continue;
      }
      const dominantZone: MediaDnaZone = tally.dominantZone;
      const dominantPct = tally.dominantShare;
      const wire = wireSignalOf(
        deduped.map((m) => ({ id: m.id, content_hash: m.content_hash })),
      );

      // Re-sort newest-first for the rendered list, matching ClusterCard's
      // expected ordering.
      deduped.sort(
        (a, b) =>
          new Date(b.published_at).getTime() -
          new Date(a.published_at).getTime()
      );

      const sourceMap = new Map<string, ClusterCardSource>();
      for (const m of deduped) {
        if (m.sources && !sourceMap.has(m.sources.id)) {
          sourceMap.set(m.sources.id, {
            id: m.sources.id,
            name: m.sources.name,
            bias: m.sources.bias,
          });
        }
      }

      bundles.push({
        cluster: {
          id: c.id,
          // Same coalesce as politics-query: prefer the LLM-neutralized
          // headline over the first-arriving outlet's raw framing. The
          // blindspot feed is exactly where a partisan seed title hurts
          // most. (passesFeedFilters still tests the raw title on purpose
          // — it detects the *story format*, which a rewrite doesn't change.)
          title_tr: c.title_tr_neutral ?? c.title_tr,
          summary_tr: c.summary_tr,
          bias_distribution: normalizeDistribution(c.bias_distribution),
          is_blindspot: c.is_blindspot,
          blindspot_side: c.blindspot_side,
          article_count: deduped.length,
          first_published: c.first_published,
          updated_at: c.updated_at,
        },
        articles: deduped.map((m) => ({
          id: m.id,
          title: m.title,
          url: m.url,
          image_url: m.image_url,
          published_at: m.published_at,
          source_id: m.source_id,
        })),
        sources: Array.from(sourceMap.values()),
        dominantZone,
        dominantPct,
        isWireRedistribution: wire.isWireRedistribution,
        effectiveArticleCount: wire.effectiveArticleCount,
      });

      if (bundles.length >= DISPLAY_LIMIT) break;
    }

    // Most lopsided first — a 100% iktidar cluster is a starker blindspot
    // than a 86% one and deserves the top slot.
    bundles.sort((a, b) => b.dominantPct - a.dominantPct);

    return { bundles };
  } catch (err) {
    // Rethrow — swallowing would let `use cache` store an empty page.
    console.error("[blindspots] unexpected error", err);
    throw err;
  }
}

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

// Public cached entry point. The /blindspots page and the weekly digest
// cron both call this identical signature — the cache layer is invisible
// from the call site.
export async function getBlindspots(): Promise<{ bundles: BlindspotBundle[] }> {
  "use cache";
  cacheLife("cluster-feed");
  cacheTag("clusters", "clusters-politics");
  return fetchBlindspots();
}
