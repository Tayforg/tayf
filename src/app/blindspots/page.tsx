import { cacheLife, cacheTag } from "next/cache";
import { connection } from "next/server";
import { Eye } from "lucide-react";

import {
  ClusterCard,
  type ClusterCardArticle,
  type ClusterCardCluster,
  type ClusterCardSource,
} from "@/components/story/cluster-card";
import { PageHero } from "@/components/ui/page-hero";
import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import { ZONE_META, zoneOf } from "@/lib/bias/config";
import { createServerClient } from "@/lib/supabase/server";
import type {
  BiasCategory,
  BiasDistribution,
  MediaDnaZone,
  NewsCategory,
} from "@/types";

// /blindspots — Tayf's "Kör Noktalar" feed.
//
// A "kör nokta" is a story cluster where ≥85% of the participating outlets
// fall in a single Medya DNA zone (iktidar / muhalefet / bagimsiz). The
// other half of the political spectrum is essentially absent — they didn't
// cover the story at all. This is the Tayf adaptation of Ground News's
// signature "Blindspot" feature.
//
// Data path mirrors politics-query.ts: a single embedded PostgREST select
// pulls clusters → cluster_articles → articles → sources in one round-trip,
// then we filter in JS for clusters whose dominant zone share ≥ 0.85 AND
// article_count ≥ 3 (Wave-1 minimum to call something a "story" rather than
// a stray report). The shape returned is a strict superset of ClusterBundle
// so we can hand it straight to <ClusterCard> via composition.

// A6-BLINDR: loosened 0.85 → 0.80 so a 4-of-5 split (80% share)
// qualifies. At 0.85 with MIN=4 we had 3 entries; 0.80 lifted to 7;
// combined with MIN=5 this lands in the 4-6 target range. The task
// option of 0.55 was rejected as obviously destructive: a 55% lean
// is not a blindspot, it's a normal political split.
const DOMINANT_ZONE_THRESHOLD = 0.8;
// B-FIX (A5 fix #2): require ≥N distinct sources before a cluster can
// claim "the other side ignored it." A5 found all 8 of the day's
// blindspot clusters had only 3–5 articles; at that scale "absence" is
// noise, not signal. Bumped from 3 → 6 per the A5 recommendation.
// A6-BLINDR: the ≥6 gate over-corrected (8 → 0 → 1 entry). The wire
// dedup, SEO, dunya, and 24h-delay filters already carry most of the
// precision load, so loosened 6 → 5 to recover brand-presence without
// reintroducing the 3-source noise floor.
const MIN_ARTICLE_COUNT = 5;
// Pre-filter floor for the embedded select. We still pull rows with
// ≥3 articles so the in-JS dedupe pass has headroom; the real ≥6 gate
// is enforced after same-source dedupe below.
const PREFILTER_MIN_ARTICLE_COUNT = 3;
const CANDIDATE_LIMIT = 80;
const DISPLAY_LIMIT = 30;
const POLITICS_CATEGORIES: readonly NewsCategory[] = [
  "politika",
  "son_dakika",
];

// B-FIX (A5 fix #3): SEO format filter. A5 found "kimdir / kaç yaşında /
// son dakika: / canlı / ne dedi" titles are SEO search-intent explainers,
// not coverage blindspots — iktidar outlets simply don't publish
// "who-is-our-own-guy" explainers. Matching titles are dropped before
// they reach the page (e.g. bf90987a "MHP İl Başkanı … kimdir?").
const SEO_PATTERN =
  /kimdir|kaç yaşında|nedir\?|ne zaman|kaç bin|kaç tl|son dakika.*?:|canlı|ne dedi/i;

// B-FIX (A5 fix #4): wire-redistribution dedup threshold. Mirrors the
// detector R2 added to politics-query.ts: when fewer than 50% of the
// cluster's deduped members carry distinct content_hashes, the cluster
// is one AA/DHA/IHA wire copy amplified by N outlets — not N independent
// reports. Kills the b9e4047c / 536cb1d4 / 9f8704b0 wire false-positives.
const WIRE_UNIQUE_HASH_RATIO = 0.5;

// B-FIX (A5 fix #5): category guard. A5 found 959b3cfc (Pakistan /
// Ortadoğu / Oman foreign-affairs) was tagged `politika` and surfaced
// as a Turkish-politics blindspot. Drop clusters where >50% of the
// deduped members live in the `dunya` category — the substance is
// foreign affairs, not domestic politics, so a one-sided iktidar share
// is meaningless as a "blindspot."
const DUNYA_CATEGORY_SHARE_LIMIT = 0.5;

// B-FIX (A5 fix #1): 24-hour delay. A5 found 6 of 8 clusters were under
// 24h old; the time-lag artifact 805acddc was a story iktidar AND
// muhalefet covered, but the muhalefet copies hadn't clustered yet.
// Waiting 24h gives the absent side time to catch up so we only flag
// real coverage gaps. A6-BLINDR: tried 12h but it made results worse
// (3 → 0) because the `updated_at desc` + 80-candidate cap let fresh
// sub-24h clusters crowd out qualifying older ones; kept at 24h.
const BLINDSPOT_AGE_DELAY_MS = 24 * 3600 * 1000;

type EmbeddedSource = {
  id: string;
  name: string;
  bias: BiasCategory;
};

type EmbeddedArticle = {
  id: string;
  title: string;
  url: string;
  image_url: string | null;
  published_at: string;
  source_id: string;
  category: NewsCategory;
  // B-FIX (A5 fix #4): used by the wire-redistribution dedup pass below.
  // Same NULL handling as politics-query.ts: a null hash is treated as a
  // unique pseudo-hash so legacy rows aren't collapsed into wire.
  content_hash: string | null;
  sources: EmbeddedSource | null;
};

type EmbeddedClusterArticle = {
  articles: EmbeddedArticle | null;
};

type EmbeddedClusterRow = {
  id: string;
  title_tr: string;
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
}

async function fetchBlindspots(): Promise<{ bundles: BlindspotBundle[] }> {
  try {
    const supabase = createServerClient();

    // B-FIX (A5 fix #1): only consider clusters whose first article is at
    // least 24h old. Computed as an ISO string and passed straight to the
    // PostgREST `.lt('first_published', …)` filter so the work is done in
    // the database, not after the round-trip.
    const blindspotCutoffIso = new Date(
      Date.now() - BLINDSPOT_AGE_DELAY_MS
    ).toISOString();

    const { data, error } = await supabase
      .from("clusters")
      .select(
        `id, title_tr, summary_tr, bias_distribution, is_blindspot, blindspot_side, article_count, first_published, updated_at,
         cluster_articles (
           articles (
             id, title, url, image_url, published_at, source_id, category, content_hash,
             sources ( id, name, bias )
           )
         )`
      )
      // B-FIX (A5 fix #2): pre-filter floor only — the real ≥6 gate runs
      // after same-source dedupe in JS so a cluster of 7 articles from 4
      // unique outlets is correctly rejected.
      .gte("article_count", PREFILTER_MIN_ARTICLE_COUNT)
      // B-FIX (A5 fix #1): 24-hour delay. Time-lag artifacts get 24h to
      // be caught up by the absent side before we call them blindspots.
      .lt("first_published", blindspotCutoffIso)
      .order("updated_at", { ascending: false })
      .limit(CANDIDATE_LIMIT)
      .returns<EmbeddedClusterRow[]>();

    if (error) {
      console.error("[blindspots] embedded select error", error.message);
      return { bundles: [] };
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
      const sortedAsc = [...members].sort(
        (a, b) =>
          new Date(a.published_at).getTime() -
          new Date(b.published_at).getTime()
      );
      const seen = new Set<string>();
      const deduped: EmbeddedArticle[] = [];
      for (const m of sortedAsc) {
        const sid = m.sources?.id ?? m.source_id;
        if (seen.has(sid)) continue;
        seen.add(sid);
        deduped.push(m);
      }

      // B-FIX (A5 fix #2): require ≥6 distinct outlets after dedupe. A5
      // showed 3-source clusters are too small to call "the other side
      // ignored it" — at that scale absence is sampling noise. Bumped
      // from 3 → 6 per the A5 recommendation.
      if (deduped.length < MIN_ARTICLE_COUNT) continue;

      // B-FIX (A5 fix #3): SEO format filter. "kimdir / kaç yaşında / son
      // dakika: / canlı / ne dedi" titles are search-intent explainers,
      // not coverage gaps. Iktidar outlets don't publish "who is our own
      // guy" pieces — they publish the appointment. Drop these before
      // they reach the page (kills bf90987a "MHP İl Başkanı … kimdir?").
      if (SEO_PATTERN.test(c.title_tr)) continue;

      // B-FIX (A5 fix #4): wire-redistribution dedup. Mirrors R2's
      // detector in politics-query.ts: when fewer than 50% of the
      // deduped members carry distinct content_hashes, the cluster is
      // one wire copy amplified by N outlets. NULL hashes are treated as
      // unique pseudo-hashes (same as politics-query.ts) so legacy rows
      // are never mis-flagged. Kills b9e4047c / 536cb1d4 / 9f8704b0.
      const distinctHashes = new Set(
        deduped.map((m) => m.content_hash ?? `__null__:${m.id}`)
      ).size;
      if (distinctHashes / deduped.length < WIRE_UNIQUE_HASH_RATIO) continue;

      // B-FIX (A5 fix #5): category guard. A5 found 959b3cfc (Pakistan /
      // Oman foreign-affairs) was tagged `politika` and surfaced as a
      // domestic-politics blindspot. Drop clusters whose `dunya` share
      // exceeds 50% — the substance is foreign affairs, not Turkish
      // politics, so a one-sided iktidar share carries no signal.
      const dunyaCount = deduped.filter((m) => m.category === "dunya").length;
      if (dunyaCount / deduped.length > DUNYA_CATEGORY_SHARE_LIMIT) continue;

      // Soft topical filter: only consider clusters whose majority is
      // politics/breaking-news. Tayf's clustering pipeline isn't gated by
      // category, so without this filter the page would surface e.g.
      // sports clusters from a single zone — not the spirit of the
      // feature.
      const politicsHits = deduped.filter((m) =>
        POLITICS_CATEGORIES.includes(m.category)
      ).length;
      if (politicsHits / deduped.length < 0.6) continue;

      // Per-zone tally over unique outlets only.
      const counts: Record<MediaDnaZone, number> = {
        iktidar: 0,
        muhalefet: 0,
        bagimsiz: 0,
      };
      for (const m of deduped) {
        if (!m.sources) continue;
        counts[zoneOf(m.sources.bias)]++;
      }
      const total = deduped.length;

      let dominantZone: MediaDnaZone | null = null;
      let dominantPct = 0;
      for (const z of Object.keys(counts) as MediaDnaZone[]) {
        const pct = counts[z] / total;
        if (pct > dominantPct) {
          dominantZone = z;
          dominantPct = pct;
        }
      }

      if (!dominantZone || dominantPct < DOMINANT_ZONE_THRESHOLD) continue;

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
          title_tr: c.title_tr,
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
      });

      if (bundles.length >= DISPLAY_LIMIT) break;
    }

    // Most lopsided first — a 100% iktidar cluster is a starker blindspot
    // than a 86% one and deserves the top slot.
    bundles.sort((a, b) => b.dominantPct - a.dominantPct);

    return { bundles };
  } catch (err) {
    console.error("[blindspots] unexpected error", err);
    return { bundles: [] };
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
  const pctLabel = `${Math.round(bundle.dominantPct * 100)}%`;

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
            Sadece {meta.label} yazdı
          </span>
          <span className="text-[11px] text-muted-foreground">
            <span className="font-mono">{pctLabel}</span> tek tarafta
          </span>
        </div>
      </div>

      <ClusterCard
        cluster={bundle.cluster}
        articles={bundle.articles}
        sources={bundle.sources}
        index={index}
        isAging={isAging}
      />
    </div>
  );
}
