import type { Metadata } from "next";
import { cacheLife, cacheTag } from "next/cache";
import Link from "next/link";

import { PageHero } from "@/components/ui/page-hero";

// Own metadata so the page doesn't inherit the root layout's title and
// `canonical: "/"` (which would mark this page a duplicate of the homepage).
export const metadata: Metadata = {
  title: "Zaman çizelgesi",
  description:
    "Son 24 saatte oluşturulan haber kümeleri, saat saat sıralandı.",
  alternates: { canonical: "/timeline" },
};
import { createServerClient } from "@/lib/supabase/server";

// /timeline — chronological feed of every cluster Tayf has minted in the
// last 24 hours, grouped by the hour the cluster first published. Acts as a
// "what's been happening" timestamp wall complementing /clusters (which
// ranks by article_count) and /blindspots (which filters by coverage gap).
//
// Server Component. One round-trip via createServerClient. Hour bucketing
// is done in-memory off the `first_published` timestamp, then rendered as a
// list of <section> blocks — one per hour, newest first.
//
// Cached at the route segment with `revalidate = 60` so the wall feels
// near-live without slamming Supabase on every navigation. The 100-row
// LIMIT keeps the payload bounded even on a busy news day.

interface ClusterRow {
  id: string;
  title_tr: string;
  title_tr_neutral: string | null;
  article_count: number;
  first_published: string;
}

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

async function getRecentClusters(): Promise<ClusterRow[]> {
  "use cache";
  cacheLife("cluster-feed");
  cacheTag("clusters");

  const supabase = createServerClient();

  // Window: last 24 hours, anchored at request time. The 60-second segment
  // revalidate means the window can drift by ~1 minute between cache fills,
  // which is well below the hour-bucket resolution.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("clusters")
    .select("id, title_tr, title_tr_neutral, article_count, first_published")
    .gt("first_published", since)
    .order("first_published", { ascending: false })
    .limit(100);

  if (error) {
    throw new Error(`timeline query failed: ${error.message}`);
  }

  return (data ?? []) as ClusterRow[];
}

export default async function TimelinePage() {
  const rows = await getRecentClusters();
  const buckets = bucketByHour(rows);

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl space-y-8">
      <PageHero
        kicker="Son 24 saat"
        title="Zaman çizelgesi"
        subtitle={`Son 24 saatte oluşturulan ${rows.length} haber kümesi, saat saat sıralandı.`}
      />

      {buckets.length === 0 ? (
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
                <span className="text-[11px] text-muted-foreground/70">
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
