import type { Metadata } from "next";
import { cacheLife, cacheTag } from "next/cache";
import { connection } from "next/server";
import { Eye } from "lucide-react";

// Own metadata so the page doesn't inherit the root layout's title and
// `canonical: "/"` (which would mark this page a duplicate of the homepage).
export const metadata: Metadata = {
  title: "Kör Noktalar",
  description:
    "Bir tarafın haberi verdiği, diğerlerinin görmezden geldiği hikâyeler. Türk medyasındaki kör noktaları tek ekranda görün.",
  alternates: { canonical: "/blindspots" },
};

import {
  ClusterCard,
  type ClusterCardArticle,
  type ClusterCardCluster,
  type ClusterCardSource,
} from "@/components/story/cluster-card";
import { PageHero } from "@/components/ui/page-hero";
import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import { BLINDSPOT, ZONE_META } from "@/lib/bias/config";
import {
  dedupeBySource,
  passesFeedFilters,
  zoneTallyOf,
  type EmbeddedArticle,
} from "@/lib/clusters/blindspot-feed";
import { wireSignalOf } from "@/lib/clusters/wire";
import { createServerClient } from "@/lib/supabase/server";
import type { BiasCategory, BiasDistribution, MediaDnaZone } from "@/types";

// /blindspots — Tayf's "Kör Noktalar" feed.
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

interface BlindspotBundle {
  cluster: ClusterCardCluster;
  articles: ClusterCardArticle[];
  sources: ClusterCardSource[];
  dominantZone: MediaDnaZone;
  dominantPct: number;
  isWireRedistribution: boolean;
  effectiveArticleCount: number;
}

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
             sources ( id, name, bias )
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

async function getBlindspots(): Promise<{ bundles: BlindspotBundle[] }> {
  "use cache";
  cacheLife("cluster-feed");
  cacheTag("clusters", "clusters-politics");
  return fetchBlindspots();
}

export default async function BlindspotsPage() {
  // connection() signals to PPR that the code below must run at request
  // time (Date.now() is non-deterministic). The loading.tsx Suspense
  // boundary provides the static shell while this streams in.
  await connection();

  const { bundles } = await getBlindspots();

  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl space-y-5">
      <PageHero
        kicker="Sadece bir tarafın gördüğü"
        title="Kör Noktalar"
        subtitle="Bir tarafın haberi verdiği, diğerlerinin görmezden geldiği hikâyeler. Diğer kaynaklar neden susuyor?"
      />

      {bundles.length === 0 ? (
        <div className="rounded-xl border border-border/60 bg-card/40 p-8 text-center">
          <p className="text-sm text-muted-foreground">
            Şu an için belirgin bir kör nokta yok. Her taraftan haberler dengeli
            dağılmış.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {bundles.map((b, i) => {
            const hoursAgo =
              (nowMs - new Date(b.cluster.updated_at).getTime()) / 3_600_000;
            const prevZone = i > 0 ? bundles[i - 1]?.dominantZone ?? null : null;
            const showDivider = i > 0 && b.dominantZone !== prevZone;
            return (
              <div key={b.cluster.id}>
                {showDivider && (
                  <div className="h-px bg-gradient-to-r from-transparent via-border/30 to-transparent my-6" />
                )}
                <div className={`animate-fade-up stagger-${i < 6 ? i + 1 : 6}`}>
                  <BlindspotCard
                    bundle={b}
                    index={i}
                    isAging={hoursAgo > 48}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface BlindspotCardProps {
  bundle: BlindspotBundle;
  index: number;
  isAging?: boolean;
}

// Composes the existing <ClusterCard> with a "Sadece X yazdı" ribbon and a
// dominant-zone tint frame. We deliberately do NOT duplicate ClusterCard's
// markup — the ribbon sits above and the tint is a parent ring + bg layer
// so any future ClusterCard tweak (e.g. layout, image rules) is inherited
// for free.
function BlindspotCard({ bundle, index, isAging }: BlindspotCardProps) {
  const meta = ZONE_META[bundle.dominantZone];
  const pct = Math.round(bundle.dominantPct * 100);
  const pctLabel = `%${pct}`;
  const chipLabel = pct < 100 ? `${pctLabel} ${meta.label}` : `Sadece ${meta.label} yazdı`;

  return (
    <div
      className={`rounded-xl border ${meta.zoneBorder} ${meta.zoneBg} p-2 sm:p-3 space-y-2`}
    >
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full ${meta.chipBg} ${meta.chipBorder} border px-2.5 py-1 text-[11px] font-serif font-semibold ${meta.chipText}`}
          >
            <Eye className="h-3 w-3" aria-hidden="true" />
            {chipLabel}
          </span>
          {pct === 100 && (
            <span className="text-[11px] text-muted-foreground">
              <span className="font-mono">{pctLabel}</span> tek tarafta
            </span>
          )}
        </div>
      </div>

      <ClusterCard
        cluster={bundle.cluster}
        articles={bundle.articles}
        sources={bundle.sources}
        index={index}
        isAging={isAging}
        isWireRedistribution={bundle.isWireRedistribution}
        effectiveArticleCount={bundle.effectiveArticleCount}
      />
    </div>
  );
}
