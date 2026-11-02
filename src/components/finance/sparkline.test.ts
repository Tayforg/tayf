import { describe, expect, it } from "vitest";
import { attentionLabels } from "./sparkline";

// AttentionBars used to print a count under every bar as SVG text at
// text-[9px] in a 600-unit viewBox (about 5 px on a 390 px phone). Now only
// the two numbers a reader needs (the peak and today) are HTML labels, placed
// by the same bar geometry as the rects.

const W = 600;
const GAP = 3;

function series(counts: number[]) {
  return counts.map((articles, i) => ({ day: `2026-10-${String(i + 1).padStart(2, "0")}`, articles }));
}

/** The 30-day shape the page draws: `at` gets `value`, everything else 0. */
function thirty(entries: Record<number, number>) {
  const counts = new Array<number>(30).fill(0);
  for (const [i, v] of Object.entries(entries)) counts[Number(i)] = v;
  return series(counts);
}

describe("attentionLabels", () => {
  it("labels the peak and today, at most two labels", () => {
    const labels = attentionLabels(thirty({ 14: 9, 29: 3, 5: 2 }), W, GAP);
    expect(labels).toHaveLength(2);
    expect(labels.map((l) => l.text)).toEqual(["9", "3"]);
  });

  it("returns nothing for a window with no articles", () => {
    expect(attentionLabels(thirty({}), W, GAP)).toEqual([]);
  });

  it("dedupes when today is the peak", () => {
    const labels = attentionLabels(thirty({ 29: 7, 3: 2 }), W, GAP);
    expect(labels).toHaveLength(1);
    expect(labels[0]!.text).toBe("7");
  });

  it("takes the first bar when the peak is tied", () => {
    const labels = attentionLabels(thirty({ 4: 5, 20: 5, 29: 1 }), W, GAP);
    expect(labels.map((l) => l.text)).toEqual(["5", "1"]);
    // First max is bar 4, far left of the second 5 at bar 20.
    expect(labels[0]!.leftPct).toBeLessThan(25);
  });

  it("labels the peak only when today has no articles", () => {
    const labels = attentionLabels(thirty({ 10: 4 }), W, GAP);
    expect(labels).toHaveLength(1);
    expect(labels[0]!.text).toBe("4");
  });

  it("labels today only when it is the sole bar with articles (and it is the peak)", () => {
    const labels = attentionLabels(thirty({ 29: 2 }), W, GAP);
    expect(labels).toHaveLength(1);
    expect(labels[0]!.text).toBe("2");
  });

  it("places a label over the centre of its bar, in percent of the viewBox width", () => {
    const n = 30;
    const bw = (W - GAP * (n - 1)) / n;
    const labels = attentionLabels(thirty({ 14: 9, 29: 3 }), W, GAP);
    const expectPct = (i: number) => (((i * (bw + GAP)) + bw / 2) / W) * 100;
    expect(labels[0]!.leftPct).toBeCloseTo(expectPct(14), 6);
    expect(labels[1]!.leftPct).toBeCloseTo(expectPct(29), 6);
  });

  it("aligns start below 10 %, end above 90 %, centre in between", () => {
    const edges = attentionLabels(thirty({ 0: 9, 29: 1 }), W, GAP);
    expect(edges[0]!.leftPct).toBeLessThan(10);
    expect(edges[0]!.align).toBe("start");
    expect(edges[1]!.leftPct).toBeGreaterThan(90);
    expect(edges[1]!.align).toBe("end");

    const middle = attentionLabels(thirty({ 15: 9 }), W, GAP);
    expect(middle[0]!.leftPct).toBeGreaterThan(10);
    expect(middle[0]!.leftPct).toBeLessThan(90);
    expect(middle[0]!.align).toBe("center");
  });

  it("works for a shorter window", () => {
    const labels = attentionLabels(series([0, 3, 0, 1]), W, GAP);
    expect(labels.map((l) => l.text)).toEqual(["3", "1"]);
    expect(labels.every((l) => l.leftPct > 0 && l.leftPct < 100)).toBe(true);
  });

  it("returns nothing for an empty series", () => {
    expect(attentionLabels([], W, GAP)).toEqual([]);
  });
});
