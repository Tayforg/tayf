import type { DayBucket } from "@/lib/trends/daily-zones";

// h17-a11y-1: rows for the /trends "tablo olarak göster" data table, the
// text alternative to the stacked-bar chart (WCAG 1.1.1 / 1.3.1). Pure on
// purpose: no Date and no Intl, so the labels are identical on the server,
// in every browser and in tests, whatever the ICU build.

export type ChartTableRow = {
  /** Day key in YYYY-MM-DD form, as in DayBucket. */
  day: string;
  /** "4 Ekim": day of month without a leading zero, full Turkish month name. */
  label: string;
  iktidar: number;
  bagimsiz: number;
  muhalefet: number;
  /** iktidar + bagimsiz + muhalefet, recomputed from the counts. */
  total: number;
};

// Local copy on purpose: src/lib/weekly has its own MONTHS_TR and is edited
// by another branch; importing it would couple this helper to those files.
const MONTHS_TR = [
  "Ocak",
  "Şubat",
  "Mart",
  "Nisan",
  "Mayıs",
  "Haziran",
  "Temmuz",
  "Ağustos",
  "Eylül",
  "Ekim",
  "Kasım",
  "Aralık",
] as const;

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-10-04" -> "4 Ekim". A key that is not a valid YYYY-MM-DD stays as is. */
function dayLabelTr(day: string): string {
  const m = DAY_KEY.exec(day);
  if (!m) return day;
  const month = MONTHS_TR[Number(m[2]) - 1];
  const dayOfMonth = Number(m[3]);
  if (month === undefined || dayOfMonth < 1 || dayOfMonth > 31) return day;
  return `${dayOfMonth} ${month}`;
}

/**
 * Appended to the label of the last, still-filling day (h37-content-3). It
 * says the count is incomplete, not that the day is "today": the flag is baked
 * into a cache entry that can be served past Istanbul midnight.
 */
const PARTIAL_LABEL_SUFFIX = " (eksik)";

/**
 * One row per bucket, oldest day first (YYYY-MM-DD keys sort lexicographically
 * in chronological order). The input is not mutated. A `partial` bucket (the
 * day still counting when the snapshot was built) reads "5 Kasım (eksik)";
 * every other label is as is.
 */
export function chartTableRows(buckets: readonly DayBucket[]): ChartTableRow[] {
  return [...buckets]
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .map((bucket) => {
      const { iktidar, bagimsiz, muhalefet } = bucket.counts;
      return {
        day: bucket.day,
        label: bucket.partial
          ? `${dayLabelTr(bucket.day)}${PARTIAL_LABEL_SUFFIX}`
          : dayLabelTr(bucket.day),
        iktidar,
        bagimsiz,
        muhalefet,
        total: iktidar + bagimsiz + muhalefet,
      };
    });
}
