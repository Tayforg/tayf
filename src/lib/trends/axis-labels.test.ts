import { describe, it, expect } from "vitest";

import { X_LABEL_STEP, xAxisLabels } from "./axis-labels";

// h46-mobile-3: the /trends x axis printed `day.slice(8, 10)` only, so a window
// that crossed a month boundary read "28 02 06" with no month anywhere.
// xAxisLabels() picks which days get a label and writes the text: day-only
// ("07"), except the first label and the first label after a month change,
// which carry the Turkish month abbreviation ("28 Eki", "02 Kas"). Pure on
// purpose (no Date, no Intl): identical on the server, in every browser and in
// tests, whatever the ICU build.

/** `n` consecutive calendar days starting at `startIso` (UTC arithmetic only). */
function days(startIso: string, n: number): string[] {
  const out: string[] = [];
  const t0 = Date.parse(`${startIso}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    out.push(new Date(t0 + i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

const texts = (labels: { text: string }[]) => labels.map((l) => l.text);

describe("xAxisLabels", () => {
  it("labels every 5th day and always the last one", () => {
    const labels = xAxisLabels(days("2026-10-28", 30));

    expect(labels.map((l) => l.idx)).toEqual([0, 5, 10, 15, 20, 25, 29]);
    expect(X_LABEL_STEP).toBe(5);
  });

  it("pins the Oct to Nov window: '28 Eki' first, '02 Kas' after the change, the rest day-only", () => {
    const labels = xAxisLabels(days("2026-10-28", 30));

    expect(texts(labels)).toEqual(["28 Eki", "02 Kas", "07", "12", "17", "22", "26"]);
  });

  it("gives the first label its month even inside a single month", () => {
    const labels = xAxisLabels(days("2024-01-01", 30));

    expect(texts(labels)).toEqual(["01 Oca", "06", "11", "16", "21", "26", "30"]);
  });

  it("puts the month on a labelled day that is itself the 1st", () => {
    // 2026-10-27 + 5 = 2026-11-01.
    const labels = xAxisLabels(days("2026-10-27", 30));

    expect(texts(labels).slice(0, 3)).toEqual(["27 Eki", "01 Kas", "06"]);
  });

  it("marks a month change that falls between two labels on the next label, not on the skipped day", () => {
    // 2026-10-28 + 4 = 2026-11-01 is not labelled (idx 4); idx 5 = 2 Kas is.
    const labels = xAxisLabels(days("2026-10-28", 30));

    expect(labels.some((l) => l.text === "01")).toBe(false);
    expect(labels.find((l) => l.idx === 5)?.text).toBe("02 Kas");
  });

  it("repeats the month for every change when a window crosses two boundaries", () => {
    // 60 days from 2026-09-20, step 10: idx 0 = 20 Eyl ... idx 20 = 10 Eki ...
    // idx 50 = 09 Kas, and the last day (idx 59) is 18 Kas, already in Kas.
    const labels = xAxisLabels(days("2026-09-20", 60), 10);

    expect(texts(labels)).toEqual(["20 Eyl", "30", "10 Eki", "20", "30", "09 Kas", "18"]);
  });

  it("crosses a year boundary: '29 Ara' then '03 Oca'", () => {
    const labels = xAxisLabels(days("2026-12-29", 30));

    expect(texts(labels).slice(0, 2)).toEqual(["29 Ara", "03 Oca"]);
  });

  it("uses the 12 Turkish month abbreviations", () => {
    const abbreviations = Array.from({ length: 12 }, (_, i) => {
      const month = String(i + 1).padStart(2, "0");
      return xAxisLabels([`2026-${month}-15`])[0]!.text;
    });

    expect(abbreviations).toEqual([
      "15 Oca",
      "15 Şub",
      "15 Mar",
      "15 Nis",
      "15 May",
      "15 Haz",
      "15 Tem",
      "15 Ağu",
      "15 Eyl",
      "15 Eki",
      "15 Kas",
      "15 Ara",
    ]);
  });

  it("keeps the leading zero of the day (the old day-only labels did)", () => {
    expect(texts(xAxisLabels(["2026-11-02"]))).toEqual(["02 Kas"]);
  });

  it("returns [] for no days", () => {
    expect(xAxisLabels([])).toEqual([]);
  });

  it("labels a single day once, with its month (first and last at the same index)", () => {
    expect(xAxisLabels(["2026-11-05"])).toEqual([{ idx: 0, text: "05 Kas" }]);
  });

  it("does not label the last day twice when it falls on the step", () => {
    // 26 days: idx 25 is both a multiple of 5 and the last index.
    const labels = xAxisLabels(days("2026-10-28", 26));

    expect(labels.map((l) => l.idx)).toEqual([0, 5, 10, 15, 20, 25]);
  });

  it("honours a custom step", () => {
    const labels = xAxisLabels(days("2026-10-28", 10), 3);

    expect(labels.map((l) => l.idx)).toEqual([0, 3, 6, 9]);
  });

  it("falls back to a step of 1 for a step below 1 or not finite", () => {
    expect(xAxisLabels(days("2026-10-28", 3), 0).map((l) => l.idx)).toEqual([0, 1, 2]);
    expect(xAxisLabels(days("2026-10-28", 3), Number.NaN).map((l) => l.idx)).toEqual([0, 1, 2]);
  });

  it("does not mutate its input", () => {
    const input = days("2026-10-28", 30);
    const copy = [...input];

    xAxisLabels(input);

    expect(input).toEqual(copy);
  });

  it("keeps the old day-slice text for a key that is not YYYY-MM-DD, with no month and no throw", () => {
    const labels = xAxisLabels(["not-a-date"]);

    expect(labels).toEqual([{ idx: 0, text: "not-a-date".slice(8, 10) }]);
  });

  it("treats month 00 and month 13 as not a date (no undefined abbreviation)", () => {
    expect(texts(xAxisLabels(["2026-13-05"]))).toEqual(["05"]);
    expect(texts(xAxisLabels(["2026-00-05"]))).toEqual(["05"]);
  });

  it("stays linear on a large input (10k days)", () => {
    const labels = xAxisLabels(days("2000-01-01", 10_000));

    // idx 0, 5, ... 9995 (2000 labels) plus the last day, idx 9999.
    expect(labels).toHaveLength(2001);
    expect(labels[0]!.text).toBe("01 Oca");
    expect(labels[labels.length - 1]!.idx).toBe(9999);
  });
});
