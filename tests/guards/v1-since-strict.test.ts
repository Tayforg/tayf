import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, relative, sep } from "node:path";

import { parseIsoInstant, parseSince } from "@/lib/api/v1-clusters";

// ---------------------------------------------------------------------------
// Permanent CI guard (api-v1 contract edges): a `since` query value is a real
// calendar instant, validated in ONE place -- parseIsoInstant in v1-clusters.ts.
//
// Why: a shape regex plus `new Date(raw)` is not validation. In Node 24
// `new Date("2026-02-30T00:00:00Z")` is 2026-03-02 and `2026-04-31` is
// 2026-05-01, so a client that mistyped a date silently got a different window
// than the one it asked for (and `T24:00:00` rolls to the next day the same
// way). /api/v1/clusters, /api/v1/alerts/blindspots (both through parseSince)
// and /api/v1/kap/pickup (through parsePickupParams) must all 400 instead.
//
// The source scan stops the old pattern coming back: a second ISO-date regex
// literal anywhere else in the keyed API would be a second, drifting parser.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SCAN_DIRS = [resolve(ROOT, "src/lib/api"), resolve(ROOT, "src/app/api/v1")];
const ALLOWED_FILE = resolve(ROOT, "src/lib/api/v1-clusters.ts");

const SINCE_ERROR = { error: "Invalid since: must be an ISO 8601 timestamp" };

describe("parseSince rejects impossible instants", () => {
  const now = new Date("2026-11-01T12:00:00.000Z");

  it.each([
    ["2026-02-30T00:00:00Z", "Feb 30 (would roll to Mar 2)"],
    ["2026-04-31T00:00:00Z", "Apr 31 (would roll to May 1)"],
    ["2027-02-29T00:00:00Z", "Feb 29 in a non-leap year"],
    ["2026-13-01T00:00:00Z", "month 13"],
    ["2026-10-10T24:00:00Z", "hour 24 (would roll to the next day)"],
    ["2026-10-10T00:60:00Z", "minute 60"],
    ["2026-10-10T00:00:60Z", "second 60"],
    ["2026-10-10T00:00:00+24:00", "offset hours 24"],
  ])("%s -> 400-shaped error (%s)", (raw) => {
    expect(parseSince(raw, now)).toEqual(SINCE_ERROR);
  });

  it("rejects the same instants with a numeric offset or fractional seconds", () => {
    for (const raw of [
      "2026-02-30T00:00:00.000Z",
      "2026-02-30T10:00:00+03:00",
      "2026-04-31T10:00:00-05:30",
      "2026-10-10T00:00:00+03:60",
      "2026-10-10T00:00:00-24:00",
    ]) {
      expect(parseSince(raw, now), raw).toEqual(SINCE_ERROR);
    }
  });
});

describe("parseSince still accepts real instants", () => {
  it("accepts a real leap day (2028-02-29) when now is 2028-03-01", () => {
    const result = parseSince("2028-02-29T00:00:00Z", new Date("2028-03-01T00:00:00.000Z"));
    expect(result).toEqual({ since: "2028-02-29T00:00:00.000Z" });
  });

  it("accepts the last millisecond of a month", () => {
    const result = parseSince("2026-01-31T23:59:59.999Z", new Date("2026-02-01T00:00:00.000Z"));
    expect(result).toEqual({ since: "2026-01-31T23:59:59.999Z" });
  });

  it("accepts a numeric offset and normalises it to UTC", () => {
    const result = parseSince("2026-03-01T00:00:00+03:00", new Date("2026-03-02T00:00:00.000Z"));
    expect(result).toEqual({ since: "2026-02-28T21:00:00.000Z" });
  });

  it("keeps the default, blank, shape and 7-day-clamp behaviour", () => {
    const now = new Date("2026-09-21T12:00:00.000Z");
    expect(parseSince(null, now)).toEqual({ since: "2026-09-20T12:00:00.000Z" });
    expect(parseSince("", now)).toEqual({ since: "2026-09-20T12:00:00.000Z" });
    expect(parseSince("2026-09-01", now)).toEqual(SINCE_ERROR);
    expect(parseSince("not-a-date", now)).toEqual(SINCE_ERROR);
    expect(parseSince("2026-08-22T12:00:00.000Z", now)).toEqual({ since: "2026-09-14T12:00:00.000Z" });
  });
});

describe("parseIsoInstant", () => {
  it("returns a Date for a valid instant and null for everything else", () => {
    expect(parseIsoInstant("2026-10-10T12:30:45Z")?.toISOString()).toBe("2026-10-10T12:30:45.000Z");
    expect(parseIsoInstant("2026-10-10T12:30:45.123456Z")?.getUTCMilliseconds()).toBe(123);
    expect(parseIsoInstant("2026-10-10T12:30:45+23:59")).toBeInstanceOf(Date);
    expect(parseIsoInstant("2026-10-10T12:30:45-23:59")).toBeInstanceOf(Date);
    // No offset keeps today's behaviour: still accepted (read in the server's zone).
    expect(parseIsoInstant("2026-10-10T12:30:45")).toBeInstanceOf(Date);

    for (const raw of [
      "",
      " ",
      "2026-10-10",
      "2026-10-10T12:30Z",
      "2026-10-10 12:30:45Z",
      "2026-10-10t12:30:45z",
      " 2026-10-10T12:30:45Z",
      "2026-10-10T12:30:45Z ",
      "+002026-10-10T12:30:45Z",
      "2026-10-10T12:30:45+0300",
      "2026-1-1T00:00:00Z",
      "garbage",
    ]) {
      expect(parseIsoInstant(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it("accepts a day exactly when it exists in that month, across leap and non-leap years", () => {
    // 2000 is a leap year (divisible by 400), 2100 is not (divisible by 100
    // only), 2024 is, 2026 is not.
    for (const year of [2000, 2024, 2026, 2100]) {
      for (let month = 1; month <= 12; month++) {
        const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
        for (let day = 1; day <= 31; day++) {
          const raw = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00Z`;
          const parsed = parseIsoInstant(raw);
          if (day <= daysInMonth) {
            expect(parsed?.toISOString(), raw).toBe(`${raw.slice(0, 19)}.000Z`);
          } else {
            expect(parsed, raw).toBeNull();
          }
        }
        expect(parseIsoInstant(`${year}-${String(month).padStart(2, "0")}-00T00:00:00Z`)).toBeNull();
      }
    }
    expect(parseIsoInstant("2026-00-10T00:00:00Z")).toBeNull();
    expect(parseIsoInstant("2026-13-10T00:00:00Z")).toBeNull();
  });

  it("gets leap days right for the years 0000-0099 too (Date.UTC would map them onto 19xx)", () => {
    // Year 0000 is a leap year in the proleptic Gregorian calendar; 1900 is not.
    expect(parseIsoInstant("0000-02-29T00:00:00Z")).toBeInstanceOf(Date);
    expect(parseIsoInstant("0004-02-29T00:00:00Z")).toBeInstanceOf(Date);
    expect(parseIsoInstant("0001-02-29T00:00:00Z")).toBeNull();
    expect(parseIsoInstant("0100-02-29T00:00:00Z")).toBeNull();
  });

  it("bounds hour, minute, second and offset fields", () => {
    expect(parseIsoInstant("2026-10-10T23:59:59Z")).toBeInstanceOf(Date);
    for (const raw of [
      "2026-10-10T24:00:00Z",
      "2026-10-10T00:60:00Z",
      "2026-10-10T00:00:60Z",
      "2026-10-10T00:00:00+24:00",
      "2026-10-10T00:00:00-24:00",
      "2026-10-10T00:00:00+00:60",
    ]) {
      expect(parseIsoInstant(raw), raw).toBeNull();
    }
  });
});

describe("every keyed `since` route goes through the one parser", () => {
  const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

  it("/clusters and /alerts/blindspots call parseSince; /kap/pickup parses through parsePickupParams", () => {
    expect(read("src/app/api/v1/clusters/route.ts")).toMatch(/\bparseSince\(/);
    expect(read("src/app/api/v1/alerts/blindspots/route.ts")).toMatch(/\bparseSince\(/);
    expect(read("src/app/api/v1/kap/pickup/route.ts")).toMatch(/\bparsePickupParams\(/);
  });

  it("v1-kap-pickup.ts imports parseIsoInstant instead of keeping its own copy", () => {
    const source = read("src/lib/api/v1-kap-pickup.ts");
    expect(source).toMatch(/import\s*\{[^}]*\bparseIsoInstant\b[^}]*\}\s*from\s*"@\/lib\/api\/v1-clusters"/);
    expect(source).not.toMatch(/\bISO_RE\b/);
  });
});

describe("no second ISO-date regex in the keyed API", () => {
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) out.push(full);
    }
    return out;
  }

  /** Blanks // and block comments, keeping offsets (and newlines) intact. */
  function blankComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
  }

  // `\d{4}-\d{2}-\d{2}T`, with or without capture groups around the fields,
  // as it would appear in a regex literal or a RegExp source string.
  const ISO_DATE_REGEX_SOURCE = /\\d\{4\}\)?-\(?\\d\{2\}\)?-\(?\\d\{2\}\)?T/;

  const files = SCAN_DIRS.flatMap(walk);

  it("scans the keyed-API source files (and finds the one allowed parser)", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain(ALLOWED_FILE);
  });

  it("only v1-clusters.ts contains an ISO date regex literal", () => {
    const offenders = files
      .filter((f) => f !== ALLOWED_FILE)
      .filter((f) => ISO_DATE_REGEX_SOURCE.test(blankComments(readFileSync(f, "utf8"))))
      .map((f) => relative(ROOT, f).split(sep).join("/"));
    expect(offenders).toEqual([]);
  });

  it("the allowed parser really does contain the regex (the scan is not vacuous)", () => {
    expect(ISO_DATE_REGEX_SOURCE.test(blankComments(readFileSync(ALLOWED_FILE, "utf8")))).toBe(true);
  });
});
