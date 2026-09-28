import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { cacheLife, cacheTag } from "next/cache";
import { connection } from "next/server";

// Own metadata so the page doesn't inherit the root layout's title and
// `canonical: "/"` (which would mark this page a duplicate of the homepage).
export const metadata: Metadata = {
  title: "Kaynaklar",
  description:
    "Tayf'ın izlediği Türk haber kaynakları — yanlılık kategorisi, son 7 günlük aktivite ve son görülme zamanıyla birlikte.",
  alternates: { canonical: "/sources" },
};

import { PageHero } from "@/components/ui/page-hero";
import { RetryButton } from "@/components/ui/retry-button";
import { BiasBadge } from "@/components/story/bias-badge";
import { SourceChips } from "@/components/source/source-chips";
import { DenominatorNote } from "@/components/source/denominator-note";
import { ClickbaitKarneSection } from "@/components/source/clickbait-karne";
import { BIAS_LABELS, BIAS_ORDER } from "@/lib/bias/config";
import { isVotingSource, sourceKindOf, SOURCE_KIND_META } from "@/lib/sources/kind";
import { countClassifiedSources } from "@/lib/sources/classification";
import { FEED_YIELD_WINDOW_MS } from "@/lib/clusters/feed-health";
import { getSourceItemsPerDay } from "@/lib/sources/feed-status";
import { weeklyCountFromPerDay, sortGroupedByActivity } from "@/lib/sources/directory";
import { formatTurkishTimeAgo } from "@/lib/time";
import { createServerClient } from "@/lib/supabase/server";
import { buildRegistryDataset, serializeJsonLd } from "@/lib/seo/json-ld";
import {
  CLICKBAIT_PRECISION_CHECK,
  getClickbaitKarne,
  isClickbaitPublic,
} from "@/lib/sources/clickbait";
import type { BiasCategory, Source } from "@/types";

// /sources — public directory of every active Türk news source Tayf monitors,
// grouped by bias category, with a 7-day article count and a "last seen"
// timestamp per source.
//
// Server Component. One cached round-trip: every active source with two
// aliased embeds of `articles` — `stats` (7-day count) and `latest` (the
// single newest row). Both aggregate in Postgres, so the result is 118 rows
// regardless of article volume. The previous version pulled every article
// row from the last week and counted in memory; PostgREST caps a response
// at 1000 rows, so at ~45k articles/week it silently counted only the
// newest 1000 and reported "0 haber" for most sources.
//
// Cached at the data layer with `unstable_cache` for 5 minutes — the source
// directory shifts on the order of weeks, and the recent-activity counter
// only needs to feel "fresh", not real-time. The route segment `revalidate`
// below layers ISR on top so cold renders are also bounded.
//
// Each row also carries `kind` (outlet/aggregator/wire/niche — migration
// 034). Only "outlet" and "wire" vote in bias_distribution / blindspot /
// trends; the page surfaces a "Yanlılık dağılımına sayılan: N/M" line up
// top and a per-card kind badge (dimmed for aggregator/niche) so a reader
// can see at a glance which sources feed the numbers and which are along
// for the ride. This is a separate axis from factuality/ownership tagging
// (src/lib/sources/classification.ts): only ~30 of the 118 sources carry a
// hand-tagged factuality/ownership chip, so that coverage is reported once,
// directory-wide ("N/M kaynak etiketli"), instead of a per-card
// "sınıflandırılmamış" chip that would otherwise dominate most cards.

interface SourceRow extends Source {
  lastPublishedAt: string | null;
}

type GroupedSources = Record<BiasCategory, SourceRow[]>;

function emptyGrouped(): GroupedSources {
  return {
    pro_government: [],
    gov_leaning: [],
    state_media: [],
    islamist_conservative: [],
    center: [],
    international: [],
    pro_kurdish: [],
    opposition_leaning: [],
    opposition: [],
    nationalist: [],
  };
}

// reader-queries G2: `stats:articles(count)` (the PERF-01 aggregate,
// measured bimodal 177-4639ms — see feed-status.ts's own header) and its
// `.gte("stats.published_at", ...)` are GONE from this select. The 7-day
// weekly-activity count now comes from `getSourceItemsPerDay()`
// (feed-status.ts, already used by /kaynaklar/durum), fetched separately
// and streamed in behind its own <Suspense> boundary below (see
// `SourceCountsGrid`) so the directory shell paints without waiting on it.
async function getSources(): Promise<GroupedSources> {
  "use cache";
  cacheLife("source-directory");
  cacheTag("sources");

  const supabase = createServerClient();

  // Window: last 7 days, anchored to "now" at cache-fill time — only used
  // for the cheap `latest` existence probe now.
  const sevenDaysAgo = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await supabase
    .from("sources")
    .select(
      "id, name, slug, url, rss_url, bias, logo_url, active, kind, latest:articles(published_at)",
    )
    .eq("active", true)
    .gte("latest.published_at", sevenDaysAgo)
    .order("published_at", { referencedTable: "latest", ascending: false })
    .limit(1, { referencedTable: "latest" })
    .order("name", { ascending: true });

  if (error) {
    throw new Error(`sources query failed: ${error.message}`);
  }

  type Row = Source & {
    latest: Array<{ published_at: string }>;
  };
  const sourceRows = (data ?? []) as unknown as Row[];

  // Group sources by bias. Unknown bias values (shouldn't happen — DB has
  // a CHECK constraint — but we narrow defensively) are dropped silently.
  const grouped = emptyGrouped();
  for (const source of sourceRows) {
    const bias = source.bias as BiasCategory;
    if (!(bias in grouped)) continue;
    const { latest, ...rest } = source;
    grouped[bias].push({
      ...rest,
      lastPublishedAt: latest[0]?.published_at ?? null,
    });
  }

  return grouped;
}

export type SourcesResult =
  | { ok: true; grouped: GroupedSources }
  | { ok: false };

/**
 * Never-throw wrapper for the page component — sits OUTSIDE the cache
 * boundary (mirroring search-query.ts's searchClusters) so a failure is
 * never memoised as "no sources" for the cache window.
 */
async function getSourcesSafe(): Promise<SourcesResult> {
  try {
    const grouped = await getSources();
    return { ok: true, grouped };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[sources] unavailable: ${message}`);
    return { ok: false };
  }
}

export default async function SourcesPage() {
  await connection();
  const result = await getSourcesSafe();

  if (!result.ok) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-6xl space-y-6">
        <PageHero
          kicker="Türkiye medya haritası"
          title="Kaynaklar"
          subtitle="Tayf'ın izlediği Türk haber kaynakları, siyasi duruşlarıyla birlikte."
        />
        <p className="text-sm text-muted-foreground">
          Kaynak listesi şu an yüklenemedi. Birkaç dakika içinde tekrar
          deneyin.
        </p>
        <RetryButton />
      </div>
    );
  }

  const { grouped } = result;

  const totalSources = BIAS_ORDER.reduce(
    (acc, bias) => acc + (grouped[bias]?.length ?? 0),
    0,
  );
  // How many of the active directory actually feed bias_distribution /
  // blindspot / trends — aggregator and niche sources are listed below but
  // never counted (migration 034 / src/lib/sources/kind.ts).
  const votingSources = BIAS_ORDER.reduce(
    (acc, bias) => acc + (grouped[bias] ?? []).filter(isVotingSource).length,
    0,
  );

  // PERF-01 / A-H1: the DenominatorNote footnote's pair, derived for free
  // from the `grouped` rows getSources() already fetched — NOT a second
  // full-directory query (do not touch getSources() itself; it doesn't
  // need to change). `lastPublishedAt` on each row already carries the
  // real timestamp within getSources()'s 7-day window, so "delivering"
  // (within the shorter 72h yield window) is derivable locally. Must be
  // the VOTING-kind intersection (A-H1) — not every active source — since
  // that's the real denominator every share on this page divides by.
  // `nowMs` guards against a future-dated `lastPublishedAt` (SEC-01 — a
  // source-controlled pubDate must never count as "just delivered").
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  let votingDelivering = 0;
  for (const bias of BIAS_ORDER) {
    for (const source of grouped[bias] ?? []) {
      if (!isVotingSource(source)) continue;
      const lastMs = source.lastPublishedAt
        ? new Date(source.lastPublishedAt).getTime()
        : null;
      const delivering =
        lastMs !== null &&
        lastMs <= nowMs &&
        nowMs - lastMs <= FEED_YIELD_WINDOW_MS;
      if (delivering) votingDelivering += 1;
    }
  }

  const allSlugs = BIAS_ORDER.flatMap(
    (bias) => (grouped[bias] ?? []).map((source) => source.slug),
  );
  const classifiedSources = countClassifiedSources(allSlugs);

  // "tık tuzağı karnesi" (migration 078) — gated on CLICKBAIT_PRECISION_CHECK
  // (src/lib/sources/clickbait.ts). getClickbaitKarne() is only called when
  // the gate is already open, so a closed gate costs nothing extra here.
  const karne = isClickbaitPublic() ? await getClickbaitKarne() : null;

  // S-17: Dataset JSON-LD describing the source registry this page
  // renders. `dateModified` reuses `nowMs` (already computed above for the
  // yield-denominator footnote) rather than a second clock read.
  const registryDataset = buildRegistryDataset({
    dateModified: new Date(nowMs).toISOString(),
  });

  return (
    <>
      {/* Same script-injection-safety rationale as cluster/[id]/page.tsx's
          NewsArticle block: `serializeJsonLd` escapes every "<" so a
          hostile source name can never terminate the script element
          early. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(registryDataset) }}
      />
      <div className="container mx-auto px-4 py-8 max-w-6xl space-y-6">
      <PageHero
        kicker="Türkiye medya haritası"
        title="Kaynaklar"
        subtitle={`Tayf ${totalSources} Türk haber kaynağını izliyor. Her biri bir siyasi duruşa yerleştirilmiş.`}
      />
      <p className="text-xs text-muted-foreground">
        Yanlılık dağılımına sayılan:{" "}
        <span className="font-mono">
          {votingSources}/{totalSources}
        </span>{" "}
        aktif kaynak — toplayıcı ve niş yayınlar kümelerde listelenir,
        yanlılık dağılımına sayılmaz.{" "}
        <Link
          href="/metodoloji#kaynaklar"
          className="underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          Neden?
        </Link>
      </p>
      <DenominatorNote delivering={votingDelivering} total={votingSources} />
      <p className="text-xs text-muted-foreground">
        Doğruluk ve sahiplik etiketi girilen kaynak:{" "}
        <span className="font-mono">
          {classifiedSources}/{totalSources}
        </span>{" "}
        — etiketi olmayan kaynaklar henüz sınıflandırılmadı; bu, yanlılık
        konumundan bağımsız bir bilgidir.
      </p>

      <Suspense
        fallback={
          <SourceDirectory
            grouped={sortGroupedByActivity(grouped, null)}
            countLabel={PENDING_COUNT_LABEL}
          />
        }
      >
        <SourceDirectoryWithCounts grouped={grouped} />
      </Suspense>
      {karne ? (
        <ClickbaitKarneSection karne={karne} check={CLICKBAIT_PRECISION_CHECK} />
      ) : null}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// reader-queries G2: the weekly-activity count streams in separately from
// the directory shell above (which paints as soon as getSourcesSafe()
// resolves). PENDING_COUNT_LABEL renders in the <Suspense> fallback (the
// aggregate hasn't been asked for yet); `null` counts (the aggregate
// resolved but the query failed) render as an em dash; a resolved counts
// map renders the real number for every source (missing from the map ==
// zero articles in the window, per getSourceItemsPerDay's contract).
// ---------------------------------------------------------------------------

const PENDING_COUNT_LABEL = "son 7 günde … haber";

function countLabelFromCounts(
  counts: Record<string, number> | null,
  slug: string,
): string {
  if (counts === null) return "son 7 günde — haber";
  return `son 7 günde ${counts[slug] ?? 0} haber`;
}

// Exported (in addition to the default page export) so tests can render
// the streamed directory body directly without needing a full
// Suspense-aware renderer — see page.test.tsx.
export async function SourceDirectoryWithCounts({
  grouped,
}: {
  grouped: GroupedSources;
}) {
  const perDay = await getSourceItemsPerDay();
  const weekly =
    perDay === null
      ? null
      : Object.fromEntries(
          Object.entries(perDay).map(([slug, value]) => [
            slug,
            weeklyCountFromPerDay(value),
          ]),
        );
  const sorted = sortGroupedByActivity(grouped, weekly);
  return (
    <SourceDirectory
      grouped={sorted}
      countLabel={(slug) => countLabelFromCounts(weekly, slug)}
    />
  );
}

// Exported (in addition to the default page export) so tests can render
// the kind-badge grid directly — see page.test.tsx.
export function SourceDirectory({
  grouped,
  countLabel,
}: {
  grouped: GroupedSources;
  countLabel: string | ((slug: string) => string);
}) {
  return (
    <>
      {BIAS_ORDER.map((bias) => {
        const bucket = grouped[bias] ?? [];
        if (bucket.length === 0) return null;

        return (
          <section key={bias} className="space-y-3">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-serif font-semibold tracking-tight">
                {BIAS_LABELS[bias]}
              </h2>
              <span className="text-[11px] text-muted-foreground">
                {bucket.length} kaynak
              </span>
            </div>

            <div className="grid grid-cols-1 min-[480px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {bucket.map((source, srcIdx) => {
                const kind = sourceKindOf(source);
                const voting = isVotingSource(source);
                const cardClassName = voting
                  ? `group relative rounded-xl ring-1 ring-border/60 hover:ring-border bg-card/60 hover:bg-card/80 p-4 transition-all hover-lift animate-fade-up stagger-${srcIdx < 6 ? srcIdx + 1 : 6}`
                  : `group relative rounded-xl ring-1 ring-border/60 hover:ring-border bg-card/60 hover:bg-card/80 p-4 transition-all hover-lift animate-fade-up stagger-${srcIdx < 6 ? srcIdx + 1 : 6} opacity-70`;
                const label =
                  typeof countLabel === "string"
                    ? countLabel
                    : countLabel(source.slug);
                return (
                  <div key={source.id} className={cardClassName}>
                  <Link
                    href={`/source/${source.slug}`}
                    className="block"
                    aria-label={`${source.name} profili`}
                  >
                    <div className="flex items-start gap-3">
                      {source.logo_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={source.logo_url}
                          alt=""
                          className="h-8 w-8 rounded shrink-0 object-contain bg-background ring-1 ring-border/30"
                          loading="lazy"
                        />
                      ) : (
                        <div className="h-8 w-8 rounded shrink-0 bg-muted/60 ring-1 ring-border/30" />
                      )}
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-sm font-sans font-semibold truncate group-hover:text-foreground pr-5">
                          {source.name}
                        </p>
                        <div className="flex flex-wrap items-center gap-1 min-w-0">
                          <BiasBadge bias={source.bias} size="sm" />
                          {kind !== "outlet" && (
                            <span
                              className="inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-1.5 py-0 text-[10px] text-muted-foreground"
                              title={SOURCE_KIND_META[kind].description}
                            >
                              {SOURCE_KIND_META[kind].label}
                            </span>
                          )}
                          <SourceChips slug={source.slug} />
                        </div>
                        <p className="text-muted-foreground">
                          <span className="font-mono text-[10px]">{label}</span>
                        </p>
                        {source.lastPublishedAt && (
                          <p className="text-[10px] text-muted-foreground/70">
                            {formatTurkishTimeAgo(source.lastPublishedAt)}
                          </p>
                        )}
                      </div>
                    </div>
                  </Link>
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${source.name} sitesini yeni sekmede aç`}
                    className="absolute top-3 right-3 text-[11px] text-muted-foreground/70 hover:text-foreground leading-none px-1.5 py-0.5 rounded hover:bg-muted/60"
                  >
                    ↗
                  </a>
                </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </>
  );
}
