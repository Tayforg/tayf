import { ExternalLink } from "lucide-react";

import { ZONE_META } from "@/lib/bias/config";
import { TrackedLink } from "@/components/ui/tracked-link";
import { pickOtherSide } from "@/lib/clusters/read-across";
import type { ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";
import { formatTurkishTimeAgo } from "@/lib/time";

/**
 * "Karşı tarafı oku" — the one-tap next action for a visitor landing
 * from a shared link. Points at the newest article from whichever pole
 * `pickOtherSide` (src/lib/clusters/read-across.ts) decides the reader is
 * least likely to have already seen, or renders a neutral empty-state
 * message when that pole has zero coverage — only using the "kör nokta"
 * wording when `cluster.is_blindspot` is true, since a zero-coverage pole
 * on a non-blindspot cluster (below BLINDSPOT.minSources, or with the
 * dominant-zone share under BLINDSPOT.dominantShare) doesn't meet the
 * product's blindspot definition.
 *
 * Server Component (the anchor is a tiny TrackedLink client island) — rendered in page.tsx directly under
 * `<BiasSpectrum>` so it's above the fold.
 */

interface ReadAcrossSpectrumProps {
  members: ClusterDetailMember[];
  isBlindspot: boolean;
}

// Literal Tailwind class strings per pole, drawn from the same red /
// emerald tones as `ZONE_META` (src/lib/bias/config.ts). Can't be built
// by interpolating ZONE_META's tokens — Tailwind's JIT only picks up
// classes it can see verbatim in source (same rule as
// `HOVER_DECORATION` in framing-comparison.tsx).
const POLE_STYLE: Record<"iktidar" | "muhalefet", string> = {
  iktidar:
    "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400 hover:bg-red-500/20",
  muhalefet:
    "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/20",
};

export function ReadAcrossSpectrum({
  members,
  isBlindspot,
}: ReadAcrossSpectrumProps) {
  const { zone, member, counts } = pickOtherSide(members);
  const zoneLabel = ZONE_META[zone].label;

  if (!member) {
    const bothPolesEmpty = counts.iktidar === 0 && counts.muhalefet === 0;
    const emptyText = bothPolesEmpty
      ? isBlindspot
        ? "İki kutupta da haber yok — sadece bağımsız kaynaklar yazdı"
        : "İki kutupta da henüz haber yok"
      : isBlindspot
        ? `Bu tarafta haber yok — kör nokta (${zoneLabel})`
        : `${zoneLabel} tarafında henüz haber yok`;
    return (
      <p className="rounded-lg border border-dashed border-border/50 px-3.5 py-2 text-[12px] text-muted-foreground/60">
        {emptyText}
      </p>
    );
  }

  return (
    <TrackedLink
      event="cta_other_side"
      data={{ zone }}
      href={member.article.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Karşı tarafı oku: ${zoneLabel} — ${member.source.name}`}
      className={`flex min-h-[44px] touch-manipulation items-center gap-2.5 rounded-lg border px-3.5 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${POLE_STYLE[zone]}`}
    >
      <ExternalLink className="h-4 w-4 shrink-0" strokeWidth={2.5} />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-bold leading-tight">
          Karşı tarafı oku
        </span>
        <span className="block truncate text-[11px] font-medium opacity-80">
          {zoneLabel} · {member.source.name}
        </span>
      </span>
      <span className="shrink-0 text-[10px] tabular-nums opacity-70">
        {formatTurkishTimeAgo(member.article.published_at)}
      </span>
    </TrackedLink>
  );
}
