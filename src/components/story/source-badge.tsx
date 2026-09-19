import { formatDdMmYyyy } from "@/lib/format/date-tr";

// Small "Kayyum · dd.mm.yyyy" badge for outlets under a court-appointed
// trustee (kayyum) — pack G3 trustee plumbing. Placed next to a source's
// name in a source list (see src/app/cluster/[id]/page.tsx's "Kaynak
// künyesi" list). Reuses the same dd.mm.yyyy formatting as the "Etiket
// kartı" trustee badge on /source/[slug] (src/components/source/
// label-card.tsx) via the shared `formatDdMmYyyy` helper.

export interface SourceBadgeProps {
  trusteeSince: string | null;
}

/**
 * Renders nothing when `trusteeSince` is null or unparseable — an
 * undated kayyum claim is a new error, not a fact (same gate LabelCard's
 * own trustee badge applies).
 */
export function SourceBadge({ trusteeSince }: SourceBadgeProps) {
  const trusteeDate = trusteeSince ? formatDdMmYyyy(trusteeSince) : "";
  if (trusteeDate === "") return null;

  return (
    <span
      className="inline-flex items-center rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0 text-[10px] font-medium text-amber-700 dark:text-amber-400"
      title="Kayyum yönetiminde"
    >
      {`Kayyum · ${trusteeDate}`}
    </span>
  );
}
