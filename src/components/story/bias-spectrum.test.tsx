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
  it("compact mode shows 88% and 12% (never 13%) for a 7:1 split", () => {
    const markup = renderToStaticMarkup(
      <BiasSpectrum distribution={SEVEN_TO_ONE} compact />,
    );

    expect(markup).toContain("88%");
    expect(markup).toContain("12%");
    expect(markup).not.toContain("13%");
  });

  it("compact mode puts the largest-remainder percent in the title text", () => {
    const markup = renderToStaticMarkup(
      <BiasSpectrum distribution={SEVEN_TO_ONE} compact />,
    );

    expect(markup).toContain("7 kaynak (88%)");
    expect(markup).toContain("1 kaynak (12%)");
  });

  it("non-compact mode gives the same 88/12 split", () => {
    const markup = renderToStaticMarkup(
      <BiasSpectrum distribution={SEVEN_TO_ONE} />,
    );

    expect(markup).toContain("88%");
    expect(markup).toContain("12%");
    expect(markup).not.toContain("13%");
    expect(markup).toContain("7 kaynak (88%)");
    expect(markup).toContain("1 kaynak (12%)");
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

    expect(markup).toContain("İktidar: 1 kaynak (34%)");
    expect(markup).toContain("Bağımsız: 1 kaynak (33%)");
    expect(markup).toContain("Muhalefet: 1 kaynak (33%)");
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
