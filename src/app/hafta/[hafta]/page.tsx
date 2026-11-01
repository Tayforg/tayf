import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { PageHero } from "@/components/ui/page-hero";
import {
  Blindspots,
  cardClass,
  proseClass,
  WidestSpectrum,
  ZoneShares,
} from "@/components/weekly/week-sections";
import { getZoneFeedHealth } from "@/lib/clusters/feed-health";
import { sharePageMetadata } from "@/lib/seo/page-metadata";
import { weekCopy } from "@/lib/weekly/week-copy";
import {
  getWeekArchiveClusters,
  parseWeekKey,
  shiftWeek,
  weekKeyFromMs,
  weekLabelTr,
  WEEK_ARCHIVE_FIRST,
} from "@/lib/weekly/week-archive";
import { summariseWeek } from "@/lib/weekly/weekly-query";

// /hafta/[hafta] — ISO-week permalink into the archive (owned-channels
// Part B). /hafta itself stays the rolling trailing-7-day page; this route
// renders one FIXED [Monday 00:00, next Monday 00:00) Istanbul window.
//
// Order matters (per spec): await params, THEN connection() (defers the
// dynamic-API boundary past the params read, same digest-cron pattern),
// THEN parseWeekKey. A key outside [WEEK_ARCHIVE_FIRST, current] 404s —
// under PPR this is a soft 404 (the static shell still prerenders), which
// is accepted here since the alternative is exporting
// generateStaticParams for an unbounded, ever-growing key space.

interface PageProps {
  params: Promise<{ hafta: string }>;
}

async function validKeyOrNotFound(rawKey: string): Promise<string> {
  const parsed = parseWeekKey(rawKey);
  if (!parsed) notFound();

  const currentKey = weekKeyFromMs(Date.now());
  // String comparison is safe here: both sides are the canonical
  // 'YYYY-Www' shape (zero-padded week), so lexicographic order matches
  // chronological order within the archive's bounded key space.
  if (rawKey < WEEK_ARCHIVE_FIRST || rawKey > currentKey) {
    notFound();
  }
  return currentKey;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { hafta } = await params;
  const parsed = parseWeekKey(hafta);
  if (!parsed) return {};

  const label = weekLabelTr(hafta);
  return sharePageMetadata({
    title: `Haftanın yelpazesi — ${label}`,
    description: `${label}: hangi taraf neyi öne çıkardı? Bölge payları, en geniş yelpazeli haberler ve kör noktalar.`,
    path: `/hafta/${hafta}`,
  });
}

// No generateStaticParams: the archive grows every week and a stale
// prerendered set would 404 real, valid weeks until the next deploy.

export default async function WeekArchivePage({ params }: PageProps) {
  const { hafta } = await params;
  await connection();
  const currentKey = await validKeyOrNotFound(hafta);
  const isCurrentWeek = hafta === currentKey;
  // A closed week has no live source health and reads as a finished record;
  // every line that differs comes from week-copy (see its header).
  const copy = weekCopy(!isCurrentWeek);

  const [read, health] = await Promise.all([
    getWeekArchiveClusters(hafta),
    // Health is only meaningful for the week still in progress — it is
    // not known retroactively for a past, closed week.
    isCurrentWeek ? getZoneFeedHealth() : Promise.resolve(null),
  ]);

  const rows = read?.rows ?? null;
  const summary = rows !== null && rows.length > 0 ? summariseWeek(rows, health) : null;
  const label = weekLabelTr(hafta);

  const prevKey = shiftWeek(hafta, -1);
  const nextKey = shiftWeek(hafta, 1);
  // Next only goes up to the current week — there is nothing beyond it.
  const nextHref =
    nextKey && nextKey <= currentKey ? `/hafta/${nextKey}` : null;
  const prevHref =
    prevKey && prevKey >= WEEK_ARCHIVE_FIRST ? `/hafta/${prevKey}` : null;

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl space-y-10">
      <PageHero
        kicker="Haftalık arşiv"
        title="Haftanın yelpazesi"
        subtitle={label}
      />

      <p className={`${proseClass}`}>{copy.note}</p>

      {rows === null ? (
        <div className="rounded-xl border border-border/60 bg-card/40 p-8 text-center">
          <p className="text-sm text-muted-foreground">{copy.unavailable}</p>
        </div>
      ) : summary === null ? (
        <div className="rounded-xl border border-border/60 bg-card/40 p-8 text-center">
          <p className="text-sm text-muted-foreground">{copy.empty}</p>
        </div>
      ) : (
        <>
          <ZoneShares
            summary={summary}
            health={isCurrentWeek ? health : null}
            feedStatus={null}
            truncated={read?.truncated === true}
            archive={!isCurrentWeek}
          />
          <WidestSpectrum summary={summary} archive={!isCurrentWeek} />
          <Blindspots
            summary={summary}
            health={health}
            archive={!isCurrentWeek}
          />
        </>
      )}

      <nav
        aria-label="Haftalar arası gezinme"
        className={`${cardClass} flex flex-wrap items-center justify-between gap-3`}
      >
        <div className="flex gap-4">
          {prevHref ? (
            <Link
              href={prevHref}
              className="text-sm font-medium text-foreground underline decoration-dotted underline-offset-2 hover:text-primary"
            >
              ← Önceki hafta
            </Link>
          ) : null}
          {nextHref ? (
            <Link
              href={nextHref}
              className="text-sm font-medium text-foreground underline decoration-dotted underline-offset-2 hover:text-primary"
            >
              Sonraki hafta →
            </Link>
          ) : null}
        </div>
        <Link
          href="/hafta"
          className="text-sm font-medium text-foreground underline decoration-dotted underline-offset-2 hover:text-primary"
        >
          {copy.latestLinkText}
        </Link>
      </nav>
    </div>
  );
}
