import type { Metadata } from "next";
import Link from "next/link";

import { PageHero } from "@/components/ui/page-hero";
import { BIAS_LABELS, ZONE_META } from "@/lib/bias/config";
import { zonePercents } from "@/lib/bias/zone-summary";
import {
  getZoneFeedHealth,
  zoneYieldDenominator,
  type ZoneFeedHealth,
} from "@/lib/clusters/feed-health";
import { formatDdMmYyyy } from "@/lib/format/date-tr";
import { getFeedStatusSummary } from "@/lib/sources/feed-status";
import {
  getWeeklyClusters,
  getWeeklyLabelChanges,
  summariseWeek,
  WEEKLY_CLUSTER_LIMIT,
  type WeeklyLabelChange,
  type WeeklySummary,
} from "@/lib/weekly/weekly-query";
import type { MediaDnaZone } from "@/types";

// /hafta — P-07 "Medya Hava Durumu", the weekly content spine: what each
// Medya DNA zone led with over the trailing 7 days, the stories that drew
// the widest spectrum, the blindspots, how many sources went silent, and
// which labels moved.
//
// Every number on this page carries the denominator it was actually
// computed from, and never mixes populations: the percentage is a zone's
// share of the week's *article* total (largest-remainder rounded by
// `zonePercents`, so the three add to exactly 100), while the source figure
// beside it is `zoneYieldDenominator` — how many sources in that zone
// delivered anything in the trailing 72 h — stated as its own fact, not as
// a ratio over article counts. When feed health is unknown the row says
// "payda bilinmiyor" instead of inventing one. All aggregation lives in
// src/lib/weekly/weekly-query.ts (unit tested there); this file only
// decides how to render null / [] / real data.
//
// No `export const dynamic` / `revalidate`: under cacheComponents every
// fetcher is a "use cache" function that resolves to null on error, so this
// page prerenders into its honest unavailable state rather than failing the
// build.

export const metadata: Metadata = {
  title: "Haftanın yelpazesi",
  description:
    "Son 7 günde hangi taraf neyi öne çıkardı: bölge payları, en geniş yelpazeli haberler, kör noktalar, sessiz kaynaklar ve etiket değişiklikleri.",
  alternates: { canonical: "/hafta" },
};

// Shared class tokens — literal strings only (Tailwind 4 has no runtime
// scanner). Mirrors /kalite's token set.
const cardClass = "rounded-xl ring-1 ring-border/60 bg-card/60 p-4 sm:p-6";
const proseClass = "max-w-[65ch] text-sm text-muted-foreground leading-relaxed";
const sectionTitleClass = "text-lg font-semibold tracking-tight text-foreground";
const rowClass =
  "flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg ring-1 ring-border/50 bg-muted/20 p-3";
const linkClass =
  "text-sm font-medium text-foreground underline decoration-dotted underline-offset-2 hover:text-primary";
const metaClass = "text-xs text-muted-foreground";

const ZONE_ORDER: readonly MediaDnaZone[] = [
  "iktidar",
  "bagimsiz",
  "muhalefet",
];

const UNAVAILABLE_COPY =
  "Haftalık özet şu anda hesaplanamıyor. Birkaç dakika içinde tekrar deneyin.";
const EMPTY_COPY = "Bu hafta yeterli küme oluşmadı.";
const DEGRADED_CAVEAT =
  "Bazı bölgelerde kaynaklara ulaşılamıyor; bu haftanın kör nokta listesi eksik olabilir.";
const TRUNCATED_CAVEAT = `En büyük ${WEEKLY_CLUSTER_LIMIT} küme üzerinden hesaplandı; haftanın tamamı değil.`;

export default async function WeeklyPage() {
  const [clusters, health, feedStatus, labelChanges] = await Promise.all([
    getWeeklyClusters(),
    getZoneFeedHealth(),
    getFeedStatusSummary(),
    getWeeklyLabelChanges(),
  ]);

  const summary =
    clusters !== null && clusters.length > 0
      ? summariseWeek(clusters, health)
      : null;

  // The cluster window is hard-capped and ordered by size, so hitting the
  // cap means the figures below are the biggest WEEKLY_CLUSTER_LIMIT
  // clusters, not the whole week. Say so rather than publishing a truncated
  // total as "the week".
  const truncated = clusters !== null && clusters.length >= WEEKLY_CLUSTER_LIMIT;

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl space-y-10">
      <PageHero
        kicker="Haftalık"
        title="Haftanın yelpazesi"
        subtitle="Son 7 günün medya hava durumu: hangi taraf neyi öne çıkardı, hangi haber en geniş yelpazeyi topladı, neyi yalnızca bir taraf gördü."
      />

      {clusters === null ? (
        <div className="rounded-xl border border-border/60 bg-card/40 p-8 text-center">
          <p className="text-sm text-muted-foreground">{UNAVAILABLE_COPY}</p>
        </div>
      ) : summary === null ? (
        <div className="rounded-xl border border-border/60 bg-card/40 p-8 text-center">
          <p className="text-sm text-muted-foreground">{EMPTY_COPY}</p>
        </div>
      ) : (
        <>
          <ZoneShares
            summary={summary}
            health={health}
            feedStatus={feedStatus}
            truncated={truncated}
          />
          <WidestSpectrum summary={summary} />
          <Blindspots summary={summary} health={health} />
        </>
      )}

      <SilentSources feedStatus={feedStatus} />
      <LabelChanges changes={labelChanges} />
    </div>
  );
}

function ZoneShares({
  summary,
  health,
  feedStatus,
  truncated,
}: {
  summary: WeeklySummary;
  health: ZoneFeedHealth | null;
  feedStatus: { delivering: number; total: number } | null;
  truncated: boolean;
}) {
  const total = ZONE_ORDER.reduce(
    (sum, zone) => sum + summary.zoneCounts[zone],
    0,
  );
  // Largest-remainder rounding (the shared helper every other zone surface
  // uses): three independent Math.round calls can sum to 99 or 101.
  const percents = zonePercents(summary.zoneCounts);

  return (
    <section className={`${cardClass} space-y-3`}>
      <h2 className={sectionTitleClass}>Bu hafta kim neyi öne çıkardı</h2>
      <ul className="space-y-2">
        {ZONE_ORDER.map((zone) => {
          const count = summary.zoneCounts[zone];
          // A source count, not a share: article counts and source counts
          // are different populations and must never be divided into each
          // other.
          const delivering = zoneYieldDenominator(health, zone);

          return (
            <li key={zone} className={rowClass}>
              <span className={`text-sm font-semibold ${ZONE_META[zone].zoneLabel}`}>
                {ZONE_META[zone].label}
              </span>
              <span className="text-sm text-foreground/90">{`${count} haber`}</span>
              <span className="font-mono text-sm text-foreground">
                {`%${percents[zone]}`}
              </span>
              <span className={metaClass}>
                {`(haftanın ${total} haberi içinde)`}
              </span>
              <span className={metaClass}>
                {delivering === null
                  ? "payda bilinmiyor"
                  : `${delivering} kaynak haber verdi`}
              </span>
            </li>
          );
        })}
      </ul>
      {truncated ? <p className={metaClass}>{TRUNCATED_CAVEAT}</p> : null}
      <BasisNote total={total} feedStatus={feedStatus} />
    </section>
  );
}

/**
 * The basis line for this section. The shared `DenominatorNote` states that
 * *shares* are computed over delivering sources, which is not how either
 * figure in the rows above is computed, so /hafta states its own two bases:
 * the percentage's denominator (the week's article total) and what the
 * per-zone source figure counts (72 h delivering sources).
 */
function BasisNote({
  total,
  feedStatus,
}: {
  total: number;
  feedStatus: { delivering: number; total: number } | null;
}) {
  const known = feedStatus !== null && feedStatus.total > 0;

  return (
    <p className="text-xs text-muted-foreground">
      {`Yüzdeler bu haftanın toplam ${total} haberi üzerinden hesaplanır. Kaynak sayıları ise son 72 saatte en az bir haber veren kaynakları gösterir`}
      {known
        ? `; sitenin genelinde ${feedStatus.delivering} / ${feedStatus.total} kaynak haber verdi. `
        : "; bu sayı şu anda bilinmiyor. "}
      <Link
        href="/kaynaklar/durum"
        className="underline decoration-dotted underline-offset-2 hover:text-foreground"
      >
        Kaynak durumu →
      </Link>
    </p>
  );
}

function WidestSpectrum({ summary }: { summary: WeeklySummary }) {
  return (
    <section className={`${cardClass} space-y-3`}>
      <h2 className={sectionTitleClass}>En geniş yelpaze</h2>
      {summary.topClusters.length === 0 ? (
        <p className={proseClass}>
          Bu hafta birden fazla bölgenin birlikte gördüğü haber olmadı.
        </p>
      ) : (
        <ul className="space-y-2">
          {summary.topClusters.map((cluster) => (
            <li key={cluster.id} className={rowClass}>
              <Link href={`/cluster/${cluster.id}`} className={linkClass}>
                {cluster.title}
              </Link>
              <span className={metaClass}>
                {`${cluster.articleCount} haber · ${cluster.zonesCovered} bölge`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Blindspots({
  summary,
  health,
}: {
  summary: WeeklySummary;
  health: ZoneFeedHealth | null;
}) {
  const degraded =
    health !== null && ZONE_ORDER.some((zone) => health[zone].degraded);

  return (
    <section className={`${cardClass} space-y-3`}>
      <h2 className={sectionTitleClass}>Kör noktalar</h2>
      {summary.blindspots.length === 0 ? (
        <p className={proseClass}>Bu hafta kör nokta yok.</p>
      ) : (
        <ul className="space-y-2">
          {summary.blindspots.map((blindspot) => (
            <li key={blindspot.id} className={rowClass}>
              <Link href={`/cluster/${blindspot.id}`} className={linkClass}>
                {blindspot.title}
              </Link>
              <span className={metaClass}>
                {`Sadece ${ZONE_META[blindspot.side].label} tarafında · ${blindspot.articleCount} haber`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {degraded ? <p className={metaClass}>{DEGRADED_CAVEAT}</p> : null}
    </section>
  );
}

function SilentSources({
  feedStatus,
}: {
  feedStatus: { delivering: number; total: number } | null;
}) {
  return (
    <section className={`${cardClass} space-y-3`}>
      <h2 className={sectionTitleClass}>Sessiz kaynaklar</h2>
      <p className="text-sm text-foreground/90">
        {feedStatus === null
          ? "Sessiz kaynak sayısı bilinmiyor."
          : // `delivering` is measured over FEED_YIELD_WINDOW_MS (72 h), not
            // the 7-day page window — the copy states the window the data
            // actually covers.
            `${feedStatus.total - feedStatus.delivering} kaynak son 72 saatte hiç haber vermedi (${feedStatus.delivering} / ${feedStatus.total} kaynak haber verdi).`}
      </p>
      <Link
        href="/kaynaklar/durum"
        className="text-xs underline decoration-dotted underline-offset-2 text-muted-foreground hover:text-foreground"
      >
        Kaynak durumu
      </Link>
    </section>
  );
}

function LabelChanges({ changes }: { changes: WeeklyLabelChange[] | null }) {
  return (
    <section className={`${cardClass} space-y-3`}>
      <h2 className={sectionTitleClass}>Etiket değişiklikleri</h2>
      {changes === null ? (
        <p className={proseClass}>Etiket geçmişi okunamadı.</p>
      ) : changes.length === 0 ? (
        <p className={proseClass}>Bu hafta etiket değişmedi.</p>
      ) : (
        <ul className="space-y-2">
          {changes.map((change) => {
            // formatDdMmYyyy returns "" for an unparseable date and its
            // contract is that callers gate on that empty string — an
            // ungated call would render a dangling "()".
            const changedOn = formatDdMmYyyy(change.changedAt);

            return (
            <li key={`${change.slug}-${change.changedAt}`} className={rowClass}>
              <span className="text-sm text-foreground/90">
                {`${change.name}: ${change.oldBias ? BIAS_LABELS[change.oldBias] : "—"} → ${BIAS_LABELS[change.newBias]}${changedOn ? ` (${changedOn})` : ""}`}
              </span>
              {change.reason ? (
                <span className={metaClass}>{change.reason}</span>
              ) : null}
            </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
