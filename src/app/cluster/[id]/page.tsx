import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft } from "lucide-react";

import { BiasSpectrum } from "@/components/story/bias-spectrum";
import { ClusterCardImage } from "@/components/story/cluster-card-image";
import { MediaDna } from "@/components/story/media-dna";
import { FramingComparison } from "@/components/story/framing-comparison";
import { CrossSpectrumCaption } from "@/components/story/cross-spectrum-caption";
import { ShareButton } from "@/components/story/share-button";
import { BookmarkButton } from "@/components/bookmark/bookmark-button";
import { SourceChips } from "@/components/source/source-chips";
import { getSourceMetadata } from "@/lib/sources/factuality";
import {
  detectCrossSpectrum,
  summarizeSurprises,
} from "@/lib/bias/cross-spectrum";
import { getClusterDetail } from "@/lib/clusters/cluster-detail-query";
import { buildShareText } from "@/lib/clusters/share";
import { ReadAcrossSpectrum } from "@/components/story/read-across-spectrum";
import { formatTurkishTimeAgo } from "@/lib/time";

interface PageProps {
  // Next.js 16: dynamic-route `params` is a Promise and must be awaited.
  params: Promise<{ id: string }>;
}

// Dynamic SEO metadata. Per Next.js 16, dynamic-route metadata must be
// produced by an exported async `generateMetadata` (the static `metadata`
// object can't access `params`). The fetch goes through the same cached
// `getClusterDetail` the page uses, so it's effectively free on warm hits.
export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { id } = await params;
  const detail = await getClusterDetail(id);

  if (!detail) {
    // The root layout's `title.template` is `%s — Tayf`, so we return just
    // the page-specific part here and let the template add the suffix.
    return { title: "Sayfa bulunamadı" };
  }

  const { cluster } = detail;
  // Trim summary so the description stays well under the ~160 char SERP cap
  // even after the article-count prefix.
  const description = `${cluster.article_count} kaynaktan haberler. ${
    cluster.summary_tr?.slice(0, 160) ?? ""
  }`;

  return {
    // Plain title — the root layout's `title.template = "%s — Tayf"` adds
    // the suffix automatically. Returning `${title} — Tayf` here would
    // double-suffix to `title — Tayf — Tayf` (caught by gstack site audit).
    title: cluster.title_tr,
    description,
    // Without an explicit canonical, Next's metadata inheritance propagates
    // the root layout's `canonical: "/"` here — telling crawlers every
    // cluster page is a duplicate of the homepage and deindexing the long
    // tail. Same pattern as source/[slug].
    alternates: {
      canonical: `/cluster/${id}`,
    },
    openGraph: {
      title: cluster.title_tr,
      description,
      type: "article",
      url: `/cluster/${id}`,
      // Deliberately no `images` key here (not even `[]`): Next's
      // `mergeStaticMetadata` (next/dist/lib/metadata/resolve-metadata.js)
      // only wires in the generated `opengraph-image.tsx` card when this
      // object has NO OWN `images` property. Setting one — as this used
      // to, pointing at the raw first article photo — silently disabled
      // the generated Medya DNA card. See the comment atop
      // `opengraph-image.tsx` for the full rule.
      locale: "tr_TR",
      siteName: "Tayf",
    },
    twitter: {
      card: "summary_large_image",
      title: cluster.title_tr,
      description,
      // Same reasoning as `openGraph.images` above — omitted so the
      // `twitter-image.tsx` file convention wires in automatically.
    },
  };
}

export default async function ClusterDetailPage({ params }: PageProps) {
  const { id } = await params;

  const detail = await getClusterDetail(id);
  if (!detail) notFound();

  const { cluster, members, allSources } = detail;

  // Derive inputs for the cross-spectrum surprise detector from the
  // member list. `memberSources` may contain the same source more than
  // once (a single outlet can publish multiple articles in a cluster);
  // that's fine — `detectCrossSpectrum` treats each row as a vote.
  const memberSources = members.map((m) => m.source);
  // Threshold 0.55 chosen after RECON: no top-5 cluster clears the 0.70
  // default (Fidan is highest at 58.8%). 0.55 is strict enough that a
  // genuinely mixed-coverage story still stays silent, but the biggest
  // partisan stories now surface their cross-spectrum outliers.
  const surpriseResult = detectCrossSpectrum(memberSources, 0.55);
  const surpriseLines = summarizeSurprises(
    surpriseResult,
    cluster.title_tr,
    2,
  );

  // Set of slugs that actually appear in this cluster — used by MediaDna
  // to highlight participating outlets and dim the rest of the 144-source
  // directory.
  const highlightSlugs = new Set(memberSources.map((s) => s.slug));

  // A1-CHIPWIRE: compact factuality + ownership lineage strip. One entry per
  // unique participating source, filtered to those we've hand-tagged in
  // `SOURCE_METADATA` — `<SourceChips>` no-ops for unknown slugs, so filtering
  // here just prevents empty `<li>` wrappers from bloating the markup.
  const uniqueRatedSources = Array.from(
    new Map(memberSources.map((s) => [s.slug, s])).values(),
  ).filter((s) => getSourceMetadata(s.slug) !== null);

  // Hero image — pass the FULL list of candidate image URLs so the
  // client component can fall back in sequence when a CDN returns 404.
  // Previously we picked only the first non-null image and hit the
  // placeholder any time that specific URL happened to be broken, even
  // if 14 other members of the cluster had working images.
  const heroCandidates = members
    .map((m) => m.article.image_url)
    .filter((u): u is string => typeof u === "string" && u.length > 0);
  const heroSrc = heroCandidates[0] ?? null;
  const heroMember = members.find((m) => !!m.article.image_url) ?? null;
  const heroAlt = heroMember?.article.title ?? cluster.title_tr;

  // bias_distribution is stored as jsonb in Postgres but the query layer
  // (`cluster-detail-query.ts`) already normalizes it to a proper
  // `BiasDistribution` at the boundary, so it's safe to use directly here.
  const biasDistribution = cluster.bias_distribution;

  // Share loop: argue the bias story in the share text itself, before the
  // click — computed server-side so it's identical for every visitor
  // (no client-side zone math duplicated in `ShareButton`).
  const shareText = buildShareText({
    articleCount: cluster.article_count,
    distribution: biasDistribution,
    isBlindspot: cluster.is_blindspot,
    blindspotSide: cluster.blindspot_side,
  });

  // Schema.org NewsArticle structured data. Lets Google surface the
  // cluster in news-rich results and gives social previews a clean
  // headline/date/image triple. Authors are listed as the source
  // outlets (capped at 5) since a cluster is the union of multiple
  // independent stories — there's no single byline.
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: cluster.title_tr,
    datePublished: cluster.first_published,
    dateModified: cluster.updated_at,
    description: cluster.summary_tr ?? undefined,
    image: heroSrc ? [heroSrc] : undefined,
    publisher: {
      "@type": "Organization",
      name: "Tayf",
    },
    author: members.slice(0, 5).map((m) => ({
      "@type": "Organization",
      name: m.source.name,
    })),
  };

  return (
    <>
      {/* JSON.stringify is safe here — values come from our own DB
          (cluster row + sources), not user input. dangerouslySetInnerHTML
          is the only way to embed JSON-LD without React escaping the
          angle brackets and breaking the schema. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <div className="container mx-auto px-5 sm:px-4 py-8 max-w-5xl space-y-8">
      {/* Back nav rendered inline (instead of importing ClusterBackNav) so
          U8-MOBILE could give it a 44px tap area + touch-manipulation hint
          without editing files outside the audited set. */}
      <Link
        href="/"
        className="inline-flex min-h-[44px] touch-manipulation items-center gap-1.5 -ml-2 px-2 text-[13px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-4 w-4" strokeWidth={2.5} />
        <span>Haberler</span>
      </Link>

      {/* Hero — the cluster's "real" hero (R4 audit #4). Image on the left
          (or banner on mobile), title + meta + spectrum on the right. The
          image reuses ClusterCardImage at a larger fixed size; the meta row
          repeats the home-card pattern (time-ago • source count • blindspot
          pill) so context carries over from the list. */}
      <section className="rounded-xl border border-border/60 bg-card/40 overflow-hidden">
        <div className="flex flex-col sm:flex-row">
          <div className="sm:shrink-0 w-full sm:w-96 h-44 sm:h-72 bg-muted">
            <ClusterCardImage
              src={heroSrc}
              srcs={heroCandidates.slice(1)}
              logoSrc={
                heroMember?.source.logo_url ??
                members[0]?.source.logo_url ??
                null
              }
              logoAlt={
                heroMember?.source.name ?? members[0]?.source.name ?? "Kaynak"
              }
              alt={heroAlt}
              width={768}
              height={576}
              sizes="(min-width: 640px) 384px, 100vw"
              priority
              className="h-full w-full object-cover"
            />
          </div>

          <div className="flex-1 min-w-0 p-5 sm:p-6 space-y-4">
            <div className="space-y-2">
              {/* A4 polish: promote "Kör nokta" to a full ribbon ABOVE the
                  title (mirrors U1's home-card pattern) so the brand feature
                  reads as the dominant affordance instead of meta filler. */}
              {cluster.is_blindspot && (
                <div className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2.5} />
                  Kör nokta
                </div>
              )}
              <h1 className="font-serif text-3xl sm:text-4xl lg:text-5xl font-extrabold tracking-tight leading-[1.05] text-foreground">
                {cluster.title_tr}
              </h1>
              <div className="flex flex-wrap items-center gap-2 text-[12px] font-medium text-muted-foreground">
                <span>{formatTurkishTimeAgo(cluster.updated_at)}</span>
                <span className="text-muted-foreground/60">•</span>
                <span>{cluster.article_count} kaynak</span>
                <ShareButton
                  clusterId={id}
                  title={cluster.title_tr}
                  text={shareText}
                />
                <BookmarkButton clusterId={id} />
              </div>
            </div>

            <div className="spectrum-glow">
              <BiasSpectrum distribution={biasDistribution} />
            </div>

            {/* "Karşı tarafı oku" — a one-tap next action for a visitor
                landing from a shared link, placed directly under the
                spectrum and above the summary so it clears the fold on a
                667px-tall viewport (the mobile hero image above is capped
                at h-44 for the same reason). */}
            <ReadAcrossSpectrum
              members={members}
              isBlindspot={cluster.is_blindspot}
            />

            {cluster.summary_tr && (
              <p className="text-sm sm:text-base text-muted-foreground leading-relaxed">
                {cluster.summary_tr}
              </p>
            )}

            {/* A1-CHIPWIRE: factuality + ownership lineage per participating
                source. Renders nothing when no member source has been tagged,
                so stories covered only by untagged outlets won't get an empty
                wrapper. Kept inside the hero section (below the summary) so
                the chips read as part of the cluster's "at-a-glance" header
                instead of colliding with the framing comparison below. */}
            {uniqueRatedSources.length > 0 && (
              <div className="space-y-1.5">
                <div className="font-serif text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80">
                  Kaynak künyesi
                </div>
                <ul className="flex flex-wrap gap-x-3 gap-y-1.5">
                  {uniqueRatedSources.map((source, i) => (
                    <li
                      key={source.id}
                      className={`inline-flex items-center gap-1.5 animate-fade-up stagger-${i}`}
                    >
                      <span className="font-mono text-[10px] uppercase tracking-wider text-foreground/80">
                        {source.name}
                      </span>
                      <SourceChips slug={source.slug} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Gradient rule between hero and subsequent sections */}
      <div className="h-px bg-gradient-to-r from-transparent via-brand/20 to-transparent my-6" />

      {/* Cross-spectrum surprise caption — moved above the chips per R4 #8.
          The caption is editorially valuable and was previously buried below
          the 144-source Medya DNA grid. Only renders when there's something
          interesting to say (handled inside the component too). */}
      {surpriseLines.length > 0 && (
        <>
          <CrossSpectrumCaption lines={surpriseLines} />
          <div className="h-px bg-gradient-to-r from-transparent via-brand/20 to-transparent my-6" />
        </>
      )}

      {/* "Aynı Haber, Farklı Dünyalar" — per-zone framing comparison. The
          outlets' own headlines side by side; replaces the old chip-only
          ClusterStance grid. */}
      <div className="rounded-xl border border-border/60 bg-card/40 p-4 sm:p-5 hover-lift animate-fade-up stagger-1">
        <FramingComparison members={members} />
      </div>

      <div className="h-px bg-gradient-to-r from-transparent via-brand/20 to-transparent my-6" />

      {/* Chart — Medya DNA'sı (all 144 sources, this cluster's highlighted).
          Now last in the page order; collapsed-by-default thanks to U4. */}
      <div className="rounded-xl border border-border/60 bg-card/40 p-4 hover-lift animate-fade-up stagger-2">
        <MediaDna sources={allSources} highlightSlugs={highlightSlugs} />
      </div>
      </div>
    </>
  );
}
