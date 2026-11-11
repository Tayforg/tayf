"use client";

import { useState } from "react";

import type { MediaDnaZone } from "@/types";
import type { MediaDnaSource } from "@/components/story/media-dna-sources";
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
 * underneath flips to "show the whole directory" mode, in which non-participating
 * sources keep their text and border but lose the zone tint (transparent
 * background), so the directory still reads as background context.
 *
 * That tint is only ~1.2:1 against the zone card, so in the expanded view
 * (story set present) it is never the sole cue (WCAG 1.4.1 / 1.3.1): each
 * covering chip carries a "✓" glyph (aria-hidden) plus an sr-only "bu haberde
 * var", every other chip an sr-only "bu haberde yok", one legend line explains
 * the mark, and the zone count reads "covering/total kaynak". The toggle exposes
 * `aria-expanded`. Collapsed and no-filter views carry none of those marks.
 *
 * If `highlightSlugs` is `undefined` or empty, the component starts in
 * the show-all state (there's no filter to apply, so dropping the tint
 * from everything would be wrong).
 *
 * The proportional 3-segment top bar always reflects the FULL directory
 * distribution regardless of toggle state.
 *
 * An EMPTY `sources` list means the directory read failed (a live directory is
 * never empty; the detail query reports it as `sourcesUnavailable`). Then the
 * component renders the header and one honest line instead of an empty bar,
 * three "Hiç kaynak yok" cards and a "Tüm 0 kaynağı göster" toggle.
 *
 * Non-voting kinds (toplayıcı / niş) still get highlighted like any other
 * participating source, but carry a dashed border and a small kind label —
 * a visual reminder that they're cluster members without being counted in
 * bias_distribution / blindspot / trends. Text stays at full strength:
 * nothing here is faded with an opaklık utility (WCAG 1.4.3 — the old soluk
 * chips measured 2.0-3.25:1), and `tests/guards/text-contrast-tokens.test.ts`
 * keeps it that way.
 */

interface MediaDnaProps {
  /**
   * The whole source directory, narrowed to the fields this chart reads. The
   * server page builds it with `toMediaDnaSources` so the RSC payload does not
   * carry id / url / rss_url / logo_url / active. Chips are keyed by `slug`,
   * which is unique per source.
   */
  sources: MediaDnaSource[];
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

/**
 * Class string for the "Hiç kaynak yok" label of an empty zone card (WCAG
 * 1.4.3). It sits on the zone's tinted card, where muted-foreground measured
 * below 4.5:1 (zinc zone, dark mode); foreground at 80 % clears it on every
 * zone, both themes and both surfaces. The ratios are asserted in
 * tests/guards/text-contrast-tokens.test.ts. Kept a literal string so
 * Tailwind 4 can see it.
 */
export const MEDIA_DNA_EMPTY_CLASS = "text-[11px] text-foreground/80 italic";

/**
 * Class string for one source chip. Pure and exported so the contrast rules
 * are testable without rendering: no opacity utility ever (full-strength
 * `chipText`), non-voting chips get a dashed border, and expanded-mode
 * non-participants swap the zone tint for a transparent background while
 * keeping `chipText` and `chipBorder`. The literal strings stay in source
 * so Tailwind 4 can see them.
 */
export function mediaDnaChipClass(
  meta: (typeof ZONE_META)[MediaDnaZone],
  o: { isVoting: boolean; isHighlighted: boolean },
): string {
  return `inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium transition-colors ${o.isHighlighted ? meta.chipBg : "bg-transparent"} ${meta.chipText} ${meta.chipBorder}${o.isVoting ? "" : " border-dashed"}`;
}

export function MediaDna({ sources, highlightSlugs }: MediaDnaProps) {
  // When there's no highlight set (or it's empty), there's no filter to
  // apply — start expanded so the component still shows useful data.
  const hasFilter = highlightSlugs !== undefined && highlightSlugs.size > 0;
  const [showAll, setShowAll] = useState(!hasFilter);
  // Expanded view WITH a story set: the only state in which "covered the story"
  // vs "did not" is a comparison the reader is making, so it gets the glyph, the
  // sr-only note, the legend and the covering/total count. Collapsed shows only
  // covering chips and no-filter has nothing to compare, so neither is marked.
  const marksCoverage = hasFilter && showAll;
  const covers = (slug: string) => highlightSlugs !== undefined && highlightSlugs.has(slug);

  // Bucket every source into its zone. Done at render time — over the whole
  // directory this is cheap and we want both views (collapsed + expanded) to
  // share the same totals for the top bar and the per-zone counts.
  const byZone: Record<MediaDnaZone, MediaDnaSource[]> = {
    muhalefet: [],
    bagimsiz: [],
    iktidar: [],
  };
  for (const source of sources) {
    byZone[zoneOf(source.bias)].push(source);
  }

  const total = sources.length;

  // Directory read failed (see the component doc): say so, show nothing else.
  // After every hook above, so the hook order never changes between renders.
  if (total === 0) {
    return (
      <div className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Medya DNA&apos;sı</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Kaynak bilgisi şu an alınamadı. Sayfayı birkaç dakika sonra
            yenileyebilirsiniz.
          </p>
        </div>
      </div>
    );
  }

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
        <h2 className="text-sm font-semibold">Medya DNA&apos;sı</h2>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Kaynakların hükümete göre temel duruşu. Haberden habere değişmez.
        </p>
      </div>

      {/* Proportional 3-segment top bar — always reflects the WHOLE directory. */}
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
            : allMembers.filter((s) => covers(s.slug));
          return (
            <div
              key={zone}
              className={`rounded-lg border ${meta.zoneBg} ${meta.zoneBorder} p-3 space-y-2`}
            >
              {/* Zone card header: dot + label + member count. Collapsed:
                  the participating sources ("N kaynak"). Expanded with a
                  story set: "covering/total kaynak", so the switch from
                  participants to the whole directory is not silent. */}
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
                <span className={`text-[10px] ${meta.zoneLabel}`}>
                  {marksCoverage
                    ? `${allMembers.filter((s) => covers(s.slug)).length}/${allMembers.length} kaynak`
                    : `${visibleMembers.length} kaynak`}
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
                  // so they all keep the zone tint. In expanded mode the
                  // non-participating ones swap the tint for a transparent
                  // background (text and border stay full strength) so the
                  // directory still reads as background context.
                  const isHighlighted =
                    !showAll ||
                    highlightSlugs === undefined ||
                    highlightSlugs.has(source.slug);
                  // The tint alone cannot carry "covered this story" (~1.2:1,
                  // WCAG 1.4.1), so expanded chips also get the glyph + note.
                  const covered = marksCoverage && covers(source.slug);
                  return (
                    <span
                      key={source.slug}
                      title={`${source.name} — ${biasLabel}${
                        isVoting ? "" : ` · ${kindLabel} · yanlılık dağılımına sayılmaz`
                      }`}
                      className={mediaDnaChipClass(meta, { isVoting, isHighlighted })}
                    >
                      <span
                        className={`h-1 w-1 rounded-full ${meta.dot}`}
                        aria-hidden="true"
                      />
                      {covered && (
                        <span aria-hidden="true" className={meta.chipText}>
                          ✓
                        </span>
                      )}
                      {source.name}
                      <span className="sr-only">
                        {" — " +
                          biasLabel +
                          (isVoting ? "" : " · " + kindLabel + " · yanlılık dağılımına sayılmaz") +
                          (marksCoverage ? (covered ? " — bu haberde var" : " — bu haberde yok") : "")}
                      </span>
                      {!isVoting && (
                        <span className="ml-0.5 text-[10px] uppercase tracking-wider">
                          {kindLabel}
                        </span>
                      )}
                    </span>
                  );
                })}
                {visibleMembers.length === 0 && (
                  <span className={MEDIA_DNA_EMPTY_CLASS}>
                    Hiç kaynak yok
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {marksCoverage && (
        <p className="text-[10px] text-muted-foreground">
          Onay işaretli (✓) kaynaklar bu haberi yazdı; işaretsiz olanlar yazmadı.
        </p>
      )}

      {showsNonVotingChip && (
        <p className="text-[10px] text-muted-foreground">
          Kesikli çerçeveyle gösterilen toplayıcı / niş kaynaklar kümelerde
          listelenir ama yanlılık dağılımına sayılmaz.
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
            aria-expanded={showAll}
            className="inline-flex min-h-6 items-center max-sm:min-h-11 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
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
