import type { Metadata } from "next";
import Link from "next/link";

import { NewClustersPill } from "@/components/timeline/new-clusters-pill";
import { PageHero } from "@/components/ui/page-hero";
import {
  bucketByHour,
  bucketCountLabel,
  bucketedRowCount,
  isTimelineTruncated,
} from "@/lib/clusters/timeline-buckets";
import { TIMELINE_HEAD_LIMIT } from "@/lib/clusters/timeline-head";
import { getRecentClusters, TIMELINE_LIMIT } from "@/lib/clusters/timeline-query";
import { formatCountTr } from "@/lib/format/number-tr";
import { staticPageMetadata } from "@/lib/seo/page-metadata";

// Own metadata so the page doesn't inherit the root layout's title and
// `canonical: "/"` (which would mark this page a duplicate of the homepage).
// staticPageMetadata also sets its own og:* / twitter:* url, title and image.
export const metadata: Metadata = staticPageMetadata({
  title: "Zaman çizelgesi",
  description:
    "Son 24 saatte ilk haberi çıkan haber kümeleri, saat saat sıralandı.",
  path: "/timeline",
});

// /timeline — chronological feed of every cluster Tayf has minted in the
// last 24 hours, grouped by the hour the cluster first published. Acts as a
// "what's been happening" timestamp wall complementing /clusters (which
// ranks by article_count) and /blindspots (which filters by coverage gap).
//
// Server Component. Query lives in @/lib/clusters/timeline-query so it can
// be unit tested without rendering JSX. Hour bucketing is done in-memory
// off the `first_published` timestamp (@/lib/clusters/timeline-buckets), then
// rendered as a list of <section> blocks — one per hour, newest first.
//
// Cached at the route segment with `revalidate = 60` so the wall feels
// near-live without slamming Supabase on every navigation. The
// TIMELINE_LIMIT (200) row cap keeps the payload bounded even on a busy news
// day; a busy day mints more qualifying clusters than that, so the subtitle
// names the real total (a separate head/exact count) whenever the list is
// capped, instead of presenting the capped length as the day's count. The cap
// cuts the oldest hour mid-hour, so a capped list drops that hour (its header
// would otherwise print the tail's row count as the hour's total) and the
// subtitle's "en yeni N" counts only the rows still shown.
//
// Realtime-lite: <NewClustersPill> (client) polls /api/timeline/head every ~2
// min while the tab is visible and offers "N yeni küme · Yenile" (router.refresh)
// when the head holds clusters this page does not. The route reuses the same
// getRecentClusters() "use cache" entry, so polling adds no DB read. The page
// hands the pill the newest first_published and the ids of the first
// TIMELINE_HEAD_LIMIT rows (the head's own window) to diff against. It is not
// rendered when the read failed (rows === null). The hero and the pill share a
// `relative` wrapper (a positioning context, no spacing): the pill is absolutely
// placed in the 32 px space-y-8 gap below it, so it never moves the list (CLS 0).

// Format an ISO timestamp as `HH:MM` in the Europe/Istanbul wall clock —
// Tayf is a Türk news product so every visible time stamp is local TR time.
// We use Intl rather than a date-fns dependency to keep the route inline.
const TIME_FORMAT = new Intl.DateTimeFormat("tr-TR", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Europe/Istanbul",
});

// Format an hour bucket header like "06 Nis 14:00" — same TR locale, day
// + month + zero-padded hour. Mirrors the dateline feel of PageHero's kicker.
const HOUR_LABEL_FORMAT = new Intl.DateTimeFormat("tr-TR", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Europe/Istanbul",
});

// Subtitle honesty: `n` is what the list shows, `total` what the count read
// found (null = the count failed). Never present a capped length as the total.
// "ilk haberi çıkan" matches the query: it filters on first_published, not on
// when the cluster row was created. Exported for the unit test. Counts go
// through formatCountTr ("1.234").
export function timelineSubtitle(n: number, total: number | null): string {
  if (n === 0 || total === n) {
    return `Son 24 saatte ilk haberi çıkan ${formatCountTr(n)} haber kümesi, saat saat sıralandı.`;
  }
  if (total === null) {
    return `Son 24 saatte ilk haberi çıkan en yeni ${formatCountTr(n)} küme, saat saat sıralandı.`;
  }
  return `Son 24 saatte ilk haberi çıkan ${formatCountTr(total)} haber kümesinin en yeni ${formatCountTr(n)} tanesi, saat saat sıralandı.`;
}

function formatHourLabel(hourISO: string): string {
  return HOUR_LABEL_FORMAT.format(new Date(hourISO));
}

function formatRowTime(iso: string): string {
  return TIME_FORMAT.format(new Date(iso));
}

export default async function TimelinePage() {
  // null = the read failed (timeout / outage), [] = it read fine and nothing
  // was minted. The two get different copy: a failure must never read as
  // "0 clusters". No noindex here on purpose: the route is static and the
  // failure is cached for "minutes", the same rule as /trends -- a noindex
  // baked into a static shell could outlive the outage in crawlers.
  const recent = await getRecentClusters();
  const rows = recent === null ? null : recent.rows;
  // A capped list ends mid-hour: bucketByHour drops that oldest hour (or flags
  // a lone one partial), and the subtitle counts the rows that are still shown.
  // A full page whose count read failed (total === null) is treated as capped.
  const buckets =
    recent === null
      ? []
      : bucketByHour(recent.rows, {
          truncated: isTimelineTruncated(recent.rows.length, recent.total, TIMELINE_LIMIT),
        });

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl space-y-8">
      <div className="relative">
        <PageHero
          kicker="Son 24 saat"
          title="Zaman çizelgesi"
          subtitle={
            recent === null
              ? "Son 24 saatte ilk haberi çıkan haber kümeleri, saat saat sıralandı."
              : timelineSubtitle(bucketedRowCount(buckets), recent.total)
          }
        />
        {rows !== null && (
          <NewClustersPill
            newestPublished={rows[0]?.first_published ?? null}
            knownIds={rows.slice(0, TIMELINE_HEAD_LIMIT).map((r) => r.id)}
          />
        )}
      </div>

      {rows === null ? (
        <p className="text-sm text-muted-foreground">
          Zaman çizelgesi şu anda yüklenemiyor. Birkaç dakika içinde tekrar deneyin.
        </p>
      ) : buckets.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Son 24 saatte yeni küme oluşturulmadı.
        </p>
      ) : (
        <div className="space-y-8 border-l-2 border-brand/20 pl-6 ml-2 relative">
          {buckets.map((bucket) => (
            <section key={bucket.hourISO} className="space-y-3 relative">
              {/* Timeline dot marker */}
              <div className="absolute -left-[calc(1.5rem+5px)] top-1 h-2.5 w-2.5 rounded-full bg-brand/60 ring-2 ring-background" />
              <div className="flex items-baseline justify-between border-b border-border/60 pb-2">
                <h2 className="text-sm font-mono text-brand font-semibold uppercase tracking-[0.12em]">
                  {formatHourLabel(bucket.hourISO)}
                </h2>
                <span className="text-[11px] text-muted-foreground">
                  {bucketCountLabel(bucket)}
                </span>
              </div>
              <ul className="space-y-2">
                {bucket.rows.map((row, rowIdx) => (
                  <li
                    key={row.id}
                    className={`flex items-baseline gap-3 rounded-lg ring-1 ring-border/60 hover:ring-border bg-card/60 hover:bg-card/80 px-3 py-2 transition-all animate-fade-up stagger-${rowIdx < 6 ? rowIdx + 1 : 6}`}
                  >
                    <time
                      dateTime={row.first_published}
                      className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
                    >
                      {formatRowTime(row.first_published)}
                    </time>
                    <Link
                      href={`/cluster/${row.id}`}
                      className="min-w-0 flex-1 text-sm font-medium leading-snug hover:text-foreground line-clamp-2"
                    >
                      {row.title_tr_neutral ?? row.title_tr}
                    </Link>
                    <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                      {row.article_count} kaynak
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
