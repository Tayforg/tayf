import { formatCountTr } from "@/lib/format/number-tr";

/** Suffix of the accessible name of a bar of the last, still-filling day. */
const PARTIAL_BAR_SUFFIX = " (son gün, eksik)";

/**
 * Accessible name of one bar segment of the /trends chart: "2026-10-05 ·
 * İktidar: 3.830". The count is grouped the tr-TR way like the rest of the page
 * (the y-axis ticks, the aria-label total, the data table): a screen reader
 * reads the bare interpolation "3830" as a year-like number. One string, because
 * React 19 renders a <title> with several children as an empty <title></title>.
 *
 * `partial` is true for the last Istanbul day of the snapshot (its count was
 * still growing when the snapshot was built): the name then ends with
 * " (son gün, eksik)" so the last bar is not heard as a finished day. It does
 * not say "today": the flag is baked into a cache entry that can be served past
 * Istanbul midnight.
 */
export function trendBarTitle(
  day: string,
  label: string,
  count: number,
  partial = false,
): string {
  const title = `${day} · ${label}: ${formatCountTr(count)}`;
  return partial ? `${title}${PARTIAL_BAR_SUFFIX}` : title;
}
