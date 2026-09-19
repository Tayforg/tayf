// Shared `tr-TR` numeric date formatting — extracted from
// src/components/source/label-card.tsx (pack G3) so other surfaces
// (e.g. src/components/story/source-badge.tsx) reuse the exact same
// rendering instead of re-deriving it.

/**
 * `tr-TR` numeric date, e.g. "11.09.2025". Pinned to Europe/Istanbul so
 * server and client renders agree. Returns "" for an unparseable input —
 * callers gate on that empty string rather than rendering a dangling
 * "Invalid Date" or an undated claim.
 */
export function formatDdMmYyyy(dateISO: string): string {
  const date = new Date(dateISO);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Istanbul",
  }).format(date);
}
