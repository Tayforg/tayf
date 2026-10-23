import { RISING_ENTITIES } from "./rising-entities";

// Pure ranking behind "Yükselen Konular" (migration 112). Input is the
// per-entity daily rollup (`trends_daily_entity_counts_ist_rollup`: one row
// per Istanbul day and vocabulary entity, counting ARTICLES whose title
// mentions the entity); output is the entities whose count on a day stands
// well above their own trailing-week average.
//
// An entity "rises" on day D only when ALL of these hold:
//   count    T >= MIN_COUNT                 (enough articles to mean anything)
//   lift     T - B >= MIN_LIFT              (a real absolute jump)
//   ratio    T / max(B, BASELINE_FLOOR) >= MIN_RATIO   (at least doubled; the
//            floor is for ranking only, so below it the shown multiple is a
//            lower bound: `ratioIsLowerBound`)
//   z-score  (T - B) / sqrt(max(B, 1)) >= MIN_Z        (Poisson-style noise)
// where B is the mean daily count over the PRESENT days among D-1..D-7. The
// four gates cover different failure modes: count and lift stop a 1 -> 3
// blip, the ratio stops a busy entity wobbling by a few percent, and the
// z-score stops a mid-sized baseline (around 8) from passing on a ratio of
// exactly 2.
//
// A day is "present" when the rollup has ANY row for it. The refresh function
// writes a row for every vocabulary entity (zeros included), so "day
// present" means "day was refreshed", and a missing entity row on a present
// day is a real zero. Fewer than MIN_BASELINE_DAYS_PRESENT present days means
// the history is too thin to judge: `insufficient`.
//
// No clock reads here: the caller supplies today's Istanbul day key. A
// partial (still running) day only understates T, so it can hide a spike for
// a few hours but never invent one.

export const MIN_COUNT = 12;
export const MIN_LIFT = 8;
export const MIN_RATIO = 2;
export const MIN_Z = 3;
export const BASELINE_FLOOR = 2;
export const BASELINE_DAYS = 7;
export const MIN_BASELINE_DAYS_PRESENT = 6;
export const MAX_ITEMS = 8;
/** A baseline mean below this reads as "didn't exist last week". */
export const NEW_BASELINE_MAX = 1;

export type RollupRow = { day: string; entity: string; count: number };

export type RisingItem = {
  key: string;
  label: string;
  /** Home search for the entity's label (no /ara page or entity hubs exist). */
  href: string;
  /** Articles mentioning the entity on the ranked day. */
  count: number;
  /** Mean daily articles over the present baseline days. */
  baseline: number;
  /**
   * Ranking and gating key: count / max(baseline, BASELINE_FLOOR). Not the true
   * multiple when the baseline is below BASELINE_FLOOR (it is then smaller).
   */
  ratio: number;
  /** `ratio` floored to one decimal, Turkish decimal comma ("2,4"). */
  ratioLabel: string;
  /**
   * True when the baseline sits below BASELINE_FLOOR, so `ratio` was computed
   * from the floor and the true multiple (count / baseline) is at least as big.
   * The reader-facing copy must then say "en az {ratioLabel} katı", never state
   * `ratioLabel` as the exact multiple. Ignored when `isNew`.
   */
  ratioIsLowerBound: boolean;
  /** Baseline below NEW_BASELINE_MAX: say "didn't exist", not "N times". */
  isNew: boolean;
};

export type RisingResult =
  | {
      status: "ok";
      dayLabel: "Bugün" | "Dün";
      /** The ranked Istanbul day, YYYY-MM-DD. */
      day: string;
      items: RisingItem[];
    }
  | { status: "insufficient" };

/**
 * Step a `YYYY-MM-DD` key by whole calendar days. Date.UTC arithmetic on the
 * key's own fields, as in daily-zones.ts, so keys stay exactly one calendar
 * day apart whatever the host time zone.
 */
export function shiftDayKey(key: string, delta: number): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

const ratioFormat = new Intl.NumberFormat("tr-TR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * Floor to one decimal, then format with the Turkish decimal comma: 2.46 ->
 * "2,4". Floor (never round) so "2,0 katı" is never shown for a ratio that
 * fell short of 2.0; the 1e-9 nudge keeps float undershoot (5.8 * 10 =
 * 57.99999999999999) from dropping an exact tenth.
 */
export function formatRatio(r: number): string {
  return ratioFormat.format(Math.floor(r * 10 + 1e-9) / 10);
}

const KNOWN: ReadonlyMap<string, (typeof RISING_ENTITIES)[number]> = new Map(
  RISING_ENTITIES.map((e) => [e.key, e]),
);

type ByDay = Map<string, Map<string, number>>;

function indexRows(rows: readonly RollupRow[]): ByDay {
  const byDay: ByDay = new Map();
  for (const row of rows) {
    const n = Number(row.count);
    if (!Number.isFinite(n)) continue;
    let day = byDay.get(row.day);
    if (!day) {
      day = new Map();
      byDay.set(row.day, day);
    }
    day.set(row.entity, (day.get(row.entity) ?? 0) + n);
  }
  return byDay;
}

/** Ranks `dayKey` against its own D-1..D-7 baseline. */
function rankDay(
  byDay: ByDay,
  dayKey: string,
): { sufficient: boolean; items: RisingItem[] } {
  const present: Map<string, number>[] = [];
  for (let off = 1; off <= BASELINE_DAYS; off++) {
    const d = byDay.get(shiftDayKey(dayKey, -off));
    if (d) present.push(d);
  }
  if (present.length < MIN_BASELINE_DAYS_PRESENT) {
    return { sufficient: false, items: [] };
  }

  const day = byDay.get(dayKey);
  const items: RisingItem[] = [];
  for (const [key, entity] of KNOWN) {
    const count = day?.get(key) ?? 0;
    if (count < MIN_COUNT) continue;

    let sum = 0;
    for (const d of present) sum += d.get(key) ?? 0;
    const baseline = sum / present.length;

    if (count - baseline < MIN_LIFT) continue;
    const ratio = count / Math.max(baseline, BASELINE_FLOOR);
    if (ratio < MIN_RATIO) continue;
    const z = (count - baseline) / Math.sqrt(Math.max(baseline, 1));
    if (z < MIN_Z) continue;

    items.push({
      key,
      label: entity.label,
      href: `/?q=${encodeURIComponent(entity.label)}`,
      count,
      baseline,
      ratio,
      ratioLabel: formatRatio(ratio),
      ratioIsLowerBound: baseline < BASELINE_FLOOR,
      isNew: baseline < NEW_BASELINE_MAX,
    });
  }

  items.sort(
    (a, b) =>
      b.ratio - a.ratio ||
      b.count - a.count ||
      a.label.localeCompare(b.label, "tr"),
  );
  return { sufficient: true, items: items.slice(0, MAX_ITEMS) };
}

/**
 * Rank the entities rising today; when today has none, look at yesterday
 * (early in the Istanbul day the rollup is still thin). `insufficient` is
 * returned only when today's own baseline is too thin; a thin baseline for
 * yesterday just means nothing to show from it.
 */
export function computeRising(
  rows: readonly RollupRow[],
  todayKey: string,
): RisingResult {
  const byDay = indexRows(rows);

  const today = rankDay(byDay, todayKey);
  if (!today.sufficient) return { status: "insufficient" };
  if (today.items.length > 0) {
    return { status: "ok", dayLabel: "Bugün", day: todayKey, items: today.items };
  }

  const yesterdayKey = shiftDayKey(todayKey, -1);
  const yesterday = rankDay(byDay, yesterdayKey);
  if (yesterday.sufficient && yesterday.items.length > 0) {
    return { status: "ok", dayLabel: "Dün", day: yesterdayKey, items: yesterday.items };
  }

  return { status: "ok", dayLabel: "Bugün", day: todayKey, items: [] };
}
