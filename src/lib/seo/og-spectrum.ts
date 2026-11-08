import type { MediaDnaZone } from "@/types";

// What the cluster OG card draws in the spectrum slot (h64-ogcards-3).
//
// A cluster whose every source is a toplayıcı / niş source has an all-zero
// bias_distribution: nothing voted. The card used to draw an empty bar and three
// "%0 · 0" tiles for it, while the cluster page, the embed, the rozet and the
// share text all say "sınıflandırılmış kaynak yok". This module decides, from
// the zone counts alone, whether the card shows the tiles or one line saying so.
// Pure: no I/O, no Satori, so the decision is testable on its own.

/**
 * The line when nothing voted and at least one toplayıcı / niş source wrote the
 * story. The same sentence the cluster page prints under its spectrum
 * (`spectrumCaption` in `src/app/cluster/[id]/page.tsx`); keep the two in step.
 */
export const EMPTY_SPECTRUM_NON_VOTING =
  "Bu kümede sınıflandırılan kaynak yok — yalnızca toplayıcı / niş kaynaklar yazdı";

/**
 * The line when nothing voted and no non-voting source is known to have written
 * either (a freshly clustered row, or a detail that carries no members): it
 * claims nothing about who wrote.
 */
export const EMPTY_SPECTRUM_UNCLASSIFIED = "Bu kümede henüz sınıflandırılan kaynak yok";

export type OgSpectrumState =
  | { kind: "tiles" }
  | { kind: "empty"; line: string };

/**
 * `tiles` when any zone holds a voting source (the stacked bar and the three zone
 * tiles, exactly as before). Otherwise `empty` with the one line to print.
 *
 * `nonVotingSourceCount` is the number of distinct toplayıcı / niş sources that
 * wrote the story, and only counts when no voting source is among the members:
 * the caller passes 0 otherwise, so "yalnızca toplayıcı / niş kaynaklar yazdı"
 * is never printed over a story a voting source also carried. A count that is
 * not above 0 (0, negative, NaN) reads as "none".
 */
export function ogSpectrumState(
  zones: Record<MediaDnaZone, number>,
  nonVotingSourceCount: number,
): OgSpectrumState {
  const total = zones.iktidar + zones.bagimsiz + zones.muhalefet;
  if (total > 0) return { kind: "tiles" };
  return {
    kind: "empty",
    line: nonVotingSourceCount > 0 ? EMPTY_SPECTRUM_NON_VOTING : EMPTY_SPECTRUM_UNCLASSIFIED,
  };
}
