import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Chart labels on /ekonomi/<ticker> used to be SVG <text>: its size is in
// viewBox units, so a 720-unit intraday chart at 6.5 rendered at about 3 px
// on a 390 px phone and the 600-unit attention bars at text-[9px] at about
// 5 px. Labels are now HTML over the SVG at a real pixel size. This guard
// keeps the SVG text from coming back.
//
// CodeQL: literal includes and a character scan only; no regular expression
// runs over the source.

const ROOT = resolve(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const INTRADAY = read("src/components/finance/intraday-chart.tsx");
const SPARKLINE = read("src/components/finance/sparkline.tsx");

/** Every pixel size N of a `text-[Npx]` token in `source`, found by scanning characters. */
function textPxSizes(source: string): number[] {
  const out: number[] = [];
  const needle = "text-[";
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) return out;
    let i = at + needle.length;
    let digits = "";
    while (i < source.length && source[i]! >= "0" && source[i]! <= "9") {
      digits += source[i];
      i++;
    }
    if (digits !== "" && source.startsWith("px]", i)) out.push(Number(digits));
    from = at + needle.length;
  }
}

describe("chart label size (390 px phone)", () => {
  it("the intraday chart draws no SVG text and no viewBox font size", () => {
    expect(INTRADAY.includes("<text")).toBe(false);
    expect(INTRADAY.includes("fontSize=")).toBe(false);
  });

  it("the attention bars draw no SVG text and no 9 px label", () => {
    expect(SPARKLINE.includes("<text")).toBe(false);
    expect(SPARKLINE.includes("text-[9px]")).toBe(false);
  });

  it("each file labels its chart with a real pixel size of at least 10", () => {
    for (const source of [INTRADAY, SPARKLINE]) {
      const sizes = textPxSizes(source);
      expect(sizes.length).toBeGreaterThan(0);
      expect(Math.max(...sizes)).toBeGreaterThanOrEqual(10);
      expect(sizes.every((px) => px >= 10)).toBe(true);
      expect(source.includes("text-[10px]")).toBe(true);
    }
  });

  it("every chart label element is hidden from assistive tech and marked for the size probe", () => {
    // The measure step reads computed font-size from [data-chart-label].
    expect(INTRADAY.includes("data-chart-label")).toBe(true);
    expect(SPARKLINE.includes("data-chart-label")).toBe(true);
    expect(INTRADAY.includes('aria-hidden="true"')).toBe(true);
    expect(SPARKLINE.includes('aria-hidden="true"')).toBe(true);
  });

  it("the stale '~13px' note about viewBox scaling is gone", () => {
    expect(INTRADAY.includes("~13px")).toBe(false);
    expect(INTRADAY.includes("FONT")).toBe(false);
  });
});
