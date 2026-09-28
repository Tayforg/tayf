import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { Newspaper, SearchX } from "lucide-react";

import { SearchBar } from "@/components/filters/search-bar";
import { currentTimeMs } from "@/lib/time";
import { ClusterCard } from "@/components/story/cluster-card";
import { NewSinceLastVisit } from "@/components/home/new-since-last-visit";
import { PageHero } from "@/components/ui/page-hero";
import { RetryButton } from "@/components/ui/retry-button";
import {
  getPoliticsClusters,
  type ClusterBundle,
  type PoliticsClustersResult,
} from "@/lib/clusters/politics-query";
import { searchClusters } from "@/lib/clusters/search-query";
import { composeSearchView } from "@/lib/clusters/search-view";
import {
  HOME_PAGE_SIZE,
  homeCanonicalPath,
  homeTotalPages,
  parseHomePage,
  rankedCountOf,
} from "@/lib/seo/home-canonical";

// Home route — this IS the news view.
//
// perf-8 / reader-queries C3: `HomePage` itself is a plain (non-async)
// Server Component so Next can serve the static shell (PageHero, the
// search bar placeholder, the feed skeleton) immediately, while the actual
// data — the politics feed AND, when present, the archive search — stream
// in behind their own <Suspense> boundaries inside `HomeFeed`. Neither the
// feed nor the archive search can fail the page any more: `loadFeed()` and
// `searchClusters()` both degrade to a retry affordance instead of
// throwing (see FeedUnavailable / SearchUnavailable below).

// Self-canonical for /?page=N (N > 1, clamped to the last page). Without
// this, the layout's canonical "/" told crawlers page 2 duplicates page 1.
// Metadata merges shallowly, so `types` (the layout's RSS alternate) is
// repeated or it would be dropped. Any failure returns {} (inherit "/") —
// metadata must never throw into the error boundary.
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; page?: string | string[] }>;
}): Promise<Metadata> {
  const { q, page: pageRaw } = await searchParams;
  const page = parseHomePage(pageRaw);
  if (page <= 1 || (Array.isArray(q) ? q[0] : q)?.trim()) return {};
  let rankedCount: number | null = null;
  try {
    rankedCount = rankedCountOf(await getPoliticsClusters());
  } catch {
    rankedCount = null;
  }
  const canonical = homeCanonicalPath({ q, page, rankedCount });
  if (!canonical) return {};
  return {
    alternates: {
      canonical,
      types: {
        "application/rss+xml": [{ url: "/rss.xml", title: "Tayf — Haberler RSS" }],
      },
    },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

type BucketKey = "today" | "thisWeek" | "older";

interface BucketDef {
  key: BucketKey;
  label: string;
  matches: (updatedAt: Date, nowMs: number) => boolean;
}

// Order matters — each bundle is assigned to the FIRST matching bucket.
// "older" is a catch-all so every bundle ends up somewhere.
const BUCKETS: readonly BucketDef[] = [
  {
    key: "today",
    label: "Bugün",
    matches: (t, now) => now - t.getTime() < DAY_MS,
  },
  {
    key: "thisWeek",
    label: "Bu hafta",
    matches: (t, now) => now - t.getTime() < WEEK_MS,
  },
  {
    key: "older",
    label: "Daha eski",
    matches: () => true,
  },
];

interface BucketWithClusters {
  key: BucketKey;
  label: string;
  count: number;
  clusters: ClusterBundle[];
}

// Shared card renderer used by both the "Son Dakika" strip and the
// time-bucketed sections below it. `idx` is passed in (not computed here)
// so the caller can maintain a single cross-section counter for the
// priority-image hint (first ~3 cards above the fold preload eagerly).
// `nowMs` is passed in because Next.js 16's `react-hooks/purity` rule
// forbids `Date.now()` in a Server Component render body — the page
// captures it once per request.
function renderClusterCard(
  bundle: ClusterBundle,
  idx: number,
  nowMs: number
) {
  const hoursAgo =
    (nowMs - new Date(bundle.cluster.updated_at).getTime()) / 3_600_000;
  return (
    <div
      key={bundle.cluster.id}
      className={`animate-fade-up stagger-${(idx % 8) + 1}`}
    >
      <ClusterCard
        cluster={bundle.cluster}
        articles={bundle.articles}
        sources={bundle.sources}
        index={idx}
        isAging={hoursAgo > 48}
        isWireRedistribution={bundle.isWireRedistribution}
        effectiveArticleCount={bundle.effectiveArticleCount}
      />
    </div>
  );
}

export default function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl space-y-5">
      <PageHero
        kicker="Türkiye haber takibi"
        title="Haberler"
        subtitle="Aynı olayı kaç farklı kaynak, hangi bakış açısıyla ele alıyor? Ensemble kümeleme ile birleştirilmiş güncel politika haberleri."
      />

      <Suspense fallback={<SearchBarPlaceholder />}>
        <SearchBar />
      </Suspense>

      <Suspense fallback={<FeedSkeleton />}>
        <HomeFeed searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

// Static placeholder matching SearchBar's own shape (see loading.tsx's
// former "Search bar skeleton" comment) — rendered synchronously in the
// static shell while the real <SearchBar/> streams in.
function SearchBarPlaceholder() {
  return (
    <div
      aria-hidden="true"
      className="h-10 w-full rounded-full bg-muted/40 animate-pulse"
    />
  );
}

// Static placeholder matching loading.tsx's former "Cluster card
// skeletons" — rendered synchronously in the static shell while
// `HomeFeed`'s data streams in.
function FeedSkeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="rounded-xl ring-1 ring-border/60 bg-card/60 p-5 flex gap-4 animate-pulse"
        >
          <div className="h-28 w-40 rounded-lg bg-muted/50 shrink-0" />
          <div className="flex-1 space-y-3">
            <div className="h-5 w-3/4 rounded bg-muted/70" />
            <div className="h-3 w-1/2 rounded bg-muted/40" />
            <div className="h-2 w-full rounded-full bg-muted/40" />
            <div className="space-y-1.5 mt-2">
              <div className="h-2.5 w-11/12 rounded bg-muted/30" />
              <div className="h-2.5 w-10/12 rounded bg-muted/30" />
              <div className="h-2.5 w-9/12 rounded bg-muted/30" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

async function loadFeed(): Promise<PoliticsClustersResult | null> {
  try {
    return await getPoliticsClusters();
  } catch (err) {
    console.warn("[home] feed unavailable:", err);
    return null;
  }
}

async function HomeFeed({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { q: qRaw, page: pageRaw } = await searchParams;
  const q = qRaw?.trim() || undefined;
  const page = parseHomePage(pageRaw);

  // Neither fetch depends on the other — run them in parallel. `search` is
  // only attempted once `q` reaches the 2-character floor (searchClusters
  // itself also enforces this, but skipping the call entirely here avoids
  // an unnecessary await on a query too short to ever match).
  const [feed, search] = await Promise.all([
    loadFeed(),
    q && q.length >= 2 ? searchClusters(q) : Promise.resolve(null),
  ]);

  if (feed === null) {
    return (
      <>
        <NewSinceLastVisit timestamps={[]} />
        <FeedUnavailable />
      </>
    );
  }

  const { bundles, breakingBundles } = feed;

  // Filter by Turkish-lowercased substring of the cluster title. We use
  // toLocaleLowerCase("tr") so dotted/dotless I are folded the way a
  // Turkish reader expects ("İstanbul" matches "istanbul").
  const needle = q?.toLocaleLowerCase("tr");
  const matchesNeedle = (b: ClusterBundle) =>
    !needle || b.cluster.title_tr.toLocaleLowerCase("tr").includes(needle);

  const filteredBreaking = breakingBundles.filter(matchesNeedle);
  const filtered = bundles.filter(matchesNeedle);

  // Dedupe: a cluster that's both "breaking" (< 2h) AND in the top-30
  // ranked set would otherwise render twice. The Son Dakika strip wins
  // — we remove those ids from the main ranked list so each cluster
  // appears in exactly one place on the page.
  const breakingIds = new Set(filteredBreaking.map((b) => b.cluster.id));
  const ranked = filtered.filter((b) => !breakingIds.has(b.cluster.id));

  const totalPages = homeTotalPages(ranked.length);
  // Clamp the requested page so /?page=999 still renders the last page
  // instead of an empty list.
  const safePage = Math.min(page, totalPages);
  const paged = ranked.slice(
    (safePage - 1) * HOME_PAGE_SIZE,
    safePage * HOME_PAGE_SIZE
  );

  // Son Dakika is a page-1-only strip. On page 2+ the user is browsing
  // deeper into the feed — re-showing the same breaking cards they
  // already scanned at the top of page 1 would be noise. Search
  // filtering still applies (via `filteredBreaking`), so a user
  // searching for a specific story won't see an irrelevant strip.
  const breaking = safePage === 1 ? filteredBreaking : [];

  // Feeds the "N yeni haber" pill: only clusters actually rendered on this page.
  const renderedTimestamps = [...breaking, ...paged].map(
    (b) => b.cluster.first_published
  );

  // Time buckets are computed on the PAGED slice only — each page is
  // self-contained, so the bucket headings reflect what's actually on
  // screen rather than the full filtered set.
  //
  // R5 stale-reactivation fix: bucket on `first_published` (when the
  // story broke) rather than `updated_at`. The clustering worker bumps
  // `updated_at` to the latest member's `published_at` every time a
  // follow-up article merges in, so a week-old cluster with one new
  // article today used to show up under "Bugün" even though the news
  // was stale. Bucketing on `first_published` makes the header labels
  // reflect when the story actually broke.
  const nowMs = currentTimeMs();
  const grouped = new Map<BucketKey, ClusterBundle[]>();
  for (const def of BUCKETS) grouped.set(def.key, []);
  for (const bundle of paged) {
    const firstPublished = new Date(bundle.cluster.first_published);
    for (const def of BUCKETS) {
      if (def.matches(firstPublished, nowMs)) {
        grouped.get(def.key)!.push(bundle);
        break;
      }
    }
  }
  const bucketsWithClusters: BucketWithClusters[] = BUCKETS.flatMap((def) => {
    const clusters = grouped.get(def.key) ?? [];
    if (clusters.length === 0) return [];
    return [
      {
        key: def.key,
        label: def.label,
        count: clusters.length,
        clusters,
      },
    ];
  });

  // All in-feed matches (breaking + ranked, across the whole filtered set —
  // not just this page's slice) so the archive section never duplicates a
  // cluster the reader can already see somewhere in the feed.
  const inFeedIds = new Set<string>([
    ...filteredBreaking.map((b) => b.cluster.id),
    ...filtered.map((b) => b.cluster.id),
  ]);
  const view = composeSearchView({ q, page: safePage, inFeedIds, search });

  const hasInFeedMatches = filtered.length > 0 || filteredBreaking.length > 0;

  // We track a global render index across buckets so the first ~3
  // ClusterCards (above the fold) still get the priority hint, even
  // though they're now nested inside <section> wrappers.
  let renderIndex = 0;

  return (
    <>
      <NewSinceLastVisit timestamps={renderedTimestamps} />

      {!q && bundles.length === 0 && breakingBundles.length === 0 ? (
        <EmptyClusters />
      ) : (
        <>
          {hasInFeedMatches && (
            <>
              {breaking.length > 0 && (
                <section className="space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 animate-pulse rounded-full bg-red-600 dark:bg-red-500"
                        aria-hidden="true"
                      />
                      <h2 className="font-serif text-sm font-semibold uppercase tracking-wider text-red-600 dark:text-red-500">
                        Son Dakika
                      </h2>
                    </div>
                    <div className="h-px flex-1 bg-gradient-to-r from-red-500/40 to-transparent" />
                    <span className="text-[11px] text-muted-foreground">
                      {breaking.length}
                    </span>
                  </div>
                  <div className="space-y-4">
                    {breaking.map((b) =>
                      renderClusterCard(b, renderIndex++, nowMs)
                    )}
                  </div>
                </section>
              )}

              {bucketsWithClusters.map((bucket) => (
                <section key={bucket.key} className="space-y-3">
                  <div className="flex items-center gap-3">
                    <h2 className="font-serif text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                      {bucket.label}
                    </h2>
                    <div className="h-px flex-1 bg-gradient-to-r from-brand/30 to-transparent" />
                    <span className="text-[11px] text-muted-foreground">
                      {bucket.count}
                    </span>
                  </div>
                  <div className="space-y-4">
                    {bucket.clusters.map((b) =>
                      renderClusterCard(b, renderIndex++, nowMs)
                    )}
                  </div>
                </section>
              ))}

              <Pagination
                currentPage={safePage}
                totalPages={totalPages}
                query={q}
              />
            </>
          )}

          {view.archive.length > 0 && (
            <section className="space-y-3">
              <div className="flex items-center gap-3">
                <h2 className="font-serif text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  Arşivden: {view.archive.length} sonuç
                </h2>
                <div className="h-px flex-1 bg-gradient-to-r from-brand/30 to-transparent" />
              </div>
              <div className="space-y-4">
                {view.archive.map((b) =>
                  renderClusterCard(b, renderIndex++, nowMs)
                )}
              </div>
            </section>
          )}

          {view.archiveUnavailable &&
            (hasInFeedMatches ? (
              <p className="text-xs text-muted-foreground">
                Arşiv araması şu an yanıt vermiyor.{" "}
                <RetryButton />
              </p>
            ) : (
              <SearchUnavailable />
            ))}

          {view.emptySearch && <EmptySearch query={q} />}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Empty / unavailable states
// ---------------------------------------------------------------------------

function EmptyClusters() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-border/60 bg-card/40 px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
        <Newspaper className="h-7 w-7" aria-hidden="true" />
      </div>
      <p className="font-serif text-sm font-medium text-foreground">
        Henüz gösterilecek bir küme yok
      </p>
      <p className="max-w-md text-xs text-muted-foreground leading-relaxed">
        Worker iki veya daha fazla kaynaktan gelen politika haberlerini
        birleştirmeye devam ediyor. Birkaç dakika sonra tekrar uğrayın.
      </p>
    </div>
  );
}

function FeedUnavailable() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-border/60 bg-card/40 px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
        <Newspaper className="h-7 w-7" aria-hidden="true" />
      </div>
      <p className="font-serif text-sm font-medium text-foreground">
        Haberler şu an yüklenemedi, birkaç dakika içinde tekrar deneyin.
      </p>
      <RetryButton />
    </div>
  );
}

function EmptySearch({ query }: { query?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-border/60 bg-card/40 px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
        <SearchX className="h-7 w-7" aria-hidden="true" />
      </div>
      <p className="font-serif text-sm font-medium text-foreground">
        Hiç haber bulunamadı
      </p>
      {query ? (
        <p className="max-w-md text-xs text-muted-foreground leading-relaxed">
          <span className="text-foreground">&ldquo;{query}&rdquo;</span>{" "}
          için sonuç yok. Farklı bir kelime deneyin.
        </p>
      ) : (
        <p className="max-w-md text-xs text-muted-foreground leading-relaxed">
          Aramanıza uyan bir küme yok. Farklı bir kelime deneyin.
        </p>
      )}
      <Link
        href="/"
        className="mt-1 inline-flex min-h-[44px] touch-manipulation items-center rounded-full border border-border/60 bg-background px-4 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
      >
        Aramayı temizle
      </Link>
    </div>
  );
}

function SearchUnavailable() {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-border/60 bg-card/40 px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
        <SearchX className="h-7 w-7" aria-hidden="true" />
      </div>
      <p className="font-serif text-sm font-medium text-foreground">
        Arama şu an yanıt vermiyor
      </p>
      <p className="max-w-md text-xs text-muted-foreground leading-relaxed">
        Arşiv araması zaman aşımına uğradı. Lütfen tekrar deneyin.
      </p>
      <div className="flex items-center gap-3">
        <RetryButton />
        <Link
          href="/"
          className="mt-1 inline-flex min-h-[44px] touch-manipulation items-center rounded-full border border-border/60 bg-background px-4 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
        >
          Aramayı temizle
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  query?: string;
}

function Pagination({ currentPage, totalPages, query }: PaginationProps) {
  if (totalPages <= 1) return null;

  // We rebuild the query string from scratch (instead of mutating the
  // incoming params) so that page=1 stays canonical (no `?page=1` in the
  // URL) and so unrelated future params don't accidentally leak in.
  const mkHref = (p: number) => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `/?${qs}` : "/";
  };

  const linkCls =
    "inline-flex min-h-[44px] touch-manipulation items-center rounded-full border border-border/60 bg-background px-4 text-[12px] font-medium text-foreground transition-colors hover:bg-muted hover:border-brand/40 hover:text-brand";

  return (
    <nav
      aria-label="Sayfalar"
      className="flex items-center justify-center gap-3 pt-4"
    >
      {currentPage > 1 ? (
        <Link href={mkHref(currentPage - 1)} className={linkCls}>
          Önceki
        </Link>
      ) : null}
      <span className="text-[11px] text-muted-foreground">
        {currentPage} / {totalPages}
      </span>
      {currentPage < totalPages ? (
        <Link href={mkHref(currentPage + 1)} className={linkCls}>
          Sonraki
        </Link>
      ) : null}
    </nav>
  );
}
