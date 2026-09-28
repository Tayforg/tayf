import Link from "next/link";

import { BIAS_LABELS, ZONE_META } from "@/lib/bias/config";
import { zonePercents } from "@/lib/bias/zone-summary";
import { zoneYieldDenominator, type ZoneFeedHealth } from "@/lib/clusters/feed-health";
import { WEEKLY_CLUSTER_LIMIT, type WeeklySummary } from "@/lib/weekly/weekly-query";
import type { MediaDnaZone } from "@/types";

// Moved verbatim out of src/app/hafta/page.tsx (Part B, owned-channels):
// ZoneShares, BasisNote, WidestSpectrum, Blindspots, and the class tokens
// they use, so /hafta/[hafta] can render the identical sections without
// duplicating markup. /hafta's own output is unchanged.

export const cardClass = "rounded-xl ring-1 ring-border/60 bg-card/60 p-4 sm:p-6";
export const proseClass = "max-w-[65ch] text-sm text-muted-foreground leading-relaxed";
export const sectionTitleClass = "text-lg font-semibold tracking-tight text-foreground";
export const rowClass =
  "flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg ring-1 ring-border/50 bg-muted/20 p-3";
export const linkClass =
  "text-sm font-medium text-foreground underline decoration-dotted underline-offset-2 hover:text-primary";
export const metaClass = "text-xs text-muted-foreground";

export const DEGRADED_CAVEAT =
  "Bazı bölgelerde kaynaklara ulaşılamıyor; bu haftanın kör nokta listesi eksik olabilir.";
export const TRUNCATED_CAVEAT = `En büyük ${WEEKLY_CLUSTER_LIMIT} küme üzerinden hesaplandı; haftanın tamamı değil.`;

const ZONE_ORDER: readonly MediaDnaZone[] = [
  "iktidar",
  "bagimsiz",
  "muhalefet",
];

export function ZoneShares({
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
export function BasisNote({
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

export function WidestSpectrum({ summary }: { summary: WeeklySummary }) {
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

export function Blindspots({
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

// Re-exported for callers that render the same label lookup /hafta uses
// (e.g. a future archive label-changes section); kept here rather than a
// second import in page.tsx for the sections that already need it.
export { BIAS_LABELS };
