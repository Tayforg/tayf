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

// 30 days of mentions as bars, oldest left. Gaps are days with no article,
// which is itself the signal (attention is spiky), so they stay empty.
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
  return (
    <figure className="px-3 py-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`Son ${windowDays} günde günlük haber sayısı, en fazla ${max}`}>
        {series.map((s, i) => {
          const h = (s.articles / max) * (H - 14);
          return (
            <g key={s.day}>
              <rect x={i * (bw + gap)} y={H - 14 - h} width={bw} height={h} className={s.articles ? "fill-brand" : "fill-foreground/10"} />
              {s.articles ? (
                <text x={i * (bw + gap) + bw / 2} y={H - 3} textAnchor="middle" className="fill-muted-foreground font-mono text-[9px]">
                  {s.articles}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>{series[0]!.day.slice(5).split("-").reverse().join(".")}</span>
        <span>bugün</span>
      </figcaption>
    </figure>
  );
}
