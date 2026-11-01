import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { emptyBiasDistribution } from "@/lib/bias/analyzer";
import type { BiasDistribution } from "@/types";

import { BiasSpectrum } from "./bias-spectrum";

// BiasSpectrum is a synchronous presentational component, so it renders
// directly with react-dom/server. A 7:1 split is the canonical bad case for
// per-segment Math.round(): 87.5 -> 88 and 12.5 -> 13 total 101%.

function dist(partial: Partial<BiasDistribution>): BiasDistribution {
  return { ...emptyBiasDistribution(), ...partial };
}

const SEVEN_TO_ONE = dist({ pro_government: 7, opposition: 1 });

describe("BiasSpectrum — percentages sum to 100", () => {
  it("compact mode shows %88 and %12 (never %13) for a 7:1 split", () => {
    const markup = renderToStaticMarkup(
      <BiasSpectrum distribution={SEVEN_TO_ONE} compact />,
    );

    expect(markup).toContain("%88");
    expect(markup).toContain("%12");
    expect(markup).not.toContain("%13");
  });

  it("compact mode puts the largest-remainder percent in the title text", () => {
    const markup = renderToStaticMarkup(
      <BiasSpectrum distribution={SEVEN_TO_ONE} compact />,
    );

    expect(markup).toContain("7 kaynak (%88)");
    expect(markup).toContain("1 kaynak (%12)");
  });

  it("non-compact mode gives the same 88/12 split", () => {
    const markup = renderToStaticMarkup(
      <BiasSpectrum distribution={SEVEN_TO_ONE} />,
    );

    expect(markup).toContain("%88");
    expect(markup).toContain("%12");
    expect(markup).not.toContain("%13");
    expect(markup).toContain("7 kaynak (%88)");
    expect(markup).toContain("1 kaynak (%12)");
  });

  it("writes percents in the Turkish prefix form only, in both modes", () => {
    for (const compact of [true, false]) {
      const markup = renderToStaticMarkup(
        <BiasSpectrum distribution={SEVEN_TO_ONE} compact={compact} />,
      );

      // No suffix-style "88%" / "12%" — but the CSS bar widths stay as-is.
      expect(markup).not.toContain("88%");
      expect(markup).not.toMatch(/(?<![\d.])12%/);
    }
  });

  it("keeps the exact fraction for the bar widths", () => {
    const markup = renderToStaticMarkup(
      <BiasSpectrum distribution={SEVEN_TO_ONE} compact />,
    );

    expect(markup).toContain("width:87.5%");
    expect(markup).toContain("width:12.5%");
  });

  it("splits a three-way tie as 34/33/33 in the compact zone bar", () => {
    const markup = renderToStaticMarkup(
      <BiasSpectrum
        distribution={dist({ pro_government: 1, center: 1, opposition: 1 })}
        compact
      />,
    );

    expect(markup).toContain("İktidar: 1 kaynak (%34)");
    expect(markup).toContain("Bağımsız: 1 kaynak (%33)");
    expect(markup).toContain("Muhalefet: 1 kaynak (%33)");
  });

  it("renders nothing for an empty distribution in both modes", () => {
    expect(
      renderToStaticMarkup(<BiasSpectrum distribution={emptyBiasDistribution()} />),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        <BiasSpectrum distribution={emptyBiasDistribution()} compact />,
      ),
    ).toBe("");
  });
});

describe("BiasSpectrum — text contrast", () => {
  it("uses no opacity-modified muted-foreground text token in either mode", () => {
    const compact = renderToStaticMarkup(
      <BiasSpectrum distribution={SEVEN_TO_ONE} compact />,
    );
    const full = renderToStaticMarkup(<BiasSpectrum distribution={SEVEN_TO_ONE} />);

    expect(compact).not.toContain("text-muted-foreground/");
    expect(full).not.toContain("text-muted-foreground/");
  });
});

// Forced colors (Windows High Contrast) repaints backgrounds with system
// colours, collapsing every zone/category segment to one flat colour. The bar
// and the legend dots opt out so the zone colours survive (WCAG 1.4.11).
// `forced-color-adjust` is inherited, so the wrapper covers its segments.
describe("BiasSpectrum — forced colors", () => {
  const FCA = "forced-color-adjust-none";
  const BAR = /<div class="[^"]*\bh-2 w-full\b[^"]*"/g;
  const DOT = /<span class="inline-block h-2 w-2 rounded-full[^"]*"/g;

  for (const [mode, compact] of [
    ["compact", true],
    ["full", false],
  ] as const) {
    describe(mode, () => {
      const markup = renderToStaticMarkup(
        <BiasSpectrum distribution={SEVEN_TO_ONE} compact={compact} />,
      );

      it("opts the bar wrapper out of forced-color adjustment", () => {
        const bars = markup.match(BAR) ?? [];
        expect(bars).toHaveLength(1);
        expect(bars[0]).toContain(FCA);
      });

      it("opts every legend dot out of forced-color adjustment", () => {
        const dots = markup.match(DOT) ?? [];
        expect(dots.length).toBeGreaterThan(0);
        for (const dot of dots) expect(dot).toContain(FCA);
      });

      it("uses the opt-out exactly once for the bar plus once per active segment", () => {
        const dots = markup.match(DOT) ?? [];
        expect(dots).toHaveLength(2);
        // SEVEN_TO_ONE has 2 active segments in both modes: 1 bar + 2 dots.
        expect(markup.split(FCA).length - 1).toBe(3);
        expect(markup.split(FCA).length - 1).toBe(1 + dots.length);
      });
    });
  }
});
