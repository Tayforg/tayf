// h46-mobile-3: the x-axis labels of the /trends chart. The old labels were
// `day.slice(8, 10)` only, so a window that crossed a month boundary read
// "28 02 06" with no month anywhere. This picks which days get a label and
// writes the text: day-only ("07"), except the first label and the first label
// after a month change, which carry the Turkish month abbreviation ("28 Eki",
// "02 Kas"). Pure on purpose: no Date and no Intl, so the text is identical on
// the server, in every browser and in tests, whatever the ICU build.

export type XAxisLabel = {
  /** Index of the day in the input array (= the bar's column). */
  idx: number;
  /** "28 Eki" on the first label and after a month change, else "07". */
  text: string;
};

/** Every 5th day is labelled (plus the last), as the svg labels always were. */
export const X_LABEL_STEP = 5;

// Same abbreviations Intl's tr-TR short month gives (Oca, Şub, ... Ara).
const MONTHS_ABBR_TR = [
  "Oca",
  "Şub",
  "Mar",
  "Nis",
  "May",
  "Haz",
  "Tem",
  "Ağu",
  "Eyl",
  "Eki",
  "Kas",
  "Ara",
] as const;

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Labels for the days of the chart, oldest first. `days` are YYYY-MM-DD keys
 * (DayBucket.day). A label is made for every `step`-th index and always for the
 * last one (never twice). A month change is judged against the PREVIOUS LABEL,
 * not the previous day: when the 1st falls on a skipped day, the next label
 * ("02 Kas") still tells the reader the month turned.
 *
 * A key that is not a valid YYYY-MM-DD keeps the old behaviour (its characters
 * 8-10) with no month, and leaves the month state alone.
 */
export function xAxisLabels(
  days: readonly string[],
  step: number = X_LABEL_STEP,
): XAxisLabel[] {
  const every = Number.isFinite(step) && step >= 1 ? Math.floor(step) : 1;
  const labels: XAxisLabel[] = [];
  let previousMonth: string | null = null; // "YYYY-MM" of the previous label

  for (let idx = 0; idx < days.length; idx++) {
    if (idx % every !== 0 && idx !== days.length - 1) continue;
    const day = days[idx]!;
    const m = DAY_KEY.exec(day);
    const abbreviation = m ? MONTHS_ABBR_TR[Number(m[2]) - 1] : undefined;
    if (!m || abbreviation === undefined) {
      labels.push({ idx, text: day.slice(8, 10) });
      continue;
    }
    const month = `${m[1]}-${m[2]}`;
    labels.push({
      idx,
      text: month === previousMonth ? m[3]! : `${m[3]} ${abbreviation}`,
    });
    previousMonth = month;
  }
  return labels;
}
