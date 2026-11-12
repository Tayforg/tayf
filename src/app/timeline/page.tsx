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
import { wireBadgeLabel } from "@/lib/clusters/wire";
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
// Headlines: each row prints `row.title`, the display title getRecentClusters
// attaches: the stored neutral title, or, while the headline cron has not
// written one yet, the cron's own first pick over the member titles
// (h76-timeline-2). A fresh cluster is therefore never listed under its raw
// ALL-CAPS outlet headline, and the list agrees with the cluster page's H1.
// A row whose cluster has only English-language outlets as members carries
// `lang="en"` on its headline link (WCAG 3.1.2; getRecentClusters marks it, see
// h118-english-1), unless its title is an LLM rewrite, which is Turkish and gets
// no lang; every other row inherits the document's lang="tr".
//
// Source count (h142-consistency-1): each row prints `row.source_count`, the honest
// number the cluster page header, the cards and the RSS feed print (distinct texts
// for an agency redistribution, else the member count), never the raw stored
// `article_count` ("8 kaynak" for 8 outlets reprinting 3 dispatches). A wire
// cluster (`row.wire`, set by getRecentClusters) also gets a small violet tag
// after the count: the leading words of wireBadgeLabel (wire.ts), the cluster
// page's own badge text, with the full label as its tooltip. The page reads only
// those two numbers; the descriptions the detection runs on stay in the query.
//
// Caching: the route is static (cacheComponents allows no segment `revalidate`).
// Its data comes from the "use cache" entry in getRecentClusters: cacheLife
// "cluster-feed" (revalidate 300 s, then served stale once while it
// regenerates), tags "clusters" and "timeline" (the headline cron revalidates
// "timeline" when it writes a title). The page's own ISR copy has a separate
// lifecycle: after an idle spell the first request is served the old copy and
// triggers the rebuild, and the next request gets the new one.
//
// The TIMELINE_LIMIT (200) row cap keeps the payload bounded even on a busy news
// day; a busy day mints more qualifying clusters than that, so the subtitle
// names the real total (a separate head/exact count) whenever the list is
// capped, instead of presenting the capped length as the day's count. The cap
// cuts the oldest hour mid-hour, so a capped list drops that hour (its header
// would otherwise print the tail's row count as the hour's total) and the
// subtitle's "en yeni N" counts only the rows still shown.
//
// Realtime-lite: <NewClustersPill> (client) polls /api/timeline/head every ~2
// min while the tab is visible and offers "N yeni küme · Yenile" (router.refresh)
// when the head holds clusters this page does not. The head reads the same
// getRecentClusters() entry, so polling adds no DB read, but the head and this
// page's ISR copy do NOT share a lifecycle: the head can already list a cluster
// that a stale page copy lacks. The pill compensates: it compares the page before
// and after the refresh, retries once on its own, and only then says the list has
// not updated yet (h76-timeline-1). The page hands the pill the newest
// first_published, the ids of the first TIMELINE_HEAD_LIMIT rows (the head's own
// window) to diff against, and `floorPublished`: the first_published of row
// TIMELINE_HEAD_LIMIT (the 50th) when the page has that many rows, else null.
// That floor is what makes a head row "new" (h103-timeline-1): a cluster becomes
// visible when its second source arrives, so it often sorts below the page's
// newest row, but never below a row that was already in the page's first 50.
// The pill is not rendered when the read failed (rows === null). The hero and
// the pill share a `relative` wrapper (a positioning context, no spacing): the
// pill is absolutely placed in the 32 px space-y-8 gap below it, so it never
// moves the list (CLS 0).

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

// The visible words of the wire tag: wireBadgeLabel's leading phrase, i.e.
// "Ajans ağırlıklı" for a cluster of several texts and "Tek kaynaktan
// dağıtıldı" for copies of one, exactly the cluster page's badge wording without
// its "· 8 haber, 3 farklı metin" tail (that is the tooltip). Plain string
// search, no pattern.
function wireTagText(label: string): string {
  const cut = label.indexOf(" · ");
  return cut === -1 ? label : label.slice(0, cut);
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
            floorPublished={rows[TIMELINE_HEAD_LIMIT - 1]?.first_published ?? null}
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
                    className={`flex items-baseline gap-3 max-sm:flex-wrap max-sm:gap-y-1 rounded-lg ring-1 ring-border/60 hover:ring-border bg-card/60 hover:bg-card/80 px-3 py-2 transition-all animate-fade-up stagger-${rowIdx < 6 ? rowIdx + 1 : 6}`}
                  >
                    <time
                      dateTime={row.first_published}
                      className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
                    >
                      {formatRowTime(row.first_published)}
                    </time>
                    <Link
                      href={`/cluster/${row.id}`}
                      lang={row.lang}
                      className="min-w-0 flex-1 text-sm font-medium leading-snug hover:text-foreground sm:line-clamp-2 max-sm:order-last max-sm:basis-full max-sm:line-clamp-4"
                    >
                      {row.title}
                    </Link>
                    <span className="shrink-0 max-sm:ml-auto text-[11px] text-muted-foreground tabular-nums">
                      {row.source_count} kaynak
                      {row.wire && (
                        <>
                          {/* A real space node: the tag is inline-flex, so without it copy,
                              extracted text and screen readers read "3 kaynakAjans ağırlıklı". */}
                          {" "}
                          <span
                            className="ml-1 inline-flex items-center whitespace-nowrap rounded-full bg-violet-500/15 border border-violet-500/30 px-1.5 py-px text-violet-800 dark:text-violet-400 font-medium"
                            title={wireBadgeLabel(row.wire.memberCount, row.wire.uniqueTexts)}
                          >
                            {wireTagText(wireBadgeLabel(row.wire.memberCount, row.wire.uniqueTexts))}
                          </span>
                        </>
                      )}
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
