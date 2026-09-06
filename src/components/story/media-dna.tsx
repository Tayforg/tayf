"use client";

import { useState } from "react";

import type { Source, MediaDnaZone } from "@/types";
import { zoneOf, ZONE_META, BIAS_LABELS } from "@/lib/bias/config";
import { isVotingSource, sourceKindOf, SOURCE_KIND_META } from "@/lib/sources/kind";

/**
 * Chart 1 — Medya DNA'sı.
 *
 * Client Component (uses `useState` for the show-all toggle). Buckets the
 * full source directory into the three baseline bias zones (muhalefet /
 * bağımsız / iktidar) and renders them as a chip wall under a proportional
 * 3-segment top bar.
 *
 * Default view: only the sources in `highlightSlugs` (the outlets that
 * actually covered this cluster) — typically 3-20 chips. A toggle button
 * underneath flips to "show all 144" mode, in which non-participating
 * sources render at `opacity-30` to preserve the directory-level signal.
 *
 * If `highlightSlugs` is `undefined` or empty, the component starts in
 * the show-all state (there's no filter to apply, so dimming everything
 * would be wrong).
 *
 * The proportional 3-segment top bar always reflects the FULL directory
 * distribution regardless of toggle state.
 *
 * Non-voting kinds (toplayıcı / niş) still get highlighted like any other
 * participating source, but render at `opacity-50` instead of full opacity
 * and carry a small kind label — a visual reminder that they're cluster
 * members without being counted in bias_distribution / blindspot / trends.
 */

interface MediaDnaProps {
  /** The full source directory (all 144 outlets). */
  sources: Source[];
  /** Slugs of sources that covered this cluster. Undefined → highlight all. */
  highlightSlugs?: Set<string>;
}

// Zones are rendered left-to-right in political order:
// Muhalefet (emerald) → Bağımsız (zinc) → İktidar (red).
const ZONE_ORDER: MediaDnaZone[] = ["muhalefet", "bagimsiz", "iktidar"];

// Solid fills for the proportional 3-segment top bar. These match the
// ZONE_META palette but are pinned here as literals so Tailwind's JIT picks
// them up.
const ZONE_BAR_FILL: Record<MediaDnaZone, string> = {
  muhalefet: "bg-emerald-500",
  bagimsiz: "bg-zinc-400",
  iktidar: "bg-red-500",
};

export function MediaDna({ sources, highlightSlugs }: MediaDnaProps) {
  // When there's no highlight set (or it's empty), there's no filter to
  // apply — start expanded so the component still shows useful data.
  const hasFilter = highlightSlugs !== undefined && highlightSlugs.size > 0;
  const [showAll, setShowAll] = useState(!hasFilter);

  // Bucket every source into its zone. Done at render time — with 144
  // sources this is cheap and we want both views (collapsed + expanded) to
  // share the same totals for the top bar and the per-zone counts.
  const byZone: Record<MediaDnaZone, Source[]> = {
    muhalefet: [],
    bagimsiz: [],
    iktidar: [],
  };
  for (const source of sources) {
    byZone[zoneOf(source.bias)].push(source);
  }

  const total = sources.length;

  // Only show the legend when a non-voting chip is actually rendered: in
  // collapsed mode that means a participating aggregator/niche source; in
  // expanded mode any non-voting source in the directory.
  const showsNonVotingChip = sources.some(
    (s) =>
      !isVotingSource(s) &&
      (showAll || (highlightSlugs !== undefined && highlightSlugs.has(s.slug))),
  );

  return (
    <div className="space-y-3">
      {/* Header */}
      <div>
        <h3 className="text-sm font-semibold">Medya DNA&apos;sı</h3>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Kaynakların hükümete göre temel duruşu. Haberden habere değişmez.
        </p>
      </div>

      {/* Proportional 3-segment top bar — always reflects ALL 144 sources. */}
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
        {ZONE_ORDER.map((zone) => {
          const count = byZone[zone].length;
          const width = total === 0 ? 0 : (count / total) * 100;
          return (
            <div
              key={zone}
              className={ZONE_BAR_FILL[zone]}
              style={{ width: `${width}%` }}
            />
          );
        })}
      </div>

      {/* Zone cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {ZONE_ORDER.map((zone) => {
          const meta = ZONE_META[zone];
          const allMembers = byZone[zone];
          // In the collapsed view we only render the participating sources
          // for this zone. In the expanded view we render every source.
          const visibleMembers = showAll
            ? allMembers
            : allMembers.filter(
                (s) => highlightSlugs !== undefined && highlightSlugs.has(s.slug),
              );
          return (
            <div
              key={zone}
              className={`rounded-lg border ${meta.zoneBg} ${meta.zoneBorder} p-3 space-y-2`}
            >
              {/* Zone card header: dot + label + member count.
                  Count reflects the CURRENT view (participating in
                  collapsed mode, total in expanded mode). */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span
                    className={`h-2 w-2 rounded-full ${meta.dot}`}
                    aria-hidden="true"
                  />
                  <span
                    className={`text-[10px] font-semibold uppercase tracking-wider ${meta.zoneLabel}`}
                  >
                    {meta.label}
                  </span>
                </div>
                <span className="text-[10px] text-muted-foreground">
                  {visibleMembers.length} kaynak
                </span>
              </div>

              {/* Source chips */}
              <div className="flex flex-wrap gap-1">
                {visibleMembers.map((source) => {
                  // Lock chip tint to the 3-zone palette so MediaDNA stays
                  // visually consistent with the rest of the page. The
                  // 10-hue BIAS_BADGE_CONFIG palette is reserved for the
                  // bias spectrum bar — using it here would leak orange/
                  // sky/amber/etc into a section that should read as a
                  // single zone tone.
                  const biasLabel = BIAS_LABELS[source.bias];
                  const isVoting = isVotingSource(source);
                  const kindLabel = SOURCE_KIND_META[sourceKindOf(source)].label;
                  // In collapsed mode every visible chip is a participant,
                  // so they're all full-opacity. In expanded mode we dim
                  // the non-participating ones so the directory still
                  // reads as background context.
                  const isHighlighted =
                    !showAll ||
                    highlightSlugs === undefined ||
                    highlightSlugs.has(source.slug);
                  return (
                    <span
                      key={source.id}
                      title={`${source.name} — ${biasLabel}${
                        isVoting ? "" : ` · ${kindLabel} · yanlılık dağılımına sayılmaz`
                      }`}
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium transition-opacity duration-300 ${meta.chipBg} ${meta.chipText} ${meta.chipBorder} ${
                        isHighlighted ? (isVoting ? "opacity-100" : "opacity-50") : "opacity-30"
                      }`}
                    >
                      <span
                        className={`h-1 w-1 rounded-full ${meta.dot}`}
                        aria-hidden="true"
                      />
                      {source.name}
                      {!isVoting && (
                        <span className="ml-0.5 text-[9px] uppercase tracking-wider opacity-70">
                          {kindLabel}
                        </span>
                      )}
                    </span>
                  );
                })}
                {visibleMembers.length === 0 && (
                  <span className="text-[11px] text-muted-foreground italic">
                    Hiç kaynak yok
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {showsNonVotingChip && (
        <p className="text-[10px] text-muted-foreground/70">
          Soluk gösterilen toplayıcı / niş kaynaklar kümelerde listelenir ama
          yanlılık dağılımına sayılmaz.
        </p>
      )}

      {/* Toggle: collapsed ↔ expanded. Hidden when there's no filter to
          collapse to (highlightSlugs missing/empty) — in that case the
          component is permanently in show-all mode. */}
      {hasFilter && (
        <div className="flex justify-center mt-2">
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {showAll
              ? "Sadece bu haberdekileri göster"
              : `Tüm ${sources.length} kaynağı göster`}
          </button>
        </div>
      )}
    </div>
  );
}
