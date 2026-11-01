import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { FollowButton } from "@/components/follow/follow-button";
import { BiasSpectrum } from "@/components/story/bias-spectrum";
import { ClusterCard } from "@/components/story/cluster-card";
import { PageHero } from "@/components/ui/page-hero";
import {
  ENTITY_HUB_WINDOW_DAYS,
  entityByKey,
  entityHubNote,
  entityHubRobots,
  isEntityKey,
  sumDistributions,
} from "@/lib/entities/entity-hub";
import { getEntityHub } from "@/lib/entities/entity-hub-query";
import {
  buildBreadcrumbs,
  buildClusterCollectionPage,
  serializeJsonLd,
} from "@/lib/seo/json-ld";
import { staticPageMetadata } from "@/lib/seo/page-metadata";
import { RISING_ENTITIES } from "@/lib/trends/rising-entities";

// /gundem/[key] — entity hub (roadmap G2): the newest clusters that mention one
// curated person, party, institution or country (rising-entities.ts), with the
// summed source spectrum of what is listed. Mirrors /konu/[slug]: 62 static
// params, no `export const dynamic` / `revalidate`; under cacheComponents the
// fetcher is a "use cache" function that resolves to null on error, so the
// page prerenders into its honest unavailable state rather than failing the
// build (and stays that way for about a minute, the "minutes" cache window).
//
// Unknown keys never get here: src/middleware.ts rewrites them to the real 404
// (gate 6). The notFound() below is defence in depth.
//
// Structured data (CollectionPage + BreadcrumbList) is emitted only for a hub
// that is indexable (entityHubRobots(result) === undefined, the same predicate
// generateMetadata uses for robots): a thin, empty or unavailable hub is
// noindexed, and describing it to crawlers would contradict that. The hub is
// also listed in /sitemaps/hubs.xml (src/lib/seo/hub-sitemap.ts) on that same
// rule.

interface PageProps {
  // Next.js 16: dynamic-route `params` is a Promise and must be awaited.
  params: Promise<{ key: string }>;
}

export async function generateStaticParams() {
  return RISING_ENTITIES.map((e) => ({ key: e.key }));
}

// Dynamic SEO metadata. A hub with fewer than three clusters, or one whose
// read failed, is thin or empty: noindex,follow (entityHubRobots). The body
// below reads the same getEntityHub(key), so metadata and page share one cache
// entry and always agree.
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { key } = await params;
  const entity = entityByKey(key);
  if (entity === null) return {};

  const { label } = entity;
  const robots = entityHubRobots(await getEntityHub(key));
  return {
    ...staticPageMetadata({
      title: `${label} haberleri`,
      description: `${label} hakkında son ${ENTITY_HUB_WINDOW_DAYS} günün haber kümeleri ve kaynak dağılımı.`,
      path: `/gundem/${key}`,
    }),
    ...(robots ? { robots } : {}),
  };
}

// Shared class tokens — literal strings only (Tailwind 4 has no runtime
// scanner). Same set as /konu/[slug].
const noteClass = "text-xs text-muted-foreground";
const unavailableWrapClass =
  "rounded-xl border border-border/60 bg-card/40 p-8 text-center";
const unavailableTextClass = "text-sm text-muted-foreground";
const listClass = "space-y-4";
const spectrumWrapClass =
  "space-y-3 rounded-xl ring-1 ring-border/60 bg-card/60 p-4 sm:p-6";
const spectrumHeadingClass = "text-sm font-semibold text-foreground";
// min-h-8 keeps the footer links at or above the 24 px WCAG 2.5.8 target size.
const footerLinkClass =
  "inline-flex min-h-8 items-center font-medium text-foreground underline decoration-dotted underline-offset-2 hover:text-primary";

const UNAVAILABLE_COPY =
  "Bu sayfa şu anda yüklenemiyor. Birkaç dakika içinde tekrar deneyin.";
const EMPTY_COPY = `Son ${ENTITY_HUB_WINDOW_DAYS} günde bu konuda küme yok.`;
const MATCH_NOTE =
  "Eşleşme, küme başlığı ve özetinde tam metin aramasıyla yapılır; eş adlı kişi ve kurumlar karışabilir.";

export default async function EntityHubPage({ params }: PageProps) {
  const { key } = await params;
  const entity = entityByKey(key);
  if (!isEntityKey(key) || entity === null) {
    notFound();
  }

  const { label } = entity;
  const result = await getEntityHub(key);
  // No clock read here: this page is fully static (generateStaticParams, no
  // searchParams), so a Date.now() in the render body fails `next build` once
  // the cached read succeeds. Relative times use the read's own timestamp,
  // stamped inside the cache scope (entity-hub-query.ts). Guarded by
  // tests/guards/static-page-clock.test.ts.
  const nowMs = result?.asOfMs ?? 0;

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl space-y-8">
      {result !== null && entityHubRobots(result) === undefined ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: serializeJsonLd([
              buildClusterCollectionPage({
                name: `${label} haberleri`,
                path: `/gundem/${key}`,
                items: result.bundles.map((b) => ({
                  name: b.cluster.title_tr,
                  path: `/cluster/${b.cluster.id}`,
                })),
              }),
              buildBreadcrumbs([
                { name: "Anasayfa", path: "/" },
                { name: "Gündem", path: "/gundem" },
                { name: label, path: `/gundem/${key}` },
              ]),
            ]),
          }}
        />
      ) : null}

      <PageHero
        kicker="Gündem"
        title={label}
        subtitle={`${label} ile ilgili son ${ENTITY_HUB_WINDOW_DAYS} günün haber kümeleri.`}
      />

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {result !== null && result.bundles.length > 0 ? (
            <p className={noteClass}>
              {entityHubNote(result.total, result.bundles.length)}
            </p>
          ) : (
            <span />
          )}
          <FollowButton kind="q" value={label} />
        </div>
        <p className={noteClass}>{MATCH_NOTE}</p>
      </div>

      {result === null ? (
        <div className={unavailableWrapClass}>
          {/* Failed state only: keep it out of the index. The failure is
              cached for "minutes" (entity-hub-query.ts), so this prerendered
              noindex lasts about a minute. Same PLACEMENT CAVEAT as /konu and
              /blindspots: this streams into <body>, not <head>; generateMetadata
              also sets robots for the same state through the shared cache entry.
              Absent from the ok and ok-but-empty states. */}
          <meta name="robots" content="noindex" />
          <p className={unavailableTextClass}>{UNAVAILABLE_COPY}</p>
        </div>
      ) : result.bundles.length === 0 ? (
        <div className={unavailableWrapClass}>
          <p className={unavailableTextClass}>{EMPTY_COPY}</p>
        </div>
      ) : (
        <>
          <section aria-labelledby="entity-spectrum-heading" className={spectrumWrapClass}>
            <h2 id="entity-spectrum-heading" className={spectrumHeadingClass}>
              Listelenen haberlerin kaynak dağılımı
            </h2>
            <BiasSpectrum distribution={sumDistributions(result.bundles)} />
          </section>

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
                  nowMs={nowMs}
                />
              );
            })}
          </div>
        </>
      )}

      <nav aria-label="Gündem bağlantıları" className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        {/* Plain <a>: the home feed is a DB-backed route; next/link would
            prefetch it as an RSC request for every hub view. */}
        <a href={`/?q=${encodeURIComponent(label)}`} className={footerLinkClass}>
          Tüm arşivde ara
        </a>
        <Link href="/gundem" className={footerLinkClass}>
          Tüm gündem başlıkları
        </Link>
      </nav>
    </div>
  );
}
