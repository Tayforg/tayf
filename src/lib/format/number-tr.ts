// Shared tr-TR count / percent formatting for reader-facing copy.
//
// Turkish groups thousands with a dot ("1.689") and writes percentages with a
// PREFIX ("%88"), not "88%". Two traps this module closes:
//   - CLDR's tr locale has minimumGroupingDigits = 2 in some ICU builds, so a
//     bare `toLocaleString("tr-TR")` prints "1689" for four-digit numbers but
//     "10.000" for five — hence `useGrouping: "always"`.
//   - Server (Vercel, UTC, one ICU) and client (visitor browser, another ICU)
//     must agree to avoid hydration mismatches; pinning `useGrouping` removes
//     the version-dependent branch.
// Finance/trends/reliability keep their own formatters (decimals, signs); this
// is only for whole-number counts and whole-number percentages.

const COUNT_FORMAT = new Intl.NumberFormat("tr-TR", {
  maximumFractionDigits: 0,
  useGrouping: "always",
});

/** Whole-number count with dot grouping: 1689 -> "1.689". Non-finite -> "0". */
export function formatCountTr(n: number): string {
  return COUNT_FORMAT.format(Number.isFinite(n) ? n : 0);
}

/** Whole-number percent in Turkish prefix form: 88 -> "%88". Non-finite -> "%0". */
export function formatPctTr(n: number): string {
  return `%${formatCountTr(n)}`;
}
