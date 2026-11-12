import {
  HUB_TREND_CAPTION,
  HUB_TREND_HEADING,
  HUB_TREND_TABLE_TOGGLE,
  hubTrendAriaLabel,
  hubTrendEarlierNote,
  hubTrendSparseEarlierNote,
  hubTrendSparseLine,
  hubTrendState,
  hubTrendSum,
  hubTrendTableCaption,
  hubTrendTableRows,
  hubTrendTotalLine,
  type HubTrendDay,
} from "@/lib/entities/hub-trend";
import { niceScale } from "@/lib/format/nice-scale";
import { formatCountTr } from "@/lib/format/number-tr";
import { xAxisLabels } from "@/lib/trends/axis-labels";
import { trendBarTitle } from "@/lib/trends/bar-title";

// Daily bar chart of /gundem/[key] (h154-hub-trend): how many of THIS hub's clusters had their first report on each of the
// last 14 Istanbul days (migration 206's entity_cluster_days, read by src/lib/entities/hub-trend-query.ts). A synchronous
// server component: it reads nothing, keeps no state and ships no script.
//
// /trends has no reusable chart component (its chart is inline in src/app/trends/page.tsx, stacked by zone, 30 days, in a
// scroller), so this reuses its helpers and its accessibility pattern and leaves /trends alone: niceScale for the axis,
// xAxisLabels for the day labels, trendBarTitle for the bar names, formatCountTr for every count. The pattern:
//   * the svg draws geometry only (gridlines and bars) and is a role="img" with an aria-label that states the total;
//   * every label is HTML around it, placed from the same constants as the geometry (percentages of the viewBox), because
//     text inside an svg is sized in viewBox units; the y labels sit in a gutter beside the svg, the x labels under it;
//   * the per-day numbers are repeated in a table inside a details element (WCAG 1.1.1 / 1.3.1), with no overflow wrapper
//     around it (a second scroll region would need its own tab stop);
//   * the running day (the last one) is drawn lighter with a dashed outline, as /trends draws its partial day, as
//     attributes and not classes; the bar name and the table row say "eksik" too.
// Colours are theme tokens only (currentColor under text-primary / text-muted-foreground): no hex, no zone colour, a
// cluster has no single zone.
//
// No layout shift: the plot box is h-28 (112 px) in CSS, so its height is reserved before any data or font loads, and the
// x label row is h-5. The chart arrives in the same streamed chunk as the list it sits above.
//
// Fewer than ENTITY_HUB_MIN_INDEXABLE clusters in the window is too little for a daily chart: the section then says so in
// one line (and, when some clusters are older than the window, names them in a second line that does not point at a chart,
// hubTrendSparseEarlierNote) and draws no svg and no table.
//
// An all-zero trend (no cluster in the window and none earlier) renders nothing: on /gundem/[key] the chart only mounts
// under a non-empty list ("Son 14 günde N küme", N >= 1), so 0 / 0 can only be a stale chart entry (the hub's page-1 entry
// and the chart's entry are cached separately), and "ilk haberi çıkan küme yok" above that list would contradict it.

interface HubTrendChartProps {
  /** The hub's label ("Özgür Özel"), for the accessible name and the table caption. */
  label: string;
  /** The 14 Istanbul days, oldest first (parseHubTrendRows order); the last one is the running day. */
  days: readonly HubTrendDay[];
  /** Clusters whose first report is older than the first day: counted by the hub, not drawn. */
  earlier: number;
}

// The viewBox is unitless, so the box scales with CSS; preserveAspectRatio="none" lets the 420 x 112 geometry fill a
// phone-width box without letterboxing, and every stroke is non-scaling so a line stays 1 px however far it is stretched.
const VIEW_W = 420;
const VIEW_H = 112;
const PAD_TOP = 6;
const PAD_BOTTOM = 6;
const PAD_LEFT = 2;
const PAD_RIGHT = 2;
const PLOT_W = VIEW_W - PAD_LEFT - PAD_RIGHT;
const PLOT_H = VIEW_H - PAD_TOP - PAD_BOTTOM;
const BAR_GAP = 6;

// The /trends partial-day values.
const PARTIAL_FILL_OPACITY = 0.45;
const PARTIAL_DASH = "3 2";

// Literal class strings only (Tailwind 4 has no runtime scanner).
const SECTION_CLASS = "space-y-3 rounded-xl ring-1 ring-border/60 bg-card/60 p-4 sm:p-6";
const HEADING_CLASS = "text-sm font-semibold text-foreground";
const NOTE_CLASS = "text-xs text-muted-foreground";
// The /trends y label class, verbatim; 11 px is the floor for every chart label.
const Y_LABEL_CLASS =
  "absolute right-1 -translate-y-1/2 whitespace-nowrap font-mono text-[11px] leading-none tabular-nums text-muted-foreground";
// The /trends x label classes, with top-1/2 added: the labels are centred vertically in the h-5 row under the svg. The first
// label is anchored at its bar's left edge and the last at its right edge so a label with a month never pokes out of the box.
const X_LABEL_CLASS = {
  start:
    "absolute top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[11px] leading-none tabular-nums text-muted-foreground",
  center:
    "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[11px] leading-none tabular-nums text-muted-foreground",
  end: "absolute top-1/2 -translate-x-full -translate-y-1/2 whitespace-nowrap font-mono text-[11px] leading-none tabular-nums text-muted-foreground",
} as const;
// The /trends table toggle classes, verbatim.
const SUMMARY_CLASS =
  "cursor-pointer select-none rounded py-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** A viewBox position as a percentage of the box, for CSS `top` / `left`. */
function pct(units: number, total: number): string {
  return `${((units / total) * 100).toFixed(2)}%`;
}

export function HubTrendChart({ label, days, earlier }: HubTrendChartProps) {
  const sum = hubTrendSum(days);
  // On /gundem/[key] this mounts only under a non-empty list, so an all-zero trend can only be a stale chart entry that
  // contradicts "Son 14 günde N küme": draw nothing.
  if (sum === 0 && earlier === 0) return null;
  const earlierNote = hubTrendEarlierNote(earlier);

  if (hubTrendState(days) === "sparse") {
    const sparseEarlierNote = hubTrendSparseEarlierNote(earlier);
    return (
      <section aria-labelledby="hub-trend-heading" data-hub-trend className={SECTION_CLASS}>
        <h2 id="hub-trend-heading" className={HEADING_CLASS}>
          {HUB_TREND_HEADING}
        </h2>
        <p className={NOTE_CLASS}>{hubTrendSparseLine(sum, earlier)}</p>
        {sum > 0 && sparseEarlierNote !== null ? <p className={NOTE_CLASS}>{sparseEarlierNote}</p> : null}
      </section>
    );
  }

  const count = days.length;
  const lastIdx = count - 1;
  const barWidth = (PLOT_W - BAR_GAP * (count - 1)) / count;
  // Round gridlines and labels: niceScale picks the step, and the bars use the same maximum, so a bar never overshoots one.
  const scale = niceScale(Math.max(...days.map((d) => d.clusters)));
  const totalLine = hubTrendTotalLine(sum);

  return (
    <section aria-labelledby="hub-trend-heading" data-hub-trend className={SECTION_CLASS}>
      <h2 id="hub-trend-heading" className={HEADING_CLASS}>
        {HUB_TREND_HEADING}
      </h2>
      <p className={NOTE_CLASS}>{HUB_TREND_CAPTION}</p>

      <div className="grid grid-cols-[2.5rem_minmax(0,1fr)]">
        <div aria-hidden="true" className="relative h-28">
          {scale.ticks.map((t) => (
            <span
              key={`y-${t}`}
              className={Y_LABEL_CLASS}
              style={{ top: pct(PAD_TOP + PLOT_H * (1 - t / scale.max), VIEW_H) }}
            >
              {formatCountTr(t)}
            </span>
          ))}
        </div>

        <div>
          <svg
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={hubTrendAriaLabel(label, sum)}
            className="block h-28 w-full"
          >
            <g className="text-muted-foreground" stroke="currentColor" strokeOpacity={0.15}>
              {scale.ticks.map((t) => {
                const y = PAD_TOP + PLOT_H * (1 - t / scale.max);
                return (
                  <line
                    key={`grid-${t}`}
                    x1={PAD_LEFT}
                    x2={VIEW_W - PAD_RIGHT}
                    y1={y}
                    y2={y}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
            </g>

            <g className="text-primary" fill="currentColor">
              {days.map((d, idx) => {
                // A zero day draws nothing; its count is in the table and the total.
                if (d.clusters <= 0) return null;
                const isLast = idx === lastIdx;
                const height = (d.clusters / scale.max) * PLOT_H;
                return (
                  <rect
                    key={d.day}
                    x={PAD_LEFT + idx * (barWidth + BAR_GAP)}
                    y={PAD_TOP + PLOT_H - height}
                    width={barWidth}
                    height={height}
                    {...(isLast
                      ? {
                          // The running day is still counting: lighter fill and a dashed outline, so it does not read as a
                          // finished day for a reader who cannot tell the two fills apart.
                          fillOpacity: PARTIAL_FILL_OPACITY,
                          stroke: "currentColor",
                          strokeWidth: 1,
                          strokeDasharray: PARTIAL_DASH,
                          vectorEffect: "non-scaling-stroke" as const,
                        }
                      : {})}
                  >
                    {/* A single string child: React 19 renders a title with several children as an empty title. */}
                    <title>{trendBarTitle(d.day, "Küme", d.clusters, isLast)}</title>
                  </rect>
                );
              })}
            </g>
          </svg>

          <div aria-hidden="true" className="relative h-5">
            {xAxisLabels(days.map((d) => d.day)).map(({ idx, text }) => {
              const barLeft = PAD_LEFT + idx * (barWidth + BAR_GAP);
              const align = idx === 0 ? "start" : idx === lastIdx ? "end" : "center";
              const anchorX =
                align === "start" ? barLeft : align === "end" ? barLeft + barWidth : barLeft + barWidth / 2;
              return (
                <span
                  key={`x-${days[idx]?.day ?? idx}`}
                  className={X_LABEL_CLASS[align]}
                  style={{ left: pct(anchorX, VIEW_W) }}
                >
                  {text}
                </span>
              );
            })}
          </div>
        </div>
      </div>

      <p className={NOTE_CLASS}>{earlierNote === null ? totalLine : `${totalLine} ${earlierNote}`}</p>

      <details className="text-xs">
        <summary className={SUMMARY_CLASS}>{HUB_TREND_TABLE_TOGGLE}</summary>
        <table className="mt-3 w-full text-xs tabular-nums">
          <caption className="sr-only">{hubTrendTableCaption(label)}</caption>
          <thead className="[&_th]:px-1.5 [&_th]:py-1 [&_th]:text-right [&_th]:font-medium [&_th:first-child]:text-left">
            <tr>
              <th scope="col">Gün</th>
              <th scope="col">Küme</th>
            </tr>
          </thead>
          <tbody>
            {hubTrendTableRows(days).map((row) => (
              <tr key={row.day}>
                <th scope="row" className="px-1.5 py-1 text-left font-normal">
                  {row.label}
                </th>
                <td className="px-1.5 py-1 text-right">{formatCountTr(row.clusters)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
