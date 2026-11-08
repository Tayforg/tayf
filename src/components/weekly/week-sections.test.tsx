import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { ZoneHealth } from "@/lib/clusters/feed-health";
import { sourceCountHead } from "@/lib/feeds/zone-line";
import type { MediaDnaZone } from "@/types";
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
  weeklySourceCount,
} from "./week-sections";

// The sections are plain synchronous components, so renderToStaticMarkup is
// enough: no async server-component machinery, no mocked data layer.

/**
 * A row whose voting counts equal its member count (every member voted), the
 * shape that keeps the bare "N kaynak"; tests of the marker state `counts`.
 */
function blindspot(overrides: Partial<WeeklyBlindspot> = {}): WeeklyBlindspot {
  const side = overrides.side ?? "iktidar";
  const articleCount = overrides.articleCount ?? 13;
  return {
    id: "bs-1",
    title: "İhale iptali",
    articleCount,
    side,
    share: 1,
    sharePct: 100,
    counts: { iktidar: 0, bagimsiz: 0, muhalefet: 0, [side]: articleCount },
    ...overrides,
  };
}

function zoneHealth(delivering: number, total: number, degraded = false): ZoneHealth {
  return {
    total,
    fetchOk: total,
    fetchOkShare: 1,
    delivering,
    votingDelivering: delivering,
    deliveringShare: total === 0 ? 0 : delivering / total,
    healthy: delivering,
    healthyShare: total === 0 ? 0 : delivering / total,
    degraded,
  };
}

/** The side tally of the rows given, unless a test states its own. */
function summaryWith(
  blindspots: WeeklyBlindspot[],
  blindspotSideCounts?: Record<MediaDnaZone, number>,
): WeeklySummary {
  const counts = blindspotSideCounts ?? { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
  if (!blindspotSideCounts) for (const b of blindspots) counts[b.side] += 1;
  return {
    zoneCounts: { iktidar: 6, bagimsiz: 3, muhalefet: 1 },
    topClusters: [],
    blindspots,
    blindspotSideCounts: counts,
  };
}

describe("blindspotShareText", () => {
  it("share exactly 1 keeps the 'Spektrumda yalnızca' claim, copy unchanged", () => {
    expect(blindspotShareText(blindspot({ side: "iktidar", articleCount: 13, share: 1, sharePct: 100 }))).toBe(
      "Spektrumda yalnızca İktidar · 13 kaynak",
    );
  });

  // h72-newreader-1: "İktidar tarafında" named the writing side but read as the
  // side that was left out. "Spektrumda yalnızca X" says who covered it; the
  // no-evidence row says "X ağırlıklı". Neither uses "tarafında".
  it("never says 'tarafında' on any branch (it read as the silent side)", () => {
    const texts = [
      blindspotShareText(blindspot({ side: "iktidar", articleCount: 13, share: 1, sharePct: 100 })),
      blindspotShareText(blindspot({ side: "iktidar", articleCount: 13, share: null, sharePct: null })),
      blindspotShareText(blindspot({ side: "iktidar", articleCount: 20, share: 15 / 17, sharePct: 88 })),
    ];

    for (const text of texts) expect(text).not.toContain("tarafında");
  });

  it("share below 1 states the percentage instead (15 / 1 / 1 reads %88, never 'Spektrumda yalnızca')", () => {
    const text = blindspotShareText(
      blindspot({ side: "iktidar", articleCount: 20, share: 15 / 17, sharePct: 88 }),
    );

    expect(text).toBe("%88 İktidar · 20 kaynak");
    expect(text).not.toContain("Spektrumda yalnızca");
  });

  it("a clamped near-total share reads %99, not 'Spektrumda yalnızca' and not %100", () => {
    const text = blindspotShareText(blindspot({ share: 0.995, sharePct: 99, articleCount: 200 }));

    expect(text).toBe("%99 İktidar · 200 kaynak");
  });

  it("a stored side with no zone evidence makes no 'Spektrumda yalnızca' and no percentage claim", () => {
    const text = blindspotShareText(blindspot({ side: "iktidar", articleCount: 13, share: null, sharePct: null }));

    expect(text).toBe("İktidar ağırlıklı · 13 kaynak");
    expect(text).not.toContain("Spektrumda yalnızca");
    expect(text).not.toContain("%");
  });

  it("names the other zones from ZONE_META and groups four-digit counts the Turkish way", () => {
    expect(blindspotShareText(blindspot({ side: "muhalefet", articleCount: 1200 }))).toBe(
      "Spektrumda yalnızca Muhalefet · 1.200 kaynak",
    );
    expect(
      blindspotShareText(blindspot({ side: "bagimsiz", articleCount: 1500, share: 0.8, sharePct: 80 })),
    ).toBe("%80 Bağımsız · 1.500 kaynak");
  });

  // h66-statsparity-1: article_count is every member; the share is over the
  // voting sources. The row says so with the wording every other surface uses.
  describe("voting basis marker (h66-statsparity-1)", () => {
    const TEN_VOTERS = { iktidar: 9, bagimsiz: 1, muhalefet: 0 };

    it("16 members, 10 voters: '%90 İktidar · 16 kaynak (10 sınıflandırılmış)'", () => {
      expect(
        blindspotShareText(
          blindspot({ side: "iktidar", share: 0.9, sharePct: 90, articleCount: 16, counts: TEN_VOTERS }),
        ),
      ).toBe("%90 İktidar · 16 kaynak (10 sınıflandırılmış)");
    });

    it("share exactly 1 with 13 members and 10 voters keeps 'Spektrumda yalnızca' and adds the marker", () => {
      expect(
        blindspotShareText(
          blindspot({
            side: "iktidar",
            share: 1,
            sharePct: 100,
            articleCount: 13,
            counts: { iktidar: 10, bagimsiz: 0, muhalefet: 0 },
          }),
        ),
      ).toBe("Spektrumda yalnızca İktidar · 13 kaynak (10 sınıflandırılmış)");
    });

    it("no zone evidence (null share) still marks the voting count of the counts it has", () => {
      expect(
        blindspotShareText(
          blindspot({ side: "iktidar", share: null, sharePct: null, articleCount: 16, counts: TEN_VOTERS }),
        ),
      ).toBe("İktidar ağırlıklı · 16 kaynak (10 sınıflandırılmış)");
    });

    it("no distribution at all (all-zero counts) reads '(0 sınıflandırılmış)', the helper's own rule", () => {
      expect(
        blindspotShareText(
          blindspot({
            side: "iktidar",
            share: null,
            sharePct: null,
            articleCount: 3,
            counts: { iktidar: 0, bagimsiz: 0, muhalefet: 0 },
          }),
        ),
      ).toBe("İktidar ağırlıklı · 3 kaynak (0 sınıflandırılmış)");
    });

    it("counts that add up to articleCount leave every existing string unchanged", () => {
      expect(
        blindspotShareText(blindspot({ articleCount: 16, share: 0.9, sharePct: 90, counts: { iktidar: 14, bagimsiz: 2, muhalefet: 0 } })),
      ).toBe("%90 İktidar · 16 kaynak");
      expect(
        blindspotShareText(blindspot({ articleCount: 13, share: 1, sharePct: 100 })),
      ).toBe("Spektrumda yalnızca İktidar · 13 kaynak");
    });

    it("a stale tally above the member count is not qualified (voting >= total keeps the bare count)", () => {
      expect(
        blindspotShareText(
          blindspot({ articleCount: 4, share: 1, sharePct: 100, counts: { iktidar: 6, bagimsiz: 0, muhalefet: 0 } }),
        ),
      ).toBe("Spektrumda yalnızca İktidar · 4 kaynak");
    });

    it("groups both numbers the Turkish way past a thousand", () => {
      expect(
        blindspotShareText(
          blindspot({
            articleCount: 1500,
            share: 1100 / 1400,
            sharePct: 79,
            side: "bagimsiz",
            counts: { iktidar: 100, bagimsiz: 1100, muhalefet: 200 },
          }),
        ),
      ).toBe("%79 Bağımsız · 1.500 kaynak (1.400 sınıflandırılmış)");
    });
  });
});

describe("weeklySourceCount (h66-statsparity-1)", () => {
  const CASES: Array<[number, Record<MediaDnaZone, number>]> = [
    [10, { iktidar: 8, bagimsiz: 0, muhalefet: 0 }],
    [7, { iktidar: 4, bagimsiz: 2, muhalefet: 1 }],
    [3, { iktidar: 0, bagimsiz: 0, muhalefet: 0 }],
    [2, { iktidar: 4, bagimsiz: 1, muhalefet: 0 }],
    [53, { iktidar: 30, bagimsiz: 6, muhalefet: 10 }],
    [999, { iktidar: 500, bagimsiz: 100, muhalefet: 200 }],
  ];

  it.each(CASES)("prints exactly what sourceCountHead prints for %i members (below 1.000)", (total, counts) => {
    expect(weeklySourceCount(total, counts)).toBe(sourceCountHead(total, counts));
  });

  it("only differs from sourceCountHead by the Turkish thousands grouping", () => {
    expect(weeklySourceCount(1200, { iktidar: 600, bagimsiz: 100, muhalefet: 100 })).toBe(
      "1.200 kaynak (800 sınıflandırılmış)",
    );
    expect(sourceCountHead(1200, { iktidar: 600, bagimsiz: 100, muhalefet: 100 })).toBe(
      "1200 kaynak (800 sınıflandırılmış)",
    );
    expect(weeklySourceCount(1500, { iktidar: 600, bagimsiz: 500, muhalefet: 400 })).toBe("1.500 kaynak");
  });
});

describe("<ZoneShares> zone rows (h18-numbers-1)", () => {
  const props = { summary: summaryWith([]), health: null, feedStatus: null };

  it("count voting-source records, not articles: each row says 'kaynak kaydı'", () => {
    const html = renderToStaticMarkup(<ZoneShares {...props} truncated={false} />);

    // summaryWith(): iktidar 6, bagimsiz 3, muhalefet 1.
    expect(html).toContain("6 kaynak kaydı");
    expect(html).toContain("3 kaynak kaydı");
    expect(html).toContain("1 kaynak kaydı");
    expect(html).not.toContain("6 haber");
  });

  it("states the basis per variant in 'kaynak kaydı' (rolling, live, closed)", () => {
    const rolling = renderToStaticMarkup(
      <ZoneShares {...props} truncated={false} variant="rolling" />,
    );
    const live = renderToStaticMarkup(<ZoneShares {...props} truncated={false} />);
    const closed = renderToStaticMarkup(<ZoneShares {...props} truncated={false} archive />);

    expect(rolling).toContain(
      "Yüzdeler son 7 günün çok kaynaklı kümelerindeki 10 kaynak kaydı üzerinden hesaplanır.",
    );
    expect(rolling).toContain("(son 7 günün 10 kaynak kaydı içinde)");
    expect(live).toContain(
      "Yüzdeler bu haftanın çok kaynaklı kümelerindeki 10 kaynak kaydı üzerinden hesaplanır.",
    );
    expect(live).toContain("(haftanın 10 kaynak kaydı içinde)");
    expect(closed).toContain(
      "Yüzdeler o haftanın çok kaynaklı kümelerindeki 10 kaynak kaydı üzerinden hesaplanır.",
    );
    expect(closed).toContain("(haftanın 10 kaynak kaydı içinde)");
    for (const html of [rolling, live, closed]) {
      expect(html).not.toContain("toplam");
      expect(html).not.toContain("haberi");
    }
  });
});

describe("<WidestSpectrum> (h18-numbers-1)", () => {
  it("labels a cluster's member count 'kaynak', the same word /blindspots uses", () => {
    const summary: WeeklySummary = {
      ...summaryWith([]),
      topClusters: [
        {
          id: "wide-1",
          title: "Geniş yelpaze",
          articleCount: 9,
          zonesCovered: 3,
          zoneCounts: { iktidar: 4, bagimsiz: 3, muhalefet: 2 },
        },
      ],
    };
    const html = renderToStaticMarkup(<WidestSpectrum summary={summary} variant="rolling" />);

    expect(html).toContain("9 kaynak · 3 bölge");
    expect(html).not.toContain("9 haber");
  });

  // h66-statsparity-1: the member count beside zonesCovered (a voting figure).
  it("marks the voting count when fewer sources voted than the row counts: '53 kaynak (46 sınıflandırılmış) · 3 bölge'", () => {
    const summary: WeeklySummary = {
      ...summaryWith([]),
      topClusters: [
        {
          id: "8507ec54",
          title: "Çok kaynaklı hikaye",
          articleCount: 53,
          zonesCovered: 3,
          zoneCounts: { iktidar: 30, bagimsiz: 6, muhalefet: 10 },
        },
        {
          id: "all-voted",
          title: "Hepsi oy kullandı",
          articleCount: 9,
          zonesCovered: 3,
          zoneCounts: { iktidar: 4, bagimsiz: 3, muhalefet: 2 },
        },
      ],
    };
    const html = renderToStaticMarkup(<WidestSpectrum summary={summary} variant="rolling" />);

    expect(html).toContain("53 kaynak (46 sınıflandırılmış) · 3 bölge");
    expect(html).toContain("9 kaynak · 3 bölge");
    expect(html).not.toContain("9 kaynak (");
    expect(html).not.toContain("53 kaynak · 3 bölge");
  });

  it("groups four-digit counts the Turkish way", () => {
    const summary: WeeklySummary = {
      ...summaryWith([]),
      topClusters: [
        {
          id: "wide-2",
          title: "Çok geniş",
          articleCount: 1500,
          zonesCovered: 3,
          zoneCounts: { iktidar: 600, bagimsiz: 500, muhalefet: 400 },
        },
      ],
    };
    expect(renderToStaticMarkup(<WidestSpectrum summary={summary} />)).toContain(
      "1.500 kaynak · 3 bölge",
    );
  });
});

describe("<Blindspots>", () => {
  it("renders each row's own claim: only the 100% row says 'Spektrumda yalnızca'", () => {
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

    expect(html).toContain("Spektrumda yalnızca İktidar · 13 kaynak");
    expect(html).toContain("%88 İktidar · 20 kaynak");
    expect(html).toContain("İktidar ağırlıklı · 4 kaynak");
    // "Spektrumda yalnızca" appears exactly once: on the 100% row.
    expect(html.match(/Spektrumda yalnızca/g) ?? []).toHaveLength(1);
  });

  it("prints the voting count on the rows that need it (f1837ee1: 16 members, 10 voters)", () => {
    const html = renderToStaticMarkup(
      <Blindspots
        summary={summaryWith([
          blindspot({
            id: "f1837ee1",
            title: "Altı toplayıcı",
            articleCount: 16,
            share: 0.9,
            sharePct: 90,
            counts: { iktidar: 9, bagimsiz: 1, muhalefet: 0 },
          }),
          blindspot({ id: "all", title: "Hepsi oy kullandı", articleCount: 13, share: 1, sharePct: 100 }),
        ])}
        health={null}
        variant="rolling"
      />,
    );

    expect(html).toContain("%90 İktidar · 16 kaynak (10 sınıflandırılmış)");
    expect(html).toContain("Spektrumda yalnızca İktidar · 13 kaynak<");
    expect(html.match(/sınıflandırılmış/g) ?? []).toHaveLength(1);
  });

  it("uses the same row text on a closed week (archive)", () => {
    const html = renderToStaticMarkup(
      <Blindspots
        summary={summaryWith([blindspot({ articleCount: 20, share: 15 / 17, sharePct: 88 })])}
        health={null}
        archive
      />,
    );

    expect(html).toContain("%88 İktidar · 20 kaynak");
    expect(html).not.toContain("Spektrumda yalnızca");
  });
});

// h52-weekly-2: the list shows the biggest claims of each side, and the line
// under the heading gives the per-side totals and says so.
describe("<Blindspots> side tally (h52-weekly-2)", () => {
  const TALLY =
    "Toplam 46 kör nokta · İktidar ağırlıklı 37 · Muhalefet ağırlıklı 9. Her taraftan en büyükleri gösteriliyor.";
  const COUNTS = { iktidar: 37, bagimsiz: 0, muhalefet: 9 };
  const rows = [
    blindspot({ id: "i", title: "İktidar haberi", side: "iktidar", articleCount: 21 }),
    blindspot({ id: "m", title: "Muhalefet haberi", side: "muhalefet", articleCount: 8 }),
  ];

  it("prints the tally under the heading and above the rows, as a metaClass paragraph", () => {
    const html = renderToStaticMarkup(
      <Blindspots summary={summaryWith(rows, COUNTS)} health={null} variant="rolling" />,
    );

    expect(html).toContain(`<p class="text-xs text-muted-foreground">${TALLY}</p>`);
    const heading = html.indexOf("Kör noktalar</h2>");
    const tally = html.indexOf(TALLY);
    const list = html.indexOf("<ul");
    expect(heading).toBeGreaterThan(-1);
    expect(tally).toBeGreaterThan(heading);
    expect(list).toBeGreaterThan(tally);
  });

  it("still lists a Muhalefet-side row next to the İktidar one", () => {
    const html = renderToStaticMarkup(
      <Blindspots summary={summaryWith(rows, COUNTS)} health={null} variant="rolling" />,
    );

    expect(html).toContain("İktidar haberi");
    expect(html).toContain("Muhalefet haberi");
    expect(html).toContain("Spektrumda yalnızca Muhalefet · 8 kaynak");
  });

  it("derives the tally from the summary, with the Bağımsız segment when present", () => {
    const html = renderToStaticMarkup(
      <Blindspots
        summary={summaryWith(rows, { iktidar: 3, bagimsiz: 2, muhalefet: 1 })}
        health={null}
      />,
    );

    expect(html).toContain(
      "Toplam 6 kör nokta · İktidar ağırlıklı 3 · Muhalefet ağırlıklı 1 · Bağımsız ağırlıklı 2. Her taraftan en büyükleri gösteriliyor.",
    );
  });

  it("prints no tally and keeps the empty-state copy when the week has no blindspot", () => {
    const html = renderToStaticMarkup(
      <Blindspots summary={summaryWith([])} health={null} variant="rolling" />,
    );

    expect(html).not.toContain("Toplam");
    expect(html).not.toContain("Her taraftan");
    expect(html).toContain("Son 7 günde kör nokta yok.");
  });

  it.each([
    ["rolling", { variant: "rolling" as const }],
    ["live", {}],
    ["closed", { archive: true }],
  ])("%s: the tally line is identical and names no calendar week", (_label, props) => {
    const html = renderToStaticMarkup(
      <Blindspots summary={summaryWith(rows, COUNTS)} health={null} {...props} />,
    );

    expect(html).toContain(TALLY);
    // The tally is the only copy this test adds; the rest of the section is
    // week-copy's. On the rolling and closed pages no 'Bu hafta' may appear.
    if (_label !== "live") expect(html.toLocaleLowerCase("tr-TR")).not.toContain("bu hafta");
  });

  it("keeps the degraded caveat after the rows", () => {
    const degraded = zoneHealth(2, 20, true);
    const ok = zoneHealth(24, 36);
    const html = renderToStaticMarkup(
      <Blindspots
        summary={summaryWith(rows, COUNTS)}
        health={{ iktidar: ok, bagimsiz: ok, muhalefet: degraded }}
        variant="rolling"
      />,
    );

    expect(html).toContain(TALLY);
    expect(html.indexOf("kör nokta listesi eksik olabilir")).toBeGreaterThan(html.indexOf("</ul>"));
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
    expect(html).toContain("Yüzdeler son 7 günün çok kaynaklı kümelerindeki 10 kaynak kaydı üzerinden hesaplanır.");
    expect(html.match(/\(son 7 günün 10 kaynak kaydı içinde\)/g) ?? []).toHaveLength(3);
    expect(html.toLocaleLowerCase("tr-TR")).not.toContain("bu hafta");
    expect(html).not.toContain("haftanın 10 haberi");
    expect(html).not.toContain("haftanın 10 kaynak kaydı");
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

    expect(html).toContain("Yüzdeler son 7 günün çok kaynaklı kümelerindeki 6.989 kaynak kaydı üzerinden hesaplanır.");
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
    expect(zones).toContain("(haftanın 10 kaynak kaydı içinde)");
    expect(spots).toContain("Bu hafta kör nokta yok.");
  });

  it("archive still selects the closed wording when no variant is given", () => {
    const zones = renderToStaticMarkup(<ZoneShares {...props} truncated={false} archive />);

    expect(zones).toContain("O hafta kim neyi öne çıkardı");
    expect(zones).toContain("(haftanın 10 kaynak kaydı içinde)");
  });
});
