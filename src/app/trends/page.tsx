import type { Metadata } from "next";
import Link from "next/link";

import { RisingTopics } from "@/components/trends/rising-topics";
import { ScrollToEnd } from "@/components/trends/scroll-to-end";
import { PageHero } from "@/components/ui/page-hero";
import { staticPageMetadata } from "@/lib/seo/page-metadata";

// Own metadata so the page doesn't inherit the root layout's title and
// `canonical: "/"` (which would mark this page a duplicate of the homepage).
// staticPageMetadata also sets its own og:* / twitter:* url, title and image.
export const metadata: Metadata = staticPageMetadata({
  title: "Medya DNA Trendi",
  description:
    "Son 30 günde iktidara yakın, bağımsız ve muhalefete yakın kaynakların günlük haber üretimi ve bugün yükselen konular.",
  path: "/trends",
});
import { ZONE_META } from "@/lib/bias/config";
import { formatCountTr } from "@/lib/format/number-tr";
import { niceScale } from "@/lib/format/nice-scale";
import { chartTableRows } from "@/lib/trends/chart-table";
import { fetchIstanbulTimeline, WINDOW_DAYS } from "@/lib/trends/daily-zones";
import { getRisingEntities } from "@/lib/trends/rising-query";
import type { MediaDnaZone } from "@/types";

// /trends — 30-day historical Medya DNA mix.
//
// What it shows: for each of the past 30 Europe/Istanbul calendar days,
// how many articles were published per Medya DNA zone (iktidar / bagimsiz
// / muhalefet), counting only voting-kind sources (outlet, wire — see
// src/lib/sources/kind.ts). Rendered as 30 vertical stacked bars in a
// single inline SVG — no chart library, no client JS. Lets a reader scan
// a month at a glance and spot days where one zone dominated the news.
//
// Data path: server-side aggregation via the
// `trends_daily_zone_counts_ist` view (see
// supabase/migrations/087_trends_istanbul_day.sql), which buckets by the
// Istanbul calendar day of least(published_at, created_at) and filters to
// voting kinds only — both of which the older UTC-day, all-kinds
// `trends_daily_bias_counts` view (migration 023) does not do. The app no longer
// reads that view since trends-query.ts was removed; dropping it is a
// separate, non-additive follow-up. PostgREST returns ≤ WINDOW_DAYS × 3 = 90 rows — one per
// (day, zone) — so egress is bounded regardless of how many articles the
// window contains. The page is still wrapped in `revalidate=3600` so the
// DB is hit at most once an hour per region.
//
// Fetch + bucketing logic lives in `@/lib/trends/daily-zones` (unit tested
// there). `fetchIstanbulTimeline` never throws — a throw inside a "use
// cache" function aborts the whole `next build` prerender, which happened
// twice in production when the aggregate query hit a statement timeout. On
// a Supabase failure (or an empty result, which must never be cached as a
// real answer) it logs and resolves `null`; this page renders an honest
// "unavailable" state for that case rather than silently rendering an
// all-zero month or crashing the build. `src/app/trends/error.tsx` still
// catches genuine render errors (it's untouched by this).
//
// "Yükselen Konular" (migration 112) sits right under the hero in BOTH
// branches. `getRisingEntities` is a second, independent "use cache" fetcher
// over the per-entity daily rollup; it also resolves `null` instead of
// throwing, and the section degrades on its own copy, so a failure of either
// fetch never hides the other.

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

export default async function TrendsPage() {
  const [buckets, rising] = await Promise.all([
    fetchIstanbulTimeline(),
    getRisingEntities(),
  ]);

  // `null` means the fetch itself failed (Supabase error, or — at build
  // time — env vars not yet wired) — a distinct, honest state from "zero
  // articles this month". Render inside the normal layout (no throw) so a
  // `next build` prerender always succeeds. The { ok: false } sentinel is
  // memoised for the whole cacheLife window (3600s) and can be baked into
  // the static HTML, so this branch deliberately carries NO
  // `<meta name="robots" content="noindex">`: a build-time Supabase blip
  // would otherwise serve noindex to Googlebot for an hour or more and
  // could de-index /trends. (The uncached surfaces — /, /blindspots,
  // /sources — are request-time and do noindex their failed state.)
  if (buckets === null) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-5xl space-y-6">
        <PageHero
          kicker="Son 30 gün"
          title="Medya DNA Trendi"
          subtitle="Her gün hangi taraf ne kadar haber üretti? Kırmızı iktidara yakın, gri bağımsız, yeşil muhalefete yakın kaynaklardır."
        />
        <RisingTopics data={rising} />
        <div className="rounded-xl border border-border/60 bg-card/40 p-4 sm:p-6">
          <p className="text-sm text-muted-foreground text-center py-12">
            Trend verileri şu anda yüklenemiyor.{" "}
            <Link
              href="/trends"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Tekrar dene
            </Link>
            .
          </p>
        </div>
      </div>
    );
  }

  // Y-axis scale derives from the busiest day in the window, so a quiet
  // month and a heavy month both fill the plot area. Floor at 1 to avoid
  // a divide-by-zero when there's literally no data.
  const yMax = Math.max(1, ...buckets.map((b) => b.total));
  const totalArticles = buckets.reduce((acc, b) => acc + b.total, 0);

  const barWidth = (PLOT_W - BAR_GAP * (WINDOW_DAYS - 1)) / WINDOW_DAYS;

  // Gridlines and axis labels sit on round numbers: niceScale() picks a
  // 1 / 2 / 2.5 / 5 x 10^k step and rounds the axis maximum up to a whole
  // number of steps (8791 -> 0, 2.500, 5.000, 7.500, 10.000), instead of the
  // old quarters of the busiest day (2198, 4396, 6593, 8791). The bars below
  // are scaled to the same `scale.max`, so a bar never overshoots a gridline.
  const scale = niceScale(yMax);

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl space-y-6">
      <PageHero
        kicker="Son 30 gün"
        title="Medya DNA Trendi"
        subtitle="Her gün hangi taraf ne kadar haber üretti? Kırmızı iktidara yakın, gri bağımsız, yeşil muhalefete yakın kaynaklardır."
      />
      <RisingTopics data={rising} />

      <div className="rounded-xl border border-border/60 bg-card/40 p-4 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground space-y-0.5">
            <div>
              Toplam <span className="font-mono">{formatCountTr(totalArticles)}</span> haber, son{" "}
              {WINDOW_DAYS} gün
            </div>
            <div>
              Yalnızca spektruma sayılan kaynaklar (haber siteleri ve ajanslar) · günler
              Türkiye saatine göre
            </div>
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

        <ScrollToEnd
          className="w-full overflow-x-auto spectrum-glow"
          label={`Son ${WINDOW_DAYS} gün grafiği (yatay kaydırılabilir)`}
        >
          <svg
            viewBox={`0 0 ${CHART_W} ${CHART_H}`}
            role="img"
            aria-label={`Son ${WINDOW_DAYS} gün boyunca günlük haber sayısı, Medya DNA bölgesine göre yığılmış sütun grafiği. Toplam ${formatCountTr(totalArticles)} haber.`}
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
              {scale.ticks.map((t) => {
                const y = PAD_TOP + PLOT_H * (1 - t / scale.max);
                return (
                  <line
                    key={`grid-${t}`}
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
              {scale.ticks.map((t) => {
                const y = PAD_TOP + PLOT_H * (1 - t / scale.max);
                return (
                  <text
                    key={`ylabel-${t}`}
                    x={PAD_LEFT - 6}
                    y={y + 3}
                    textAnchor="end"
                  >
                    {formatCountTr(t)}
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
                  const segHeight = (count / scale.max) * PLOT_H;
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
                      {/* A single string child: React 19 renders a <title>
                          with multiple children (day, label, count as
                          separate JSX expressions) as an empty <title></title>. */}
                      <title>{`${bucket.day} · ${ZONE_META[zone].label}: ${count}`}</title>
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
        </ScrollToEnd>

        {/* Text alternative to the chart (WCAG 1.1.1 / 1.3.1): the per-day
            counts otherwise exist only as <title>s inside a role="img" svg.
            Deliberately NOT wrapped in an overflow container: five short
            columns fit a 324px viewport, and a second scrollable region would
            need its own tab stop (axe scrollable-region-focusable). */}
        {totalArticles > 0 ? (
          <details className="text-xs">
            <summary className="cursor-pointer select-none rounded py-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Günlük sayıları tablo olarak göster
            </summary>
            <table className="mt-3 w-full text-xs tabular-nums">
              <caption className="sr-only">
                {`Son ${WINDOW_DAYS} günde Medya DNA bölgesine göre günlük haber sayısı (günler Türkiye saatine göre)`}
              </caption>
              <thead className="[&_th]:px-1.5 [&_th]:py-1 [&_th]:text-right [&_th]:font-medium [&_th:first-child]:text-left">
                <tr>
                  <th scope="col">Gün</th>
                  {ZONES.map((z) => (
                    <th key={z} scope="col">
                      {ZONE_META[z].label}
                    </th>
                  ))}
                  <th scope="col">Toplam</th>
                </tr>
              </thead>
              <tbody>
                {chartTableRows(buckets).map((row) => (
                  <tr key={row.day}>
                    <th scope="row" className="px-1.5 py-1 text-left font-normal">
                      {row.label}
                    </th>
                    <td className="px-1.5 py-1 text-right">{formatCountTr(row.iktidar)}</td>
                    <td className="px-1.5 py-1 text-right">{formatCountTr(row.bagimsiz)}</td>
                    <td className="px-1.5 py-1 text-right">{formatCountTr(row.muhalefet)}</td>
                    <td className="px-1.5 py-1 text-right">{formatCountTr(row.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ) : null}

        {totalArticles === 0 ? (
          <p className="text-xs text-muted-foreground text-center pt-2">
            Son 30 gün için veri bulunamadı.
          </p>
        ) : null}
      </div>
    </div>
  );
}
