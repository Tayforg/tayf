import { cacheLife, cacheTag } from "next/cache";

import type {
  ClusterCardArticle,
  ClusterCardCluster,
  ClusterCardSource,
} from "@/components/story/cluster-card";
import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import { BLINDSPOT } from "@/lib/bias/config";
import { attemptCached } from "@/lib/cache-resilience";
import {
  dedupeBySource,
  passesFeedFilters,
  zoneTallyOf,
  type EmbeddedArticle,
} from "@/lib/clusters/blindspot-feed";
import {
  degradedSilentZone,
  getZoneFeedHealth,
  shouldSuppressBlindspot,
  type ZoneFeedHealth,
} from "@/lib/clusters/feed-health";
import { wireSignalOf } from "@/lib/clusters/wire";
import { createServerClient } from "@/lib/supabase/server";
import type { BiasCategory, BiasDistribution, MediaDnaZone } from "@/types";

// Names the pole zone whose degraded feeds caused a blindspot to be
// suppressed, via the shared `degradedSilentZone` helper (feed-health.ts)
// so this call site can't drift from cluster-detail-query.ts /
// politics-query.ts on which zone a suppression log names.
function logSuppression(
  clusterId: string,
  dominantZone: MediaDnaZone,
  health: ZoneFeedHealth | null | undefined,
): void {
  const silentZone = health ? degradedSilentZone(dominantZone, health) : null;
  if (!silentZone || !health) {
    // Cannot happen right after shouldSuppressBlindspot returned true (same
    // underlying condition) — kept as a total branch that logs without
    // inventing a zone rather than assuming one.
    console.log(
      `[feed-health] suppressed blindspot for cluster ${clusterId} (silent zone unknown)`,
    );
    return;
  }
  const stats = health[silentZone];
  console.log(
    `[feed-health] suppressed blindspot for cluster ${clusterId} (silent zone ${silentZone}: ${stats.healthy}/${stats.total} feeds healthy)`,
  );
}

// Fetcher for /blindspots — extracted out of the page component so the
// cluster-page.test.ts-style unit tests can exercise it without rendering
// JSX, and so other surfaces (e.g. the weekly digest cron) can reuse the
// same "most lopsided" query.
//
// reader-queries fix: the previous single embedded select ran the
// cluster_articles -> articles -> sources lateral JOIN for every one of up
// to CANDIDATE_LIMIT (200) candidate rows BEFORE the final ORDER BY/LIMIT
// could discard any of them — PostgREST/Postgres has no way to push the
// candidate-selection order-by-limit below the embed. The audit measured
// 8s statement timeouts on this shape (digest 2792684209). Splitting into
// a lean id-only Step A (cheap: the existing partial index) and a
// Step-B embed fetch BATCHED over just those ids removes the full-embed
// cost from every candidate this feed will never render.
const PREFILTER_MIN_ARTICLE_COUNT = 3;
const CANDIDATE_LIMIT = 200;
const DISPLAY_LIMIT = 30;
const EMBED_BATCH_SIZE = 50;

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
  /** Migration 071; filtered DB-side (always false on returned rows). */
  blindspot_recall_veto?: boolean | null;
  article_count: number;
  first_published: string;
  updated_at: string;
  cluster_articles: EmbeddedClusterArticle[] | null;
};

const EMBED_SELECT = `id, title_tr, title_tr_neutral, summary_tr, bias_distribution, is_blindspot, blindspot_side, blindspot_recall_veto, article_count, first_published, updated_at,
         cluster_articles (
           articles (
             id, title, url, image_url, published_at, source_id, category, content_hash, politics_admitted_at,
             sources ( id, name, bias, kind, image_allowed, excerpt_allowed )
           )
         )`;

export interface BlindspotBundle {
  cluster: ClusterCardCluster;
  articles: ClusterCardArticle[];
  sources: ClusterCardSource[];
  dominantZone: MediaDnaZone;
  dominantPct: number;
  isWireRedistribution: boolean;
  effectiveArticleCount: number;
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

/**
 * Per-row candidate -> bundle assembly, extracted verbatim (no behaviour
 * change) from the old inline loop: same-source dedupe, the feed quality
 * filter, the live zone re-tally against the BLINDSPOT contract, the
 * feed-health suppression gate (+ its log line), the BL-13 image rights
 * gate, and the ClusterCard-shaped output. Returns `null` when the
 * candidate doesn't clear the contract (or was suppressed) so the caller
 * can filter with a plain `.filter(Boolean)`-style loop.
 */
function toBlindspotBundle(
  c: EmbeddedClusterRow,
  health: ZoneFeedHealth | null,
): BlindspotBundle | null {
  const members: EmbeddedArticle[] = [];
  for (const ca of c.cluster_articles ?? []) {
    if (ca.articles) members.push(ca.articles);
  }
  if (members.length === 0) return null;

  // Same dedupe-by-source rule the politics page uses, so the zone
  // distribution is computed against unique outlets.
  const deduped = dedupeBySource(members);

  if (!passesFeedFilters({ title_tr: c.title_tr }, deduped).ok) return null;

  // Live tally over unique outlets — re-checked against the contract so a
  // cluster whose `is_blindspot` flag has gone stale can never surface.
  const tally = zoneTallyOf(deduped);
  if (
    !tally.dominantZone ||
    tally.total < BLINDSPOT.minSources ||
    tally.dominantShare < BLINDSPOT.dominantShare
  ) {
    return null;
  }
  const dominantZone: MediaDnaZone = tally.dominantZone;

  // A degraded-feed cluster never enters the /blindspots feed at all — per
  // 032_blindspot_contract_recompute.sql:21-23, blindspot_side is the side
  // that DID cover, so the silent side is the opposite pole, not
  // blindspot_side.
  if (shouldSuppressBlindspot(dominantZone, health)) {
    logSuppression(c.id, dominantZone, health);
    return null;
  }

  const dominantPct = tally.dominantShare;
  const wire = wireSignalOf(
    deduped.map((m) => ({ id: m.id, content_hash: m.content_hash })),
  );

  // Re-sort newest-first for the rendered list, matching ClusterCard's
  // expected ordering.
  deduped.sort(
    (a, b) =>
      new Date(b.published_at).getTime() - new Date(a.published_at).getTime(),
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

  return {
    cluster: {
      id: c.id,
      // H2 neutral-headline coalesce, same rule as politics-query.
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
      // BL-13 rights gate: a source that has asked Tayf not to reuse its
      // photos gets image_allowed = false — null the URL here so it can
      // never surface as a hero/card image candidate. `undefined` (legacy
      // rows/fixtures predating migration 047) is treated as allowed.
      image_url: m.sources?.image_allowed === false ? null : m.image_url,
      published_at: m.published_at,
      source_id: m.source_id,
    })),
    sources: Array.from(sourceMap.values()),
    dominantZone,
    dominantPct,
    isWireRedistribution: wire.isWireRedistribution,
    effectiveArticleCount: wire.effectiveArticleCount,
  };
}

/** Step A: the lean id-only candidate select — no embed, so the cost never
 * scales with the number of candidates that end up discarded. */
async function fetchCandidateIds(): Promise<string[]> {
  const supabase = createServerClient();
  const blindspotCutoffIso = new Date(
    Date.now() - BLINDSPOT.feedDelayHours * 3600 * 1000,
  ).toISOString();

  const { data, error } = await supabase
    .from("clusters")
    .select("id")
    .gte("article_count", PREFILTER_MIN_ARTICLE_COUNT)
    .eq("is_blindspot", true)
    .eq("blindspot_recall_veto", false)
    .eq("is_archived", false)
    .lt("first_published", blindspotCutoffIso)
    .order("updated_at", { ascending: false })
    .limit(CANDIDATE_LIMIT)
    .returns<Array<{ id: string }>>();

  if (error) {
    throw new Error(`[blindspots] candidate select error: ${error.message}`);
  }
  return (data ?? []).map((r) => r.id);
}

/** Step B: fetch the embed for one batch of ids (order/limit-free — the
 * candidate ORDER already came from Step A). */
async function fetchEmbedBatch(ids: string[]): Promise<EmbeddedClusterRow[]> {
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("clusters")
    .select(EMBED_SELECT)
    .in("id", ids)
    .returns<EmbeddedClusterRow[]>();

  if (error) {
    throw new Error(`[blindspots] embedded select error: ${error.message}`);
  }
  return data ?? [];
}

// Internal (uncached) implementation. The exported `getBlindspots` wraps
// this with `"use cache"` below.
async function fetchBlindspots(): Promise<{ bundles: BlindspotBundle[] }> {
  const ids = await fetchCandidateIds();
  if (ids.length === 0) return { bundles: [] };

  const order = new Map(ids.map((id, i) => [id, i]));
  const bundles: BlindspotBundle[] = [];
  let health: ZoneFeedHealth | null = null;

  for (let i = 0; i < ids.length && bundles.length < DISPLAY_LIMIT; i += EMBED_BATCH_SIZE) {
    const batchIds = ids.slice(i, i + EMBED_BATCH_SIZE);
    let rows: EmbeddedClusterRow[];
    if (i === 0) {
      // Fetch feed health once, alongside the FIRST batch only — every
      // later batch reuses it.
      const [fetchedHealth, batchRows] = await Promise.all([
        getZoneFeedHealth(),
        fetchEmbedBatch(batchIds),
      ]);
      health = fetchedHealth;
      rows = batchRows;
    } else {
      rows = await fetchEmbedBatch(batchIds);
    }

    const sortedRows = [...rows].sort(
      (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    );
    for (const row of sortedRows) {
      const bundle = toBlindspotBundle(row, health);
      if (bundle) bundles.push(bundle);
    }
  }

  // Most lopsided first — a 100% iktidar cluster is a starker blindspot
  // than a 86% one and deserves the top slot.
  bundles.sort((a, b) => b.dominantPct - a.dominantPct);
  return { bundles: bundles.slice(0, DISPLAY_LIMIT) };
}

// Build-safety: `attemptCached` swallows whatever `fetchBlindspots` throws
// instead of letting it cross the `"use cache: remote"` boundary — a throw
// here fails `next build`'s prerender even when every caller catches (see
// src/lib/cache-resilience.ts).
async function getBlindspotsCached() {
  "use cache: remote";
  cacheLife("cluster-feed");
  cacheTag("clusters", "clusters-politics");
  return attemptCached("blindspots-query", fetchBlindspots);
}

// Public cached entry point. The /blindspots page and the weekly digest
// cron both call this identical signature — the cache layer is invisible
// from the call site. Still THROWS on failure (unchanged contract): the
// digest cron, the social cron and rss/[topic] depend on that — they each
// catch it themselves. On a cache-attempt failure this retries the query
// live once (bypassing the cache boundary, never memoising a failure)
// before letting a genuine, still-failing outage propagate as a throw.
export async function getBlindspots(): Promise<{ bundles: BlindspotBundle[] }> {
  const attempt = await getBlindspotsCached();
  if (attempt.ok) return attempt.data;
  return fetchBlindspots();
}

export type BlindspotsResult =
  | { ok: true; bundles: BlindspotBundle[] }
  | { ok: false };

/**
 * Never-throw wrapper for /blindspots' page component — sits OUTSIDE the
 * cache boundary (mirroring search-query.ts's searchClusters) so a failure
 * is never memoised as "no blindspots" for the cache window.
 */
export async function getBlindspotsSafe(): Promise<BlindspotsResult> {
  try {
    const { bundles } = await getBlindspots();
    return { ok: true, bundles };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[blindspots] unavailable: ${message}`);
    return { ok: false };
  }
}
