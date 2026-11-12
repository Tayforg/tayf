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

// h50-biasmath-2: the count noun in every tooltip. A single story's bar counts
// one source per outlet ('kaynak'); the topic / entity / thread bars sum those
// slots over many stories, where the same outlet counts once per story, so
// those callers say 'kaynak kaydı' (the wording /hafta already uses).
describe("BiasSpectrum — countUnit", () => {
  /** Every title="..." attribute, in document order (bar segments, then legend). */
  function titles(markup: string): string[] {
    return [...markup.matchAll(/ title="([^"]*)"/g)].map((m) => m[1] ?? "");
  }

  // 115 + 38 + 49 = 202 -> 56.9 / 18.8 / 24.3 -> %57 / %19 / %24 (the prod
  // /konu/genel numbers the idea was filed from).
  const SUMMED = dist({ pro_government: 115, center: 38, opposition: 49 });

  describe("default unit stays 'kaynak'", () => {
    const THREE_TO_TWO = dist({ pro_government: 3, opposition: 2 });

    it("compact titles read 'İktidar: 3 kaynak (%60)', bar then legend", () => {
      const markup = renderToStaticMarkup(
        <BiasSpectrum distribution={THREE_TO_TWO} compact />,
      );

      expect(titles(markup)).toEqual([
        "İktidar: 3 kaynak (%60)",
        "Muhalefet: 2 kaynak (%40)",
        "İktidar: 3 kaynak (%60)",
        "Muhalefet: 2 kaynak (%40)",
      ]);
    });

    it("full titles read '<category>: 3 kaynak (%60)', bar then legend", () => {
      const markup = renderToStaticMarkup(<BiasSpectrum distribution={THREE_TO_TWO} />);

      expect(titles(markup)).toEqual([
        "Hükümete Yakın: 3 kaynak (%60)",
        "Muhalefet: 2 kaynak (%40)",
        "Hükümete Yakın: 3 kaynak (%60)",
        "Muhalefet: 2 kaynak (%40)",
      ]);
    });

    it("an explicit countUnit='kaynak' renders exactly what the default renders", () => {
      for (const compact of [true, false]) {
        expect(
          renderToStaticMarkup(
            <BiasSpectrum distribution={THREE_TO_TWO} compact={compact} countUnit="kaynak" />,
          ),
        ).toBe(
          renderToStaticMarkup(<BiasSpectrum distribution={THREE_TO_TWO} compact={compact} />),
        );
      }
    });
  });

  describe("countUnit='kaynak kaydı'", () => {
    it("compact: every bar and legend title reads 'İktidar: 115 kaynak kaydı (%57)'", () => {
      const markup = renderToStaticMarkup(
        <BiasSpectrum distribution={SUMMED} compact countUnit="kaynak kaydı" />,
      );

      expect(titles(markup)).toEqual([
        "İktidar: 115 kaynak kaydı (%57)",
        "Bağımsız: 38 kaynak kaydı (%19)",
        "Muhalefet: 49 kaynak kaydı (%24)",
        "İktidar: 115 kaynak kaydı (%57)",
        "Bağımsız: 38 kaynak kaydı (%19)",
        "Muhalefet: 49 kaynak kaydı (%24)",
      ]);
      expect(markup).not.toContain(" kaynak (");
    });

    it("full: every bar and legend title reads '<category>: N kaynak kaydı (%P)'", () => {
      const markup = renderToStaticMarkup(
        <BiasSpectrum distribution={SUMMED} countUnit="kaynak kaydı" />,
      );

      expect(titles(markup)).toEqual([
        "Hükümete Yakın: 115 kaynak kaydı (%57)",
        "Merkez: 38 kaynak kaydı (%19)",
        "Muhalefet: 49 kaynak kaydı (%24)",
        "Hükümete Yakın: 115 kaynak kaydı (%57)",
        "Merkez: 38 kaynak kaydı (%19)",
        "Muhalefet: 49 kaynak kaydı (%24)",
      ]);
      expect(markup).not.toContain(" kaynak (");
    });

    it("keeps the Turkish thousands separator and the prefix percent", () => {
      const markup = renderToStaticMarkup(
        <BiasSpectrum
          distribution={dist({ pro_government: 1234, opposition: 766 })}
          compact
          countUnit="kaynak kaydı"
        />,
      );

      expect(titles(markup)).toEqual([
        "İktidar: 1.234 kaynak kaydı (%62)",
        "Muhalefet: 766 kaynak kaydı (%38)",
        "İktidar: 1.234 kaynak kaydı (%62)",
        "Muhalefet: 766 kaynak kaydı (%38)",
      ]);
    });

    it("changes only the title text: the visible legend and the bar widths are untouched", () => {
      const strip = (html: string) => html.replace(/ title="[^"]*"/g, "");

      for (const compact of [true, false]) {
        expect(
          strip(
            renderToStaticMarkup(
              <BiasSpectrum distribution={SUMMED} compact={compact} countUnit="kaynak kaydı" />,
            ),
          ),
        ).toBe(
          strip(renderToStaticMarkup(<BiasSpectrum distribution={SUMMED} compact={compact} />)),
        );
      }
    });

    it("still renders nothing for an empty distribution", () => {
      expect(
        renderToStaticMarkup(
          <BiasSpectrum
            distribution={emptyBiasDistribution()}
            compact
            countUnit="kaynak kaydı"
          />,
        ),
      ).toBe("");
      expect(
        renderToStaticMarkup(
          <BiasSpectrum distribution={emptyBiasDistribution()} countUnit="kaynak kaydı" />,
        ),
      ).toBe("");
    });
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

// react-a11y-1 (h163): the compact bar's segments are empty divs with a title,
// so accname step 2I (tooltip) gives each one its title as a name. The card link
// points aria-describedby at a wrapper holding this bar, and the legend under
// it already says every zone and percent as text, so each zone was announced
// twice ("İktidar: 4 kaynak (%67) ... İktidar %67"). The bar container is
// aria-hidden; the segments keep their title for the mouse hover tooltip, and
// the legend (the text that carries the information) stays exposed.
describe("BiasSpectrum — compact bar is hidden from assistive tech (react-a11y-1)", () => {
  const THREE_TO_TWO = dist({ pro_government: 3, opposition: 2 });
  const BAR_CLASS = "h-2 w-full gap-px";

  /** The opening tag (`<div ...>`) of the element whose markup starts at `start`. */
  function openingTagAt(markup: string, start: number): string {
    const end = markup.indexOf(">", start);
    if (end === -1) throw new Error("unterminated tag");
    return markup.slice(start, end + 1);
  }

  /** Every opening tag that carries a title="..." attribute, in document order. */
  function titledTags(markup: string): string[] {
    const tags: string[] = [];
    let from = 0;
    for (;;) {
      const lt = markup.indexOf("<", from);
      if (lt === -1) return tags;
      const tag = openingTagAt(markup, lt);
      if (tag.includes(' title="')) tags.push(tag);
      from = lt + tag.length;
    }
  }

  it("the bar container carries aria-hidden=\"true\"", () => {
    const markup = renderToStaticMarkup(
      <BiasSpectrum distribution={THREE_TO_TWO} compact />,
    );
    const classAt = markup.indexOf(BAR_CLASS);
    expect(classAt).toBeGreaterThan(-1);
    // Exactly one bar container in the compact branch.
    expect(markup.indexOf(BAR_CLASS, classAt + 1)).toBe(-1);
    const barTag = openingTagAt(markup, markup.lastIndexOf("<div", classAt));
    expect(barTag.startsWith("<div ")).toBe(true);
    expect(barTag).toContain(' aria-hidden="true"');
  });

  it("keeps the segment titles (the mouse hover tooltip) inside the hidden bar", () => {
    const markup = renderToStaticMarkup(
      <BiasSpectrum distribution={THREE_TO_TWO} compact />,
    );
    const titled = titledTags(markup);
    // Two bar segments, then two legend spans.
    expect(titled).toHaveLength(4);
    const segments = titled.filter((tag) => tag.startsWith("<div "));
    expect(segments).toHaveLength(2);
    expect(segments[0]).toContain('title="İktidar: 3 kaynak (%60)"');
    expect(segments[1]).toContain('title="Muhalefet: 2 kaynak (%40)"');
  });

  it("leaves every legend <span title=...> exposed: none carries aria-hidden", () => {
    const markup = renderToStaticMarkup(
      <BiasSpectrum distribution={THREE_TO_TWO} compact />,
    );
    const legendTags = titledTags(markup).filter((tag) => tag.startsWith("<span "));
    expect(legendTags).toHaveLength(2);
    for (const tag of legendTags) expect(tag).not.toContain("aria-hidden");
    // The legend text is what a screen reader reads: it carries zone and percent.
    expect(markup).toContain("%60");
    expect(markup).toContain("%40");
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
