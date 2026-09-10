/**
 * Correction status vocabulary — the 042 rebase of 033's original
 * `new` / `reviewed` / `resolved` set.
 *
 * `open` replaces `new`, `dismissed` replaces `resolved`; `reviewed` is
 * unchanged. See supabase/migrations/042_corrections_status.sql for the
 * DB-side constraint and the one-time remap of existing rows.
 */
export const CORRECTION_STATUSES = ["open", "reviewed", "dismissed"] as const;

export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

export function isCorrectionStatus(value: unknown): value is CorrectionStatus {
  return (
    typeof value === "string" &&
    (CORRECTION_STATUSES as readonly string[]).includes(value)
  );
}

export const CORRECTION_STATUS_LABELS_TR: Record<CorrectionStatus, string> = {
  open: "Açık",
  reviewed: "İncelendi",
  dismissed: "Reddedildi",
};

/**
 * Turkish label for a known status; the raw value for anything else so a
 * legacy `new` / `resolved` row from an un-migrated DB still renders
 * instead of throwing or showing "undefined".
 */
export function correctionStatusLabel(value: string): string {
  return isCorrectionStatus(value) ? CORRECTION_STATUS_LABELS_TR[value] : value;
}
