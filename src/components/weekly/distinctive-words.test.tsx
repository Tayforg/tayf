import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WeeklyDistinctiveWords } from "@/lib/weekly/distinctive-words";

import { DistinctiveWords } from "./distinctive-words";

// DistinctiveWords is a plain synchronous server component and TrackedLink
// renders a plain <a>, so renderToStaticMarkup is enough. The markup is only
// inspected with includes()/indexOf() (never a regex over HTML tags).

const LEGEND = "z: belirginlik puanı; 1,96 ve üstü istatistiksel olarak anlamlı sayılır.";
const INTRO_MARKER = "Bu bir sayımdır";

const SAMPLE = { iktidar: 300, bagimsiz: 280, muhalefet: 260 };

function okData(): WeeklyDistinctiveWords {
  return {
    status: "ok",
    sample: SAMPLE,
    zones: {
      iktidar: [
        {
          term: "bakan",
          display: "Bakan",
          count: 54,
          z: 5.6,
          example: { title: "Örnek", url: "https://example.com/a", sourceName: "Örnek Gazete" },
        },
      ],
      bagimsiz: [],
      muhalefet: [],
    },
  };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

describe("DistinctiveWords z legend", () => {
  it("renders the legend exactly once, after the intro and before the first list", () => {
    const markup = renderToStaticMarkup(<DistinctiveWords data={okData()} />);

    expect(countOccurrences(markup, LEGEND)).toBe(1);

    const legendAt = markup.indexOf(LEGEND);
    const introAt = markup.indexOf(INTRO_MARKER);
    const listAt = markup.indexOf("<ol");
    expect(introAt).toBeGreaterThan(-1);
    expect(listAt).toBeGreaterThan(-1);
    expect(legendAt).toBeGreaterThan(introAt);
    expect(legendAt).toBeLessThan(listAt);
  });

  it("does not rely on a title attribute (hover-only) anywhere", () => {
    const markup = renderToStaticMarkup(<DistinctiveWords data={okData()} />);

    expect(markup.includes('title="')).toBe(false);
  });

  it("keeps the visible row stats as one text leaf inside an aria-hidden span", () => {
    const markup = renderToStaticMarkup(<DistinctiveWords data={okData()} />);

    expect(markup).toContain('<span aria-hidden="true"> · 54 başlık · z 5,6</span>');
  });

  it("adds a screen-reader twin that spells out the score", () => {
    const markup = renderToStaticMarkup(<DistinctiveWords data={okData()} />);

    expect(markup).toContain('<span class="sr-only">, 54 başlık, belirginlik puanı 5,6</span>');
  });

  it("keeps the term name outside the aria-hidden span", () => {
    const markup = renderToStaticMarkup(<DistinctiveWords data={okData()} />);

    expect(markup).toContain('<span class="font-medium">Bakan</span><span aria-hidden="true">');
  });

  it("omits the legend when the data is null", () => {
    const markup = renderToStaticMarkup(<DistinctiveWords data={null} />);

    expect(markup.includes(LEGEND)).toBe(false);
    expect(markup).toContain("Kelime karşılaştırması şu anda hesaplanamıyor.");
  });

  it("omits the legend when the sample is insufficient", () => {
    const markup = renderToStaticMarkup(
      <DistinctiveWords data={{ status: "insufficient", sample: SAMPLE }} />,
    );

    expect(markup.includes(LEGEND)).toBe(false);
    expect(markup).toContain("Son 7 günde kelime karşılaştırması için yeterli başlık yok.");
  });

  it("never says 'bu hafta' (/hafta is a trailing 7-day window)", () => {
    const variants: Array<WeeklyDistinctiveWords | null> = [
      okData(),
      null,
      { status: "insufficient", sample: SAMPLE },
    ];
    for (const data of variants) {
      const markup = renderToStaticMarkup(<DistinctiveWords data={data} />);
      expect(markup.toLocaleLowerCase("tr-TR").includes("bu hafta")).toBe(false);
    }
  });
});
