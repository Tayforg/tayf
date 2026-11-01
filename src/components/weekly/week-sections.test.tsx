import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { WeeklyBlindspot, WeeklySummary } from "@/lib/weekly/weekly-query";

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

import {
  Blindspots,
  TRUNCATED_CAVEAT,
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
    expect(TRUNCATED_CAVEAT).toBe("En büyük 5.000 küme üzerinden hesaplandı; haftanın tamamı değil.");
  });

  it("shows the caveat only when the read was truncated", () => {
    const truncated = renderToStaticMarkup(<ZoneShares {...props} truncated />);
    const complete = renderToStaticMarkup(<ZoneShares {...props} truncated={false} />);

    expect(truncated).toContain("En büyük 5.000 küme üzerinden hesaplandı; haftanın tamamı değil.");
    expect(complete).not.toContain("En büyük");
    expect(complete).not.toContain("haftanın tamamı değil");
  });
});
