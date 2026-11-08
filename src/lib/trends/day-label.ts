// Turkish day label for a YYYY-MM-DD Istanbul day key, shared by the /trends
// chart table (chart-table.ts, h17-a11y-1) and the "Yükselen Konular" card
// (h63-timezones-1). Pure on purpose: no Date and no Intl, so the labels are
// identical on the server, in every browser and in tests, whatever the ICU
// build. A label built from the key itself never goes stale inside a cache
// entry served past Istanbul midnight, which a "Bugün"/"Dün" word does.

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

/**
 * "2026-10-04" -> "4 Ekim": day of month without a leading zero, full Turkish
 * month name. A key that is not a valid YYYY-MM-DD stays as is.
 */
export function dayLabelTr(day: string): string {
  const m = DAY_KEY.exec(day);
  if (!m) return day;
  const month = MONTHS_TR[Number(m[2]) - 1];
  const dayOfMonth = Number(m[3]);
  if (month === undefined || dayOfMonth < 1 || dayOfMonth > 31) return day;
  return `${dayOfMonth} ${month}`;
}
