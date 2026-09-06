export const LAST_VISIT_KEY = "tayf:last-visit";

/** Count ISO timestamps strictly newer than `stamp`; 0 when there is no usable stamp. */
export function countNewSince(timestamps: readonly string[], stamp: string | null): number {
  if (!stamp) return 0;
  const since = Date.parse(stamp);
  if (Number.isNaN(since)) return 0;
  let n = 0;
  for (const t of timestamps) {
    const ms = Date.parse(t);
    if (!Number.isNaN(ms) && ms > since) n += 1;
  }
  return n;
}

export function readLastVisit(): string | null {
  try {
    return window.localStorage.getItem(LAST_VISIT_KEY);
  } catch {
    return null;
  }
}

export function writeLastVisit(iso: string): void {
  try {
    window.localStorage.setItem(LAST_VISIT_KEY, iso);
  } catch {
    // storage unavailable (private mode, quota) — pill simply won't show next time
  }
}
