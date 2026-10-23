// "Okuma diyetin": the zone mix of the stories saved on THIS device, computed
// from the rows /saved already fetched. Pure and client-safe: no network, no
// storage, no analytics -- saved-mix-privacy.test.ts keeps it that way.
//
// Basis: each story's stored `bias_distribution` (voting sources only, the same
// basis the card's bar and the Denge puani use), collapsed onto the 3 zones by
// `safeZoneCounts`. The mix SUMS source votes over the saved stories; it is not
// a per-story average, so a story covered by many outlets weighs more.
import { balanceFromZoneCounts, type BalanceTier } from "@/lib/bias/balance";
import { roundPercents } from "@/lib/bias/round-percents";
import type { MediaDnaZone } from "@/types";

import { safeZoneCounts } from "./bookmark-snapshots";

/** Fewer saved stories than this and no mix is shown. */
export const SAVED_MIX_MIN_STORIES = 3;

/** Short tier labels for the card (the cluster chip uses the longer ones). */
export const SAVED_MIX_LABELS: Record<BalanceTier, string> = {
  dengeli: "Dengeli",
  yakin: "Tek tarafa yakın",
  tek: "Tek tarafta",
};

export interface SavedMixRow {
  bias_distribution: unknown;
}

export type SavedMix =
  | { status: "too-few"; stories: number }
  | { status: "no-votes"; stories: number }
  | {
      status: "ok";
      stories: number;
      /** Classified (voting) sources summed over every saved story. */
      total: number;
      counts: Record<MediaDnaZone, number>;
      /** Integer percents that always add to 100. */
      percents: Record<MediaDnaZone, number>;
      /** Null below BALANCE_MIN_SOURCES classified sources. */
      balance: { score: number; label: string } | null;
    };

export function savedMix(rows: ReadonlyArray<SavedMixRow>): SavedMix {
  const stories = rows.length;
  if (stories < SAVED_MIX_MIN_STORIES) return { status: "too-few", stories };

  const counts: Record<MediaDnaZone, number> = { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
  for (const row of rows) {
    const zones = safeZoneCounts(row?.bias_distribution);
    counts.iktidar += zones.iktidar;
    counts.bagimsiz += zones.bagimsiz;
    counts.muhalefet += zones.muhalefet;
  }

  const total = counts.iktidar + counts.bagimsiz + counts.muhalefet;
  if (total <= 0) return { status: "no-votes", stories };

  const [iktidar = 0, bagimsiz = 0, muhalefet = 0] = roundPercents([
    counts.iktidar,
    counts.bagimsiz,
    counts.muhalefet,
  ]);
  const scored = balanceFromZoneCounts(counts);

  return {
    status: "ok",
    stories,
    total,
    counts,
    percents: { iktidar, bagimsiz, muhalefet },
    balance: scored ? { score: scored.score, label: SAVED_MIX_LABELS[scored.tier] } : null,
  };
}
