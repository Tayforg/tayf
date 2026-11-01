import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ZoneHealth } from "@/lib/clusters/feed-health";
import type { WeeklyBlindspot, WeeklySummary } from "@/lib/weekly/weekly-query";

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

import {
  BasisNote,
  Blindspots,
  TRUNCATED_CAVEAT,
  WidestSpectrum,
  ZoneShares,
  blindspotShareText,
} from "./week-sections";

// The sections are plain synchronous components, so renderToStaticMarkup is
// enough: no async server-component machinery, no mocked data layer.

function blindspot(overrides: Partial<WeeklyBlindspot> = {}): WeeklyBlindspot {
  return {
    id: "bs-1",
    title: "İhale iptali",
    articleCount: 13,
    side: "iktidar",
    share: 1,
    sharePct: 100,
    ...overrides,
  };
}

function zoneHealth(delivering: number, total: number, degraded = false): ZoneHealth {
  return {
    total,
    fetchOk: total,
    fetchOkShare: 1,
    delivering,
    deliveringShare: total === 0 ? 0 : delivering / total,
    healthy: delivering,
    healthyShare: total === 0 ? 0 : delivering / total,
    degraded,
  };
}

function summaryWith(blindspots: WeeklyBlindspot[]): WeeklySummary {
  return {
    zoneCounts: { iktidar: 6, bagimsiz: 3, muhalefet: 1 },
    topClusters: [],
    blindspots,
  };
}

describe("blindspotShareText", () => {
  it("share exactly 1 keeps the 'Sadece' claim, copy unchanged", () => {
    expect(blindspotShareText(blindspot({ side: "iktidar", articleCount: 13, share: 1, sharePct: 100 }))).toBe(
      "Sadece İktidar tarafında · 13 haber",
    );
  });

  it("share below 1 states the percentage instead (15 / 1 / 1 reads %88, never 'Sadece')", () => {
    const text = blindspotShareText(
      blindspot({ side: "iktidar", articleCount: 20, share: 15 / 17, sharePct: 88 }),
    );

    expect(text).toBe("%88 İktidar · 20 haber");
    expect(text).not.toContain("Sadece");
  });

  it("a clamped near-total share reads %99, not 'Sadece' and not %100", () => {
    const text = blindspotShareText(blindspot({ share: 0.995, sharePct: 99, articleCount: 200 }));

    expect(text).toBe("%99 İktidar · 200 haber");
  });

  it("a stored side with no zone evidence makes no 'Sadece' and no percentage claim", () => {
    const text = blindspotShareText(blindspot({ side: "iktidar", articleCount: 13, share: null, sharePct: null }));

    expect(text).toBe("İktidar tarafında · 13 haber");
    expect(text).not.toContain("Sadece");
    expect(text).not.toContain("%");
  });

  it("names the other zones from ZONE_META and groups four-digit counts the Turkish way", () => {
    expect(blindspotShareText(blindspot({ side: "muhalefet", articleCount: 1200 }))).toBe(
      "Sadece Muhalefet tarafında · 1.200 haber",
    );
    expect(
      blindspotShareText(blindspot({ side: "bagimsiz", articleCount: 1500, share: 0.8, sharePct: 80 })),
    ).toBe("%80 Bağımsız · 1.500 haber");
  });
});

describe("<Blindspots>", () => {
  it("renders each row's own claim: only the 100% row says 'Sadece'", () => {
    const html = renderToStaticMarkup(
      <Blindspots
        summary={summaryWith([
          blindspot({ id: "all", title: "Tam tek taraf", articleCount: 13, share: 1, sharePct: 100 }),
          blindspot({ id: "most", title: "Çoğu tek taraf", articleCount: 20, share: 15 / 17, sharePct: 88 }),
          blindspot({ id: "none", title: "Kanıtsız", articleCount: 4, share: null, sharePct: null }),
        ])}
        health={null}
      />,
    );

    expect(html).toContain("Sadece İktidar tarafında · 13 haber");
    expect(html).toContain("%88 İktidar · 20 haber");
    expect(html).toContain("İktidar tarafında · 4 haber");
    // "Sadece" appears exactly once: on the 100% row.
    expect(html.match(/Sadece/g) ?? []).toHaveLength(1);
  });

  it("uses the same row text on a closed week (archive)", () => {
    const html = renderToStaticMarkup(
      <Blindspots
        summary={summaryWith([blindspot({ articleCount: 20, share: 15 / 17, sharePct: 88 })])}
        health={null}
        archive
      />,
    );

    expect(html).toContain("%88 İktidar · 20 haber");
    expect(html).not.toContain("Sadece");
  });
});

describe("<ZoneShares> truncation caveat", () => {
  const props = { summary: summaryWith([]), health: null, feedStatus: null };

  it("the caveat names the ceiling with Turkish grouping (5.000, not 5000)", () => {
    expect(TRUNCATED_CAVEAT).toBe("En büyük 5.000 küme üzerinden hesaplandı; dönemin tamamı değil.");
  });

  it("shows the caveat only when the read was truncated", () => {
    const truncated = renderToStaticMarkup(<ZoneShares {...props} truncated />);
    const complete = renderToStaticMarkup(<ZoneShares {...props} truncated={false} />);

    expect(truncated).toContain("En büyük 5.000 küme üzerinden hesaplandı; dönemin tamamı değil.");
    expect(complete).not.toContain("En büyük");
    expect(complete).not.toContain("dönemin tamamı değil");
  });

  it("the caveat names no calendar week: it also prints on the rolling /hafta page", () => {
    expect(TRUNCATED_CAVEAT.toLocaleLowerCase("tr-TR")).not.toMatch(/hafta/);
    const rolling = renderToStaticMarkup(<ZoneShares {...props} truncated variant="rolling" />);
    expect(rolling).toContain("dönemin tamamı değil");
    expect(rolling.toLocaleLowerCase("tr-TR")).not.toContain("haftanın tamamı");
  });
});

// /hafta is a trailing 7-day window, not a calendar week: it passes
// variant="rolling" so no section says "Bu hafta" (h15-tz-1). Without the prop
// the sections keep the live wording the in-progress ISO week shows.
describe("variant=\"rolling\" (/hafta)", () => {
  const props = { summary: summaryWith([]), health: null, feedStatus: null };

  it("<ZoneShares> uses the rolling heading, basis and row total", () => {
    const html = renderToStaticMarkup(
      <ZoneShares {...props} truncated={false} variant="rolling" />,
    );

    expect(html).toContain("Son 7 günde kim neyi öne çıkardı");
    expect(html).toContain("Yüzdeler son 7 günün toplam 10 haberi üzerinden hesaplanır.");
    expect(html.match(/\(son 7 günün 10 haberi içinde\)/g) ?? []).toHaveLength(3);
    expect(html.toLocaleLowerCase("tr-TR")).not.toContain("bu hafta");
    expect(html).not.toContain("haftanın 10 haberi");
  });

  it("<ZoneShares> keeps the live source-health line under rolling", () => {
    const html = renderToStaticMarkup(
      <ZoneShares
        {...props}
        health={{
          iktidar: zoneHealth(24, 36),
          bagimsiz: zoneHealth(33, 57),
          muhalefet: zoneHealth(15, 20),
        }}
        feedStatus={{ delivering: 72, total: 113 }}
        truncated={false}
        variant="rolling"
      />,
    );

    expect(html).toContain("24 kaynak haber verdi (toplayıcı / niş dahil)");
    expect(html).toContain("spektruma sayılan kaynaklardan 72 / 113 tanesi haber verdi");
    expect(html).toContain('href="/kaynaklar/durum"');
  });

  it("<BasisNote> states the rolling percent basis", () => {
    const html = renderToStaticMarkup(
      <BasisNote total={6989} feedStatus={null} variant="rolling" />,
    );

    expect(html).toContain("Yüzdeler son 7 günün toplam 6.989 haberi üzerinden hesaplanır.");
    expect(html.toLocaleLowerCase("tr-TR")).not.toContain("bu hafta");
  });

  it("<WidestSpectrum> shows the rolling empty text", () => {
    const html = renderToStaticMarkup(
      <WidestSpectrum summary={summaryWith([])} variant="rolling" />,
    );

    expect(html).toContain("Son 7 günde birden fazla bölgenin birlikte gördüğü haber olmadı.");
    expect(html.toLocaleLowerCase("tr-TR")).not.toContain("bu hafta");
  });

  it("<Blindspots> shows the rolling empty text", () => {
    const html = renderToStaticMarkup(
      <Blindspots summary={summaryWith([])} health={null} variant="rolling" />,
    );

    expect(html).toContain("Son 7 günde kör nokta yok.");
    expect(html.toLocaleLowerCase("tr-TR")).not.toContain("bu hafta");
  });

  it("<Blindspots> words the degraded caveat for the last seven days", () => {
    const degraded = zoneHealth(2, 20, true);
    const ok = zoneHealth(24, 36);
    const html = renderToStaticMarkup(
      <Blindspots
        summary={summaryWith([])}
        health={{ iktidar: ok, bagimsiz: ok, muhalefet: degraded }}
        variant="rolling"
      />,
    );

    expect(html).toContain(
      "Bazı bölgelerde kaynaklara ulaşılamıyor; son 7 günün kör nokta listesi eksik olabilir.",
    );
  });

  it("without the prop the sections keep the live wording", () => {
    const zones = renderToStaticMarkup(<ZoneShares {...props} truncated={false} />);
    const spots = renderToStaticMarkup(<Blindspots summary={summaryWith([])} health={null} />);

    expect(zones).toContain("Bu hafta kim neyi öne çıkardı");
    expect(zones).toContain("(haftanın 10 haberi içinde)");
    expect(spots).toContain("Bu hafta kör nokta yok.");
  });

  it("archive still selects the closed wording when no variant is given", () => {
    const zones = renderToStaticMarkup(<ZoneShares {...props} truncated={false} archive />);

    expect(zones).toContain("O hafta kim neyi öne çıkardı");
    expect(zones).toContain("(haftanın 10 haberi içinde)");
  });
});
