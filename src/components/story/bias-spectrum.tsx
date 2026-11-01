import type { BiasDistribution, BiasCategory, MediaDnaZone } from "@/types";
import {
  BIAS_COLORS,
  BIAS_ORDER,
  BIAS_SHORT_LABELS,
  zoneOf,
} from "@/lib/bias/config";
import { roundPercents } from "@/lib/bias/round-percents";
import { formatCountTr, formatPctTr } from "@/lib/format/number-tr";

// Spectrum segments are derived from the canonical order + color palette in
// `@/lib/bias/config`. Keeping a local `SEGMENTS` array here lets us pre-bake
// the shape (key / color / dot / label) the render loop wants without chasing
// the palette at every render.
const SEGMENTS: Array<{
  key: BiasCategory;
  color: string;
  dot: string;
  label: string;
}> = BIAS_ORDER.map((key) => ({
  key,
  color: BIAS_COLORS[key].solid,
  dot: BIAS_COLORS[key].dot,
  label: BIAS_SHORT_LABELS[key],
}));

// Card-mode (compact) segments — collapses the 10 bias categories to the
// 3 Medya DNA zones so cluster cards stay scannable in ~2s. Tailwind class
// strings are kept literal so the JIT picks them up at build.
const ZONE_SEGMENTS: Array<{
  key: MediaDnaZone;
  color: string;
  dot: string;
  label: string;
}> = [
  { key: "iktidar", color: "bg-red-500", dot: "bg-red-400", label: "İktidar" },
  { key: "bagimsiz", color: "bg-zinc-400", dot: "bg-zinc-300", label: "Bağımsız" },
  { key: "muhalefet", color: "bg-emerald-500", dot: "bg-emerald-400", label: "Muhalefet" },
];

interface BiasSpectrumProps {
  distribution: BiasDistribution;
  /**
   * When true, collapse the 10 bias categories into the 3 Medya DNA zones
   * (iktidar / bağımsız / muhalefet) so cluster cards render a glanceable
   * 3-segment bar instead of the full 10-segment spectrum. The detail page
   * keeps `compact` off so the full breakdown stays visible there.
   */
  compact?: boolean;
}

export function BiasSpectrum({ distribution, compact = false }: BiasSpectrumProps) {
  if (compact) {
    const zones: Record<MediaDnaZone, number> = {
      iktidar: 0,
      bagimsiz: 0,
      muhalefet: 0,
    };
    for (const [bias, count] of Object.entries(distribution) as Array<
      [BiasCategory, number]
    >) {
      zones[zoneOf(bias)] += count;
    }
    const zoneTotal = zones.iktidar + zones.bagimsiz + zones.muhalefet;
    if (zoneTotal === 0) return null;

    const activeZones = ZONE_SEGMENTS.filter((z) => zones[z.key] > 0);

    // Largest-remainder percents, computed once for the whole bar so the
    // labels always total 100 (independent Math.round gave 88 + 13 = 101).
    // Bar widths below keep the exact fractions.
    const zonePcts = roundPercents(ZONE_SEGMENTS.map((z) => zones[z.key]));
    const pctByZone = new Map(ZONE_SEGMENTS.map((z, i) => [z.key, zonePcts[i] ?? 0]));

    return (
      <div className="space-y-2">
        {/* Bar */}
        <div className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-muted forced-color-adjust-none">
          {activeZones.map((segment) => {
            const pct = pctByZone.get(segment.key) ?? 0;
            return (
              <div
                key={segment.key}
                title={`${segment.label}: ${formatCountTr(zones[segment.key])} kaynak (${formatPctTr(pct)})`}
                className={`${segment.color} transition-all duration-500`}
                style={{ width: `${(zones[segment.key] / zoneTotal) * 100}%` }}
              />
            );
          })}
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {activeZones.map((segment) => {
            const pct = pctByZone.get(segment.key) ?? 0;
            return (
              <span
                key={segment.key}
                title={`${segment.label}: ${formatCountTr(zones[segment.key])} kaynak (${formatPctTr(pct)})`}
                className="flex items-center gap-1 text-[11px] text-muted-foreground"
              >
                <span className={`inline-block h-2 w-2 rounded-full forced-color-adjust-none ${segment.dot}`} />
                {segment.label}
                <span className="tabular-nums text-muted-foreground">{formatPctTr(pct)}</span>
              </span>
            );
          })}
        </div>
      </div>
    );
  }

  const total = SEGMENTS.reduce((sum, s) => sum + distribution[s.key], 0);
  if (total === 0) return null;

  const active = SEGMENTS.filter((s) => distribution[s.key] > 0);

  // Same largest-remainder rounding as the compact branch (see above); bar
  // widths keep the exact fractions.
  const segmentPcts = roundPercents(SEGMENTS.map((s) => distribution[s.key]));
  const pctBySegment = new Map(SEGMENTS.map((s, i) => [s.key, segmentPcts[i] ?? 0]));

  return (
    <div className="space-y-2">
      {/* Bar */}
      <div className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-muted forced-color-adjust-none">
        {active.map((segment) => {
          const pct = pctBySegment.get(segment.key) ?? 0;
          return (
            <div
              key={segment.key}
              title={`${segment.label}: ${formatCountTr(distribution[segment.key])} kaynak (${formatPctTr(pct)})`}
              className={`${segment.color} transition-all duration-500`}
              style={{ width: `${(distribution[segment.key] / total) * 100}%` }}
            />
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {active.map((segment) => {
          const pct = pctBySegment.get(segment.key) ?? 0;
          return (
            <span
              key={segment.key}
              title={`${segment.label}: ${formatCountTr(distribution[segment.key])} kaynak (${formatPctTr(pct)})`}
              className="flex items-center gap-1 text-[11px] text-muted-foreground"
            >
              <span className={`inline-block h-2 w-2 rounded-full forced-color-adjust-none ${segment.dot}`} />
              {segment.label}
              <span className="tabular-nums text-muted-foreground">{formatPctTr(pct)}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
