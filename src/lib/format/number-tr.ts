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
// is for whole-number counts and whole-number percentages, plus signedPercentTr
// for a signed percent change with decimals.

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

const DEFAULT_SIGNED_PCT_DIGITS = 2;
const MAX_SIGNED_PCT_DIGITS = 4;

// One formatter per digit count (0..4): building an Intl.NumberFormat is far
// dearer than calling format(), and a ticker tape formats dozens per render.
const SIGNED_PCT_FORMATS = new Map<number, Intl.NumberFormat>();

function signedPctFormat(digits: number): Intl.NumberFormat {
  let format = SIGNED_PCT_FORMATS.get(digits);
  if (format === undefined) {
    format = new Intl.NumberFormat("tr-TR", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: "always",
    });
    SIGNED_PCT_FORMATS.set(digits, format);
  }
  return format;
}

/** An integer in 0..4; NaN falls back to 2, Infinity clamps to 4 and -Infinity to 0. */
function clampPctDigits(fractionDigits: number): number {
  if (Number.isNaN(fractionDigits)) return DEFAULT_SIGNED_PCT_DIGITS;
  return Math.min(MAX_SIGNED_PCT_DIGITS, Math.max(0, Math.trunc(fractionDigits)));
}

/** True when a formatted magnitude shows no non-zero digit ("0,00", "0"). */
function showsOnlyZeros(formatted: string): boolean {
  for (const ch of formatted) {
    if (ch >= "1" && ch <= "9") return false;
  }
  return true;
}

/**
 * Signed percent change in Turkish prefix form: sign, then "%", then the
 * number with comma decimals and dot grouping. -4.73 -> "-%4,73", 9.95 ->
 * "+%9,95", 1234.5 -> "+%1.234,50"; `fractionDigits` (default 2) is clamped to
 * an integer in 0..4.
 *
 * The sign is the ASCII hyphen-minus "-" (U+002D) and "+", NOT the true minus
 * U+2212. The site uses U+2212 only inside prose formulas (metodoloji,
 * v1-docs); every rendered number (Intl tr-TR output, the finance tests that
 * pin '-%10,00') uses "-", and a different glyph here would make the same
 * kind of value look different from its neighbours.
 *
 * A value that rounds to zero at the chosen precision gets no sign ("%0,00",
 * also for -0.001 and -0), so a flat move never reads as "+%0,00" or "-%0,00".
 * A non-finite value is written as zero.
 */
export function signedPercentTr(n: number, fractionDigits: number = DEFAULT_SIGNED_PCT_DIGITS): string {
  const magnitude = signedPctFormat(clampPctDigits(fractionDigits)).format(Number.isFinite(n) ? Math.abs(n) : 0);
  // Plain concatenation, not a template: tests/guards/tr-number-format.test.ts
  // flags "}%" in source as the English suffix form, and a template that opens
  // with the sign interpolation would trip it on the prefix percent sign.
  if (showsOnlyZeros(magnitude)) return "%" + magnitude;
  const sign = n < 0 ? "-" : "+";
  return sign + "%" + magnitude;
}
