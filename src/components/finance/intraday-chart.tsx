import { fmtClock, fmtPrice } from "@/lib/finance/format";
import type { Bar5m } from "@/lib/finance/queries";

export interface ChartMarker {
  ts: string;
  label: string;
}

// One session of 5-minute closes with the headlines that landed during it
// drawn as ticks on the time axis. This is the trader's question in one
// picture: did the price move before, at, or after the news. The previous
// close is a dashed reference so the day's sign is readable without an
// axis. Session window is fixed 10:00-18:10 Istanbul.
//
// The SVG draws only geometry. Every label (the hour axis, the last price and
// the previous close) is HTML positioned over it in percent of the plot box:
// text inside the SVG is sized in viewBox units, so on a 390 px phone the
// 720-unit viewBox shrinks it to about 3 px, while an HTML label stays at its
// real 10 px. The helpers below place the labels from the same geometry as
// the plot, so a label cannot drift off its gridline or price level.

const W = 720;
const H = 150;
// The right and bottom margins hold no text any more; they only keep the line
// end, the dashed baseline and the 3-unit-wide marker triangles inside the
// viewBox.
const PAD = { top: 8, right: 6, bottom: 6, left: 8 };
const SESSION_START_MIN = 10 * 60;
const SESSION_END_MIN = 18 * 60 + 10;
const AXIS_HOURS = [10, 12, 14, 16, 18] as const;
/** Default: two price tags closer than this (in percent of the chart height) are pushed apart. */
const PRICE_TAG_MIN_GAP = 14;
/**
 * What the chart asks for. On a 390 px phone the plot is about 56 px tall, so
 * the default 14 points is only about 8 px: two 10 px tags on the same level
 * still touched. 22 points is about 12 px there, which clears the digits; on a
 * wide screen it only matters when the two levels really are that close.
 */
const PRICE_TAG_PHONE_GAP = 22;

type LabelAlign = "start" | "center" | "end";

// Literal class strings only (Tailwind 4 has no runtime scanner), so the
// alignment is a lookup of whole classes, never a computed name.
const ALIGN_CLASS: Record<LabelAlign, string> = {
  start: "",
  center: "-translate-x-1/2",
  end: "-translate-x-full",
};

const PLOT_W = W - PAD.left - PAD.right;
const xAt = (mins: number) => PAD.left + ((mins - SESSION_START_MIN) / (SESSION_END_MIN - SESSION_START_MIN)) * PLOT_W;

export interface AxisTick {
  label: string;
  /** Horizontal anchor in percent of the svg width, from the plot's own xAt. */
  leftPct: number;
  align: LabelAlign;
}

/** The hour labels under the plot: 10:00 flush left, 18:00 flush right when it sits past 90 %. */
export function sessionAxisTicks(): AxisTick[] {
  return AXIS_HOURS.map((h, i) => {
    const leftPct = (xAt(h * 60) / W) * 100;
    const align: LabelAlign = i === 0 ? "start" : leftPct > 90 ? "end" : "center";
    return { label: `${h}:00`, leftPct, align };
  });
}

const clampPct = (v: number) => Math.min(100, Math.max(0, v));

/**
 * Vertical anchors of the last-price tag and the previous-close tag, in percent
 * of the chart height. Tags whose levels are closer than `minGap` (default 14) are
 * pushed apart symmetrically about their midpoint (the tag that was lower stays
 * lower), then slid back inside 0-100 without closing the gap.
 */
export function priceTagTops(
  lastY: number,
  prevY: number | null,
  height: number,
  minGap: number = PRICE_TAG_MIN_GAP,
): { last: number; prev: number | null } {
  const last = (lastY / height) * 100;
  if (prevY == null) return { last: clampPct(last), prev: null };
  const prev = (prevY / height) * 100;

  let upper = Math.min(last, prev);
  let lower = Math.max(last, prev);
  if (lower - upper < minGap) {
    const mid = (upper + lower) / 2;
    upper = mid - minGap / 2;
    lower = mid + minGap / 2;
  }
  if (upper < 0) {
    lower -= upper;
    upper = 0;
  } else if (lower > 100) {
    upper -= lower - 100;
    lower = 100;
  }
  upper = clampPct(upper);
  lower = clampPct(lower);
  return last <= prev ? { last: upper, prev: lower } : { last: lower, prev: upper };
}

function istMinutes(iso: string): number {
  const d = new Date(new Date(iso).getTime() + 3 * 3600 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

const PRICE_TAG_CLASS = "absolute left-full ml-1 -translate-y-1/2 font-mono text-[10px] tabular-nums";

/**
 * `closeOverride` (h92-marketclock-1) is the settled daily close of a session whose bars were cut short
 * (bist_intraday_targets dropped the ticker mid-session, so the newest bar is not where the day ended). When it is
 * finite, the colour, the last-price tag (its text and its level) and the aria-label follow it instead of the last
 * bar; the path is still the bars. Absent or not finite, the output is what it always was.
 */
export function IntradayChart({
  bars,
  markers,
  prevClose,
  closeOverride,
}: {
  bars: Bar5m[];
  markers: ChartMarker[];
  prevClose?: number | null;
  closeOverride?: number | null;
}) {
  if (bars.length < 2) return null;
  const closes = bars.map((b) => b.close);
  const lo = Math.min(...closes, prevClose ?? Infinity);
  const hi = Math.max(...closes, prevClose ?? -Infinity);
  const span = hi - lo || hi * 0.01 || 1;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (iso: string) => xAt(istMinutes(iso));
  const y = (v: number) => PAD.top + (1 - (v - lo) / span) * plotH;
  const path = bars.map((b, i) => `${i ? "L" : "M"}${x(b.ts).toFixed(1)},${y(b.close).toFixed(1)}`).join(" ");
  const last = bars[bars.length - 1]!;
  const settled = typeof closeOverride === "number" && Number.isFinite(closeOverride) ? closeOverride : null;
  const lastClose = settled ?? last.close;
  const up = prevClose != null ? lastClose >= prevClose : lastClose >= bars[0]!.close;
  const inSession = markers.filter((m) => {
    const mins = istMinutes(m.ts);
    return mins >= SESSION_START_MIN - 30 && mins <= SESSION_END_MIN;
  });
  const tops = priceTagTops(y(lastClose), prevClose != null ? y(prevClose) : null, H, PRICE_TAG_PHONE_GAP);
  const ariaLabel = settled != null ? `Seans içi fiyat, kapanış ${fmtPrice(settled)}, gün içi veri eksik` : `Seans içi fiyat, son ${fmtPrice(last.close)}`;

  return (
    <figure className="px-3 py-2">
      {/* pr-16 is the gutter the price tags sit in (left-full of the plot box). */}
      <div className="pr-16">
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={ariaLabel}>
            {AXIS_HOURS.map((h) => {
              const xx = xAt(h * 60);
              return <line key={h} x1={xx} x2={xx} y1={PAD.top} y2={H - PAD.bottom} className="stroke-foreground/10" strokeWidth="0.5" />;
            })}
            {prevClose != null ? (
              <line x1={PAD.left} x2={W - PAD.right} y1={y(prevClose)} y2={y(prevClose)} className="stroke-foreground/30" strokeDasharray="2 2" strokeWidth="0.6" />
            ) : null}
            <path d={path} fill="none" strokeWidth="1.2" strokeLinejoin="round" className={up ? "stroke-emerald-400" : "stroke-red-400"} />
            {inSession.map((m, i) => {
              const xx = Math.max(PAD.left, x(m.ts));
              return (
                <g key={`${m.ts}-${i}`}>
                  <line x1={xx} x2={xx} y1={PAD.top} y2={H - PAD.bottom} className="stroke-brand/70" strokeWidth="0.6" />
                  <polygon points={`${xx - 3},${H - PAD.bottom + 1} ${xx + 3},${H - PAD.bottom + 1} ${xx},${H - PAD.bottom - 4}`} className="fill-brand" />
                </g>
              );
            })}
          </svg>
          {prevClose != null && tops.prev != null ? (
            <span aria-hidden="true" data-chart-label className={`${PRICE_TAG_CLASS} text-muted-foreground`} style={{ top: `${tops.prev.toFixed(2)}%` }}>
              {fmtPrice(prevClose)}
            </span>
          ) : null}
          <span
            aria-hidden="true"
            data-chart-label
            className={`${PRICE_TAG_CLASS} ${up ? "text-emerald-400" : "text-red-400"}`}
            style={{ top: `${tops.last.toFixed(2)}%` }}
          >
            {fmtPrice(lastClose)}
          </span>
        </div>
        <div className="relative h-4 font-mono text-[10px] text-muted-foreground">
          {sessionAxisTicks().map((t) => (
            <span
              key={t.label}
              aria-hidden="true"
              data-chart-label
              className={`absolute top-0.5 whitespace-nowrap leading-none ${ALIGN_CLASS[t.align]}`}
              style={{ left: `${t.leftPct.toFixed(2)}%` }}
            >
              {t.label}
            </span>
          ))}
        </div>
      </div>
      {inSession.length > 0 ? (
        <figcaption className="mt-1 space-y-0.5 font-mono text-[10px] text-muted-foreground">
          {inSession.slice(0, 6).map((m, i) => (
            <div key={`${m.ts}-${i}`} className="flex gap-2">
              <span className="text-brand">▲</span>
              <span className="tabular-nums">{fmtClock(m.ts)}</span>
              <span className="truncate">{m.label}</span>
            </div>
          ))}
        </figcaption>
      ) : null}
    </figure>
  );
}
