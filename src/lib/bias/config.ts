import type { BiasCategory, MediaDnaZone, SourceKind } from "@/types";
import { BIAS_TO_ZONE as CONTRACT_BIAS_TO_ZONE } from "../../../supabase/functions/_shared/cluster/blindspot";
import {
  SOURCE_KINDS as CONTRACT_SOURCE_KINDS,
  VOTING_SOURCE_KINDS as CONTRACT_VOTING_SOURCE_KINDS,
} from "../../../supabase/functions/_shared/cluster/source-kind";

// Single source of truth for all bias label / color / spectrum-order data
// AND the bias → Medya DNA zone mapping. Both used to live in separate
// files (config.ts + zones.ts) but they share the same `BiasCategory` key
// space and were always edited together, so they're consolidated here.
//
// If you need to tweak a label or a Tailwind class, do it here — `BiasBadge`,
// `BiasSpectrum`, and `MediaDna` all read from the same tables below.

/** Turkish, full-length label per bias. Used by `BiasBadge`, chip titles, tooltips. */
export const BIAS_LABELS: Record<BiasCategory, string> = {
  pro_government: "Hükümete Yakın",
  gov_leaning: "Hükümete Meyilli",
  state_media: "Devlet Medyası",
  islamist_conservative: "İslamcı/Muhafazakâr",
  center: "Merkez",
  international: "Uluslararası",
  pro_kurdish: "Kürt Yanlısı",
  opposition_leaning: "Muhalefete Meyilli",
  opposition: "Muhalefet",
  nationalist: "Milliyetçi",
};

/**
 * Shorter labels used inside the bias-spectrum legend where horizontal real
 * estate is tight. Falls back to the full label for most entries; only
 * `islamist_conservative` currently needs shortening.
 */
export const BIAS_SHORT_LABELS: Record<BiasCategory, string> = {
  pro_government: "Hükümete Yakın",
  gov_leaning: "Hükümete Meyilli",
  state_media: "Devlet Medyası",
  islamist_conservative: "İslamcı/Muh.",
  center: "Merkez",
  international: "Uluslararası",
  pro_kurdish: "Kürt Yanlısı",
  opposition_leaning: "Muhalefete Meyilli",
  opposition: "Muhalefet",
  nationalist: "Milliyetçi",
};

export interface BiasColor {
  /** Solid Tailwind bg class used for spectrum bar segments, e.g. `bg-red-500`. */
  solid: string;
  /** Slightly lighter Tailwind bg class used for legend dots, e.g. `bg-red-400`. */
  dot: string;
  /** Chip background (style-guide 5.2). */
  chipBg: string;
  /** Chip text color (style-guide 5.2). */
  chipText: string;
  /** Chip border color (style-guide 5.2). */
  chipBorder: string;
  /** Pre-combined `${chipBg} ${chipText} ${chipBorder}` for backward-compat consumers. */
  className: string;
}

const buildColor = (
  solid: string,
  dot: string,
  chipBg: string,
  chipText: string,
  chipBorder: string,
): BiasColor => ({
  solid,
  dot,
  chipBg,
  chipText,
  chipBorder,
  className: `${chipBg} ${chipText} ${chipBorder}`,
});

export const BIAS_COLORS: Record<BiasCategory, BiasColor> = {
  pro_government: buildColor(
    "bg-red-500",
    "bg-red-400",
    "bg-red-500/15",
    "text-red-700 dark:text-red-400",
    "border-red-500/20",
  ),
  gov_leaning: buildColor(
    "bg-orange-500",
    "bg-orange-400",
    "bg-orange-500/15",
    "text-orange-700 dark:text-orange-400",
    "border-orange-500/20",
  ),
  state_media: buildColor(
    "bg-rose-500",
    "bg-rose-400",
    "bg-rose-500/15",
    "text-rose-700 dark:text-rose-400",
    "border-rose-500/20",
  ),
  islamist_conservative: buildColor(
    "bg-purple-500",
    "bg-purple-400",
    "bg-purple-500/15",
    "text-purple-700 dark:text-purple-400",
    "border-purple-500/20",
  ),
  center: buildColor(
    "bg-zinc-500",
    "bg-zinc-400",
    "bg-zinc-500/15",
    "text-zinc-700 dark:text-zinc-400",
    "border-zinc-500/20",
  ),
  international: buildColor(
    "bg-slate-500",
    "bg-slate-400",
    "bg-slate-500/15",
    "text-slate-700 dark:text-slate-400",
    "border-slate-500/20",
  ),
  pro_kurdish: buildColor(
    "bg-teal-500",
    "bg-teal-400",
    "bg-teal-500/15",
    "text-teal-700 dark:text-teal-400",
    "border-teal-500/20",
  ),
  opposition_leaning: buildColor(
    "bg-sky-500",
    "bg-sky-400",
    "bg-sky-500/15",
    "text-sky-700 dark:text-sky-400",
    "border-sky-500/20",
  ),
  opposition: buildColor(
    "bg-emerald-500",
    "bg-emerald-400",
    "bg-emerald-500/15",
    "text-emerald-700 dark:text-emerald-400",
    "border-emerald-500/20",
  ),
  nationalist: buildColor(
    "bg-amber-500",
    "bg-amber-400",
    "bg-amber-500/15",
    "text-amber-700 dark:text-amber-400",
    "border-amber-500/20",
  ),
};

/**
 * Left-to-right order of bias categories as rendered by `BiasSpectrum`.
 * Grouped by Medya DNA zone: İktidar (reds/oranges) → Bağımsız (zincs/slate/teal) →
 * Muhalefet (sky/emerald/amber).
 */
export const BIAS_ORDER: BiasCategory[] = [
  "pro_government",
  "state_media",
  "gov_leaning",
  "islamist_conservative",
  "center",
  "international",
  "pro_kurdish",
  "opposition_leaning",
  "opposition",
  "nationalist",
];

// ===========================================================================
// Medya DNA zone mapping + editorial rules — re-exported from the shared
// contract so Next, the Deno consumer and (via the parity test) SQL agree.
// ===========================================================================

/**
 * Maps each of the 10 bias categories onto one of the three Medya DNA zones.
 *
 * - iktidar   → pro-government / state-aligned voices (incl. nationalist MHP as Cumhur İttifakı ally)
 * - bagimsiz  → center, international, pro-Kurdish (treated as independent)
 * - muhalefet → opposition voices
 *
 * Defined in supabase/functions/_shared/cluster/blindspot.ts; `satisfies`
 * keeps the app-side `BiasCategory` / `MediaDnaZone` unions in lockstep
 * with the contract's key sets.
 */
export const BIAS_TO_ZONE = CONTRACT_BIAS_TO_ZONE satisfies Record<
  BiasCategory,
  MediaDnaZone
>;

export { BLINDSPOT, SURPRISE, tallyZones } from "../../../supabase/functions/_shared/cluster/blindspot";

// ===========================================================================
// Source-kind contract re-exports
// ===========================================================================
//
// Which kinds of source VOTE in bias_distribution, blindspot/surprise
// detection and the trends view. Defined in
// supabase/functions/_shared/cluster/source-kind.ts; `satisfies` keeps the
// app-side `SourceKind` union in lockstep with the contract's SOURCE_KINDS
// tuple. src/lib/sources/kind.ts builds the UI-facing helpers on top of
// these re-exports.
export const SOURCE_KINDS = CONTRACT_SOURCE_KINDS satisfies readonly SourceKind[];
export const VOTING_SOURCE_KINDS = CONTRACT_VOTING_SOURCE_KINDS satisfies readonly SourceKind[];
export {
  DEFAULT_SOURCE_KIND,
  isVotingKind,
  normalizeSourceKind,
} from "../../../supabase/functions/_shared/cluster/source-kind";

/**
 * Per-zone presentation tokens.
 *
 * Tailwind class strings are kept as literals so the compiler's JIT picks
 * them up at build time. Do NOT interpolate these — build a new token set
 * instead if a variant is needed.
 */
export const ZONE_META: Record<
  MediaDnaZone,
  {
    label: string;
    description: string; // short Turkish gloss for row headers
    dot: string; // bg-* class for the per-chip dot
    chipBg: string;
    chipHover: string; // hover:bg-* class matching the zone tone
    chipText: string;
    chipBorder: string;
    zoneBg: string; // lighter tint for the zone card background
    zoneBorder: string;
    zoneLabel: string;
  }
> = {
  iktidar: {
    label: "İktidar",
    description: "iktidara yakın kaynaklar",
    dot: "bg-red-500",
    chipBg: "bg-red-500/15",
    chipHover: "hover:bg-red-500/25",
    chipText: "text-red-700 dark:text-red-400",
    chipBorder: "border-red-500/20",
    zoneBg: "bg-red-500/10",
    zoneBorder: "border-red-500/30",
    zoneLabel: "text-red-700 dark:text-red-400",
  },
  bagimsiz: {
    label: "Bağımsız",
    description: "merkez ve bağımsız kaynaklar",
    dot: "bg-zinc-400",
    chipBg: "bg-zinc-500/15",
    chipHover: "hover:bg-zinc-500/25",
    chipText: "text-zinc-700 dark:text-zinc-300",
    chipBorder: "border-zinc-500/20",
    zoneBg: "bg-zinc-500/10",
    zoneBorder: "border-zinc-500/30",
    zoneLabel: "text-zinc-700 dark:text-zinc-300",
  },
  muhalefet: {
    label: "Muhalefet",
    description: "muhalefete yakın kaynaklar",
    dot: "bg-emerald-500",
    chipBg: "bg-emerald-500/15",
    chipHover: "hover:bg-emerald-500/25",
    chipText: "text-emerald-700 dark:text-emerald-400",
    chipBorder: "border-emerald-500/20",
    zoneBg: "bg-emerald-500/10",
    zoneBorder: "border-emerald-500/30",
    zoneLabel: "text-emerald-700 dark:text-emerald-400",
  },
};

/** Convenience lookup: bias → zone. */
export function zoneOf(bias: BiasCategory): MediaDnaZone {
  return BIAS_TO_ZONE[bias];
}
