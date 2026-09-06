import type { Metadata } from "next";
import Link from "next/link";
import { cacheLife, cacheTag } from "next/cache";
import { connection } from "next/server";

// Own metadata so the page doesn't inherit the root layout's title and
// `canonical: "/"` (which would mark this page a duplicate of the homepage).
export const metadata: Metadata = {
  title: "Kaynaklar",
  description:
    "Tayf'ın izlediği 144 Türk haber kaynağı — yanlılık kategorisi, son 7 günlük aktivite ve son görülme zamanıyla birlikte.",
  alternates: { canonical: "/sources" },
};

import { PageHero } from "@/components/ui/page-hero";
import { BiasBadge } from "@/components/story/bias-badge";
import { BIAS_LABELS, BIAS_ORDER } from "@/lib/bias/config";
import { isVotingSource, sourceKindOf, SOURCE_KIND_META } from "@/lib/sources/kind";
import { formatTurkishTimeAgo } from "@/lib/time";
import { createServerClient } from "@/lib/supabase/server";
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
// trends; the page surfaces a "Sınıflandırılan: N/M" line up top and a
// per-card kind badge (dimmed for aggregator/niche) so a reader can see at
// a glance which sources feed the numbers and which are along for the ride.

interface SourceRow extends Source {
  articleCount7d: number;
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

async function getSources(): Promise<GroupedSources> {
  "use cache";
  cacheLife("source-directory");
  cacheTag("sources");

  const supabase = createServerClient();

  // Window: last 7 days, anchored to "now" at cache-fill time. The 5-minute
  // cache TTL means the window can drift by up to 5 minutes between
  // refreshes — well within the resolution of "haftalık aktivite".
  const sevenDaysAgo = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await supabase
    .from("sources")
    .select(
      "id, name, slug, url, rss_url, bias, logo_url, active, kind, stats:articles(count), latest:articles(published_at)",
    )
    .eq("active", true)
    .gte("stats.published_at", sevenDaysAgo)
    .gte("latest.published_at", sevenDaysAgo)
    .order("published_at", { referencedTable: "latest", ascending: false })
    .limit(1, { referencedTable: "latest" })
    .order("name", { ascending: true });

  if (error) {
    throw new Error(`sources query failed: ${error.message}`);
  }

  type Row = Source & {
    stats: Array<{ count: number }>;
    latest: Array<{ published_at: string }>;
  };
  const sourceRows = (data ?? []) as unknown as Row[];

  // Group sources by bias. Unknown bias values (shouldn't happen — DB has
  // a CHECK constraint — but we narrow defensively) are dropped silently.
  const grouped = emptyGrouped();
  for (const source of sourceRows) {
    const bias = source.bias as BiasCategory;
    if (!(bias in grouped)) continue;
    const { stats, latest, ...rest } = source;
    grouped[bias].push({
      ...rest,
      articleCount7d: stats[0]?.count ?? 0,
      lastPublishedAt: latest[0]?.published_at ?? null,
    });
  }

  // Within each bias bucket, surface the most-active sources first; ties
  // fall back to alphabetical (already pre-sorted by the SQL ORDER BY).
  for (const bias of BIAS_ORDER) {
    grouped[bias].sort((a, b) => b.articleCount7d - a.articleCount7d);
  }

  return grouped;
}

export default async function SourcesPage() {
  await connection();
  const grouped = await getSources();

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

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl space-y-6">
      <PageHero
        kicker="Türkiye medya haritası"
        title="Kaynaklar"
        subtitle={`Tayf ${totalSources} Türk haber kaynağını izliyor. Her biri bir siyasi duruşa yerleştirilmiş.`}
      />
      <p className="text-xs text-muted-foreground">
        Sınıflandırılan:{" "}
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

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {bucket.map((source, srcIdx) => {
                const kind = sourceKindOf(source);
                const voting = isVotingSource(source);
                const cardClassName = voting
                  ? `group relative rounded-xl ring-1 ring-border/60 hover:ring-border bg-card/60 hover:bg-card/80 p-4 transition-all hover-lift animate-fade-up stagger-${srcIdx < 6 ? srcIdx + 1 : 6}`
                  : `group relative rounded-xl ring-1 ring-border/60 hover:ring-border bg-card/60 hover:bg-card/80 p-4 transition-all hover-lift animate-fade-up stagger-${srcIdx < 6 ? srcIdx + 1 : 6} opacity-70`;
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
                        <div className="flex flex-wrap items-center gap-1">
                          <BiasBadge bias={source.bias} size="sm" />
                          {kind !== "outlet" && (
                            <span
                              className="inline-flex items-center rounded-full border border-border/60 bg-muted/40 px-1.5 py-0 text-[10px] text-muted-foreground"
                              title={SOURCE_KIND_META[kind].description}
                            >
                              {SOURCE_KIND_META[kind].label}
                            </span>
                          )}
                        </div>
                        <p className="text-muted-foreground">
                          <span className="font-mono text-[10px]">son 7 günde {source.articleCount7d} haber</span>
                        </p>
                        {source.lastPublishedAt ? (
                          <p className="text-[10px] text-muted-foreground/70">
                            {formatTurkishTimeAgo(source.lastPublishedAt)}
                          </p>
                        ) : (
                          <p className="text-[10px] text-muted-foreground/70">
                            son 7 günde aktivite yok
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
    </div>
  );
}
