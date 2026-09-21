import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";

import { ClusterCard } from "@/components/story/cluster-card";
import { PageHero } from "@/components/ui/page-hero";
import {
  buildTopicCollectionPage,
  clampTopicPage,
  getTopicClusters,
  isTopicSlug,
  topicMetadata,
  TOPIC_LABELS_TR,
  TOPIC_MAX_PAGE,
  TOPIC_NOTE_LINK_LABEL,
  TOPIC_NOTE_PREFIX,
  TOPIC_REDIRECT_SLUGS,
  TOPIC_SLUGS,
  type TopicSlug,
} from "@/lib/clusters/topic-query";
import { serializeJsonLd } from "@/lib/seo/json-ld";
import { currentTimeMs } from "@/lib/time";

// /konu/[slug] — Pack C ("Konu") hub. Six static params (TOPIC_SLUGS);
// `politika` is a valid clusters.topic7 value but has no hub of its own —
// it 308s to "/", the existing politics feed. No `export const dynamic` /
// `revalidate`: under cacheComponents every fetcher is a "use cache"
// function that resolves to null on error, so this page prerenders into
// its honest unavailable state rather than failing the build.

interface PageProps {
  // Next.js 16: dynamic-route `params` is a Promise and must be awaited.
  params: Promise<{ slug: string }>;
  // Next supplies string[] for a repeated ?sayfa= param, not just string.
  searchParams: Promise<{ sayfa?: string | string[] }>;
}

export async function generateStaticParams() {
  return TOPIC_SLUGS.map((slug) => ({ slug }));
}

// Dynamic SEO metadata. Per Next.js 16, dynamic-route metadata must be
// produced by an exported async `generateMetadata` (the static `metadata`
// object can't see params). politika/unknown slugs get {} — the
// redirect/404 is what the reader gets, not a meta tag.
export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  if (isTopicSlug(slug)) return topicMetadata(slug);
  return {};
}

// Shared class tokens — literal strings only (Tailwind 4 has no runtime
// scanner). Mirrors /hafta's token set.
const noteClass = "text-xs text-muted-foreground";
const unavailableWrapClass =
  "rounded-xl border border-border/60 bg-card/40 p-8 text-center";
const unavailableTextClass = "text-sm text-muted-foreground";
const listClass = "space-y-4";
const pagerClass =
  "flex items-center justify-between gap-3 pt-2 text-sm";
const pagerLinkClass =
  "font-medium text-foreground underline decoration-dotted underline-offset-2 hover:text-primary";
const pagerMetaClass = "text-xs text-muted-foreground";

const UNAVAILABLE_COPY =
  "Konu listesi şu anda yüklenemiyor. Birkaç dakika içinde tekrar deneyin.";
const EMPTY_COPY = "Bu konuda son 7 günde küme oluşmadı.";
const EMPTY_PAGE_COPY = "Bu sayfada küme yok.";

export default async function TopicHubPage({
  params,
  searchParams,
}: PageProps) {
  const { slug } = await params;

  // Order matters: politika is not a hub slug and would otherwise 404, so
  // the redirect must run BEFORE the isTopicSlug check.
  if ((TOPIC_REDIRECT_SLUGS as readonly string[]).includes(slug)) {
    permanentRedirect("/");
  }

  if (!isTopicSlug(slug)) {
    notFound();
  }

  const { sayfa } = await searchParams;
  const raw = Array.isArray(sayfa) ? sayfa[0] : sayfa;
  // Clamp BEFORE the "use cache" fetcher runs, not inside it: the cache key
  // is the argument passed here, so an unclamped ?sayfa= mints a distinct
  // cache entry (and Supabase round trip) for every integer a crawler tries.
  const page = clampTopicPage(parseInt(raw ?? "1", 10));

  const result = await getTopicClusters(slug, page);
  const label = TOPIC_LABELS_TR[slug];
  // Next 16 forbids Date.now() in a render body — one clock read via
  // currentTimeMs(), same rule the home feed follows.
  const nowMs = currentTimeMs();

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl space-y-8">
      {/* Shared contract (pack.md:217) places this CollectionPage script on
          /konu/[slug] unconditionally. Deliberate divergence: it is only
          rendered once there is at least one bundle to list — an ItemList
          with numberOfItems: 0 adds nothing for the null/empty states. */}
      {result !== null && result.bundles.length > 0 ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: serializeJsonLd(
              buildTopicCollectionPage({ slug, bundles: result.bundles }),
            ),
          }}
        />
      ) : null}

      <PageHero
        kicker="Konu"
        title={label}
        subtitle={`Son 7 günde ${label} konusunda kümelenen haberler.`}
      />

      <p className={noteClass}>
        {TOPIC_NOTE_PREFIX}
        <Link
          href="/metodoloji#konu"
          className="underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          {TOPIC_NOTE_LINK_LABEL}
        </Link>
      </p>

      {result === null ? (
        <div className={unavailableWrapClass}>
          <p className={unavailableTextClass}>{UNAVAILABLE_COPY}</p>
        </div>
      ) : result.bundles.length === 0 ? (
        result.page === 1 ? (
          <div className={unavailableWrapClass}>
            <p className={unavailableTextClass}>{EMPTY_COPY}</p>
          </div>
        ) : (
          // A page past the last one: real clusters still exist on earlier
          // pages, so this must not repeat EMPTY_COPY (which claims none
          // exist at all) and must keep Önceki reachable.
          <>
            <div className={unavailableWrapClass}>
              <p className={unavailableTextClass}>{EMPTY_PAGE_COPY}</p>
            </div>
            <TopicPager slug={slug} page={result.page} hasMore={false} />
          </>
        )
      ) : (
        <>
          <div className={listClass}>
            {result.bundles.map((b, i) => {
              const hoursAgo =
                (nowMs - new Date(b.cluster.updated_at).getTime()) /
                3_600_000;
              return (
                <ClusterCard
                  key={b.cluster.id}
                  cluster={b.cluster}
                  articles={b.articles}
                  sources={b.sources}
                  index={i}
                  isAging={hoursAgo > 48}
                  isWireRedistribution={b.isWireRedistribution}
                  effectiveArticleCount={b.effectiveArticleCount}
                />
              );
            })}
          </div>
          <TopicPager slug={slug} page={result.page} hasMore={result.hasMore} />
        </>
      )}
    </div>
  );
}

// Local pager — do not touch the home page's. Never prints a total: hasMore
// is all getTopicClusters knows.
function TopicPager({
  slug,
  page,
  hasMore,
}: {
  slug: TopicSlug;
  page: number;
  hasMore: boolean;
}) {
  const prevHref =
    page - 1 <= 1 ? `/konu/${slug}` : `/konu/${slug}?sayfa=${page - 1}`;
  const nextHref = `/konu/${slug}?sayfa=${page + 1}`;

  return (
    <nav aria-label="Sayfalar" className={pagerClass}>
      {page > 1 ? (
        <Link href={prevHref} className={pagerLinkClass}>
          Önceki
        </Link>
      ) : (
        <span />
      )}
      <span className={pagerMetaClass} aria-current="page">{`Sayfa ${page}`}</span>
      {hasMore && page < TOPIC_MAX_PAGE ? (
        <Link href={nextHref} className={pagerLinkClass}>
          Sonraki
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
