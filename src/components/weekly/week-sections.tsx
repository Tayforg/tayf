import Link from "next/link";

import { BIAS_LABELS, ZONE_META } from "@/lib/bias/config";
import { zonePercents } from "@/lib/bias/zone-summary";
import { zoneYieldDenominator, type ZoneFeedHealth } from "@/lib/clusters/feed-health";
import { formatCountTr, formatPctTr } from "@/lib/format/number-tr";
import { weekCopy } from "@/lib/weekly/week-copy";
import {
  WEEKLY_CLUSTER_LIMIT,
  type WeeklyBlindspot,
  type WeeklySummary,
} from "@/lib/weekly/weekly-query";
import type { MediaDnaZone } from "@/types";

// Moved out of src/app/hafta/page.tsx (Part B, owned-channels): ZoneShares,
// BasisNote, WidestSpectrum, Blindspots, and the class tokens they use, so
// /hafta/[hafta] can render the same sections without duplicating markup.
//
// Every reader-facing line that differs between a live week and a closed one
// comes from src/lib/weekly/week-copy.ts via the `archive` prop (default
// false = live, which is what /hafta renders). Closed weeks have no live
// source health, so they omit the per-zone source counts and the 72 h basis
// footnote instead of printing placeholders. Do not add week-specific string
// literals here: tests/guards/week-archive-copy.test.ts forbids them.

export const cardClass = "rounded-xl ring-1 ring-border/60 bg-card/60 p-4 sm:p-6";
export const proseClass = "max-w-[65ch] text-sm text-muted-foreground leading-relaxed";
export const sectionTitleClass = "text-lg font-semibold tracking-tight text-foreground";
export const rowClass =
  "flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg ring-1 ring-border/50 bg-muted/20 p-3";
export const linkClass =
  "text-sm font-medium text-foreground underline decoration-dotted underline-offset-2 hover:text-primary";
export const metaClass = "text-xs text-muted-foreground";

// Shown only when the paged cluster read stopped at its own ceiling, so the
// number is the ceiling (5.000), grouped the Turkish way.
export const TRUNCATED_CAVEAT = `En büyük ${formatCountTr(WEEKLY_CLUSTER_LIMIT)} küme üzerinden hesaplandı; haftanın tamamı değil.`;

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
  archive = false,
}: {
  summary: WeeklySummary;
  health: ZoneFeedHealth | null;
  feedStatus: { delivering: number; total: number } | null;
  truncated: boolean;
  archive?: boolean;
}) {
  const copy = weekCopy(archive);
  const total = ZONE_ORDER.reduce(
    (sum, zone) => sum + summary.zoneCounts[zone],
    0,
  );
  // Largest-remainder rounding (the shared helper every other zone surface
  // uses): three independent Math.round calls can sum to 99 or 101.
  const percents = zonePercents(summary.zoneCounts);

  return (
    <section className={`${cardClass} space-y-3`}>
      <h2 className={sectionTitleClass}>{copy.zoneHeading}</h2>
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
              <span className="text-sm text-foreground/90">{`${formatCountTr(count)} haber`}</span>
              <span className="font-mono text-sm text-foreground">
                {formatPctTr(percents[zone])}
              </span>
              <span className={metaClass}>
                {`(haftanın ${formatCountTr(total)} haberi içinde)`}
              </span>
              {copy.showSourceCounts && delivering !== null ? (
                <span className={metaClass}>
                  {`${delivering} kaynak haber verdi (toplayıcı / niş dahil)`}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {truncated ? <p className={metaClass}>{TRUNCATED_CAVEAT}</p> : null}
      <BasisNote total={total} feedStatus={feedStatus} archive={archive} />
    </section>
  );
}

/**
 * The basis line for this section. The shared `DenominatorNote` states that
 * *shares* are computed over delivering sources, which is not how either
 * figure in the rows above is computed, so /hafta states its own two bases:
 * the percentage's denominator (the week's article total) and what the
 * per-zone source figure counts (72 h delivering sources, toplayıcı / niş
 * dahil — mixed with the spektruma-sayılan-only feedStatus basis below,
 * which is why both bases are now stated explicitly rather than folded
 * into one ambiguous "kaynak" count — browser-qa-15).
 *
 * A closed week states only the percentage basis: the source figures and the
 * link to the live status page describe the present, not that week.
 */
export function BasisNote({
  total,
  feedStatus,
  archive = false,
}: {
  total: number;
  feedStatus: { delivering: number; total: number } | null;
  archive?: boolean;
}) {
  const copy = weekCopy(archive);
  const sourceBasis = copy.sourceBasis(feedStatus);

  return (
    <p className="text-xs text-muted-foreground">
      {sourceBasis === null
        ? copy.percentBasis(total)
        : `${copy.percentBasis(total)} ${sourceBasis} `}
      {copy.showStatusLink ? (
        <Link
          href="/kaynaklar/durum"
          className="underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          Kaynak durumu →
        </Link>
      ) : null}
    </p>
  );
}

export function WidestSpectrum({
  summary,
  archive = false,
}: {
  summary: WeeklySummary;
  archive?: boolean;
}) {
  const copy = weekCopy(archive);

  return (
    <section className={`${cardClass} space-y-3`}>
      <h2 className={sectionTitleClass}>En geniş yelpaze</h2>
      {summary.topClusters.length === 0 ? (
        <p className={proseClass}>{copy.noSharedStory}</p>
      ) : (
        <ul className="space-y-2">
          {summary.topClusters.map((cluster) => (
            <li key={cluster.id} className={rowClass}>
              <Link href={`/cluster/${cluster.id}`} className={linkClass}>
                {cluster.title}
              </Link>
              <span className={metaClass}>
                {`${formatCountTr(cluster.articleCount)} haber · ${cluster.zonesCovered} bölge`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The meta line of one blindspot row. "Sadece" is a claim that no other side
 * covered the story, so it is printed only at an exact 100% share; below that
 * the row states the share ("%88 İktidar"), and a row with no zone evidence
 * (a stored side but no distribution) names the side without either claim.
 * The OG image, the embed and the /blindspots chip already follow this rule.
 */
export function blindspotShareText(blindspot: WeeklyBlindspot): string {
  const zone = ZONE_META[blindspot.side].label;
  const count = `${formatCountTr(blindspot.articleCount)} haber`;

  if (blindspot.share === 1) return `Sadece ${zone} tarafında · ${count}`;
  if (blindspot.share === null || blindspot.sharePct === null) {
    return `${zone} tarafında · ${count}`;
  }
  return `${formatPctTr(blindspot.sharePct)} ${zone} · ${count}`;
}

export function Blindspots({
  summary,
  health,
  archive = false,
}: {
  summary: WeeklySummary;
  health: ZoneFeedHealth | null;
  archive?: boolean;
}) {
  const copy = weekCopy(archive);
  const degraded =
    health !== null && ZONE_ORDER.some((zone) => health[zone].degraded);

  return (
    <section className={`${cardClass} space-y-3`}>
      <h2 className={sectionTitleClass}>Kör noktalar</h2>
      {summary.blindspots.length === 0 ? (
        <p className={proseClass}>{copy.noBlindspot}</p>
      ) : (
        <ul className="space-y-2">
          {summary.blindspots.map((blindspot) => (
            <li key={blindspot.id} className={rowClass}>
              <Link href={`/cluster/${blindspot.id}`} className={linkClass}>
                {blindspot.title}
              </Link>
              <span className={metaClass}>{blindspotShareText(blindspot)}</span>
            </li>
          ))}
        </ul>
      )}
      {degraded && copy.degradedCaveat !== null ? (
        <p className={metaClass}>{copy.degradedCaveat}</p>
      ) : null}
    </section>
  );
}

// Re-exported for callers that render the same label lookup /hafta uses
// (e.g. a future archive label-changes section); kept here rather than a
// second import in page.tsx for the sections that already need it.
export { BIAS_LABELS };
