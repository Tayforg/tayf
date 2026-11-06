import { ExternalLink } from "lucide-react";

import { ZONE_META } from "@/lib/bias/config";
import { TrackedLink } from "@/components/ui/tracked-link";
import { pickOtherSide } from "@/lib/clusters/read-across";
import { sourceLang } from "@/lib/sources/source-language";
import type { ClusterDetailMember } from "@/lib/clusters/cluster-detail-query";
import { RelativeTime } from "@/components/story/relative-time";
import type { MediaDnaZone } from "@/types";

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
 * Server Component (the anchor is a tiny TrackedLink client island, and the
 * article's age a tiny RelativeTime one) — rendered in page.tsx directly under
 * `<BiasSpectrum>` so it's above the fold.
 *
 * h47-time-1: the age is measured against `nowMs`, the page's per-request
 * render stamp, and RelativeTime re-bases it to the reader's clock after mount,
 * so a service-worker copy of the page does not show a frozen age. The server
 * text is the one the plain formatter printed.
 */

interface ReadAcrossSpectrumProps {
  // Voting members only: page.tsx passes `votingMembers` (partitionByVote), so
  // the link below never points at a toplayıcı / niş source and its `zone` is
  // always a real vote (/diyetim counts it).
  members: ClusterDetailMember[];
  // The instant the server rendered the page (epoch ms), taken once per request
  // in page.tsx. Required: a caller that forgets it would print a frozen age.
  nowMs: number;
  isBlindspot: boolean;
  // True when the feed-health gate withdrew this cluster's blindspot claim
  // for this render (see cluster-detail-query.ts's suppression block) —
  // lets the empty state explain the silence as a possible infrastructure
  // gap instead of silently falling back to the generic "no news yet"
  // wording a genuine non-blindspot gets.
  feedDegraded?: boolean;
  /**
   * browser-qa-11: how many DEDUPED (by source.slug) toplayıcı / niş
   * (non-voting) members wrote from each zone. When the silent pole of a
   * genuine blindspot has one or more non-voting writers, the empty-state
   * copy names them instead of implying total silence — "İzlediğimiz
   * kaynaklar arasında…" reads as a factual claim that nobody covered the
   * story, which is false when a niche/aggregator source did.
   */
  nonVotingZoneCounts?: Partial<Record<MediaDnaZone, number>>;
}

// Literal Tailwind class strings per pole, drawn from the same red /
// emerald tones as `ZONE_META` (src/lib/bias/config.ts). Can't be built
// by interpolating ZONE_META's tokens — Tailwind's JIT only picks up
// classes it can see verbatim in source (same rule as
// `HOVER_DECORATION` in framing-comparison.tsx).
const POLE_STYLE: Record<"iktidar" | "muhalefet", string> = {
  iktidar:
    "border-red-500/40 bg-red-500/10 text-red-800 dark:text-red-400 hover:bg-red-500/20",
  muhalefet:
    "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-400 hover:bg-emerald-500/20",
};

export function ReadAcrossSpectrum({
  members,
  nowMs,
  isBlindspot,
  feedDegraded = false,
  nonVotingZoneCounts,
}: ReadAcrossSpectrumProps) {
  const { zone, member, counts } = pickOtherSide(members);
  const zoneLabel = ZONE_META[zone].label;

  if (!member) {
    const bothPolesEmpty = counts.iktidar === 0 && counts.muhalefet === 0;
    // Pack C: a suppressed blindspot (feed-health gate withdrew the claim,
    // see cluster-detail-query.ts) is NOT a genuine "no coverage" case —
    // say so instead of silently falling back to the generic wording a
    // real non-blindspot gets.
    const degradedSuffix = feedDegraded
      ? " — bu taraftaki bazı kaynaklara şu an ulaşamıyoruz"
      : "";
    // browser-qa-11: name non-voting (toplayıcı / niş) writers from the
    // silent side(s) instead of letting the copy imply total silence. For a
    // single empty pole, only that zone's non-voting count matters; for
    // both-poles-empty, either pole's non-voting writers are worth naming.
    const nonVotingCount = bothPolesEmpty
      ? (nonVotingZoneCounts?.iktidar ?? 0) + (nonVotingZoneCounts?.muhalefet ?? 0)
      : (nonVotingZoneCounts?.[zone] ?? 0);
    const nonVotingSuffix =
      isBlindspot && nonVotingCount > 0
        ? ` · ${nonVotingCount} toplayıcı / niş kaynak yazdı (spektruma sayılmaz)`
        : "";
    const emptyText = bothPolesEmpty
      ? isBlindspot
        ? `İki kutupta da haber yok — sadece bağımsız kaynaklar yazdı${nonVotingSuffix}`
        : "İki kutupta da henüz haber yok"
      : isBlindspot
        ? `Spektruma sayılan kaynaklar arasında bu tarafta haber yok — kör nokta (${zoneLabel})${nonVotingSuffix}`
        : `${zoneLabel} tarafında henüz haber yok${degradedSuffix}`;
    return (
      <p className="rounded-lg border border-dashed border-border/50 px-3.5 py-2 text-[12px] text-muted-foreground">
        {emptyText}
      </p>
    );
  }

  // WCAG 3.1.2: an English outlet's name inside <html lang="tr">. The link
  // renders no article title, so the name is the only English text here. A
  // Turkish name is left bare, so its markup is unchanged.
  const nameLang = sourceLang({
    slug: member.source.slug,
    name: member.source.name,
  });
  const sourceName =
    nameLang === undefined ? (
      member.source.name
    ) : (
      <span lang={nameLang}>{member.source.name}</span>
    );

  return (
    <TrackedLink
      event="cta_other_side"
      data={{ zone }}
      href={member.article.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`flex min-h-[44px] touch-manipulation items-center gap-2.5 rounded-lg border px-3.5 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${POLE_STYLE[zone]}`}
    >
      <ExternalLink className="h-4 w-4 shrink-0" strokeWidth={2.5} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-bold leading-tight">
          Karşı tarafı oku
        </span>
        <span className="block truncate text-[11px] font-medium">
          {zoneLabel} · {sourceName}
        </span>
      </span>
      <span className="shrink-0 text-[10px] tabular-nums">
        <RelativeTime iso={member.article.published_at} nowMs={nowMs} />
      </span>
      <span className="sr-only"> (yeni sekmede açılır)</span>
    </TrackedLink>
  );
}
