import { istanbulDayKey } from "@/lib/trends/daily-zones";

// Section headings of the home feed: 'Bugün' / 'Dün' / 'Son 7 gün' / 'Daha
// eski', by the Europe/Istanbul calendar day a story broke.
//
// Why calendar days and not "less than 24 h ago": the old buckets were
// `now - t < 24 h` (labelled 'Bugün') and `now - t < 7 d` (labelled 'Bu
// hafta'). At 00:25 on 02.11 that put every story of 01.11 under 'Bugün' (12
// of 14 cards on prod, 2026-11-01 21:24Z) and called a rolling window 'Bu
// hafta' (h15-tz-1). A reader in Türkiye expects 'Bugün' to flip at local
// midnight, and a rolling window to say 'Son 7 gün'.
//
// Pure: no clock read, no I/O. The caller passes `nowMs` (the page takes it
// from currentTimeMs() at request time, outside any "use cache" scope).
//
// 'Dün' is `istanbulDayKey(t) === istanbulDayKey(now - 24 h)`. That is exact
// because Türkiye has had no daylight-saving time since 2016 (fixed UTC+3), so
// a calendar day is always 24 h long.

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export type DayBucketKey = "today" | "yesterday" | "last7Days" | "older";

export interface DayBucketDef {
  readonly key: DayBucketKey;
  readonly label: string;
}

/** Display order. `older` is the catch-all, so every story lands somewhere. */
export const DAY_BUCKETS: readonly DayBucketDef[] = Object.freeze([
  Object.freeze({ key: "today", label: "Bugün" }),
  Object.freeze({ key: "yesterday", label: "Dün" }),
  Object.freeze({ key: "last7Days", label: "Son 7 gün" }),
  Object.freeze({ key: "older", label: "Daha eski" }),
]) as readonly DayBucketDef[];

export interface DayBucketGroup<T> {
  key: DayBucketKey;
  label: string;
  count: number;
  items: T[];
}

/**
 * The bucket a story belongs to.
 *
 *  - `today`      same Istanbul calendar day as `nowMs`, or in the future
 *                 (clock skew between the writer and this server);
 *  - `yesterday`  the previous Istanbul calendar day;
 *  - `last7Days`  anything else strictly less than 7 days old;
 *  - `older`      7 days or more, an unparseable timestamp (NaN) or a
 *                 non-finite `nowMs`.
 */
export function dayBucketOf(firstPublishedMs: number, nowMs: number): DayBucketKey {
  if (!Number.isFinite(firstPublishedMs) || !Number.isFinite(nowMs)) {
    return "older";
  }
  if (firstPublishedMs > nowMs) return "today";
  // Nothing 7 days or more old can be today or yesterday, so skip the
  // formatter (and stay clear of out-of-range dates) for the common old story.
  if (nowMs - firstPublishedMs >= WEEK_MS) return "older";

  const storyDay = istanbulDayKey(firstPublishedMs);
  if (storyDay === istanbulDayKey(nowMs)) return "today";
  if (storyDay === istanbulDayKey(nowMs - DAY_MS)) return "yesterday";
  return "last7Days";
}

/**
 * Split `items` into the non-empty buckets, in display order. Each item keeps
 * its input order inside its bucket. `msOf` returns the story's
 * first-published instant in epoch milliseconds (NaN files it under 'Daha
 * eski').
 */
export function groupByDayBucket<T>(
  items: readonly T[],
  msOf: (item: T) => number,
  nowMs: number,
): DayBucketGroup<T>[] {
  const grouped = new Map<DayBucketKey, T[]>(
    DAY_BUCKETS.map((def) => [def.key, []]),
  );
  for (const item of items) {
    grouped.get(dayBucketOf(msOf(item), nowMs))!.push(item);
  }
  return DAY_BUCKETS.flatMap((def) => {
    const bucketItems = grouped.get(def.key)!;
    return bucketItems.length === 0
      ? []
      : [
          {
            key: def.key,
            label: def.label,
            count: bucketItems.length,
            items: bucketItems,
          },
        ];
  });
}
