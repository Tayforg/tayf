import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FW_DEFAULTS } from "@/lib/text/fightin-words";
import type { WeeklyDistinctiveWords } from "@/lib/weekly/distinctive-words";

import { DistinctiveWords } from "./distinctive-words";

// DistinctiveWords is a plain synchronous server component and TrackedLink
// renders a plain <a>, so renderToStaticMarkup is enough. The markup is only
// inspected with includes()/indexOf() (never a regex over HTML tags).

// zCut 3.3 in okData(): the legend says what the list is filtered against and shows the cut.
const LEGEND =
  "z: belirginlik puanı. Aynı başlıkların bölge etiketleri rastgele karıştırıldığında bir bölgede çıkan en yüksek puan, denemelerin yüzde 95'inde eşiğin altında kalıyor; listeye yalnızca eşiği aşan kelimeler girer (eşik: z 3,3).";
const INTRO_MARKER = "Bu bir sayımdır";

const SAMPLE = { iktidar: 300, bagimsiz: 280, muhalefet: 260 };

function okData(): WeeklyDistinctiveWords {
  return {
    status: "ok",
    sample: SAMPLE,
    zCut: 3.3,
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

// renderToStaticMarkup escapes the ASCII apostrophe ("95'inde" -> "95&#x27;inde"), so exact-string checks on
// the legend run on markup with that one entity decoded; a negative check on the escaped text would pass vacuously.
function renderPlain(data: WeeklyDistinctiveWords | null): string {
  return renderToStaticMarkup(<DistinctiveWords data={data} />).replaceAll("&#x27;", "'");
}

describe("DistinctiveWords z legend", () => {
  it("renders the legend exactly once, after the intro and before the first list", () => {
    const markup = renderPlain(okData());

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
    const markup = renderPlain(null);

    expect(markup.includes(LEGEND)).toBe(false);
    expect(markup.includes("eşik")).toBe(false);
    expect(markup).toContain("Kelime karşılaştırması şu anda hesaplanamıyor.");
  });

  it("omits the legend when the sample is insufficient", () => {
    const markup = renderPlain({ status: "insufficient", sample: SAMPLE });

    expect(markup.includes(LEGEND)).toBe(false);
    expect(markup.includes("eşik")).toBe(false);
    expect(markup).toContain("Son 7 günde kelime karşılaştırması için yeterli başlık yok.");
  });

  it("no longer claims 1,96 or statistical significance anywhere", () => {
    const markup = renderToStaticMarkup(<DistinctiveWords data={okData()} />);

    expect(markup.includes("1,96")).toBe(false);
    expect(markup.includes("1.96")).toBe(false);
    expect(markup.toLocaleLowerCase("tr-TR").includes("anlamlı")).toBe(false);
    expect(markup.toLocaleLowerCase("tr-TR").includes("istatistiksel")).toBe(false);
  });

  it("shows the cut in the legend, formatted like the row scores (one decimal, tr-TR comma)", () => {
    const markup = renderToStaticMarkup(<DistinctiveWords data={okData()} />);
    expect(markup).toContain("(eşik: z 3,3)");

    const other = { ...okData(), zCut: 3.26 } as WeeklyDistinctiveWords;
    const otherMarkup = renderToStaticMarkup(<DistinctiveWords data={other} />);
    expect(otherMarkup).toContain("(eşik: z 3,3)");

    const high = { ...okData(), zCut: 4 } as WeeklyDistinctiveWords;
    expect(renderToStaticMarkup(<DistinctiveWords data={high} />)).toContain("(eşik: z 4,0)");
  });

  it("explains the cut as a 95th-percentile threshold, not as 'above every shuffled maximum'", () => {
    const markup = renderPlain(okData());

    expect(markup).toContain("denemelerin yüzde 95'inde eşiğin altında kalıyor");
    expect(markup).toContain("listeye yalnızca eşiği aşan kelimeler girer");
    // The old wording claimed every listed word beats the highest shuffled score;
    // the cut is the 95th percentile of the shuffled maxima, so that was false.
    expect(markup.includes("en yüksek puanları aşan")).toBe(false);
  });

  it("keeps the 95 per cent in the legend in step with the quantile the cut is computed at", () => {
    // If the null quantile changes, the legend's "yüzde 95" must change with it.
    expect(FW_DEFAULTS.nullQuantile).toBe(0.95);
  });

  it("states the cut in the footnote too, replacing 'en az 1,96'", () => {
    const markup = renderToStaticMarkup(<DistinctiveWords data={okData()} />);

    expect(markup).toContain(
      "belirginlik puanı (z), bölge etiketleri 20 kez rastgele karıştırılarak bulunan şans eşiğini (z 3,3) aşmalı.",
    );
    expect(markup.includes("en az 1,96")).toBe(false);
    // The method sentence that follows is unchanged.
    expect(markup).toContain("Yöntem: bilgilendirici Dirichlet önselli log-odds oranı");
  });

  it("shows the same cut in the legend and in the footnote", () => {
    const data = { ...okData(), zCut: 2.84 } as WeeklyDistinctiveWords;
    const markup = renderToStaticMarkup(<DistinctiveWords data={data} />);

    expect(countOccurrences(markup, "z 2,8")).toBeGreaterThanOrEqual(2);
    expect(markup).toContain("(eşik: z 2,8)");
    expect(markup).toContain("şans eşiğini (z 2,8) aşmalı");
  });

  it("degrades without printing 'NaN' or 'undefined' when a cached payload predates zCut", () => {
    const { zCut: _zCut, ...legacy } = okData() as Extract<WeeklyDistinctiveWords, { status: "ok" }>;
    const markup = renderToStaticMarkup(
      <DistinctiveWords data={legacy as unknown as WeeklyDistinctiveWords} />,
    );

    expect(markup).toContain("Bakan");
    expect(markup.includes("NaN")).toBe(false);
    expect(markup.includes("undefined")).toBe(false);
    expect(markup.includes("eşik")).toBe(false);
    expect(markup.includes("1,96")).toBe(false);
    expect(markup).toContain("listeye yalnızca eşiği aşan kelimeler girer.");
  });

  it("renders a zone with no terms above the cut as the empty-zone copy", () => {
    const markup = renderToStaticMarkup(<DistinctiveWords data={okData()} />);

    // okData lists one term (iktidar); bagimsiz and muhalefet are empty.
    expect(countOccurrences(markup, "Son 7 günde belirgin şekilde öne çıkan kelime yok.")).toBe(2);
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

describe("DistinctiveWords zone headings (h19-copy-1)", () => {
  // The zone label is an adjective for "Bağımsız": "Bağımsız medya" /
  // "Bağımsız medyada", never "Bağımsız medyası" / "Bağımsız medyasında".
  it("renders the grammatical heading and locative line for each zone", () => {
    const markup = renderToStaticMarkup(<DistinctiveWords data={okData()} />);

    expect(markup).toContain("Bağımsız medya");
    expect(markup).toContain(">Bağımsız medya</h3>");
    expect(markup).toContain(
      "Son 7 günde Bağımsız medyada belirgin şekilde daha sık geçen kelimeler",
    );
    expect(markup).toContain(">İktidar medyası</h3>");
    expect(markup).toContain("İktidar medyası");
    expect(markup).toContain(">Muhalefet medyası</h3>");
    expect(markup).toContain("Muhalefet medyasında");
    expect(markup).toContain(
      "Son 7 günde İktidar medyasında belirgin şekilde daha sık geçen kelimeler",
    );
    expect(markup).toContain(
      "Son 7 günde Muhalefet medyasında belirgin şekilde daha sık geçen kelimeler",
    );
  });

  it("never renders the ungrammatical 'Bağımsız medyası' (heading or locative)", () => {
    const markup = renderToStaticMarkup(<DistinctiveWords data={okData()} />);

    expect(markup.includes("Bağımsız medyası")).toBe(false);
    expect(markup.includes("Bağımsız medyasında")).toBe(false);
  });

  it("keeps one heading and one locative line per zone", () => {
    const markup = renderToStaticMarkup(<DistinctiveWords data={okData()} />);

    expect(countOccurrences(markup, "<h3")).toBe(3);
    for (const zone of ["İktidar medyasında", "Bağımsız medyada", "Muhalefet medyasında"]) {
      expect(
        countOccurrences(markup, `Son 7 günde ${zone} belirgin şekilde daha sık geçen kelimeler`),
        zone,
      ).toBe(1);
    }
  });
});

describe("DistinctiveWords tr-TR counts (h29-regress-2)", () => {
  // /hafta printed the sample sizes raw ("İktidar 1789"), next to numbers the
  // rest of the page groups with a dot.
  it("groups the footnote sample counts with the tr-TR dot", () => {
    const data = { ...okData(), sample: { iktidar: 1789, bagimsiz: 1828, muhalefet: 1809 } };
    const markup = renderToStaticMarkup(<DistinctiveWords data={data} />);

    expect(markup).toContain("İktidar 1.789, Bağımsız 1.828, Muhalefet 1.809 başlık");
    expect(markup).not.toContain("İktidar 1789");
    // The per-day cap is under 1000 and stays a bare number.
    expect(markup).toContain("günde en fazla 300 başlık");
  });

  it("leaves sample counts under 1000 as they are", () => {
    const markup = renderToStaticMarkup(<DistinctiveWords data={okData()} />);

    expect(markup).toContain("İktidar 300, Bağımsız 280, Muhalefet 260 başlık");
  });

  it("groups a term count of 1000 or more in the visible row and in the screen-reader twin", () => {
    const data = okData();
    const first = data.status === "ok" ? data.zones.iktidar[0] : undefined;
    expect(first).toBeDefined();
    if (first) first.count = 1234;
    const markup = renderToStaticMarkup(<DistinctiveWords data={data} />);

    expect(markup).toContain('<span aria-hidden="true"> · 1.234 başlık · z 5,6</span>');
    expect(markup).toContain('<span class="sr-only">, 1.234 başlık, belirginlik puanı 5,6</span>');
    expect(markup).not.toContain("1234");
  });
});
