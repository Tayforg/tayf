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
  title: "Medya DNA trendi",
  description:
    "Son 30 günde iktidara yakın, bağımsız ve muhalefete yakın kaynakların günlük haber üretimi ve bugün yükselen konular.",
  path: "/trends",
});
import { ZONE_META } from "@/lib/bias/config";
import { formatCountTr } from "@/lib/format/number-tr";
import { niceScale } from "@/lib/format/nice-scale";
import { xAxisLabels } from "@/lib/trends/axis-labels";
import { trendBarTitle } from "@/lib/trends/bar-title";
import { getEntityHub } from "@/lib/entities/entity-hub-query";
import { chartTableRows } from "@/lib/trends/chart-table";
import { fetchIstanbulTimeline, WINDOW_DAYS } from "@/lib/trends/daily-zones";
import { MAX_ITEMS, withHubLinks, type RisingResult } from "@/lib/trends/rising";
import { getRisingEntities } from "@/lib/trends/rising-query";
import type { MediaDnaZone } from "@/types";

// /trends — 30-day historical Medya DNA mix.
//
// What it shows: for each of the past 30 Europe/Istanbul calendar days,
// how many articles were published per Medya DNA zone (iktidar / bagimsiz
// / muhalefet), counting only voting-kind sources (outlet, wire — see
// src/lib/sources/kind.ts). Rendered as 30 vertical stacked bars in a
// single inline SVG — no chart library, no client JS beyond the scroller's
// open-on-the-newest-day ref. Lets a reader scan
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
//
// Hub links (h43-entities-3). A rising row links to its /gundem hub only when
// that hub is indexable; a thin or unreadable one links to the home search
// instead (withHubLinks). The hubs are read HERE, at page level and after
// getRisingEntities resolved, for at most MAX_ITEMS rows, and never inside a
// "use cache" function: getEntityHub is a resolveCachedOrRetry getter, and its
// live retry awaits connection(), which throws inside a cache body and fails
// `next build` (tests/guards/cache-retry-prerender.test.ts). Each read is one
// of the 62 per-key cache entries /gundem/[key] and the hubs sitemap already
// share, so a warm page costs no extra query.

const ZONES: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

// SVG geometry — kept as constants so the per-bar layout is trivial to
// reason about and the chart renders identically on every breakpoint.
// viewBox is unitless so the parent container can scale it via CSS.
//
// The SVG draws only geometry (gridlines and bars). Every label is HTML around
// it (h46-mobile-3, the same fix as /kalite h25-visual-2 and the /ekonomi
// intraday chart): text inside the SVG is sized in viewBox units, so in a
// 900-unit viewBox shown 640 px wide a 10-unit label rendered at about 7 px.
// The y labels sit in a gutter BESIDE the horizontal scroller, so the value
// scale stays on screen however far the bars are scrolled; the x labels sit
// over the blank bottom padding inside the scroller, so they travel with the
// bars. Both are placed from the same constants the geometry uses, as
// percentages of the svg box, so a label cannot drift off its gridline or bar.
const CHART_W = 900;
const CHART_H = 320;
// Only enough room to keep the first bar and the gridline ends off the very
// edge: the value labels live in the gutter, not in the svg.
const PAD_LEFT = 4;
const PAD_RIGHT = 16;
const PAD_TOP = 16;
const PAD_BOTTOM = 36;
const PLOT_W = CHART_W - PAD_LEFT - PAD_RIGHT;
const PLOT_H = CHART_H - PAD_TOP - PAD_BOTTOM;
const BAR_GAP = 4;

// The svg box never gets narrower than this (literal `min-w-[640px]` below;
// Tailwind 4 has no runtime scanner), so on a phone the bars scroll.
const CHART_MIN_W_PX = 640;
// Width of the y-axis gutter, in rem. Must equal the first column of the
// literal `grid-cols-[3rem_minmax(0,1fr)]` below. 3rem fits "10.000" (6 mono
// characters, about 40 px at 11 px) with a few px to spare.
const GUTTER_REM = 3;
// The gutter is as tall as the svg box: its width is max(640 px, row width -
// gutter) (the scroller is the second grid column) and the box keeps the
// viewBox aspect ratio. Container units (the row is an `@container`) give that
// without a scrollbar, which would stretch a plain `items-stretch` gutter by
// its own thickness and push every label off its gridline. A browser without
// container units drops the declaration and the grid stretches the gutter to
// the row instead (right but for a classic scrollbar's thickness).
const GUTTER_HEIGHT = `calc(max(${CHART_MIN_W_PX}px, 100cqw - ${GUTTER_REM}rem) * ${(CHART_H / CHART_W).toFixed(5)})`;
// x label centre: this many viewBox units below the bars' baseline, where the
// svg <text> baseline used to sit, inside the PAD_BOTTOM padding.
const X_LABEL_DY = 14;

// Literal class strings only (Tailwind 4: no computed class names). 11 px is
// the floor for every chart label; right-1 keeps a y label off the plot's edge.
const Y_LABEL_CLASS =
  "absolute right-1 -translate-y-1/2 whitespace-nowrap font-mono text-[11px] leading-none tabular-nums text-muted-foreground";
// The first label is anchored at its bar's left edge and the last at its right
// edge, so a label with a month ("28 Eki", about 40 px) never pokes out of the
// scroller (content left of x=0 cannot be scrolled to); the rest are centred.
const X_LABEL_CLASS = {
  start:
    "absolute -translate-y-1/2 whitespace-nowrap font-mono text-[11px] leading-none tabular-nums text-muted-foreground",
  center:
    "absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[11px] leading-none tabular-nums text-muted-foreground",
  end: "absolute -translate-x-full -translate-y-1/2 whitespace-nowrap font-mono text-[11px] leading-none tabular-nums text-muted-foreground",
} as const;

/** A viewBox position as a percentage of the svg box, for CSS `top` / `left`. */
function pct(units: number, total: number): string {
  return `${((units / total) * 100).toFixed(2)}%`;
}

// Hard-coded SVG fills per zone. We do NOT reuse ZONE_META.dot (a Tailwind
// class) because <rect fill="…"> needs an actual colour string. The hex
// values mirror Tailwind's red-500 / zinc-400 / emerald-500 so the legend
// (which DOES use ZONE_META) reads as a perfect match.
const ZONE_FILL: Record<MediaDnaZone, string> = {
  iktidar: "#ef4444", // red-500
  bagimsiz: "#a1a1aa", // zinc-400
  muhalefet: "#10b981", // emerald-500
};

// h37-content-3: how the last, `partial` bucket (the Istanbul day still filling
// up when this snapshot was built) is told apart from the finished days. The
// wording is relative to the snapshot, never "today": the cache entry that bakes
// the flag in is served up to about an hour past Istanbul midnight, and longer
// to the first request after an idle spell, so a "bugün" claim could be a day
// stale.
const PARTIAL_FILL_OPACITY = 0.45;
const PARTIAL_DASH = "3 2";
const PARTIAL_HEADER_NOTE = " (son gün dahil, eksik)";
const PARTIAL_ARIA_NOTE = " Son günün sayımı eksik.";

/**
 * The rising result with each row's href settled against its hub. A result
 * without rows (failed read, thin history, nothing rising) is returned as is
 * and reads no hub. Rows past MAX_ITEMS are dropped (computeRising never
 * returns more) so the reads stay bounded.
 */
async function linkRisingHubs(rising: RisingResult | null): Promise<RisingResult | null> {
  if (rising === null || rising.status !== "ok" || rising.items.length === 0) {
    return rising;
  }
  const items = rising.items.slice(0, MAX_ITEMS);
  const reads = await Promise.all(items.map((item) => getEntityHub(item.key)));
  const hubs = new Map(items.map((item, i) => [item.key, reads[i] ?? null] as const));
  return { ...rising, items: withHubLinks(items, hubs) };
}

export default async function TrendsPage() {
  const [buckets, risingRaw] = await Promise.all([
    fetchIstanbulTimeline(),
    getRisingEntities(),
  ]);
  const rising = await linkRisingHubs(risingRaw);

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
          title="Medya DNA trendi"
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

  // h37-content-3: the last bucket is the Istanbul day that was still running
  // when the snapshot was built. The flag was set by the cached fetcher from
  // its own hour-quantized clock, so
  // the render stays clock-free (Cache Components). yMax and the totals above
  // deliberately still include that day: only its presentation changes.
  const hasPartialDay = buckets.some((b) => b.partial === true);

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
        title="Medya DNA trendi"
        subtitle="Her gün hangi taraf ne kadar haber üretti? Kırmızı iktidara yakın, gri bağımsız, yeşil muhalefete yakın kaynaklardır."
      />
      <RisingTopics data={rising} />

      <div className="rounded-xl border border-border/60 bg-card/40 p-4 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground space-y-0.5">
            <div>
              Toplam <span className="font-mono">{formatCountTr(totalArticles)}</span> haber, son{" "}
              {WINDOW_DAYS} gün{hasPartialDay ? PARTIAL_HEADER_NOTE : null}
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
                  className="flex items-center gap-1.5 font-mono text-[11px] uppercase text-muted-foreground"
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

        {/* Chart row: y-axis gutter + scroller. A two-column grid, not a flex
            row: the first column is fixed and the second is minmax(0,1fr), so
            the 640px-min box inside the scroller overflows the scroller (and
            scrolls) instead of widening the page. */}
        <div
          data-trends-chart
          className="@container grid grid-cols-[3rem_minmax(0,1fr)] items-stretch"
        >
          <div
            aria-hidden="true"
            data-y-axis
            className="relative"
            style={{ height: GUTTER_HEIGHT }}
          >
            {scale.ticks.map((t) => (
              <span
                key={`ylabel-${t}`}
                data-y-label
                className={Y_LABEL_CLASS}
                style={{ top: pct(PAD_TOP + PLOT_H * (1 - t / scale.max), CHART_H) }}
              >
                {formatCountTr(t)}
              </span>
            ))}
          </div>

          <ScrollToEnd
            className="w-full overflow-x-auto spectrum-glow"
            label={`Son ${WINDOW_DAYS} gün grafiği (yatay kaydırılabilir)`}
          >
            <div className="relative w-full min-w-[640px]">
              <svg
                viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                role="img"
                aria-label={`Son ${WINDOW_DAYS} gün boyunca günlük haber sayısı, Medya DNA bölgesine göre yığılmış sütun grafiği. Toplam ${formatCountTr(totalArticles)} haber.${hasPartialDay ? PARTIAL_ARIA_NOTE : ""}`}
                className="block h-auto w-full"
              >
                {/* Horizontal gridlines. Stroke uses currentColor so the chart
                    inherits the page text colour and stays readable in both
                    light and dark mode. Their value labels are the HTML gutter. */}
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

                {/* Stacked bars — one column per day. We draw zones bottom
                    up (iktidar → bagimsiz → muhalefet) so colours read in
                    the same order everywhere on the page. */}
                <g>
                  {buckets.map((bucket, idx) => {
                    const x = PAD_LEFT + idx * (barWidth + BAR_GAP);
                    const isPartial = bucket.partial === true;
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
                          {...(isPartial
                            ? {
                                // Lighter fill + a dashed outline in the zone
                                // colour: still reads as "unfinished" for readers
                                // who cannot tell the two opacities apart.
                                fillOpacity: PARTIAL_FILL_OPACITY,
                                stroke: ZONE_FILL[zone],
                                strokeWidth: 1,
                                strokeDasharray: PARTIAL_DASH,
                              }
                            : {})}
                        >
                          {/* A single string child: React 19 renders a <title>
                              with multiple children (day, label, count as
                              separate JSX expressions) as an empty <title></title>. */}
                          <title>
                            {trendBarTitle(bucket.day, ZONE_META[zone].label, count, isPartial)}
                          </title>
                        </rect>
                      );
                    });
                    return <g key={bucket.day}>{segments}</g>;
                  })}
                </g>
              </svg>

              {/* X-axis labels: HTML over the svg's blank bottom padding, so
                  they scroll with the bars. Every 5th day plus the last; the
                  first label and the first after a month change carry the
                  Turkish month ("28 Eki", "02 Kas"), the rest are day-only. */}
              <div
                aria-hidden="true"
                data-x-axis
                className="pointer-events-none absolute inset-0"
              >
                {xAxisLabels(buckets.map((b) => b.day)).map(({ idx, text }) => {
                  const barLeft = PAD_LEFT + idx * (barWidth + BAR_GAP);
                  const align =
                    idx === 0 ? "start" : idx === buckets.length - 1 ? "end" : "center";
                  const anchorX =
                    align === "start"
                      ? barLeft
                      : align === "end"
                        ? barLeft + barWidth
                        : barLeft + barWidth / 2;
                  return (
                    <span
                      key={`xlabel-${buckets[idx]!.day}`}
                      data-x-label
                      className={X_LABEL_CLASS[align]}
                      style={{
                        left: pct(anchorX, CHART_W),
                        top: pct(CHART_H - PAD_BOTTOM + X_LABEL_DY, CHART_H),
                      }}
                    >
                      {text}
                    </span>
                  );
                })}
              </div>
            </div>
          </ScrollToEnd>
        </div>

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
