import { formatCountTr } from "@/lib/format/number-tr";

/**
 * Accessible name of one bar segment of the /trends chart: "2026-10-05 ·
 * İktidar: 3.830". The count is grouped the tr-TR way like the rest of the page
 * (the y-axis ticks, the aria-label total, the data table): a screen reader
 * reads the bare interpolation "3830" as a year-like number. One string, because
 * React 19 renders a <title> with several children as an empty <title></title>.
 */
export function trendBarTitle(day: string, label: string, count: number): string {
  return `${day} · ${label}: ${formatCountTr(count)}`;
}
