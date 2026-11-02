import type { AttentionDay } from "@/lib/finance/queries";
import { cn } from "@/lib/utils";

// Five-session close line. Stroke uses currentColor so the caller picks
// the move colour with a text class.
export function Sparkline({ values, className, width = 120, height = 32 }: { values: number[]; className?: string; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * (width - 2) + 1;
      const y = height - 1 - ((v - min) / span) * (height - 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className={cn("block", className)} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export type AttentionLabelAlign = "start" | "center" | "end";

export interface AttentionLabel {
  text: string;
  /** Centre of the bar, in percent of the svg width. */
  leftPct: number;
  align: AttentionLabelAlign;
}

// Literal class strings only (Tailwind 4 has no runtime scanner), so the
// alignment is a lookup of whole classes, never a computed name.
const LABEL_ALIGN_CLASS: Record<AttentionLabelAlign, string> = {
  start: "",
  center: "-translate-x-1/2",
  end: "-translate-x-full",
};

/**
 * The only two counts worth printing under the bars: the peak (the first bar
 * at the maximum, so a tie reads as the earliest) and today (the last bar).
 * Both need articles > 0, and they collapse into one label when they are the
 * same bar. Anchored on the bar's centre with the same geometry AttentionBars
 * draws its rects with; a label near an edge aligns inward (start below 10 %,
 * end above 90 %) so it never spills out of the figure.
 */
export function attentionLabels(series: Array<{ day: string; articles: number }>, W: number, gap: number): AttentionLabel[] {
  const n = series.length;
  if (n === 0) return [];
  const bw = (W - gap * (n - 1)) / n;
  const label = (i: number): AttentionLabel => {
    const leftPct = ((i * (bw + gap) + bw / 2) / W) * 100;
    const align: AttentionLabelAlign = leftPct < 10 ? "start" : leftPct > 90 ? "end" : "center";
    return { text: String(series[i]!.articles), leftPct, align };
  };

  let peak = -1;
  let peakArticles = 0;
  series.forEach((s, i) => {
    if (s.articles > peakArticles) {
      peakArticles = s.articles;
      peak = i;
    }
  });

  const out: AttentionLabel[] = [];
  if (peak !== -1) out.push(label(peak));
  const today = n - 1;
  if (series[today]!.articles > 0 && today !== peak) out.push(label(today));
  return out;
}

// 30 days of mentions as bars, oldest left. Gaps are days with no article,
// which is itself the signal (attention is spiky), so they stay empty.
//
// The SVG draws only the bars. The counts are HTML labels in a row under it:
// SVG text is sized in viewBox units, so the old 9 px label in a 600-unit
// viewBox rendered at about 5 px on a 390 px phone, while an HTML label stays
// at its real 10 px.
export function AttentionBars({ days, today, windowDays = 30 }: { days: AttentionDay[]; today: string; windowDays?: number }) {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const end = Date.parse(`${today}T00:00:00Z`);
  const series: Array<{ day: string; articles: number }> = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(end - i * 86400 * 1000).toISOString().slice(0, 10);
    series.push({ day: d, articles: byDay.get(d)?.articles ?? 0 });
  }
  const max = Math.max(1, ...series.map((s) => s.articles));
  const W = 600;
  const H = 72;
  const gap = 3;
  const bw = (W - gap * (windowDays - 1)) / windowDays;
  const labels = attentionLabels(series, W, gap);
  return (
    <figure className="px-3 py-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`Son ${windowDays} günde günlük haber sayısı, en fazla ${max}`}>
        {series.map((s, i) => {
          const h = (s.articles / max) * H;
          return <rect key={s.day} x={i * (bw + gap)} y={H - h} width={bw} height={h} className={s.articles ? "fill-brand" : "fill-foreground/10"} />;
        })}
      </svg>
      {labels.length > 0 ? (
        <div className="relative h-4 font-mono text-[10px] text-muted-foreground">
          {labels.map((l) => (
            <span
              key={`${l.leftPct}-${l.text}`}
              aria-hidden="true"
              data-chart-label
              className={`absolute top-0.5 whitespace-nowrap leading-none ${LABEL_ALIGN_CLASS[l.align]}`}
              style={{ left: `${l.leftPct.toFixed(2)}%` }}
            >
              {l.text}
            </span>
          ))}
        </div>
      ) : null}
      <figcaption className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>{series[0]!.day.slice(5).split("-").reverse().join(".")}</span>
        <span>bugün</span>
      </figcaption>
    </figure>
  );
}
