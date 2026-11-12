// Static Borsa İstanbul (Pay Piyasası) holiday and half-day calendar for the /ekonomi market state. Pure data and
// pure lookups: no clock reads (callers pass an epoch-day number derived from an explicit instant), no next/*
// imports. session.ts is the only consumer.
//
// SOURCE OF EVERY ROW, by block:
//  - 2026, OFFICIAL: Borsa İstanbul circular E-18454353-100.04.02-41625 (04.12.2025), EK-3 "Pay Piyasası 2026 Yılı
//    Tatil Tablosu" (https://borsaistanbul.com/files/41625-sayili-duyurumuz-hk.-turkce-04122025.pdf, indexed at
//    https://www.borsaistanbul.com/resmi-tatil-gunleri). The 2026 rows equal that table exactly: closed 01.01, 20.03,
//    23.04, 01.05, 19.05, 27-29.05, 15.07, 29.10; half days 19.03, 26.05, 28.10. The table has no row after
//    29.10.2026, so 31.12.2026 is a full session.
//  - 2027, EXPECTED (NOT yet in an official BIST table): derived from Law 2429 md.1-2 (28 Ekim from 13.00, arefe
//    from 13.00, Ramazan 3,5 and Kurban 4,5 days) and the Diyanet 2027 dini günler calendar (Ramazan arefe Mon
//    08.03, bayram 09-11.03; Kurban arefe Sat 15.05, bayram Sun 16.05 - Wed 19.05). Borsa İstanbul had not published
//    its 2027 table on 12.11.2026 (expected early December 2026). Every 2027 row carries an "EXPECTED" comment; when
//    BIST publishes, compare each row with the EK "Pay Piyasası" of the 2027 circular, replace "expected" with the
//    circular number, and fix any differing row together with its test.
//  - Half-day HOURS (the 12:45 close used by session.ts) are not in this file: they come from the BIST "Pay Piyasası
//    İşlem Saatleri Çizelgeleri" (güncellenme 04.11.2019), "YARIM İŞ GÜNLERİNDE".
//
// Rows are Monday to Friday only: the weekend days of a bayram are left out, because the weekday rule already closes
// them. A "closed" row is closed all day; a "half" row trades until the half-day close.
//
// Past BIST_CALENDAR_LAST_DAY the lookups know nothing and only the weekday rule applies (the behaviour from before
// this table). bist-calendar.test.ts fails from 2028-01-01 Istanbul until the next year's rows are added.

export type BistCalendarKind = "closed" | "half";

export interface BistCalendarEntry {
  /** Istanbul calendar day, YYYY-MM-DD. */
  day: string;
  kind: BistCalendarKind;
  /** The law-2429 holiday name, without the "tatili" or "arifesi" suffix (bistCalendarLabel adds it). */
  name: string;
}

/** The last day the table covers. From the next day on, only the weekday rule applies. */
export const BIST_CALENDAR_LAST_DAY = "2027-12-31";

export const BIST_CALENDAR: readonly BistCalendarEntry[] = [
  // 2026: OFFICIAL, BIST circular 41625 (04.12.2025), EK-3 "Pay Piyasası 2026 Yılı Tatil Tablosu".
  { day: "2026-01-01", kind: "closed", name: "Yılbaşı" }, // official, EK-3
  { day: "2026-03-19", kind: "half", name: "Ramazan Bayramı" }, // official, EK-3
  { day: "2026-03-20", kind: "closed", name: "Ramazan Bayramı" }, // official, EK-3
  { day: "2026-04-23", kind: "closed", name: "Ulusal Egemenlik ve Çocuk Bayramı" }, // official, EK-3
  { day: "2026-05-01", kind: "closed", name: "Emek ve Dayanışma Günü" }, // official, EK-3
  { day: "2026-05-19", kind: "closed", name: "Atatürk'ü Anma, Gençlik ve Spor Bayramı" }, // official, EK-3
  { day: "2026-05-26", kind: "half", name: "Kurban Bayramı" }, // official, EK-3
  { day: "2026-05-27", kind: "closed", name: "Kurban Bayramı" }, // official, EK-3
  { day: "2026-05-28", kind: "closed", name: "Kurban Bayramı" }, // official, EK-3
  { day: "2026-05-29", kind: "closed", name: "Kurban Bayramı" }, // official, EK-3
  { day: "2026-07-15", kind: "closed", name: "Demokrasi ve Milli Birlik Günü" }, // official, EK-3
  { day: "2026-10-28", kind: "half", name: "Cumhuriyet Bayramı" }, // official, EK-3
  { day: "2026-10-29", kind: "closed", name: "Cumhuriyet Bayramı" }, // official, EK-3

  // 2027: expected — confirm against BIST "Pay Piyasası 2027 Yılı Tatil Tablosu"
  { day: "2027-01-01", kind: "closed", name: "Yılbaşı" }, // EXPECTED: law 2429
  { day: "2027-03-08", kind: "half", name: "Ramazan Bayramı" }, // EXPECTED: law 2429 + Diyanet 2027 (arefe Mon)
  { day: "2027-03-09", kind: "closed", name: "Ramazan Bayramı" }, // EXPECTED: law 2429 + Diyanet 2027
  { day: "2027-03-10", kind: "closed", name: "Ramazan Bayramı" }, // EXPECTED: law 2429 + Diyanet 2027
  { day: "2027-03-11", kind: "closed", name: "Ramazan Bayramı" }, // EXPECTED: law 2429 + Diyanet 2027
  { day: "2027-04-23", kind: "closed", name: "Ulusal Egemenlik ve Çocuk Bayramı" }, // EXPECTED: law 2429
  { day: "2027-05-17", kind: "closed", name: "Kurban Bayramı" }, // EXPECTED: law 2429 + Diyanet 2027 (bayram from Sun)
  { day: "2027-05-18", kind: "closed", name: "Kurban Bayramı" }, // EXPECTED: law 2429 + Diyanet 2027
  { day: "2027-05-19", kind: "closed", name: "Kurban Bayramı" }, // EXPECTED: law 2429 + Diyanet 2027 (also 19 Mayıs)
  { day: "2027-07-15", kind: "closed", name: "Demokrasi ve Milli Birlik Günü" }, // EXPECTED: law 2429
  { day: "2027-08-30", kind: "closed", name: "Zafer Bayramı" }, // EXPECTED: law 2429
  { day: "2027-10-28", kind: "half", name: "Cumhuriyet Bayramı" }, // EXPECTED: law 2429 (28 Ekim from 13.00)
  { day: "2027-10-29", kind: "closed", name: "Cumhuriyet Bayramı" }, // EXPECTED: law 2429
];

const DAY_MS = 86_400_000;

/** Anchored and linear: exactly four, two and two digits. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The epoch-day number of a YYYY-MM-DD day, or null when `day` is not a string of that shape or not a real day
 * (Date.parse accepts "2026-02-30", so the result must round-trip). It equals session.ts istDay(ms) for any instant
 * on that Istanbul day. Never throws.
 */
export function bistDayNumber(day: string): number | null {
  if (typeof day !== "string" || !DAY_PATTERN.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10) === day ? ms / DAY_MS : null;
}

const ENTRIES: ReadonlyMap<number, BistCalendarEntry> = new Map(
  BIST_CALENDAR.flatMap((entry): [number, BistCalendarEntry][] => {
    const n = bistDayNumber(entry.day);
    return n === null ? [] : [[n, entry]];
  }),
);

/** The table row of an epoch-day number, or null (a plain day, a weekend, or a day outside the table). */
export function bistCalendarEntry(dayNum: number): BistCalendarEntry | null {
  return ENTRIES.get(dayNum) ?? null;
}

/**
 * Whether the BIST Pay Piyasası trades on an epoch-day number: a weekday that is not a closed row. A half day IS a
 * trading day. The weekday is arithmetic, no Date: day 0 (1970-01-01) is a Thursday. Past BIST_CALENDAR_LAST_DAY
 * only the weekday rule applies.
 */
export function bistTradingDay(dayNum: number): boolean {
  if (!Number.isInteger(dayNum)) return false;
  const weekday = ((dayNum % 7) + 11) % 7; // 0 = Sunday .. 6 = Saturday
  return weekday >= 1 && weekday <= 5 && bistCalendarEntry(dayNum)?.kind !== "closed";
}

/** The Turkish reason line for a row: "Kurban Bayramı tatili" or "Cumhuriyet Bayramı arifesi, yarım gün". */
export function bistCalendarLabel(entry: BistCalendarEntry): string {
  return entry.kind === "closed" ? `${entry.name} tatili` : `${entry.name} arifesi, yarım gün`;
}
