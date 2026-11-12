import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";

import { FollowButton } from "@/components/follow/follow-button";
import { BiasSpectrum } from "@/components/story/bias-spectrum";
import { ClusterCard } from "@/components/story/cluster-card";
import { HubTrendChart } from "@/components/trends/hub-trend-chart";
import { PageHero } from "@/components/ui/page-hero";
import type { ClusterBundle } from "@/lib/clusters/politics-query";
import {
  distributionTotal,
  SPECTRUM_EMPTY_COPY,
  sumDistributions,
} from "@/lib/bias/sum-distributions";
import {
  ENTITY_HUB_WINDOW_DAYS,
  entityByKey,
  entityHubLastPage,
  entityHubNote,
  entityHubPageRobots,
  entityHubRobots,
  hubCardBannerIndex,
  hubMatchNote,
  isEntityKey,
  parseEntityHubPage,
} from "@/lib/entities/entity-hub";
import { getEntityHub } from "@/lib/entities/entity-hub-query";
import { hubTrendState } from "@/lib/entities/hub-trend";
import { getHubTrend } from "@/lib/entities/hub-trend-query";
import {
  buildBreadcrumbs,
  buildClusterCollectionPage,
  serializeJsonLd,
} from "@/lib/seo/json-ld";
import { staticPageMetadata } from "@/lib/seo/page-metadata";
import { RISING_ENTITIES } from "@/lib/trends/rising-entities";
import { splitFeedHead } from "@/lib/ui/feed-head";

// /gundem/[key] — entity hub (roadmap G2): the clusters that mention one
// curated person, party, institution or country (rising-entities.ts), with the
// summed source spectrum of what is listed. Mirrors /konu/[slug]: 62 static
// params, no `export const dynamic` / `revalidate`; under cacheComponents the
// fetcher is a "use cache" function that resolves to null on error, so the
// page prerenders into its honest unavailable state rather than failing the
// build (and stays that way for about a minute, the "minutes" cache window).
//
// ?sayfa=N (h136-roadmap-2) pages through every matched cluster of the 14-day
// window, 20 per page, as /konu/[slug] does: page 1 is the page it always was
// (title, canonical, robots), a later page is its own canonical with
// `noindex, follow`, titled "{label} — Sayfa N". A page past the last one says so
// and links to page 1 and to the last page; its title and canonical describe the
// page that was ASKED for, never a clamped one (h79/h98). While migration 199's
// `entity_cluster_ids_v4` is unapplied a later page is `unavailable` and says so
// (entity-hub-query.ts); page 1 never depends on it.
//
// Page 1 of a hub that lists clusters also draws a daily bar chart (h154-hub-trend): how many of THIS hub's clusters had
// their first report on each of the last 14 Istanbul days, from migration 206's `entity_cluster_days` (the hub's own match,
// counted per day; src/lib/entities/hub-trend-query.ts). It does not read the daily rollup of /trends
// (trends_daily_entity_counts_ist_rollup): that counts headline articles, not clusters, and each of its days keeps the
// basis of its last refresh (neither 163 nor 182 was backfilled), so a series built on it would show a code change as
// news. The read starts before the hub read and runs beside it; an unapplied 206 (PGRST202), a failed read, a later page
// and every state without a list draw no chart, and generateMetadata never reads it.
//
// h166-perf-3: a hub with more than FEED_HEAD_CARDS (2) clusters on the page splits its card list. The first two cards
// render with the head (title, counts, chart, spectrum); the rest, the pager and the 'Gündem bağlantıları' nav render in
// EntityHubTail behind a nested <Suspense>. React reveals a boundary only once its last card has streamed and in windows
// of about 300 ms, so with all 20 cards in the head's boundary the LCP note waited for the whole list (byte 676,506 of
// 885,693). Same cards, same order, same markup and banner priority; only the boundary moves. A page with 2 or fewer
// clusters, and every empty, failed, unavailable and past-the-end state, has no tail and renders as before.
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
  // Next supplies string[] for a repeated ?sayfa= param, not just string.
  searchParams: Promise<{ sayfa?: string | string[] }>;
}

export async function generateStaticParams() {
  return RISING_ENTITIES.map((e) => ({ key: e.key }));
}

// Dynamic SEO metadata. A hub with fewer than three clusters, or one whose
// read failed, is thin or empty: noindex,follow (entityHubRobots). The body
// below reads the same getEntityHub(key, page), so metadata and page share one
// cache entry and always agree.
//
// Page N > 1 (h136-roadmap-2, as /konu/[slug] seo-2): its own title and its own
// canonical /gundem/<key>?sayfa=N (staticPageMetadata's path regex forbids a
// query string, so the paged URL is applied after the call, to the canonical
// and to og:url), and noindex,follow whatever the page holds. The page number is
// the one that was asked for, parsed exactly as the body parses it: a page past
// the end is titled and canonicalised as itself, never as the last page or page 1.
export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { key } = await params;
  const entity = entityByKey(key);
  if (entity === null) return {};

  const { sayfa } = await searchParams;
  const page = parseEntityHubPage(sayfa);

  const { label } = entity;
  const path = `/gundem/${key}`;
  const robots = entityHubPageRobots(page, await getEntityHub(key, page));
  const base = staticPageMetadata({
    title: page === 1 ? `${label} haberleri` : `${label} — Sayfa ${page}`,
    description: `${label} hakkında son ${ENTITY_HUB_WINDOW_DAYS} günün haber kümeleri ve kaynak dağılımı.`,
    path,
    // <link rel="alternate" type="application/rss+xml"> for this hub's feed
    // (src/app/rss/[topic]/route.ts serves /rss/gundem-<key>.xml).
    alternateTypes: { "application/rss+xml": `/rss/gundem-${key}.xml` },
  });
  const paged =
    page === 1
      ? base
      : {
          ...base,
          alternates: { ...base.alternates, canonical: `${path}?sayfa=${page}` },
          openGraph: { ...base.openGraph, url: `${path}?sayfa=${page}` },
        };
  return {
    ...paged,
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
// The /konu/[slug] pager tokens, literally. Phones get the site's 44 px hit-area
// floor (max-sm:min-h-11); pagerClass stays items-center so the taller phone links
// line up with the "Sayfa N / M" label.
const pagerClass = "flex items-center justify-between gap-3 pt-2 text-sm";
const pagerLinkClass =
  "inline-flex max-sm:min-h-11 items-center touch-manipulation font-medium text-foreground underline decoration-dotted underline-offset-2 hover:text-primary";
const pagerMetaClass = "text-xs text-muted-foreground";
// The RSS link beside the follow button is a stand-alone target, so it keeps the same 24 px floor.
const rssLinkClass =
  "inline-flex min-h-8 items-center text-sm font-medium text-foreground underline decoration-dotted underline-offset-2 hover:text-primary";

const UNAVAILABLE_COPY =
  "Bu sayfa şu anda yüklenemiyor. Birkaç dakika içinde tekrar deneyin.";
const EMPTY_COPY = `Son ${ENTITY_HUB_WINDOW_DAYS} günde bu konuda küme yok.`;
// A page past the last one: real clusters exist on earlier pages, so this must not
// repeat EMPTY_COPY (which claims there are none).
const EMPTY_PAGE_COPY = "Bu sayfada küme yok.";
// A later page while migration 199 is not applied yet.
const PAGE_UNAVAILABLE_COPY = "Bu sayfa şu an gösterilemiyor.";

export default async function EntityHubPage({ params, searchParams }: PageProps) {
  const { key } = await params;
  const entity = entityByKey(key);
  if (!isEntityKey(key) || entity === null) {
    notFound();
  }

  const { sayfa } = await searchParams;
  // The page that was asked for, parsed as generateMetadata parses it. The read
  // bounds its own cache key (getEntityHub folds every page past the last into one).
  const page = parseEntityHubPage(sayfa);

  const { label } = entity;
  // Started before the hub read so both run in parallel; page 1 only.
  const trendPromise = page === 1 ? getHubTrend(key) : null;
  const result = await getEntityHub(key, page);
  const trend = trendPromise === null ? null : await trendPromise;
  // Whether the daily chart is drawn above the list. It decides two things: the chart conditional, and the first card's
  // banner priority (h159-perf-3: with the chart above it, card 0 is below the fold, so it must not be fetched at
  // fetchpriority=high; hubCardBannerIndex).
  const trendShown = trend !== null && trend.status === "ok";
  // Whether the FULL chart is drawn. The sparse state (under ENTITY_HUB_MIN_INDEXABLE clusters in the window) draws only a
  // heading and a note, and 0 clusters over 0 earlier renders null, so in both cases card 0 is back above the fold and keeps
  // its banner hint. The "chart" state implies a sum of at least 3, which excludes the null branch.
  const trendChartDrawn = trendShown && hubTrendState(trend.days) === "chart";
  // No clock read here, the rule this page had when it was fully static (a
  // Date.now() in the render body fails `next build` once the cached read
  // succeeds): relative times use the read's own timestamp, stamped inside the
  // cache scope (entity-hub-query.ts). Guarded by
  // tests/guards/static-page-clock.test.ts.
  const nowMs = result?.asOfMs ?? 0;
  const lastPage = result === null ? 1 : entityHubLastPage(result.total);

  // Summed source mix of the listed clusters. A hub whose clusters are covered
  // by aggregator or niche sources only sums to 0 (bias_distribution counts
  // voting kinds only), and BiasSpectrum draws nothing for 0: the section then
  // says so (h61-emptystates-1) instead of leaving a headed, empty region. Same
  // rule as /konu/[slug].
  const distribution = sumDistributions(result?.bundles ?? []);
  const spectrumTotal = distributionTotal(distribution);

  // h166-perf-3: the cut of the card list. Only the list branch below reads
  // these, so the bundles are the ones that branch renders (a failed read, an
  // unavailable page and an empty page list none).
  const listed = result !== null && result.unavailable !== true ? result.bundles : [];
  const feedSplit = splitFeedHead(listed);
  const hasTail = feedSplit.tail.length > 0;

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl space-y-8">
      {page === 1 && result !== null && entityHubRobots(result) === undefined ? (
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
              {entityHubNote(result.total, result.bundles.length, page)}
            </p>
          ) : (
            <span />
          )}
          <div className="flex flex-wrap items-center gap-3">
            {/* Plain <a>, as on /konu/[slug]: next/link would prefetch this
                DB-backed feed route handler as an RSC request (perf-6;
                tests/guards/feed-links-plain-anchor.test.ts). */}
            <a
              href={`/rss/gundem-${entity.key}.xml`}
              type="application/rss+xml"
              className={rssLinkClass}
            >
              RSS
            </a>
            {/* The ENTITY, not its label as a keyword: a keyword follow runs the
                generic stemmed archive search ("DEVA" lists every "devam"),
                while kind="gundem" is answered by this page's own matcher. */}
            <FollowButton kind="gundem" value={entity.key} />
          </div>
        </div>
        {/* What THIS hub searches (h128-hubs-1): the headline and the summary's first line (its first
            paragraph; for almost every cluster the whole summary), or the headline alone for a
            headline-only hub. Never "tam metin": no hub reads the body. */}
        <p className={noteClass}>{hubMatchNote(entity)}</p>
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
      ) : result.unavailable === true ? (
        // A later page while migration 199 is not applied: the honest line and the
        // way back. No pager, no list. The page is noindex through generateMetadata
        // (every page after the first is), so this carries no body robots meta.
        <div className={unavailableWrapClass}>
          <p className={unavailableTextClass}>{PAGE_UNAVAILABLE_COPY}</p>
          <p className={unavailableTextClass}>
            <Link href={`/gundem/${key}`} className={footerLinkClass}>
              İlk sayfaya dön
            </Link>
          </p>
        </div>
      ) : result.bundles.length === 0 ? (
        page === 1 ? (
          <div className={unavailableWrapClass}>
            <p className={unavailableTextClass}>{EMPTY_COPY}</p>
          </div>
        ) : (
          // A page past the last one: the pager leads back to page 1 and to the
          // last page that has rows, never to a next page. Status stays 200 (the PPR
          // shell has already flushed one); generateMetadata sends noindex,follow.
          <>
            <div className={unavailableWrapClass}>
              <p className={unavailableTextClass}>
                {lastPage < page && result.total > 0
                  ? `${EMPTY_PAGE_COPY} Liste ${lastPage}. sayfada bitiyor.`
                  : EMPTY_PAGE_COPY}
              </p>
            </div>
            <PastEndPager hubKey={key} page={page} lastPage={lastPage} />
          </>
        )
      ) : (
        <>
          {trendShown ? (
            <HubTrendChart label={label} days={trend.days} earlier={trend.earlier} />
          ) : null}
          <section aria-labelledby="entity-spectrum-heading" className={spectrumWrapClass}>
            <h2 id="entity-spectrum-heading" className={spectrumHeadingClass}>
              Listelenen haberlerin kaynak dağılımı
            </h2>
            {spectrumTotal > 0 ? (
              <BiasSpectrum
                distribution={distribution}
                compact
                countUnit="kaynak kaydı"
              />
            ) : (
              <p className={noteClass}>{SPECTRUM_EMPTY_COPY}</p>
            )}
          </section>

          <div className={listClass}>
            {feedSplit.head.map((b, i) => renderHubCard(b, i, nowMs, trendChartDrawn))}
          </div>
          {hasTail ? (
            // More than FEED_HEAD_CARDS cards: the rest of the list, the pager and
            // the nav stream behind this nested boundary, after the head has been
            // revealed. The fallback is null: with the nav inside the tail nothing
            // sits below the head, so nothing can be pushed down by the tail arriving.
            <Suspense fallback={null}>
              <EntityHubTail
                bundles={result.bundles}
                hubKey={key}
                page={page}
                lastPage={lastPage}
                label={label}
                nowMs={nowMs}
                trendChartDrawn={trendChartDrawn}
              />
            </Suspense>
          ) : lastPage > 1 ? (
            <HubPager hubKey={key} page={page} lastPage={lastPage} />
          ) : null}
        </>
      )}

      {hasTail ? null : hubLinksNav(label)}
    </div>
  );
}

// One card of the list. `i` is the card's position in the WHOLE page, never in the
// head or the tail: the first-card banner priority (hubCardBannerIndex) depends
// on it. The one place this page renders a card, shared by the head and the tail.
function renderHubCard(b: ClusterBundle, i: number, nowMs: number, trendChartDrawn: boolean) {
  const hoursAgo = (nowMs - new Date(b.cluster.updated_at).getTime()) / 3_600_000;
  return (
    <ClusterCard
      key={b.cluster.id}
      cluster={b.cluster}
      articles={b.articles}
      sources={b.sources}
      index={hubCardBannerIndex(i, trendChartDrawn)}
      isAging={hoursAgo > 48}
      isWireRedistribution={b.isWireRedistribution}
      effectiveArticleCount={b.effectiveArticleCount}
      nowMs={nowMs}
    />
  );
}

// The footer links. A function that returns the element (not a component), so the
// page and the tail share one definition and the element tree keeps its shape.
function hubLinksNav(label: string) {
  return (
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
  );
}

// The part of a hub page after its first FEED_HEAD_CARDS cards (h166-perf-3): the
// remaining cards, the pager when there is more than one page, and the footer nav,
// in the order the single page had them. Mounted by EntityHubPage behind its own
// <Suspense> only when the page lists more than the head; exported so tests can
// render it directly.
//
// It is async on purpose: an async component makes Flight serialize the tail after
// the head's rows, so the head's boundary completes and reveals first. connection()
// is the idiom of the other async slots in this codebase and reads no clock; the
// page already awaits searchParams, so its static/dynamic status does not change.
// `nowMs` is the read's own timestamp, passed in.
//
// Spacing: the page container is space-y-8, so the head's list gets 32 px below it,
// and this list's -mt-4 (-16 px) collapses with that to the 16 px between two cards
// of the single space-y-4 list. The pager and the nav stay siblings of the list (not
// children of it), so they keep the container's 32 px.
export async function EntityHubTail({
  bundles,
  hubKey,
  page,
  lastPage,
  label,
  nowMs,
  trendChartDrawn,
}: {
  bundles: ClusterBundle[];
  hubKey: string;
  page: number;
  lastPage: number;
  label: string;
  nowMs: number;
  trendChartDrawn: boolean;
}) {
  await connection();

  const { tail, tailStart } = splitFeedHead(bundles);

  return (
    <>
      <div className="space-y-4 -mt-4">
        {tail.map((b, k) => renderHubCard(b, tailStart + k, nowMs, trendChartDrawn))}
      </div>
      {lastPage > 1 ? <HubPager hubKey={hubKey} page={page} lastPage={lastPage} /> : null}
      {hubLinksNav(label)}
    </>
  );
}

// The hub URL of page N: page 1 is the bare hub URL (never ?sayfa=1).
function pageHref(key: string, n: number): string {
  return n <= 1 ? `/gundem/${key}` : `/gundem/${key}?sayfa=${n}`;
}

// Pager for a page that lists clusters (/konu/[slug]'s TopicPager). Unlike /konu it
// knows the total, so it prints the last page too: "Sayfa N / M".
function HubPager({
  hubKey,
  page,
  lastPage,
}: {
  hubKey: string;
  page: number;
  lastPage: number;
}) {
  return (
    <nav aria-label="Sayfalar" className={pagerClass}>
      {page > 1 ? (
        <Link href={pageHref(hubKey, page - 1)} className={pagerLinkClass}>
          Önceki
        </Link>
      ) : (
        <span />
      )}
      <span className={pagerMetaClass} aria-current="page">{`Sayfa ${page} / ${lastPage}`}</span>
      {page < lastPage ? (
        <Link href={pageHref(hubKey, page + 1)} className={pagerLinkClass}>
          Sonraki
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}

// Pager for an empty page past the last one (/konu/[slug]'s PastEndPager): never a
// next link, never a link to page - 1 (it is empty too). First page, then the last
// page that has rows when it is a different page.
function PastEndPager({
  hubKey,
  page,
  lastPage,
}: {
  hubKey: string;
  page: number;
  lastPage: number;
}) {
  return (
    <nav aria-label="Sayfalar" className={pagerClass}>
      <Link href={pageHref(hubKey, 1)} className={pagerLinkClass}>
        İlk sayfaya dön
      </Link>
      {lastPage > 1 && lastPage < page ? (
        <Link href={pageHref(hubKey, lastPage)} className={pagerLinkClass}>
          Son sayfaya git
        </Link>
      ) : null}
    </nav>
  );
}
