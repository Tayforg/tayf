import { describe, it, expect } from "vitest";
import { normalizeWeeklyTitle, dedupeByTitle } from "./dedupe-titles";

describe("normalizeWeeklyTitle", () => {
  it("folds case (tr-TR), punctuation and whitespace so the same story matches regardless of styling", () => {
    expect(normalizeWeeklyTitle("Mansur Yavaş CHP'den istifa etti")).toBe(
      normalizeWeeklyTitle("MANSUR YAVAŞ CHP’DEN İSTİFA ETTİ!"),
    );
  });

  it("normalizes NFC and strips punctuation/symbol/space runs", () => {
    expect(normalizeWeeklyTitle("Deprem: yönetmelik değişti.")).toBe(
      normalizeWeeklyTitle("Deprem yönetmelik değişti"),
    );
  });
});

describe("dedupeByTitle", () => {
  interface Row {
    id: string;
    title: string;
    articleCount: number;
  }

  it("keeps only the first of a sorted list of duplicate titles, preserving order", () => {
    const rows: Row[] = [
      { id: "a", title: "Mansur Yavaş CHP'den istifa etti", articleCount: 29 },
      { id: "b", title: "MANSUR YAVAŞ CHP’DEN İSTİFA ETTİ!", articleCount: 26 },
      { id: "c", title: "Deprem yönetmeliği", articleCount: 10 },
    ];

    const result = dedupeByTitle(rows, (r) => r.title);

    expect(result.map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("returns the input unchanged when every title is distinct", () => {
    const rows: Row[] = [
      { id: "a", title: "Haber bir", articleCount: 5 },
      { id: "b", title: "Haber iki", articleCount: 3 },
    ];

    expect(dedupeByTitle(rows, (r) => r.title)).toEqual(rows);
  });
});
