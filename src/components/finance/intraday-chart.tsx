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
// Text sizes are SVG user units (the viewBox scales ~2x on a wide screen),
// so 6.5 here reads as ~13px.

const W = 720;
const H = 150;
const PAD = { top: 8, right: 44, bottom: 20, left: 8 };
const FONT = 6.5;
const SESSION_START_MIN = 10 * 60;
const SESSION_END_MIN = 18 * 60 + 10;

function istMinutes(iso: string): number {
  const d = new Date(new Date(iso).getTime() + 3 * 3600 * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function IntradayChart({ bars, markers, prevClose }: { bars: Bar5m[]; markers: ChartMarker[]; prevClose?: number | null }) {
  if (bars.length < 2) return null;
  const closes = bars.map((b) => b.close);
  const lo = Math.min(...closes, prevClose ?? Infinity);
  const hi = Math.max(...closes, prevClose ?? -Infinity);
  const span = hi - lo || hi * 0.01 || 1;
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const xAt = (mins: number) => PAD.left + ((mins - SESSION_START_MIN) / (SESSION_END_MIN - SESSION_START_MIN)) * plotW;
  const x = (iso: string) => xAt(istMinutes(iso));
  const y = (v: number) => PAD.top + (1 - (v - lo) / span) * plotH;
  const path = bars.map((b, i) => `${i ? "L" : "M"}${x(b.ts).toFixed(1)},${y(b.close).toFixed(1)}`).join(" ");
  const last = bars[bars.length - 1]!;
  const up = prevClose != null ? last.close >= prevClose : last.close >= bars[0]!.close;
  const inSession = markers.filter((m) => {
    const mins = istMinutes(m.ts);
    return mins >= SESSION_START_MIN - 30 && mins <= SESSION_END_MIN;
  });

  return (
    <figure className="px-3 py-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full font-mono" role="img" aria-label={`Seans içi fiyat, son ${fmtPrice(last.close)}`}>
        {[10, 12, 14, 16, 18].map((h) => {
          const xx = xAt(h * 60);
          return (
            <g key={h}>
              <line x1={xx} x2={xx} y1={PAD.top} y2={H - PAD.bottom} className="stroke-foreground/10" strokeWidth="0.5" />
              <text x={xx} y={H - 6} textAnchor={h === 10 ? "start" : "middle"} fontSize={FONT} className="fill-muted-foreground">
                {h}:00
              </text>
            </g>
          );
        })}
        {prevClose != null ? (
          <g>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(prevClose)} y2={y(prevClose)} className="stroke-foreground/30" strokeDasharray="2 2" strokeWidth="0.6" />
            <text x={W - PAD.right + 3} y={y(prevClose) + 2} fontSize={FONT} className="fill-muted-foreground">
              {fmtPrice(prevClose)}
            </text>
          </g>
        ) : null}
        <path d={path} fill="none" strokeWidth="1.2" strokeLinejoin="round" className={up ? "stroke-emerald-400" : "stroke-red-400"} />
        <text x={W - PAD.right + 3} y={y(last.close) + 2} fontSize={FONT} className={up ? "fill-emerald-400" : "fill-red-400"}>
          {fmtPrice(last.close)}
        </text>
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
