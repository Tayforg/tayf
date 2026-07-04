import type { Metadata } from "next";
import { cacheLife } from "next/cache";

import { PageHero } from "@/components/ui/page-hero";

// Own metadata so the page doesn't inherit the root layout's title and
// `canonical: "/"` (which would mark this page a duplicate of the homepage).
export const metadata: Metadata = {
  title: "Medya DNA Trendi",
  description:
    "Son 30 günde iktidara yakın, bağımsız ve muhalefete yakın kaynakların günlük haber üretimi.",
  alternates: { canonical: "/trends" },
};
import { ZONE_META } from "@/lib/bias/config";
import { createServerClient } from "@/lib/supabase/server";
import type { MediaDnaZone } from "@/types";

// /trends — 30-day historical Medya DNA mix.
//
// What it shows: for each of the past 30 calendar days (UTC), how many
// articles were published per Medya DNA zone (iktidar / bagimsiz /
// muhalefet). Rendered as 30 vertical stacked bars in a single inline SVG
// — no chart library, no client JS. Lets a reader scan a month at a glance
// and spot days where one zone dominated the news.
//
// Data path: server-side aggregation via the `trends_daily_bias_counts`
// view (see supabase/migrations/023_trends_daily_histogram.sql). PostgREST
// returns ≤ WINDOW_DAYS × 3 = 90 rows — one per (day, zone) — so egress is
// bounded regardless of how many articles the window contains. The old
// approach paged through raw articles (15-25k rows) just to fold the same
// histogram in JS. The page is still wrapped in `revalidate=3600` so the
// DB is hit at most once an hour per region.

const DAY_MS = 24 * 3600 * 1000;
const WINDOW_DAYS = 30;
const ZONES: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

// SVG geometry — kept as constants so the per-bar layout is trivial to
// reason about and the chart renders identically on every breakpoint.
// viewBox is unitless so the parent container can scale it via CSS.
const CHART_W = 900;
const CHART_H = 320;
const PAD_LEFT = 48;
const PAD_RIGHT = 16;
const PAD_TOP = 16;
const PAD_BOTTOM = 36;
const PLOT_W = CHART_W - PAD_LEFT - PAD_RIGHT;
const PLOT_H = CHART_H - PAD_TOP - PAD_BOTTOM;
const BAR_GAP = 4;

// Hard-coded SVG fills per zone. We do NOT reuse ZONE_META.dot (a Tailwind
// class) because <rect fill="…"> needs an actual colour string. The hex
// values mirror Tailwind's red-500 / zinc-400 / emerald-500 so the legend
// (which DOES use ZONE_META) reads as a perfect match.
const ZONE_FILL: Record<MediaDnaZone, string> = {
  iktidar: "#ef4444", // red-500
  bagimsiz: "#a1a1aa", // zinc-400
  muhalefet: "#10b981", // emerald-500
};

type DayBucket = {
  /** Day key in YYYY-MM-DD form (UTC). */
  day: string;
  /** Per-zone article counts. */
  counts: Record<MediaDnaZone, number>;
  /** Sum of counts (cached so the renderer doesn't re-add). */
  total: number;
};

/** One row per (day, zone) from the `trends_daily_bias_counts` view. */
type AggregateRow = {
  day: string; // "YYYY-MM-DD" (date → ISO string via PostgREST)
  zone: MediaDnaZone;
  count: number;
};

/**
 * Build a contiguous 30-day timeline and merge in the pre-aggregated view
 * rows. Days with zero articles are still emitted (with all-zero counts)
 * so the chart x-axis is gap-free and a quiet day reads as a blank column
 * rather than a missing one.
 */
function bucketFromAggregates(rows: AggregateRow[]): DayBucket[] {
  // Compute the inclusive [start, end] window in UTC. We anchor `end` to
  // the start of *today* UTC so the rightmost bar is always "today" and
  // the leftmost is "29 days ago".
  const now = new Date();
  const todayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );

  const buckets = new Map<string, DayBucket>();
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const ts = todayUtc - (WINDOW_DAYS - 1 - i) * DAY_MS;
    const key = new Date(ts).toISOString().slice(0, 10);
    buckets.set(key, {
      day: key,
      counts: { iktidar: 0, bagimsiz: 0, muhalefet: 0 },
      total: 0,
    });
  }

  for (const row of rows) {
    const bucket = buckets.get(row.day);
    if (!bucket) continue; // outside window — defensive against clock skew
    bucket.counts[row.zone] += row.count;
    bucket.total += row.count;
  }

  return Array.from(buckets.values());
}

async function fetchTimeline(): Promise<DayBucket[]> {
  "use cache";
  cacheLife({ revalidate: 3600 });

  try {
    const supabase = createServerClient();

    // `day` in the view is a DATE, so we filter on a bare `YYYY-MM-DD`
    // cutoff rather than a full timestamp. This bounds the payload at
    // `WINDOW_DAYS * (# zones)` rows regardless of article volume.
    const cutoffDay = new Date(Date.now() - WINDOW_DAYS * DAY_MS)
      .toISOString()
      .slice(0, 10);

    const { data, error } = await supabase
      .from("trends_daily_bias_counts")
      .select("day, zone, count")
      .gte("day", cutoffDay)
      .returns<AggregateRow[]>();

    if (error) {
      console.error("[trends] fetchTimeline error", error.message);
      return bucketFromAggregates([]);
    }

    return bucketFromAggregates(data ?? []);
  } catch (err) {
    console.error("[trends] unexpected error", err);
    return bucketFromAggregates([]);
  }
}

export default async function TrendsPage() {
  const buckets = await fetchTimeline();

  // Y-axis scale derives from the busiest day in the window, so a quiet
  // month and a heavy month both fill the plot area. Floor at 1 to avoid
  // a divide-by-zero when there's literally no data.
  const yMax = Math.max(1, ...buckets.map((b) => b.total));
  const totalArticles = buckets.reduce((acc, b) => acc + b.total, 0);

  const barWidth = (PLOT_W - BAR_GAP * (WINDOW_DAYS - 1)) / WINDOW_DAYS;

  // Pre-compute four reference y values (0, 25%, 50%, 75%, 100%) so the
  // chart has horizontal gridlines + axis labels without a ton of inline
  // arithmetic in the JSX below.
  const gridSteps = [0, 0.25, 0.5, 0.75, 1] as const;

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl space-y-6">
      <PageHero
        kicker="Son 30 gün"
        title="Medya DNA Trendi"
        subtitle="Her gün hangi taraf ne kadar haber üretti? Kırmızı iktidara yakın, gri bağımsız, yeşil muhalefete yakın kaynaklardır."
      />

      <div className="rounded-xl border border-border/60 bg-card/40 p-4 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            Toplam <span className="font-mono">{totalArticles.toLocaleString("tr-TR")}</span> haber, son{" "}
            {WINDOW_DAYS} gün
          </div>
          <ul className="flex flex-wrap items-center gap-3">
            {ZONES.map((z) => {
              const meta = ZONE_META[z];
              return (
                <li
                  key={z}
                  className="flex items-center gap-1.5 font-mono text-[10px] uppercase text-muted-foreground"
                >
                  <span
                    className={`inline-block h-2.5 w-2.5 rounded-sm ${meta.dot}`}
                    aria-hidden="true"
                  />
                  {meta.label}
                </li>
              );
            })}
          </ul>
        </div>

        <div className="w-full overflow-x-auto spectrum-glow">
          <svg
            viewBox={`0 0 ${CHART_W} ${CHART_H}`}
            role="img"
            aria-label={`Son ${WINDOW_DAYS} gün boyunca günlük haber sayısı, Medya DNA bölgesine göre yığılmış sütun grafiği. Toplam ${totalArticles} haber.`}
            className="w-full h-auto min-w-[640px]"
          >
            {/* Horizontal gridlines + y-axis labels. Stroke uses
                currentColor so the chart inherits the page text colour
                and stays readable in both light and dark mode. */}
            <g
              className="text-muted-foreground"
              stroke="currentColor"
              strokeOpacity={0.15}
              strokeWidth={1}
            >
              {gridSteps.map((step) => {
                const y = PAD_TOP + PLOT_H * (1 - step);
                return (
                  <line
                    key={`grid-${step}`}
                    x1={PAD_LEFT}
                    x2={CHART_W - PAD_RIGHT}
                    y1={y}
                    y2={y}
                  />
                );
              })}
            </g>
            <g
              className="text-muted-foreground"
              fill="currentColor"
              fontSize={10}
            >
              {gridSteps.map((step) => {
                const y = PAD_TOP + PLOT_H * (1 - step);
                const value = Math.round(yMax * step);
                return (
                  <text
                    key={`ylabel-${step}`}
                    x={PAD_LEFT - 6}
                    y={y + 3}
                    textAnchor="end"
                  >
                    {value}
                  </text>
                );
              })}
            </g>

            {/* Stacked bars — one column per day. We draw zones bottom
                up (iktidar → bagimsiz → muhalefet) so colours read in
                the same order everywhere on the page. */}
            <g>
              {buckets.map((bucket, idx) => {
                const x = PAD_LEFT + idx * (barWidth + BAR_GAP);
                let cursorY = PAD_TOP + PLOT_H; // bottom of plot area
                const segments = ZONES.map((zone) => {
                  const count = bucket.counts[zone];
                  if (count === 0) return null;
                  const segHeight = (count / yMax) * PLOT_H;
                  cursorY -= segHeight;
                  return (
                    <rect
                      key={`${bucket.day}-${zone}`}
                      x={x}
                      y={cursorY}
                      width={barWidth}
                      height={segHeight}
                      fill={ZONE_FILL[zone]}
                    >
                      <title>
                        {bucket.day} · {ZONE_META[zone].label}: {count}
                      </title>
                    </rect>
                  );
                });
                return <g key={bucket.day}>{segments}</g>;
              })}
            </g>

            {/* X-axis labels — only every 5th day so they don't collide
                on narrow viewports. The tick text is the day-of-month
                because that's the smallest unambiguous label that fits
                in ~20px of width. */}
            <g
              className="text-muted-foreground"
              fill="currentColor"
              fontSize={10}
              fontFamily="var(--font-mono, ui-monospace, monospace)"
            >
              {buckets.map((bucket, idx) => {
                if (idx % 5 !== 0 && idx !== buckets.length - 1) return null;
                const x = PAD_LEFT + idx * (barWidth + BAR_GAP) + barWidth / 2;
                const dayNum = bucket.day.slice(8, 10);
                return (
                  <text
                    key={`xlabel-${bucket.day}`}
                    x={x}
                    y={CHART_H - PAD_BOTTOM + 14}
                    textAnchor="middle"
                  >
                    {dayNum}
                  </text>
                );
              })}
            </g>
          </svg>
        </div>

        {totalArticles === 0 ? (
          <p className="text-xs text-muted-foreground text-center pt-2">
            Son 30 gün için veri bulunamadı.
          </p>
        ) : null}
      </div>
    </div>
  );
}
