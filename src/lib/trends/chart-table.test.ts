import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { chartTableRows } from "./chart-table";
import type { DayBucket } from "./daily-zones";

// h17-a11y-1: the /trends chart's per-day values existed only as <title>
// children of <rect>s inside a role="img" svg, so a screen reader heard the
// 30-day total and nothing else. chartTableRows() turns the same buckets into
// plain rows for a real <table> (WCAG 1.1.1 / 1.3.1).

function bucket(
  day: string,
  iktidar: number,
  bagimsiz: number,
  muhalefet: number,
  total = iktidar + bagimsiz + muhalefet,
): DayBucket {
  return { day, counts: { iktidar, bagimsiz, muhalefet }, total };
}

describe("chartTableRows", () => {
  it("returns [] for no buckets", () => {
    expect(chartTableRows([])).toEqual([]);
  });

  it("returns one row per bucket with exactly the documented shape", () => {
    const rows = chartTableRows([bucket("2026-10-04", 3, 2, 1)]);

    expect(rows).toEqual([
      {
        day: "2026-10-04",
        label: "4 Ekim",
        iktidar: 3,
        bagimsiz: 2,
        muhalefet: 1,
        total: 6,
      },
    ]);
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ["bagimsiz", "day", "iktidar", "label", "muhalefet", "total"],
    );
  });

  it("sorts rows by day ascending even when the input is out of order", () => {
    const rows = chartTableRows([
      bucket("2026-10-06", 1, 0, 0),
      bucket("2026-10-04", 2, 0, 0),
      bucket("2026-10-05", 3, 0, 0),
    ]);

    expect(rows.map((r) => r.day)).toEqual([
      "2026-10-04",
      "2026-10-05",
      "2026-10-06",
    ]);
    expect(rows.map((r) => r.iktidar)).toEqual([2, 3, 1]);
  });

  it("sorts across a month and a year boundary", () => {
    const rows = chartTableRows([
      bucket("2027-01-01", 0, 0, 0),
      bucket("2026-12-31", 0, 0, 0),
      bucket("2026-02-01", 0, 0, 0),
    ]);

    expect(rows.map((r) => r.day)).toEqual([
      "2026-02-01",
      "2026-12-31",
      "2027-01-01",
    ]);
  });

  it("does not mutate the input array or its buckets", () => {
    const input = [
      bucket("2026-10-06", 1, 1, 1),
      bucket("2026-10-04", 2, 2, 2),
    ];
    const snapshot = JSON.parse(JSON.stringify(input));

    chartTableRows(input);

    expect(input.map((b) => b.day)).toEqual(["2026-10-06", "2026-10-04"]);
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });

  it("recomputes total from the counts instead of trusting bucket.total", () => {
    const rows = chartTableRows([bucket("2026-10-04", 4, 3, 2, 999)]);

    expect(rows[0]!.total).toBe(9);
  });

  it("the row totals add up to every count in the input", () => {
    const input = [
      bucket("2026-10-01", 10, 20, 30),
      bucket("2026-10-02", 0, 0, 0),
      bucket("2026-10-03", 1, 2, 3, 12345), // stale .total must not leak in
      bucket("2026-10-04", 2198, 0, 5),
    ];
    const everyCount = input.reduce(
      (acc, b) => acc + b.counts.iktidar + b.counts.bagimsiz + b.counts.muhalefet,
      0,
    );

    const rows = chartTableRows(input);

    expect(rows.reduce((acc, r) => acc + r.total, 0)).toBe(everyCount);
    expect(rows.reduce((acc, r) => acc + r.total, 0)).toBe(2269);
  });

  it("keeps zero rows (a quiet day is still a row)", () => {
    const rows = chartTableRows([bucket("2026-10-04", 0, 0, 0)]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ iktidar: 0, bagimsiz: 0, muhalefet: 0, total: 0 });
  });

  describe("labels", () => {
    it.each([
      ["2026-10-04", "4 Ekim"],
      ["2026-01-01", "1 Ocak"],
      ["2026-08-31", "31 Ağustos"],
      ["2026-12-09", "9 Aralık"],
      ["2026-02-10", "10 Şubat"],
      ["2026-03-15", "15 Mart"],
      ["2026-04-20", "20 Nisan"],
      ["2026-05-02", "2 Mayıs"],
      ["2026-06-30", "30 Haziran"],
      ["2026-07-07", "7 Temmuz"],
      ["2026-09-21", "21 Eylül"],
      ["2026-11-02", "2 Kasım"],
    ])("%s reads %s (full month name, no leading zero)", (day, label) => {
      expect(chartTableRows([bucket(day, 0, 0, 0)])[0]!.label).toBe(label);
    });

    it.each(["bad", "", "2026-10", "2026-10-4", "2026-13-01", "2026-00-10", "2026-10-00", "2026-10-32", "2026-10-04T00:00"])(
      "keeps the raw key %j as the label when it is not a valid YYYY-MM-DD",
      (day) => {
        expect(chartTableRows([bucket(day, 1, 1, 1)])[0]!.label).toBe(day);
      },
    );
  });
});

describe("chart-table.ts — source guard", () => {
  const source = readFileSync(resolve(__dirname, "chart-table.ts"), "utf8");
  // Strip comments so prose mentioning Date/Intl does not trip the guard.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("is pure: no Date, no Intl", () => {
    expect(code).not.toMatch(/\bDate\b/);
    expect(code).not.toMatch(/\bIntl\b/);
  });

  it("keeps its own month table instead of importing from the weekly files", () => {
    expect(code).toContain("MONTHS_TR");
    expect(code).not.toMatch(/from\s+["'][^"']*weekly/);
  });
});
