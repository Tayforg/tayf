import { getSourceMetadata, type Factuality } from "@/lib/sources/factuality";
import {
  isClassifiedSource,
  UNCLASSIFIED_LABEL_TR,
  UNCLASSIFIED_TITLE_TR,
} from "@/lib/sources/classification";
import { cn } from "@/lib/utils";

/**
 * `<SourceChips>` — Server Component that surfaces hand-tagged factuality
 * and ownership signals next to a source name.
 *
 * Background: Tayf currently shows zero factuality / ownership context on
 * a story card, while Ground News surfaces both as small chips. This is
 * the missing primitive — once it's wired into `cluster-card.tsx` and
 * `cluster-stance.tsx` (follow-up task), every source mention will carry
 * the same lineage info.
 *
 * Behavior:
 *   - Looks up the slug in `SOURCE_METADATA`.
 *   - If unknown → renders nothing (no skeleton, no placeholder). This
 *     keeps partial coverage safe; we can ship the data file
 *     incrementally without churning every consuming layout.
 *   - If known → renders up to two small chips: factuality + ownership.
 *     Either field may be `null` independently.
 *
 * Design notes:
 *   - Server-only. No state, no hooks. Tailwind classes are kept as
 *     literals (no dynamic interpolation) so the JIT picks them up.
 *   - Visual scale matches the existing `SourceChip` primitive in
 *     `src/components/story/source-chip.tsx` (text-[10px], rounded-full,
 *     border + tinted background) so the two can sit next to each other
 *     without a size jump.
 *   - Color palette intentionally subdued — these are *metadata* chips,
 *     not bias signals, and we don't want them to compete visually with
 *     the bias chip already on the card.
 */

const FACTUALITY_LABELS: Record<Factuality, string> = {
  high: "Yüksek doğruluk",
  mixed: "Karışık doğruluk",
  low: "Düşük doğruluk",
};

const FACTUALITY_CLASSES: Record<Factuality, string> = {
  high: "bg-emerald-500/10 text-emerald-700 border-emerald-500/20 dark:text-emerald-400",
  mixed: "bg-amber-500/10 text-amber-700 border-amber-500/20 dark:text-amber-400",
  low: "bg-red-500/10 text-red-700 border-red-500/20 dark:text-red-400",
};

const FACTUALITY_DOT: Record<Factuality, string> = {
  high: "bg-emerald-500",
  mixed: "bg-amber-500",
  low: "bg-red-500",
};

const CHIP_BASE =
  "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none whitespace-nowrap max-w-full min-w-0";

// `truncate` alone isn't enough inside a flex container: a flex item's
// default `min-width: auto` floors it at its content's natural (nowrap)
// width, so `overflow-hidden`/`text-ellipsis` never has anything to clip.
// `min-w-0` removes that floor so the label can actually shrink and ellide.
const CHIP_LABEL_CLASS = "truncate min-w-0";

const OWNERSHIP_CLASS =
  "bg-zinc-500/10 text-zinc-700 border-zinc-500/20 dark:text-zinc-300";

const UNCLASSIFIED_CLASS =
  "bg-muted/40 text-muted-foreground border-border/60";

// "Bağımsız" is also the name of the middle Medya DNA zone; as a bare chip
// next to a bias badge it reads as a political position. Spell out that
// this one is about ownership. Every other owner name is unambiguous.
export function ownershipLabel(ownership: string): string {
  return ownership.replace(/^Bağımsız/, "Bağımsız sahiplik");
}

export interface SourceChipsProps {
  /** Source slug (matches `slug` column in the `sources` table). */
  slug: string;
  /** Optional extra classes appended to the wrapping flex row. */
  className?: string;
  /**
   * Opt-in: when the slug has no tagged factuality/ownership, render a
   * single muted "sınıflandırılmamış" chip instead of nothing. Defaults to
   * `false` so existing consumers (e.g. the cluster detail page, which
   * pre-filters to slugs it already knows are tagged) keep rendering
   * byte-identically.
   */
  showUnclassified?: boolean;
}

export function SourceChips({
  slug,
  className,
  showUnclassified = false,
}: SourceChipsProps) {
  const meta = getSourceMetadata(slug);
  const classified = isClassifiedSource(slug);

  if (!classified) {
    if (!showUnclassified) return null;
    return (
      <span
        className={cn(
          "inline-flex flex-wrap items-center gap-1 min-w-0 max-w-full",
          className,
        )}
        role="group" aria-label="Kaynak bilgisi"
      >
        <span
          className={cn(CHIP_BASE, UNCLASSIFIED_CLASS)}
          title={UNCLASSIFIED_TITLE_TR}
        >
          <span className={CHIP_LABEL_CLASS}>{UNCLASSIFIED_LABEL_TR}</span>
        </span>
      </span>
    );
  }

  if (!meta) return null;

  return (
    <span
      className={cn(
        "inline-flex flex-wrap items-center gap-1 min-w-0 max-w-full",
        className,
      )}
      role="group" aria-label="Kaynak bilgisi"
    >
      {meta.factuality !== null && (
        <span
          className={cn(CHIP_BASE, FACTUALITY_CLASSES[meta.factuality])}
          title={FACTUALITY_LABELS[meta.factuality]}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              FACTUALITY_DOT[meta.factuality],
            )}
            aria-hidden="true"
          />
          <span className={CHIP_LABEL_CLASS}>
            {FACTUALITY_LABELS[meta.factuality]}
          </span>
        </span>
      )}
      {meta.ownership !== null && (
        <span
          className={cn(CHIP_BASE, OWNERSHIP_CLASS)}
          title={`Sahiplik: ${meta.ownership}`}
        >
          <span className={CHIP_LABEL_CLASS}>{ownershipLabel(meta.ownership)}</span>
        </span>
      )}
    </span>
  );
}
