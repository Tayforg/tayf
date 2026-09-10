// Relative time formatting in Turkish. Keep this a pure, dependency-free
// helper so both server components and client components can share it.
//
// Output shape (grammatically natural Turkish):
//   "az önce"                 — under 1 minute
//   "1 dakika önce"           — exactly 1 minute
//   "N dakika önce"           — 2..59 minutes
//   "1 saat önce" / "N saat önce"
//   "1 gün önce"  / "N gün önce"
//   "1 hafta önce" / "N hafta önce"  (up to 4 weeks)
//   "1 ay önce"   / "N ay önce"      (up to 12 months)
//   "1 yıl önce"  / "N yıl önce"
//
// We deliberately avoid Intl.RelativeTimeFormat here because its Turkish
// output ("1 dakika önce" vs "1 dk. önce") is inconsistent across runtimes.
//
// Past `ABSOLUTE_AFTER_MS` (48h by default) `formatTurkishTimeAgo` stops
// returning a relative string altogether and instead delegates to
// `formatTurkishDate` — an old cluster or article should read as a dated
// event, not a stale "3 gün önce" that keeps climbing forever. Because of
// that default threshold the "N hafta/ay/yıl önce" branches below are
// unreachable in normal use; they are kept (rather than deleted) because a
// caller can pass a larger `opts.absoluteAfterMs` and re-enable them — see
// the `formatTurkishTimeAgo` signature.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/** Delta past which `formatTurkishTimeAgo` renders an absolute date instead of a relative one. */
export const ABSOLUTE_AFTER_MS = 48 * HOUR_MS;

/**
 * Absolute Turkish date, e.g. "2 Eylül 2026".
 *
 * The `timeZone` is pinned to `Europe/Istanbul` on purpose: this helper runs
 * in both server components (which render in UTC on Vercel) and client
 * components (which render in the visitor's local zone). An unpinned
 * `Intl.DateTimeFormat` would therefore disagree with itself between server
 * and client render for any timestamp near local midnight, producing a
 * hydration mismatch. Pinning to the newsroom's own timezone keeps the
 * output identical everywhere it runs.
 *
 * Returns `""` for an unparseable input, same guard as `formatTurkishTimeAgo`.
 */
export function formatTurkishDate(dateISO: string): string {
  const then = new Date(dateISO).getTime();
  if (Number.isNaN(then)) return "";

  return new Intl.DateTimeFormat("tr-TR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Istanbul",
  }).format(then);
}

export function formatTurkishTimeAgo(
  dateISO: string,
  opts?: { absoluteAfterMs?: number; now?: number },
): string {
  const then = new Date(dateISO).getTime();
  if (Number.isNaN(then)) return "";

  const now = opts?.now ?? Date.now();
  const absoluteAfterMs = opts?.absoluteAfterMs ?? ABSOLUTE_AFTER_MS;
  const deltaMs = Math.max(0, now - then);

  if (deltaMs >= absoluteAfterMs) return formatTurkishDate(dateISO);

  if (deltaMs < MINUTE_MS) return "az önce";

  if (deltaMs < HOUR_MS) {
    const mins = Math.floor(deltaMs / MINUTE_MS);
    return `${mins} dakika önce`;
  }

  if (deltaMs < DAY_MS) {
    const hours = Math.floor(deltaMs / HOUR_MS);
    return `${hours} saat önce`;
  }

  if (deltaMs < WEEK_MS) {
    const days = Math.floor(deltaMs / DAY_MS);
    return `${days} gün önce`;
  }

  if (deltaMs < MONTH_MS) {
    const weeks = Math.floor(deltaMs / WEEK_MS);
    return `${weeks} hafta önce`;
  }

  if (deltaMs < YEAR_MS) {
    const months = Math.floor(deltaMs / MONTH_MS);
    return `${months} ay önce`;
  }

  const years = Math.floor(deltaMs / YEAR_MS);
  return `${years} yıl önce`;
}

/** Request-time clock for Server Components (react-hooks/purity forbids Date.now() in render). */
export function currentTimeMs(): number {
  return Date.now();
}
