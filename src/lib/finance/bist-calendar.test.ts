import { describe, expect, it } from "vitest";

import {
  BIST_CALENDAR,
  BIST_CALENDAR_LAST_DAY,
  bistCalendarEntry,
  bistCalendarLabel,
  bistDayNumber,
  bistTradingDay,
  type BistCalendarEntry,
} from "./bist-calendar";

// Pure data and pure lookups: every case passes an explicit day or instant.
const IST_OFFSET_MS = 3 * 3600 * 1000;
const DAY_MS = 86_400_000;
const at = (iso: string) => Date.parse(iso);
/** The Istanbul calendar day of an instant, derived the same way session.ts istDay does. */
const istDayOf = (ms: number) => Math.floor((ms + IST_OFFSET_MS) / DAY_MS);
/** Independent weekday (0 = Sunday), through Date, so it does not share code with the table's arithmetic. */
const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();

function nextWeekday(day: string): string {
  let ms = Date.parse(`${day}T00:00:00Z`);
  do {
    ms += DAY_MS;
  } while (new Date(ms).getUTCDay() === 0 || new Date(ms).getUTCDay() === 6);
  return new Date(ms).toISOString().slice(0, 10);
}

const rowsOfYear = (year: string) => BIST_CALENDAR.filter((r) => r.day.startsWith(`${year}-`));
const pairs = (rows: readonly BistCalendarEntry[]) => rows.map((r) => [r.day, r.kind]);

describe("BIST_CALENDAR (table integrity)", () => {
  it("every row is a real YYYY-MM-DD day from Monday to Friday", () => {
    for (const row of BIST_CALENDAR) {
      expect(bistDayNumber(row.day), `${row.day} is a real day`).not.toBeNull();
      const wd = weekdayOf(row.day);
      expect(wd >= 1 && wd <= 5, `${row.day} falls on weekday ${wd}`).toBe(true);
    }
  });

  it("rows are strictly ascending, so no day is listed twice", () => {
    const days = BIST_CALENDAR.map((r) => r.day);
    expect(days).toEqual([...new Set(days)].sort());
  });

  it("every row lies in 2026-01-01 .. BIST_CALENDAR_LAST_DAY", () => {
    for (const row of BIST_CALENDAR) {
      expect(row.day >= "2026-01-01" && row.day <= BIST_CALENDAR_LAST_DAY, `${row.day} is inside the table span`).toBe(
        true,
      );
    }
  });

  it("BIST_CALENDAR_LAST_DAY is 31 December of the last year that has rows", () => {
    const last = BIST_CALENDAR[BIST_CALENDAR.length - 1];
    expect(last).toBeDefined();
    expect(BIST_CALENDAR_LAST_DAY).toBe(`${last!.day.slice(0, 4)}-12-31`);
  });

  it("every half day is the eve of a closed day: the next weekday is a closed row", () => {
    const halves = BIST_CALENDAR.filter((r) => r.kind === "half");
    expect(halves.length).toBeGreaterThan(0);
    for (const half of halves) {
      const next = BIST_CALENDAR.find((r) => r.day === nextWeekday(half.day));
      expect(next?.kind, `${half.day} is followed by a closed row`).toBe("closed");
    }
  });

  it("every name is a law-2429 holiday name", () => {
    const names = new Set([
      "Yılbaşı",
      "Ramazan Bayramı",
      "Ulusal Egemenlik ve Çocuk Bayramı",
      "Emek ve Dayanışma Günü",
      "Atatürk'ü Anma, Gençlik ve Spor Bayramı",
      "Kurban Bayramı",
      "Demokrasi ve Milli Birlik Günü",
      "Zafer Bayramı",
      "Cumhuriyet Bayramı",
    ]);
    for (const row of BIST_CALENDAR) {
      expect(names.has(row.name), `${row.day}: "${row.name}" is a known name`).toBe(true);
    }
  });

  it("2026 rows equal the BIST Pay Piyasası 2026 tatil tablosu (circular 41625, EK-3)", () => {
    const rows = rowsOfYear("2026");
    expect(rows).toHaveLength(13);
    expect(pairs(rows)).toEqual([
      ["2026-01-01", "closed"],
      ["2026-03-19", "half"],
      ["2026-03-20", "closed"],
      ["2026-04-23", "closed"],
      ["2026-05-01", "closed"],
      ["2026-05-19", "closed"],
      ["2026-05-26", "half"],
      ["2026-05-27", "closed"],
      ["2026-05-28", "closed"],
      ["2026-05-29", "closed"],
      ["2026-07-15", "closed"],
      ["2026-10-28", "half"],
      ["2026-10-29", "closed"],
    ]);
  });

  it("2026 names match the EK-3 holidays row by row", () => {
    expect(rowsOfYear("2026").map((r) => [r.day, r.name])).toEqual([
      ["2026-01-01", "Yılbaşı"],
      ["2026-03-19", "Ramazan Bayramı"],
      ["2026-03-20", "Ramazan Bayramı"],
      ["2026-04-23", "Ulusal Egemenlik ve Çocuk Bayramı"],
      ["2026-05-01", "Emek ve Dayanışma Günü"],
      ["2026-05-19", "Atatürk'ü Anma, Gençlik ve Spor Bayramı"],
      ["2026-05-26", "Kurban Bayramı"],
      ["2026-05-27", "Kurban Bayramı"],
      ["2026-05-28", "Kurban Bayramı"],
      ["2026-05-29", "Kurban Bayramı"],
      ["2026-07-15", "Demokrasi ve Milli Birlik Günü"],
      ["2026-10-28", "Cumhuriyet Bayramı"],
      ["2026-10-29", "Cumhuriyet Bayramı"],
    ]);
  });

  it("2027 rows are the expected set (law 2429 + Diyanet 2027)", () => {
    const rows = rowsOfYear("2027");
    expect(rows).toHaveLength(13);
    expect(pairs(rows)).toEqual([
      ["2027-01-01", "closed"],
      ["2027-03-08", "half"],
      ["2027-03-09", "closed"],
      ["2027-03-10", "closed"],
      ["2027-03-11", "closed"],
      ["2027-04-23", "closed"],
      ["2027-05-17", "closed"],
      ["2027-05-18", "closed"],
      ["2027-05-19", "closed"],
      ["2027-07-15", "closed"],
      ["2027-08-30", "closed"],
      ["2027-10-28", "half"],
      ["2027-10-29", "closed"],
    ]);
  });

  it("2027 weekend days of a bayram are left out (rows are Monday to Friday only)", () => {
    for (const day of ["2027-05-01", "2027-05-15", "2027-05-16"]) {
      expect(bistCalendarEntry(bistDayNumber(day)!), day).toBeNull();
    }
  });

  it("the table holds only 2026 and 2027, nothing else", () => {
    expect(BIST_CALENDAR).toHaveLength(26);
    expect(rowsOfYear("2026").length + rowsOfYear("2027").length).toBe(BIST_CALENDAR.length);
  });

  it("31 December is never a half day", () => {
    expect(BIST_CALENDAR.filter((r) => r.day.endsWith("-12-31") && r.kind === "half")).toEqual([]);
  });

  it("uses the ASCII apostrophe in Atatürk'ü", () => {
    for (const row of BIST_CALENDAR) {
      expect(row.name.includes("’"), `${row.day} has no typographic apostrophe`).toBe(false);
    }
    expect(BIST_CALENDAR.some((r) => r.name.startsWith("Atatürk'ü"))).toBe(true);
  });
});

describe("lookups", () => {
  describe("bistDayNumber", () => {
    it("is null for text that is not a real YYYY-MM-DD day", () => {
      for (const bad of ["", "2026-13-01", "2026-02-30", "2026-02-29", "29-10-2026", "2026-10-29T10:00", "2026-1-5"]) {
        expect(bistDayNumber(bad), JSON.stringify(bad)).toBeNull();
      }
    });

    it("is null for a value that is not a string, and for trailing or leading text", () => {
      expect(bistDayNumber(undefined as unknown as string)).toBeNull();
      expect(bistDayNumber(null as unknown as string)).toBeNull();
      expect(bistDayNumber(20261029 as unknown as string)).toBeNull();
      expect(bistDayNumber(" 2026-10-29")).toBeNull();
      expect(bistDayNumber("2026-10-29\n")).toBeNull();
    });

    it("accepts a real leap day", () => {
      expect(bistDayNumber("2028-02-29")).not.toBeNull();
    });

    it("is the epoch-day integer, and equals the Istanbul day of any instant on that day", () => {
      const n = bistDayNumber("2026-10-29");
      expect(n).toBe(Date.parse("2026-10-29T00:00:00Z") / DAY_MS);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBe(istDayOf(at("2026-10-29T11:00:00+03:00")));
      expect(n).toBe(istDayOf(at("2026-10-29T00:30:00+03:00")));
      expect(n).toBe(istDayOf(at("2026-10-29T23:59:00+03:00")));
      // 21:30Z on the 28th is already the 29th in Istanbul.
      expect(n).toBe(istDayOf(at("2026-10-28T21:30:00Z")));
    });

    it("consecutive days differ by exactly one", () => {
      expect(bistDayNumber("2026-03-01")! - bistDayNumber("2026-02-28")!).toBe(1);
      expect(bistDayNumber("2027-01-01")! - bistDayNumber("2026-12-31")!).toBe(1);
    });
  });

  describe("bistCalendarEntry", () => {
    it("finds a closed day, a half day, and nothing for a plain day or a day past the table", () => {
      expect(bistCalendarEntry(bistDayNumber("2026-10-29")!)).toMatchObject({ kind: "closed", name: "Cumhuriyet Bayramı" });
      expect(bistCalendarEntry(bistDayNumber("2026-10-28")!)).toMatchObject({ kind: "half", name: "Cumhuriyet Bayramı" });
      expect(bistCalendarEntry(bistDayNumber("2026-11-12")!)).toBeNull();
      expect(bistCalendarEntry(bistDayNumber("2028-03-01")!)).toBeNull();
    });

    it("is null for a number that is not a day number", () => {
      expect(bistCalendarEntry(Number.NaN)).toBeNull();
      expect(bistCalendarEntry(1.5)).toBeNull();
      expect(bistCalendarEntry(Number.POSITIVE_INFINITY)).toBeNull();
    });

    it("returns the table's own row for every row", () => {
      for (const row of BIST_CALENDAR) {
        expect(bistCalendarEntry(bistDayNumber(row.day)!)).toBe(row);
      }
    });
  });

  describe("bistTradingDay", () => {
    const trading = (day: string) => bistTradingDay(bistDayNumber(day)!);

    it("is false on a weekend and on a closed holiday, true on a half day and a plain weekday", () => {
      expect(trading("2026-10-31")).toBe(false); // Saturday
      expect(trading("2026-11-01")).toBe(false); // Sunday
      expect(trading("2026-10-29")).toBe(false); // Cumhuriyet Bayramı
      expect(trading("2026-10-28")).toBe(true); // half day trades
      expect(trading("2026-11-12")).toBe(true);
    });

    it("past the table only the weekday rule applies", () => {
      expect(trading("2028-03-01")).toBe(true); // Wednesday
      expect(trading("2028-01-01")).toBe(false); // Saturday
      expect(trading("2028-01-03")).toBe(true); // Monday
    });

    it("the idari izin day 25.05.2026 is a trading day (it traded)", () => {
      expect(trading("2026-05-25")).toBe(true);
    });

    it("is false for a number that is not an integer", () => {
      expect(bistTradingDay(Number.NaN)).toBe(false);
      expect(bistTradingDay(20_000.5)).toBe(false);
      expect(bistTradingDay(Number.POSITIVE_INFINITY)).toBe(false);
    });

    it("the weekday arithmetic agrees with Date for every day from 1969 to 2054 that is not a table row", () => {
      for (let n = -400; n <= 30_000; n++) {
        if (bistCalendarEntry(n)) continue;
        const wd = new Date(n * DAY_MS).getUTCDay();
        expect(bistTradingDay(n), `day number ${n} (weekday ${wd})`).toBe(wd >= 1 && wd <= 5);
      }
    });

    it("every closed row is not a trading day and every half row is", () => {
      for (const row of BIST_CALENDAR) {
        expect(bistTradingDay(bistDayNumber(row.day)!), row.day).toBe(row.kind === "half");
      }
    });
  });

  describe("bistCalendarLabel", () => {
    it("words a closed day as '<name> tatili' and a half day as '<name> arifesi, yarım gün'", () => {
      expect(bistCalendarLabel(bistCalendarEntry(bistDayNumber("2026-05-28")!)!)).toBe("Kurban Bayramı tatili");
      expect(bistCalendarLabel(bistCalendarEntry(bistDayNumber("2027-01-01")!)!)).toBe("Yılbaşı tatili");
      expect(bistCalendarLabel(bistCalendarEntry(bistDayNumber("2026-10-28")!)!)).toBe(
        "Cumhuriyet Bayramı arifesi, yarım gün",
      );
    });
  });
});

describe("coverage guard", () => {
  // The same predicate the guard below applies to the real clock, so its boundary can be pinned with explicit instants.
  const tablePassed = (nowMs: number) => istDayOf(nowMs) > bistDayNumber(BIST_CALENDAR_LAST_DAY)!;

  it("the guard predicate flips at midnight Istanbul between 2027-12-31 and 2028-01-01", () => {
    expect(BIST_CALENDAR_LAST_DAY).toBe("2027-12-31");
    expect(tablePassed(at("2027-12-31T23:59:59+03:00"))).toBe(false);
    expect(tablePassed(at("2028-01-01T00:00:00+03:00"))).toBe(true);
    // 21:00Z on 31 December is already 1 January in Istanbul.
    expect(tablePassed(at("2027-12-31T21:00:00Z"))).toBe(true);
    expect(tablePassed(at("2026-11-12T12:56:00+03:00"))).toBe(false);
  });

  it("the table still covers today: add next year's BIST tatil tablosu before BIST_CALENDAR_LAST_DAY passes", () => {
    expect(
      tablePassed(Date.now()),
      `BIST_CALENDAR ends on ${BIST_CALENDAR_LAST_DAY} and that day has passed. Add next year's rows to ` +
        "src/lib/finance/bist-calendar.ts from the BIST Pay Piyasası tatil tablosu " +
        "(borsaistanbul.com/resmi-tatil-gunleri, the EK for Pay Piyasası), then move BIST_CALENDAR_LAST_DAY to " +
        "31 December of that year and add its rows to bist-calendar.test.ts.",
    ).toBe(false);
  });
});
