import type { Metadata } from "next";
import Link from "next/link";

import { PageHero } from "@/components/ui/page-hero";
import { getRecentClusters, type ClusterRow } from "@/lib/clusters/timeline-query";
import { staticPageMetadata } from "@/lib/seo/page-metadata";

// Own metadata so the page doesn't inherit the root layout's title and
// `canonical: "/"` (which would mark this page a duplicate of the homepage).
// staticPageMetadata also sets its own og:* / twitter:* url, title and image.
export const metadata: Metadata = staticPageMetadata({
  title: "Zaman çizelgesi",
  description:
    "Son 24 saatte oluşturulan haber kümeleri, saat saat sıralandı.",
  path: "/timeline",
});

// /timeline — chronological feed of every cluster Tayf has minted in the
// last 24 hours, grouped by the hour the cluster first published. Acts as a
// "what's been happening" timestamp wall complementing /clusters (which
// ranks by article_count) and /blindspots (which filters by coverage gap).
//
// Server Component. Query lives in @/lib/clusters/timeline-query so it can
// be unit tested without rendering JSX. Hour bucketing is done in-memory
// off the `first_published` timestamp, then rendered as a list of
// <section> blocks — one per hour, newest first.
//
// Cached at the route segment with `revalidate = 60` so the wall feels
// near-live without slamming Supabase on every navigation. The
// TIMELINE_LIMIT (200) row cap keeps the payload bounded even on a busy news
// day; a busy day mints more qualifying clusters than that, so the subtitle
// names the real total (a separate head/exact count) whenever the list is
// capped, instead of presenting the capped length as the day's count.

interface HourBucket {
  // ISO of the top-of-hour the rows in this bucket belong to. Used as the
  // section key and as the input to `formatHourLabel`.
  hourISO: string;
  rows: ClusterRow[];
}

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
function timelineSubtitle(n: number, total: number | null): string {
  if (n === 0 || total === n) {
    return `Son 24 saatte oluşturulan ${n} haber kümesi, saat saat sıralandı.`;
  }
  if (total === null) {
    return `Son 24 saatte oluşturulan en yeni ${n} küme, saat saat sıralandı.`;
  }
  return `Son 24 saatte oluşturulan ${total} haber kümesinin en yeni ${n} tanesi, saat saat sıralandı.`;
}

function formatHourLabel(hourISO: string): string {
  return HOUR_LABEL_FORMAT.format(new Date(hourISO));
}

function formatRowTime(iso: string): string {
  return TIME_FORMAT.format(new Date(iso));
}

// Bucket cluster rows by the top-of-hour their first_published falls into.
// We key on a UTC top-of-hour ISO string — the wall-clock label is a render-
// time concern handled by `formatHourLabel`. Buckets are returned in the
// same order they were first seen, which (because the SQL is ORDER BY
// first_published DESC) is newest hour → oldest hour.
function bucketByHour(rows: ClusterRow[]): HourBucket[] {
  const buckets = new Map<string, ClusterRow[]>();
  for (const row of rows) {
    const d = new Date(row.first_published);
    // Top-of-hour in UTC. Two clusters published 14:03 and 14:57 land in
    // the same bucket; one published 15:01 starts a new one.
    d.setUTCMinutes(0, 0, 0);
    const key = d.toISOString();
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      buckets.set(key, [row]);
    }
  }
  return Array.from(buckets.entries()).map(([hourISO, rowsForHour]) => ({
    hourISO,
    rows: rowsForHour,
  }));
}

export default async function TimelinePage() {
  // null = the read failed (timeout / outage), [] = it read fine and nothing
  // was minted. The two get different copy: a failure must never read as
  // "0 clusters". No noindex here on purpose: the route is static and the
  // failure is cached for "minutes", the same rule as /trends -- a noindex
  // baked into a static shell could outlive the outage in crawlers.
  const recent = await getRecentClusters();
  const rows = recent === null ? null : recent.rows;
  const buckets = rows === null ? [] : bucketByHour(rows);

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl space-y-8">
      <PageHero
        kicker="Son 24 saat"
        title="Zaman çizelgesi"
        subtitle={
          recent === null
            ? "Son 24 saatte oluşturulan haber kümeleri, saat saat sıralandı."
            : timelineSubtitle(recent.rows.length, recent.total)
        }
      />

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
                  {bucket.rows.length} küme
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
