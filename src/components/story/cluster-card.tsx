import { AlertTriangle, Clock, Users } from "lucide-react";
import Link from "next/link";

import { BookmarkButton } from "@/components/bookmark/bookmark-button";
import { BiasSpectrum } from "@/components/story/bias-spectrum";
import { ClusterCardImage } from "@/components/story/cluster-card-image";
import { ZONE_META } from "@/lib/bias/config";
import { formatTurkishTimeAgo } from "@/lib/time";
import type { BiasCategory, BiasDistribution, MediaDnaZone } from "@/types";

// Pure presentational card for a single cluster on /clusters.
// Extracted from the old inline ClusterCard in app/clusters/page.tsx so the
// page component can focus on data fetching. Look-and-feel is preserved
// exactly (same classnames, same markup, same line counts per row).
//
// Props are intentionally split:
//   cluster  — cluster metadata (title, bias distribution, timestamps)
//   articles — the (optionally enriched) member articles to preview
//   sources  — source lookup, kept so callers can resolve bias/name without
//              pre-joining. Currently the card only needs per-article
//              source_name/source_bias; if a source id cannot be resolved
//              via `sources`, the article is skipped rather than crashing.
//
// Hero image:
//   As of the image rollout (feat: cluster hero images), the card also
//   renders a single representative image per cluster. Selection priority:
//     1. image_url of the most-recently-published member article
//     2. image_url of the first member article with any non-null value
//     3. no image block (card renders fine without it)
//   The image itself lives in a tiny "use client" child (ClusterCardImage)
//   so this file can remain a Server Component and still get `onError`
//   handling for broken remote URLs.

export interface ClusterCardCluster {
  id: string;
  title_tr: string;
  summary_tr: string;
  bias_distribution: BiasDistribution;
  is_blindspot: boolean;
  blindspot_side: BiasCategory | null;
  article_count: number;
  first_published: string;
  updated_at: string;
}

export interface ClusterCardArticle {
  id: string;
  title: string;
  url: string;
  /** Non-null when RSS captured an enclosure/og:image for this article. */
  image_url?: string | null;
  published_at: string;
  source_id: string;
  /** Optional: pre-resolved display name. Falls back to `sources` lookup. */
  source_name?: string;
  /** Optional: pre-resolved bias. Falls back to `sources` lookup. */
  source_bias?: BiasCategory;
}

export interface ClusterCardSource {
  id: string;
  name: string;
  bias: BiasCategory;
  logo_url?: string | null;
}

interface ClusterCardProps {
  cluster: ClusterCardCluster;
  articles: ClusterCardArticle[];
  sources: ClusterCardSource[];
  /**
   * Position of the card in the page's cluster grid. Used purely to flag
   * above-the-fold cards so their hero image preloads eagerly. Defaults
   * to a non-priority slot when omitted.
   */
  index?: number;
  /**
   * Whether this cluster is "aging" (latest update older than 48h) and
   * should render with a subtle opacity dim. Computed in the parent and
   * passed in as a prop because Next.js 16's `react-hooks/purity` rule
   * forbids calling `Date.now()` (or other impure functions) inside a
   * Server Component render body. The parent page is allowed to compute
   * this once per request and pass the resulting boolean down.
   */
  isAging?: boolean;
}

const MAX_VISIBLE_ARTICLES = 4;
const PRIORITY_CARD_COUNT = 3;

// ---------------------------------------------------------------------------
// ClusterMetaBadges (inlined from former cluster-meta-badges.tsx)
// ---------------------------------------------------------------------------
//
// Renders the per-card metadata pill row: article count, time-ago, optional
// dominant-zone pill (only shown when dominantPct ≥ 0.6), and an optional
// "kör nokta" badge. Was a separate file; only ever consumed here, so it's
// inlined to keep cluster-card.tsx self-contained.

interface ClusterMetaBadgesProps {
  articleCount: number;
  firstPublished: string;
  updatedAt: string;
  isBlindspot: boolean;
  dominantZone?: MediaDnaZone | null;
  dominantPct?: number;
}

function ClusterMetaBadges({
  articleCount,
  firstPublished,
  isBlindspot,
  dominantZone,
  dominantPct,
}: ClusterMetaBadgesProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      <span className="inline-flex items-center gap-1 rounded-full bg-muted/50 border border-border/40 px-2 py-0.5 text-muted-foreground">
        <Users className="h-3 w-3" />
        {articleCount} kaynak
      </span>

      <span className="inline-flex items-center gap-1 rounded-full bg-muted/50 border border-border/40 px-2 py-0.5 text-muted-foreground">
        <Clock className="h-3 w-3" />
        {formatTurkishTimeAgo(firstPublished)}
      </span>

      {dominantZone && dominantPct !== undefined && dominantPct >= 0.6 && (
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium ${ZONE_META[dominantZone].chipBg} ${ZONE_META[dominantZone].chipText} ${ZONE_META[dominantZone].chipBorder}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${ZONE_META[dominantZone].dot}`} />
          %{Math.round(dominantPct * 100)} {ZONE_META[dominantZone].label}
        </span>
      )}

      {isBlindspot && (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-amber-700 dark:text-amber-500 font-medium">
          <AlertTriangle className="h-3 w-3" />
          Kör nokta
        </span>
      )}
    </div>
  );
}

export function ClusterCard({
  cluster,
  articles,
  sources,
  index = PRIORITY_CARD_COUNT,
  isAging = false,
}: ClusterCardProps) {
  const sourceById = new Map(sources.map((s) => [s.id, s]));

  const resolved = articles
    .map((a) => {
      const src = sourceById.get(a.source_id);
      const source_name = a.source_name ?? src?.name;
      if (!source_name) return null;
      return { ...a, source_name, source_logo_url: src?.logo_url ?? null };
    })
    .filter(
      (
        a
      ): a is ClusterCardArticle & {
        source_name: string;
        source_logo_url: string | null;
      } => a !== null
    );

  // Aging dim: clusters whose latest update is older than 48h are still
  // valid but visually de-emphasised so fresher stories pop. opacity-80
  // is intentionally subtle — they're not stale, just no longer hot.
  // The boolean is computed in the parent (page.tsx / blindspots/page.tsx)
  // because `Date.now()` is impure and Next.js 16's `react-hooks/purity`
  // rule disallows it in a Server Component render body.

  const visible = resolved.slice(0, MAX_VISIBLE_ARTICLES);
  const extra = resolved.length - visible.length;

  // Hero image selection — priority spec:
  //   1) newest article's image
  //   2) first article with any image
  // The politics query already pre-sorts members newest-first, so
  // `resolved[0]` is the newest.
  // Build the FULL list of candidate hero images. The client
  // `ClusterCardImage` walks this array on each `onError` so a single
  // broken CDN URL doesn't collapse to the placeholder when the card
  // has 14 other working images.
  const heroCandidates = resolved
    .map((a) => a.image_url)
    .filter((u): u is string => typeof u === "string" && u.length > 0);
  const heroArticle = resolved.find((a) => !!a.image_url) ?? null;
  const heroSrc = heroCandidates[0] ?? null;
  const heroFallbacks = heroCandidates.slice(1);
  const heroAlt = heroArticle?.title ?? cluster.title_tr;
  const isPriority = index < PRIORITY_CARD_COUNT;

  // Approach A (b-8): the entire card is a single <Link> to /cluster/{id}.
  // We deliberately convert the previously-linked article list items into
  // plain <span>s so we don't nest <a>s inside the wrapping <Link> (which
  // would hydrate as invalid HTML and break both links). The member article
  // titles + source names remain visible as a preview; the full outbound
  // links live on the detail page instead.
  //
  // The bookmark control is a positioned SIBLING of the Link (inside a
  // relative wrapper) for the same reason — a <button> inside an <a> is
  // invalid interactive nesting.
  return (
    <div className="relative">
      <BookmarkButton
        clusterId={cluster.id}
        variant="overlay"
        className="absolute right-3 top-3 z-10"
      />
      <Link
      href={`/cluster/${cluster.id}`}
      className={`hover-lift group block min-h-[44px] touch-manipulation rounded-xl ring-1 ${
        cluster.is_blindspot
          ? "ring-amber-500/40 hover:ring-amber-500/60"
          : "ring-border/60 hover:ring-border"
      } bg-card/60 overflow-hidden transition-colors hover:bg-card/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring${
        isAging ? " opacity-80" : ""
      }`}
    >
      <article>
        {/* Mobile-only banner image (above content). On sm+ we hide this and
            show the side thumbnail inside the flex row below. Rendered
            unconditionally: ClusterCardImage falls back to a muted
            placeholder when `heroSrc` is null, keeping card heights stable. */}
        <div className="sm:hidden relative aspect-[16/9] w-full overflow-hidden bg-muted">
          <ClusterCardImage
            src={heroSrc}
            srcs={heroFallbacks}
            logoSrc={resolved[0]?.source_logo_url ?? null}
            logoAlt={resolved[0]?.source_name ?? "Kaynak"}
            alt={heroAlt}
            width={640}
            height={360}
            sizes="(max-width: 640px) 100vw, 0px"
            priority={isPriority}
            className="h-full w-full object-cover"
          />
          <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-card/80 to-transparent" />
        </div>

        <div className="p-6 sm:p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-2 min-w-0 flex-1">
              {cluster.is_blindspot && (
                <div className="flex items-center gap-1.5 mb-2">
                  <AlertTriangle
                    className="h-3.5 w-3.5 text-amber-500 animate-pulse"
                    strokeWidth={2.5}
                  />
                  <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-500">
                    Kör nokta
                  </span>
                </div>
              )}
              <h2 className="font-serif text-lg sm:text-xl lg:text-2xl font-bold leading-tight tracking-tight text-foreground line-clamp-3">
                {cluster.title_tr}
              </h2>
              <ClusterMetaBadges
                articleCount={cluster.article_count}
                firstPublished={cluster.first_published}
                updatedAt={cluster.updated_at}
                isBlindspot={false}
              />
            </div>

            {/* Desktop-only side thumbnail. Hidden below sm (mobile gets the
                banner above). Fixed aspect keeps card heights predictable in
                the cluster grid. Rendered unconditionally: ClusterCardImage
                falls back to a muted placeholder when `heroSrc` is null. */}
            <div className="hidden sm:block shrink-0 w-32 h-24 sm:w-40 sm:h-28 overflow-hidden rounded-lg bg-muted">
              <ClusterCardImage
                src={heroSrc}
                srcs={heroFallbacks}
                logoSrc={resolved[0]?.source_logo_url ?? null}
                logoAlt={resolved[0]?.source_name ?? "Kaynak"}
                alt={heroAlt}
                width={320}
                height={224}
                sizes="(min-width: 640px) 160px, 100vw"
                priority={isPriority}
                className="h-full w-full object-cover"
              />
            </div>
          </div>

          <div className="spectrum-glow rounded">
            <BiasSpectrum distribution={cluster.bias_distribution} compact />
          </div>

          {visible.length > 0 && (
            <ul className="space-y-1.5 pt-1">
              {visible.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center gap-1.5 leading-relaxed min-w-0"
                >
                  {a.source_logo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={a.source_logo_url}
                      alt=""
                      width={14}
                      height={14}
                      className="h-3.5 w-3.5 rounded shrink-0"
                      loading="lazy"
                    />
                  ) : (
                    <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded bg-muted text-[8px] font-bold text-muted-foreground shrink-0">
                      {a.source_name.slice(0, 2).toUpperCase()}
                    </span>
                  )}
                  <span className="block truncate min-w-0">
                    <span className="text-foreground font-mono font-medium text-[10px] mr-1.5">
                      {a.source_name}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {a.title}
                    </span>
                  </span>
                </li>
              ))}
              {extra > 0 && (
                <li className="text-[11px] text-brand/60">
                  +{extra} başka kaynak
                </li>
              )}
            </ul>
          )}
        </div>
      </article>
      </Link>
    </div>
  );
}
