import Link from "next/link";
import { Newspaper, SearchX } from "lucide-react";

import { SearchBar } from "@/components/filters/search-bar";
import { ClusterCard } from "@/components/story/cluster-card";
import { PageHero } from "@/components/ui/page-hero";
import {
  getPoliticsClusters,
  type ClusterBundle,
} from "@/lib/clusters/politics-query";

// Home route — this IS the news view.
// Previously a separate "Haberler" article feed lived here, but the user
// consolidated it: the canonical "news" experience is the story-cluster
// view (aynı haber, farklı kaynaklar), so the home route now renders the
// cluster bundles directly.
//
// Caching: the cluster worker runs on a 30s cycle, so serving a cached
// render for up to 30s is the natural freshness window. Route-segment ISR
// (`revalidate = 30`) layers on top of the in-process cache inside
// `getPoliticsClusters`.
//
// b4 update: the page now reads two query params and re-shapes the
// cluster list in JS:
//   ?q=...      free-text title filter (Turkish lowercase substring)
//   ?page=N     1-indexed pagination slice (PAGE_SIZE clusters per page)
// Filtering happens BEFORE pagination, then the paged set is grouped
// into three time buckets (Bugün / Bu hafta / Daha eski) based on each
// cluster's `updated_at`. The data fetch itself is unchanged — the
// politics-query helper caches its result for 30s, so re-filtering on
// every request is essentially free.
const PAGE_SIZE = 15;

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
// time-bucketed sections below it. Extracted because we now render the
// same card JSX in two places. `idx` is passed in (not computed here)
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

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { q: qRaw, page: pageRaw } = await searchParams;
  const q = qRaw?.trim() || undefined;
  const page = Math.max(1, parseInt(pageRaw ?? "1", 10) || 1);

  const { bundles, breakingBundles } = await getPoliticsClusters();

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

  const totalPages = Math.max(1, Math.ceil(ranked.length / PAGE_SIZE));
  // Clamp the requested page so /?page=999 still renders the last page
  // instead of an empty list.
  const safePage = Math.min(page, totalPages);
  const paged = ranked.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE
  );

  // Son Dakika is a page-1-only strip. On page 2+ the user is browsing
  // deeper into the feed — re-showing the same breaking cards they
  // already scanned at the top of page 1 would be noise. Search
  // filtering still applies (via `filteredBreaking`), so a user
  // searching for a specific story won't see an irrelevant strip.
  const breaking = safePage === 1 ? filteredBreaking : [];

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
  const nowMs = Date.now();
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

  // We track a global render index across buckets so the first ~3
  // ClusterCards (above the fold) still get the priority hint, even
  // though they're now nested inside <section> wrappers.
  let renderIndex = 0;

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl space-y-5">
      <PageHero
        kicker="Türkiye haber takibi"
        title="Haberler"
        subtitle="Aynı olayı kaç farklı kaynak, hangi bakış açısıyla ele alıyor? Ensemble kümeleme ile birleştirilmiş güncel politika haberleri."
      />

      <SearchBar />

      {bundles.length === 0 && breakingBundles.length === 0 ? (
        <EmptyClusters />
      ) : filtered.length === 0 && filteredBreaking.length === 0 ? (
        <EmptySearch query={q} />
      ) : (
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
                {breaking.map((b) => renderClusterCard(b, renderIndex++, nowMs))}
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty states
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
